// The brain of the agent. It is deliberately I/O-light: it is handed a "source"
// (live Ticqet data), a "sender", a "clock" and the config, which makes the whole
// thing testable offline with fakes.
//
// Two entry points are called on timers by src/index.js (and once per run by the
// Google Apps Script version):
//   tick()        every ~15 s : notice booking changes and alert on them
//   minuteTick()  every minute: reminders, morning updates, event notices,
//                 schedule changes, held alerts, silence alarm
//
// Several facilities are watched at once (settings.facilities: the
// Multi-Purpose Court and the two 5-a-side pitches). What the agent has seen is
// kept per facility, and every message names the facility it is about.
//
// Who gets what (agreed with Zaria):
//   team        new / cancelled / changed bookings         (held during quiet hours)
//   attendants  reminders before sessions, last-minute bookings (never held)
//   summaries   daily update, or the weekly overview on its day
//   team+admin  event days (one booking of many hours): the day before, with the
//               teams to call because the facility is not available
//   everyone    schedule changes the admin writes on the sheet (car-free day...)
//   admin       possible double-bookings, open regular slots, renewals,
//               Umuganda heads-up, technical alarms, anything unusual

import { log, mask } from './logger.js';
import * as store from './store.js';
import * as fmt from './formatter.js';
import { bookingFromDoc, diffDay, fingerprint, pairReissues, slotsToRanges } from './bookings.js';
import {
  nowInZone, dateWindow, ticqetLabel, hhmmToMinutes, weekdayOf, WEEKDAYS,
  isoDate, dayFromIso, dayFromLabel, daysBetween, shortDate, clockLabelMinutes,
  compactRange, addDays, isLastSaturday, joinNames,
} from './time.js';
import { planForDate, windowHolding, lapsedRegularHours, buildSessions } from './regulars.js';
import { recipients, adminName, channelName } from './config.js';

// Admin messages are never blocked by the daily message cap.
const ADMIN_KINDS = new Set([
  'regular-slot-check', 'mass-removal', 'open-regular-slots', 'renewal',
  'technical', 'technical-recovered', 'send-cap', 'admin-overnight', 'umuganda',
]);
// Booking alerts are the first to pause when the day's messages run low, so
// reminders, updates and event notices still go out.
const ALERT_KINDS = new Set(['new-booking', 'bookings-digest', 'cancelled', 'changed', 'overnight']);
// A reminder may go out up to 5 min late (e.g. after a restart). When the agent
// only runs every few minutes, settings.reminderToleranceMinutes widens this.
const REMINDER_TOLERANCE_MIN = 5;
const MORNING_GRACE_MIN = 180; // send the morning update up to 3 h late, never in the evening
const MORNING_DATA_WAIT_MIN = 15; // wait this long for fresh Ticqet data before the morning update
const UMUGANDA_NOTICE_DAYS = 3; // the admin hears about sessions during Umuganda up to 3 days before

const dateOf = (d) => ({ y: d.y, m: d.m, d: d.d, label: d.label });
const sameDay = (a, b) => a.y === b.y && a.m === b.m && a.d === b.d;
const sameClient = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

// State saved before the agent watched several facilities belongs to the one
// court it watched then: date-keyed snapshots, "rem|date|hour|min" reminder
// marks and "open|date|client|hour" marks get that court's id.
function upgradeSnapshot(snap, legacyId) {
  const days = (snap && snap.days) || {};
  const keys = Object.keys(days);
  if (keys.length && keys.every((k) => dayFromLabel(k))) return { days: legacyId ? { [legacyId]: days } : {} };
  return { days };
}

function upgradeReminders(set, legacyId) {
  const out = new Set();
  for (const k of set) {
    const p = k.split('|');
    out.add(p[0] === 'rem' && p.length === 4 && legacyId ? `rem|${p[1]}|${legacyId}|${p[2]}|${p[3]}` : k);
  }
  return out;
}

function upgradeJobs(jobs, legacyId) {
  const out = {};
  for (const [k, v] of Object.entries(jobs || {})) {
    const p = k.split('|');
    if (p[0] === 'open' && p.length === 4 && legacyId) out[`open|${p[1]}|${legacyId}|${p[2]}|${p[3]}`] = v;
    else out[k] = v;
  }
  // The facilities everyone has been told about. Unknown on a new install (the
  // welcome will name them all); just the court for an agent from before.
  if (!Array.isArray(out.watching) && out.watching !== null) {
    out.watching = Object.keys(out).length ? (legacyId ? [legacyId] : []) : null;
  }
  return out;
}

export class Engine {
  // source: { get(label, facilityId) -> [record]|undefined, watch?(labels),
  //           probe?(labels), lastContactAt, oldestErrorAt, failing? }
  // sender: { send({ to, text, kind }) -> { ok } }
  // clock:  { now() -> Date }
  constructor({ cfg, source, sender, clock }) {
    this.cfg = cfg;
    this.source = source;
    this.sender = sender;
    this.clock = clock || { now: () => new Date() };

    const legacyId = this.settings.court?.ticqetEventId || null;
    this.snapshot = upgradeSnapshot(store.loadSnapshot(), legacyId); // bookings seen: { days: { facilityId: { label: [booking] } } }
    this.reminders = upgradeReminders(store.loadReminders(), legacyId); // reminder keys already sent
    this.deferred = store.loadDeferred(); // alerts held during quiet hours
    this.jobs = upgradeJobs(store.loadJobMarks(), legacyId); // one-off jobs done + daily counters

    this.pending = new Map(); // "facilityId|label" -> { fp, since }: changes waiting to settle
    this.watchedKey = '';
    this.watchedLabels = [];
    this.startedAt = this.nowMs();
    this.silence = { alerted: false, since: null };
    this.probeCursor = 0;
    this.changeStatus = new Map(); // Schedule Changes row -> what the agent did with it
  }

  // ---------- basics ----------
  get settings() { return this.cfg.settings; }
  get regulars() { return this.cfg.regulars; }
  get facilities() { return this.settings.facilities && this.settings.facilities.length ? this.settings.facilities : [this.settings.court]; }
  get changes() { return (this.cfg.changes || []).filter((c) => !c.problem); }
  nowMs() { return this.clock.now().getTime(); }
  now() { return nowInZone(this.settings.timezone, this.clock.now()); }
  today(n = this.now()) { return { y: n.y, m: n.m, d: n.d, label: ticqetLabel(n.y, n.m, n.d) }; }
  minuteOfDay(n = this.now()) { return n.hour * 60 + n.minute; }
  stamp() { return new Date(this.nowMs()).toISOString(); }
  saveJobs() { store.saveJobMarks(this.jobs); }

  inQuietHours(n = this.now()) {
    const q = this.settings.quietHours;
    if (!q || !q.start || !q.end || q.start === q.end) return false;
    const cur = this.minuteOfDay(n);
    const start = hhmmToMinutes(q.start);
    const end = hhmmToMinutes(q.end);
    return start > end ? cur >= start || cur < end : cur >= start && cur < end;
  }

  // The morning message for a date: weekly overview on its day, else daily update.
  morningPlan(today) {
    const weekly = WEEKDAYS[weekdayOf(today.y, today.m, today.d)] === this.settings.weeklyOverviewDay;
    const at = hhmmToMinutes(weekly ? this.settings.weeklyOverviewTime : this.settings.dailyUpdateTime);
    return { weekly, at };
  }

  // Has today's morning update gone out (or is it too late for it now)?
  morningDone(today, n = this.now()) {
    if (this.jobs[`morning|${isoDate(today)}`]) return true;
    return this.minuteOfDay(n) >= this.morningPlan(today).at + MORNING_GRACE_MIN;
  }

  // ---------- what is on at a facility ----------

  bookingsOn(f, date) { return this.snapshot.days[f.ticqetEventId]?.[date.label]; }
  dayKnown(f, date) { return this.bookingsOn(f, date) !== undefined; }
  plan(facilityName, date) { return planForDate(this.regulars, date, facilityName, this.changes); }
  isEventBooking(b) { return this.settings.eventMinHours > 0 && b.hours >= this.settings.eventMinHours; }

  // Bookings made in hours a regular gave up that date (after the change):
  // real bookings, so they keep their reminders.
  lateIds(f, date) {
    const prefix = `late|${isoDate(date)}|${f.ticqetEventId}|`;
    return new Set(Object.keys(this.jobs).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)));
  }

  sessionsFor(f, date) {
    return buildSessions(this.bookingsOn(f, date) || [], this.regulars, date, f.name, {
      changes: this.changes,
      eventMinHours: this.settings.eventMinHours,
      exempt: this.lateIds(f, date),
    });
  }

  // An event or setup at a facility on a date: its hours, and the teams that
  // need a call - everyone else booked there that day, plus regulars whose
  // usual hours the event booking took.
  eventInfo(f, date) {
    const events = (this.bookingsOn(f, date) || []).filter((b) => this.isEventBooking(b));
    if (!events.length) return null;
    const eventSlots = new Set(events.flatMap((b) => b.slots));
    const ranges = slotsToRanges([...eventSlots]);
    const others = this.sessionsFor(f, date).filter((s) => !s.event && !s.off);
    const displaced = this.plan(f.name, date).windows
      .filter((w) => {
        for (let h = w.startHour; h < w.endHour; h++) if (eventSlots.has(h)) return true;
        return false;
      })
      .filter((w) => !others.some((s) => s.client && sameClient(s.client, w.client) && s.startHour < w.endHour && s.endHour > w.startHour))
      .map((w) => ({ startHour: w.startHour, endHour: w.endHour, client: w.client, displaced: true }));
    const teams = [...others, ...displaced].sort((a, b) => a.startHour - b.startHour || a.endHour - b.endHour);
    return { ranges, teams };
  }

  umugandaOn(date) {
    const u = this.settings.umuganda;
    if (!u || !isLastSaturday(date.y, date.m, date.d)) return null;
    return { start: hhmmToMinutes(u.start), end: hhmmToMinutes(u.end) };
  }

  eventRecipients() {
    return [...new Set([...recipients(this.cfg, 'team'), ...recipients(this.cfg, 'admin')])];
  }

  // ======================================================================
  // 1) Booking changes
  // ======================================================================

  async tick() {
    const n = this.now();
    const window = dateWindow(this.today(n), this.settings.watch.windowDays);
    const labels = window.map((d) => d.label);
    const ids = this.facilities.map((f) => f.ticqetEventId);

    // Keep the watched dates in step with the calendar (rolls over at midnight)
    // and the watched facilities in step with the settings.
    const key = `${ids.join(',')}|${labels.join('|')}`;
    if (key !== this.watchedKey) {
      this.watchedKey = key;
      this.watchedLabels = labels;
      if (this.source.watch) this.source.watch(labels);
      const keepIds = new Set(ids);
      const keepLabels = new Set(labels);
      for (const fid of Object.keys(this.snapshot.days)) {
        if (!keepIds.has(fid)) {
          delete this.snapshot.days[fid];
          continue;
        }
        for (const label of Object.keys(this.snapshot.days[fid])) if (!keepLabels.has(label)) delete this.snapshot.days[fid][label];
      }
      for (const k of [...this.pending.keys()]) {
        const [fid, label] = k.split('|');
        if (!keepIds.has(fid) || !keepLabels.has(label)) this.pending.delete(k);
      }
      store.saveSnapshot(this.snapshot);
    }

    const settleMs = (this.settings.watch.settleSeconds ?? 60) * 1000;
    const nowMs = this.nowMs();
    const events = [];
    let dirty = false;

    for (const f of this.facilities) {
      const fid = f.ticqetEventId;
      const seen = this.snapshot.days[fid] || (this.snapshot.days[fid] = {});
      const tag = (b) => ({ ...b, facility: f.name, facilityId: fid });
      for (const day of window) {
        const raw = this.source.get(day.label, fid);
        if (raw === undefined) continue; // not read from Ticqet yet
        const date = dateOf(day);
        const current = raw.map((r) => bookingFromDoc(r, date));
        const known = seen[day.label];
        const pkey = `${fid}|${day.label}`;

        // First time we see this date (first run, a new facility, or the date
        // just entered the watch window): record what is there silently. These
        // bookings already existed before we were watching, so they are not "new".
        if (known === undefined) {
          seen[day.label] = current;
          dirty = true;
          for (const b of current) {
            store.appendBookingLog({ event: 'first-seen', at: this.stamp(), facility: f.name, facilityId: fid, date: day.label, id: b.id, slots: b.slots });
          }
          continue;
        }

        const fpNow = fingerprint(current);
        if (fpNow === fingerprint(known)) {
          this.pending.delete(pkey);
          continue;
        }
        // Something changed. Wait until it has been stable for `settleSeconds`
        // so a record that Ticqet rewrites (delete + create) causes no alert.
        const p = this.pending.get(pkey);
        if (!p || p.fp !== fpNow) {
          this.pending.set(pkey, { fp: fpNow, since: nowMs });
          if (settleMs > 0) continue;
        } else if (nowMs - p.since < settleMs) {
          continue;
        }
        this.pending.delete(pkey);

        const diff = diffDay(known, current);
        const { added, removed, reissued } = pairReissues(diff.added, diff.removed);
        for (const r of reissued) {
          log.info(`[engine] ${f.name}, ${day.label}: record re-issued (${r.before.id} -> ${r.after.id}) with the same hours - not alerted`);
        }
        for (const b of added) events.push({ type: 'added', booking: tag(b) });
        for (const b of removed) events.push({ type: 'removed', booking: tag(b) });
        for (const c of diff.changed) events.push({ type: 'changed', before: tag(c.before), after: tag(c.after) });
        seen[day.label] = current;
        dirty = true;
      }
    }

    if (dirty) store.saveSnapshot(this.snapshot);
    if (events.length) await this.dispatch(events);
    await this.maybeWelcome();
    await this.maybeAnnounceFacilities();
  }

  // Decide who hears about a batch of changes, and how.
  async dispatch(events) {
    const n = this.now();
    const teamAdds = [];
    const eventAdds = [];
    const removals = [];
    const changes = [];
    const checks = []; // for the admin: bookings in a regular client's slot

    for (const ev of events) {
      if (ev.type === 'changed') {
        const a = ev.after;
        store.appendBookingLog({ event: 'changed', at: this.stamp(), facility: a.facility, facilityId: a.facilityId, date: a.date.label, id: a.id, from: ev.before.slots, to: a.slots });
        if (!this.isPast(a, n)) changes.push(ev);
        continue;
      }
      const b = ev.booking;
      const isEvent = this.isEventBooking(b);
      const plan = this.plan(b.facility, b.date);
      const win = isEvent ? null : windowHolding(b, plan.windows);
      const offWin = isEvent || win ? null : windowHolding(b, plan.off);
      const regular = win ? win.client : null;
      store.appendBookingLog({ event: ev.type, at: this.stamp(), facility: b.facility, facilityId: b.facilityId, date: b.date.label, id: b.id, slots: b.slots, regular });
      if (this.isPast(b, n)) {
        log.info(`[engine] ${ev.type} on ${b.facility}, ${b.date.label} is for a time already past - not alerted`);
        continue;
      }
      if (ev.type === 'removed') {
        removals.push({ booking: b, regular: regular || (offWin ? offWin.client : null) });
      } else if (isEvent) {
        eventAdds.push(b);
      } else if (win) {
        // Fully inside a regular's hours. Exactly their block: Zaria blocking the
        // slot for them - nothing to report. Only part of it: could be a customer
        // booking a regular's hour that was left open - the admin checks it.
        if (b.slots.length === win.endHour - win.startHour) {
          log.info(`[engine] ${regular}'s slot blocked on ${b.facility}, ${b.date.label} - no alert`);
        } else {
          log.info(`[engine] booking inside ${regular}'s usual slot on ${b.facility}, ${b.date.label} - asking admin to check`);
          checks.push({ booking: b, client: regular, inside: true });
        }
      } else {
        if (offWin) {
          // Booked in hours a regular gave up that date (schedule change): a
          // real booking, so it keeps its reminders.
          this.jobs[`late|${isoDate(b.date)}|${b.facilityId}|${b.id}`] = true;
          this.saveJobs();
        }
        teamAdds.push(b);
        const overlap = plan.windows.filter((w) => b.slots.some((h) => h >= w.startHour && h < w.endHour));
        if (overlap.length) checks.push({ booking: b, client: overlap[0].client, inside: false });
      }
    }

    const max = this.settings.maxAlertsAtOnce ?? 5;

    // New bookings: one message each, or one summary if many arrive together.
    if (teamAdds.length > max) {
      log.warn(`[engine] ${teamAdds.length} new bookings at once - sending one summary`);
      await this.teamAlert('bookings-digest', fmt.bookingsDigest(teamAdds), teamAdds.map((b) => fmt.overnightLine('new', b)));
      for (const b of teamAdds) if (this.isLastMinute(b, n)) await this.lastMinuteToAttendants(b, n);
    } else {
      for (const b of teamAdds) await this.announceNew(b, n);
    }

    // Events: the team and the admin, with the teams to call.
    for (const b of eventAdds) await this.announceEvent(b, n);

    // Cancellations: many vanishing at once is far more likely a Ticqet glitch
    // or data change than real cancellations - tell the admin, not the team.
    if (removals.length > max) {
      log.warn(`[engine] ${removals.length} bookings vanished at once - admin only`);
      await this.adminAlert('mass-removal', fmt.massRemoval(removals.map((r) => r.booking)));
    } else {
      for (const { booking, regular } of removals) {
        await this.teamAlert('cancelled', fmt.cancelledBooking(booking, booking.facility, regular), [fmt.overnightLine('cancelled', booking)]);
      }
    }

    for (const c of changes) {
      await this.teamAlert('changed', fmt.changedBooking(c.before, c.after, c.after.facility), [fmt.overnightLine('changed', c.before, c.after)]);
    }

    if (checks.length) await this.adminAlert('regular-slot-check', fmt.regularSlotCheck(checks));
  }

  async announceNew(b, n) {
    const text = fmt.newBooking(b, b.facility);
    const line = fmt.overnightLine('new', b);
    if (this.isLastMinute(b, n)) {
      // Attendants get ONE immediate "starting soon" message instead of their
      // two reminders; the rest of the team gets the normal new-booking alert.
      await this.lastMinuteToAttendants(b, n);
      const attendants = new Set(recipients(this.cfg, 'attendants'));
      await this.teamAlert('new-booking', text, [line], recipients(this.cfg, 'team').filter((p) => !attendants.has(p)));
    } else {
      await this.teamAlert('new-booking', text, [line]);
    }
  }

  // A booking long enough to be an event or setup. For today or tomorrow this
  // also counts as the day-before event notice.
  async announceEvent(b, n) {
    const today = this.today(n);
    const when = sameDay(b.date, today) ? 'today' : sameDay(b.date, addDays(today, 1)) ? 'tomorrow' : null;
    const f = this.facilities.find((x) => x.ticqetEventId === b.facilityId);
    const info = f ? this.eventInfo(f, b.date) : null;
    const teams = (info ? info.teams : []).filter((t) => when !== 'today' || t.startHour * 60 > this.minuteOfDay(n));
    const held = this.inQuietHours(n);
    await this.teamAlert('event-booked', fmt.eventBooked({ booking: b, facility: b.facility, when, teams }), [fmt.overnightLine('event', b)], this.eventRecipients());
    if (when && !held) {
      this.jobs[`event|${isoDate(b.date)}|${b.facilityId}`] = this.stamp();
      this.saveJobs();
    }
  }

  // Today, and starting within the first-reminder lead time (or already running).
  isLastMinute(b, n) {
    if (!sameDay(b.date, this.today(n)) || !b.ranges.length) return false;
    const first = b.ranges[0];
    const cur = this.minuteOfDay(n);
    const lead = Math.max(0, ...this.settings.attendantReminderMinutes);
    return first.startHour * 60 - cur < lead && first.endHour * 60 > cur;
  }

  // A booking for today whose hours have entirely passed.
  isPast(b, n) {
    if (!sameDay(b.date, this.today(n)) || !b.ranges.length) return false;
    return b.ranges[b.ranges.length - 1].endHour * 60 <= this.minuteOfDay(n);
  }

  async lastMinuteToAttendants(b, n) {
    const r = b.ranges[0];
    const minutesToStart = r.startHour * 60 - this.minuteOfDay(n);
    await this.send('last-minute', fmt.lastMinute({ startHour: r.startHour, endHour: r.endHour, client: null }, b.facility, minutesToStart), recipients(this.cfg, 'attendants'));
    const iso = isoDate(this.today(n));
    for (const mb of this.settings.attendantReminderMinutes) this.reminders.add(`rem|${iso}|${b.facilityId}|${r.startHour}|${mb}`);
    store.saveReminders(this.reminders);
  }

  // ======================================================================
  // 2) Sending
  // ======================================================================

  // Team alerts wait for the morning update during quiet hours.
  async teamAlert(kind, text, lines, to = recipients(this.cfg, 'team')) {
    if (this.inQuietHours()) {
      this.deferred.push({ audience: 'team', kind, lines, at: this.stamp() });
      store.saveDeferred(this.deferred);
      log.info(`[engine] quiet hours - ${kind} held for the morning update`);
      return;
    }
    await this.send(kind, text, to);
  }

  // Admin notes also wait for the morning during quiet hours.
  async adminAlert(kind, text) {
    if (this.inQuietHours()) {
      this.deferred.push({ audience: 'admin', kind, text, at: this.stamp() });
      store.saveDeferred(this.deferred);
      log.info(`[engine] quiet hours - ${kind} held for the morning`);
      return;
    }
    await this.send(kind, text, recipients(this.cfg, 'admin'));
  }

  // Send one text to several people. A failure for one person never stops the
  // others. A daily cap protects against runaway costs if something goes wrong;
  // booking alerts stop a little earlier so reminders and updates still go out.
  async send(kind, text, to) {
    if (!to.length) {
      log.warn(`[engine] nobody is set to receive "${kind}" messages`);
      return 0;
    }
    const day = isoDate(this.today());
    const countKey = `sent|${day}`;
    const cap = this.settings.maxMessagesPerDay ?? 300;
    const alertCap = cap - Math.min(30, Math.floor(cap / 3));
    let ok = 0;
    for (const addr of to) {
      const count = this.jobs[countKey] || 0;
      if (!ADMIN_KINDS.has(kind)) {
        if (count >= cap) {
          await this.capReached(day, cap);
          break;
        }
        if (ALERT_KINDS.has(kind) && count >= alertCap) {
          await this.alertsPaused(day, count, cap);
          break;
        }
      }
      this.jobs[countKey] = count + 1;
      try {
        const res = await this.sender.send({ to: addr, text, kind });
        if (res && res.ok === false) log.warn(`[send] ${kind} to ${mask(addr)} failed${res.error ? `: ${res.error}` : ''}`);
        else ok += 1;
      } catch (err) {
        log.error(`[send] ${kind} to ${mask(addr)} failed: ${err.message}`);
      }
    }
    this.saveJobs();
    return ok;
  }

  async capReached(day, cap) {
    const key = `capNotice|${day}`;
    if (this.jobs[key]) return;
    this.jobs[key] = true;
    this.saveJobs();
    log.error(`[engine] daily message limit (${cap}) reached - team messages paused until tomorrow`);
    await this.send('send-cap', fmt.sendCapReached(cap), recipients(this.cfg, 'admin'));
  }

  async alertsPaused(day, sent, cap) {
    const key = `alertsPaused|${day}`;
    if (this.jobs[key]) return;
    this.jobs[key] = true;
    this.saveJobs();
    log.warn(`[engine] ${sent} messages sent today - booking alerts paused until tomorrow, the rest is kept for reminders`);
    await this.send('send-cap', fmt.alertsPaused(sent, cap), recipients(this.cfg, 'admin'));
  }

  takeDeferred(audience) {
    const taken = this.deferred.filter((d) => d.audience === audience);
    if (taken.length) {
      this.deferred = this.deferred.filter((d) => d.audience !== audience);
      store.saveDeferred(this.deferred);
    }
    return taken;
  }

  async flushAdminDeferred() {
    const items = this.takeDeferred('admin');
    if (!items.length) return;
    const text = items.length === 1
      ? items[0].text
      : fmt.adminOvernight(items.map((it) => it.text.split('\n').slice(1).join(' ')));
    await this.send('admin-overnight', text, recipients(this.cfg, 'admin'));
  }

  // ======================================================================
  // 3) Every minute: reminders, morning jobs, event notices, schedule
  //    changes, held alerts, silence alarm
  // ======================================================================

  async minuteTick() {
    await this.tickReminders();
    await this.morningJobs();
    await this.eventNotices();
    await this.announceChanges();
    await this.flushDeferredIfDue();
    await this.checkSilence();
    this.prune();
  }

  // Reminders before every session today, at every facility (Ticqet and
  // regular). The first one (e.g. 60 min) goes to the "Reminder 1" people,
  // later ones to "Reminder 2". Sessions starting at the same time share one
  // message. No reminder for a regular who is not playing (schedule change).
  async tickReminders() {
    const mins = this.settings.attendantReminderMinutes;
    if (!mins.length) return;
    const n = this.now();
    const today = this.today(n);
    const iso = isoDate(today);
    const cur = this.minuteOfDay(n);
    const readyGap = mins.length > 1 ? mins[mins.length - 1] : 0; // ready by the last reminder
    const tolerance = this.settings.reminderToleranceMinutes ?? REMINDER_TOLERANCE_MIN;
    const due = mins.map(() => new Map()); // per reminder: start hour -> sessions

    for (const f of this.facilities) {
      for (const s of this.sessionsFor(f, today)) {
        if (s.off) continue;
        const start = s.startHour * 60;
        if (cur >= start) continue;
        for (let i = 0; i < mins.length; i++) {
          const fireAt = start - mins[i];
          const until = Math.min(fireAt + tolerance, i + 1 < mins.length ? start - mins[i + 1] : start);
          const key = `rem|${iso}|${f.ticqetEventId}|${s.startHour}|${mins[i]}`;
          if (this.reminders.has(key) || cur < fireAt || cur >= until) continue;
          this.reminders.add(key);
          if (!due[i].has(s.startHour)) due[i].set(s.startHour, []);
          due[i].get(s.startHour).push({ ...s, facility: f.name });
        }
      }
    }
    if (!due.some((m) => m.size)) return;
    store.saveReminders(this.reminders);
    for (let i = 0; i < mins.length; i++) {
      for (const [startHour, items] of [...due[i]].sort((a, b) => a[0] - b[0])) {
        await this.send('reminder', fmt.reminder(items, mins[i], i === 0, startHour * 60 - readyGap), recipients(this.cfg, i === 0 ? 'reminder1' : 'reminder2'));
      }
    }
  }

  // The morning message (daily update, or weekly overview on its day), then the
  // admin's morning notes: held checks, open regular slots, renewals, Umuganda.
  async morningJobs() {
    const n = this.now();
    const today = this.today(n);
    const key = `morning|${isoDate(today)}`;
    if (this.jobs[key]) return;
    const { weekly, at } = this.morningPlan(today);
    const cur = this.minuteOfDay(n);
    if (cur < at || cur >= at + MORNING_GRACE_MIN) return;
    // Just restarted? Give the live connection a few minutes to load today.
    if (this.facilities.some((f) => !this.dayKnown(f, today)) && cur < at + MORNING_DATA_WAIT_MIN) return;

    this.jobs[key] = true;
    this.saveJobs();
    const overnight = this.takeDeferred('team').flatMap((d) => d.lines);
    if (weekly) await this.sendWeekly(today, overnight);
    else await this.sendDaily(today, overnight);
    await this.flushAdminDeferred();
    await this.openSlotsDigest(today);
    await this.renewals(today);
    await this.umugandaHeadsUp(today);
  }

  // Lines for the daily update's "Notes:" - notices from the Schedule Changes
  // tab, and notes about clients who have no session shown that day.
  notesFor(date, sections) {
    const iso = isoDate(date);
    const lines = [];
    for (const c of this.changes) {
      if (c.date !== iso) continue;
      if (c.kind === 'notice') lines.push(`${c.facility ? `${c.facility}: ` : ''}${c.reason}`);
      if (c.kind === 'note') {
        const shown = sections.some((sec) => sec.sessions.some((s) => s.client && sameClient(s.client, c.client) && s.change && s.change.kind === 'note'));
        if (!shown) lines.push(`${c.client}: ${c.reason}`);
      }
    }
    return lines;
  }

  async sendDaily(today, overnight = []) {
    const sections = this.facilities.map((f) => ({ name: f.name, sessions: this.sessionsFor(f, today) }));
    const dataOk = this.facilities.every((f) => this.dayKnown(f, today)) && this.healthy();
    const text = fmt.dailyUpdate(today, sections, { overnight, dataOk, notes: this.notesFor(today, sections), umuganda: this.umugandaOn(today) });
    await this.send('daily', text, recipients(this.cfg, 'summaries'));
  }

  async sendWeekly(today, overnight = []) {
    const days = dateWindow(today, 7);
    let dataOk = this.healthy();
    const sections = this.facilities.map((f) => ({
      name: f.name,
      days: days.map((d) => {
        if (!this.dayKnown(f, d)) dataOk = false;
        return { label: WEEKDAYS[d.dow].slice(0, 3), sessions: this.sessionsFor(f, dateOf(d)), umuganda: this.umugandaOn(d) };
      }),
    }));
    const range = `${shortDate(days[0].y, days[0].m, days[0].d)} - ${shortDate(days[6].y, days[6].m, days[6].d)}`;
    await this.send('weekly', fmt.weeklyOverview(range, sections, { overnight, dataOk }), recipients(this.cfg, 'summaries'));
  }

  // Alerts held overnight normally ride along with the morning update. If that
  // update is already done (or was missed), send them on their own.
  async flushDeferredIfDue() {
    if (!this.deferred.length) return;
    const n = this.now();
    if (this.inQuietHours(n)) return;
    const today = this.today(n);
    if (!this.morningDone(today, n)) return; // the morning update will carry them
    const team = this.takeDeferred('team');
    if (team.length) await this.send('overnight', fmt.overnightUpdates(team.flatMap((d) => d.lines)), recipients(this.cfg, 'team'));
    await this.flushAdminDeferred();
  }

  // Event days: after the morning update, the team and the admin hear about
  // tomorrow's events, with the teams to call. An event today that nobody was
  // told about (booked overnight, or the agent was off) is sent too, if some
  // team booked later that day still needs a call.
  async eventNotices() {
    if (!(this.settings.eventMinHours > 0)) return;
    const n = this.now();
    if (this.inQuietHours(n)) return;
    const today = this.today(n);
    if (!this.morningDone(today, n)) return;
    const cur = this.minuteOfDay(n);
    for (const [when, date] of [['today', today], ['tomorrow', addDays(today, 1)]]) {
      for (const f of this.facilities) {
        const key = `event|${isoDate(date)}|${f.ticqetEventId}`;
        if (this.jobs[key] || !this.dayKnown(f, date)) continue;
        const info = this.eventInfo(f, date);
        if (!info) continue;
        const teams = when === 'today' ? info.teams.filter((t) => t.startHour * 60 > cur) : info.teams;
        this.jobs[key] = this.stamp();
        this.saveJobs();
        if (when === 'today' && !teams.length) continue;
        await this.send('event-day', fmt.eventDay({ facility: f.name, date, when, ranges: info.ranges, teams }), this.eventRecipients());
      }
    }
  }

  // The Schedule Changes tab: email each ticked row to everyone once (again if
  // it is edited), and note on each row what the agent made of it.
  async announceChanges() {
    const status = new Map();
    const rows = this.cfg.changes || [];
    const n = this.now();
    const todayIso = isoDate(this.today(n));
    const channel = this.settings.channel;
    for (const c of rows) {
      if (c.problem) {
        status.set(c.row, `Problem: ${c.problem}`);
        continue;
      }
      if (c.date < todayIso) {
        status.set(c.row, 'Date has passed - no longer used.');
        continue;
      }
      if (c.date === todayIso && c.kind === 'moved' && c.endHour * 60 <= this.minuteOfDay(n)) {
        status.set(c.row, `Over: ${c.summary} That time has passed, so it is not emailed.`);
        continue;
      }
      let text = `OK: ${c.summary}`;
      if (!c.email) {
        text += ' Not emailed (tick Email everyone to send it).';
      } else {
        const sentKey = `chg|${c.date}|${c.key}|${channel}`;
        const idKey = `chgid|${c.date}|${c.id}|${channel}`;
        if (this.jobs[sentKey]) {
          text += ` ${this.jobs[sentKey].note}`;
        } else if (this.inQuietHours(n)) {
          text += ` Will be emailed at ${clockLabelMinutes(hhmmToMinutes(this.settings.quietHours.end))}, when quiet hours end.`;
        } else {
          const to = recipients(this.cfg, 'everyone');
          const updated = !!this.jobs[idKey] && this.jobs[idKey] !== c.key;
          const ok = to.length ? await this.send('schedule-change', fmt.scheduleChange(c, { updated }), to) : 0;
          if (!ok) {
            text += to.length ? ' Could not be sent - see the Status tab.' : ' Nobody to send it to yet - add emails on the Contacts tab.';
          } else {
            const at = new Date(this.nowMs());
            const when = `${shortDate(n.y, n.m, n.d)}, ${clockLabelMinutes(this.minuteOfDay(n))}`;
            const note = channel === 'preview'
              ? `Written to the Preview tab ${when} (Channel is Preview, so not really sent).`
              : `${channel === 'email' ? 'Emailed' : 'Sent'} to ${ok} ${ok === 1 ? 'person' : 'people'} on ${when}.`;
            this.jobs[sentKey] = { at: at.toISOString(), note };
            this.jobs[idKey] = c.key;
            this.saveJobs();
            text += ` ${note}`;
          }
        }
      }
      status.set(c.row, text);
    }
    this.changeStatus = status;
  }

  // Regular clients' usual hours that are OPEN on Ticqet in the coming days.
  // Each open slot is reported once.
  async openSlotsDigest(today) {
    const ahead = this.settings.openSlotCheckDaysAhead ?? 7;
    if (ahead <= 0) return;
    const items = [];
    for (const d of dateWindow(today, ahead)) {
      const date = dateOf(d);
      for (const f of this.facilities) {
        const known = this.bookingsOn(f, d);
        if (known === undefined) continue; // not read: do not guess
        const booked = new Set(known.flatMap((b) => b.slots));
        for (const lr of lapsedRegularHours(this.regulars, date, f.name, booked, this.changes)) {
          for (const r of slotsToRanges(lr.openHours)) {
            const key = `open|${isoDate(date)}|${f.ticqetEventId}|${lr.client}|${r.startHour}`;
            if (this.jobs[key]) continue;
            this.jobs[key] = true;
            items.push({ day: date, facility: f.name, client: lr.client, range: r });
          }
        }
      }
    }
    if (!items.length) return;
    this.saveJobs();
    await this.adminAlert('open-regular-slots', fmt.openRegularSlots(items));
  }

  // Remind the admin before regular arrangements' Until dates - all that are
  // due in one message.
  async renewals(today) {
    const before = this.settings.renewalReminderDaysBefore ?? 3;
    const groups = new Map(); // client + until -> rows
    for (const r of this.regulars) {
      if (!r.until) continue;
      const until = dayFromIso(r.until);
      const left = daysBetween(today, until);
      const key = `renewal|${r.client}|${r.until}`;
      if (left < 0 || left > before || this.jobs[key]) continue;
      if (!groups.has(key)) groups.set(key, { client: r.client, until, daysLeft: left, rows: [] });
      groups.get(key).rows.push(r);
    }
    if (!groups.size) return;
    const items = [];
    for (const [key, g] of groups) {
      this.jobs[key] = true;
      const places = new Map();
      for (const r of g.rows) {
        const range = compactRange(Math.floor(hhmmToMinutes(r.start) / 60), Math.floor(hhmmToMinutes(r.end) / 60));
        if (!places.has(r.facility)) places.set(r.facility, []);
        places.get(r.facility).push(`${r.day.slice(0, 3)} ${range}`);
      }
      const hours = [...places].map(([fac, list]) => `${fac || 'Facility'}: ${list.join(', ')}`).join('; ');
      items.push({ client: g.client, until: g.until, daysLeft: g.daysLeft, hours });
    }
    this.saveJobs();
    await this.adminAlert('renewal', fmt.renewals(items));
  }

  // Umuganda (last Saturday of the month): up to 3 days before, tell the admin
  // about sessions booked during it, once.
  async umugandaHeadsUp(today) {
    for (let i = 1; i <= UMUGANDA_NOTICE_DAYS; i++) {
      const date = addDays(today, i);
      const u = this.umugandaOn(date);
      if (!u) continue;
      const key = `umuganda|${isoDate(date)}`;
      if (this.jobs[key]) continue;
      const items = [];
      for (const f of this.facilities) {
        for (const s of this.sessionsFor(f, date)) {
          if (!s.off && !s.event && s.startHour * 60 < u.end && s.endHour * 60 > u.start) items.push({ ...s, facility: f.name });
        }
      }
      if (!items.length) continue;
      this.jobs[key] = this.stamp();
      this.saveJobs();
      await this.adminAlert('umuganda', fmt.umugandaHeadsUp(date, u, items));
    }
  }

  // Is Ticqet being read right now?
  healthy() {
    const thr = (this.settings.technicalAlertAfterMinutes ?? 15) * 60000;
    const now = this.nowMs();
    const last = this.source.lastContactAt ?? this.startedAt;
    const errAt = this.source.oldestErrorAt ?? null;
    return now - last <= thr && !(errAt && now - errAt > thr);
  }

  // Silence alarm: tell the admin if Ticqet cannot be read, so nobody mistakes
  // "no alerts" for "no bookings". And say when it is back.
  async checkSilence() {
    const ok = this.healthy();
    const now = this.nowMs();
    if (!ok && !this.silence.alerted) {
      if (this.inQuietHours()) return; // re-checked when quiet hours end
      const last = this.source.lastContactAt ?? this.startedAt;
      const errAt = this.source.oldestErrorAt ?? now;
      const mins = Math.max(1, Math.round((now - Math.min(last, errAt)) / 60000));
      this.silence = { alerted: true, since: Math.min(last, errAt) };
      const failing = this.source.failing || [];
      const what = failing.length && failing.length < this.facilities.length ? joinNames(failing) : '';
      log.error(`[engine] Ticqet unreadable for ${mins} min - alerting admin`);
      await this.send('technical', fmt.technicalAlert(mins, what), recipients(this.cfg, 'admin'));
    } else if (ok && this.silence.alerted) {
      const mins = Math.max(1, Math.round((now - this.silence.since) / 60000));
      this.silence = { alerted: false, since: null };
      log.info('[engine] Ticqet readable again');
      await this.adminAlert('technical-recovered', fmt.technicalRecovered(mins));
    }
  }

  // One welcome per channel, once the agent has actually read Ticqet and there
  // is someone to welcome (contacts may be added after the agent starts).
  async maybeWelcome() {
    const channel = this.settings.channel;
    const key = `welcome|${channel}`;
    if (this.jobs[key] || this.settings.sendWelcome === false) return;
    if (!this.dayKnown(this.facilities[0], this.today())) return;
    if (this.inQuietHours()) return;
    const everyone = recipients(this.cfg, 'everyone');
    if (!everyone.length) return;
    this.jobs[key] = this.stamp();
    this.jobs.watching = this.facilities.map((f) => f.ticqetEventId);
    this.saveJobs();
    await this.send('welcome', fmt.welcome({
      channelName: channelName(channel),
      facilities: this.facilities.map((f) => f.name),
      dailyTime: clockLabelMinutes(hhmmToMinutes(this.settings.dailyUpdateTime)),
      adminName: adminName(this.cfg),
    }), everyone);
  }

  // Facilities added to an agent that is already running: tell everyone once,
  // after their bookings are read (and noted quietly, not announced).
  async maybeAnnounceFacilities() {
    const ids = this.facilities.map((f) => f.ticqetEventId);
    if (this.jobs.watching === null || this.jobs.watching === undefined) {
      this.jobs.watching = ids; // a new install: the welcome names them all
      this.saveJobs();
      return;
    }
    const kept = this.jobs.watching.filter((id) => ids.includes(id));
    if (kept.length !== this.jobs.watching.length) {
      this.jobs.watching = kept;
      this.saveJobs();
    }
    const added = this.facilities.filter((f) => !kept.includes(f.ticqetEventId));
    if (!added.length) return;
    if (!this.jobs[`welcome|${this.settings.channel}`] && this.settings.sendWelcome !== false) return; // the welcome will name them
    const today = this.today();
    if (added.some((f) => !this.dayKnown(f, today)) || this.inQuietHours()) return;
    const everyone = recipients(this.cfg, 'everyone');
    if (!everyone.length) return;
    this.jobs.watching = [...kept, ...added.map((f) => f.ticqetEventId)];
    this.saveJobs();
    await this.send('facilities-added', fmt.facilitiesAdded(added.map((f) => f.name)), everyone);
  }

  // Server double-check of today plus one other date, rotating through the window.
  async probe() {
    if (!this.source.probe || !this.watchedLabels.length) return;
    const labels = this.watchedLabels;
    this.probeCursor = labels.length > 1 ? (this.probeCursor % (labels.length - 1)) + 1 : 0;
    await this.source.probe([...new Set([labels[0], labels[this.probeCursor]])]);
  }

  // Events in the coming days, for the Status tab: "Sat 10 Oct: Multi-Purpose Court 7AM-12AM".
  upcomingEvents(days = 14) {
    const out = [];
    if (!(this.settings.eventMinHours > 0)) return out;
    for (const d of dateWindow(this.today(), days)) {
      for (const f of this.facilities) {
        const list = (this.bookingsOn(f, d) || []).filter((b) => this.isEventBooking(b));
        if (!list.length) continue;
        const ranges = slotsToRanges(list.flatMap((b) => b.slots));
        out.push(`${shortDate(d.y, d.m, d.d)}: ${f.name} ${ranges.map((r) => compactRange(r.startHour, r.endHour)).join(' + ')}`);
      }
    }
    return out;
  }

  // Once a day, forget reminder flags and job marks older than two weeks.
  prune() {
    const today = this.today();
    const iso = isoDate(today);
    if (this.jobs.lastPrune === iso) return;
    const cutoff = (days) => new Date(Date.UTC(today.y, today.m - 1, today.d - days)).toISOString().slice(0, 10);
    const remCut = cutoff(7);
    for (const k of [...this.reminders]) if ((k.split('|')[1] || '') < remCut) this.reminders.delete(k);
    const jobCut = cutoff(14);
    for (const k of Object.keys(this.jobs)) {
      const m = k.match(/^(?:morning|sent|capNotice|alertsPaused|open|late|event|chg|chgid|umuganda)\|(\d{4}-\d{2}-\d{2})/);
      if (m && m[1] < jobCut) delete this.jobs[k];
    }
    this.jobs.lastPrune = iso;
    store.saveReminders(this.reminders);
    this.saveJobs();
  }

  // A one-line status for the log.
  status() {
    const last = this.source.lastContactAt;
    const known = this.facilities.reduce((n, f) => n + Object.keys(this.snapshot.days[f.ticqetEventId] || {}).length, 0);
    const sent = this.jobs[`sent|${isoDate(this.today())}`] || 0;
    const ago = last ? `${Math.round((this.nowMs() - last) / 1000)}s ago` : 'never';
    return `watching ${this.facilities.length} facilities x ${this.watchedLabels.length} days (${known} loaded), Ticqet last answered ${ago}, ${sent} messages sent today, ${this.deferred.length} held`;
  }
}
