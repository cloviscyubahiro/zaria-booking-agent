// The brain of the agent. It is deliberately I/O-light: it is handed a "source"
// (live Ticqet data), a "sender", a "clock" and the config, which makes the whole
// thing testable offline with fakes.
//
// Two entry points are called on timers by src/index.js:
//   tick()        every ~15 s : notice booking changes and alert on them
//   minuteTick()  every minute: reminders, morning updates, held alerts, silence alarm
//
// Who gets what (agreed with Zaria):
//   team        new / cancelled / changed bookings         (held during quiet hours)
//   attendants  reminders before sessions, last-minute bookings (never held)
//   summaries   daily update, or the weekly overview on its day
//   admin       possible double-bookings, open regular slots, renewals,
//               technical alarms, anything unusual

import { log, mask } from './logger.js';
import * as store from './store.js';
import * as fmt from './formatter.js';
import { bookingFromDoc, diffDay, fingerprint, pairReissues, slotsToRanges } from './bookings.js';
import {
  nowInZone, dateWindow, ticqetLabel, hhmmToMinutes, weekdayOf, WEEKDAYS,
  isoDate, dayFromIso, daysBetween, shortDate, clockLabelMinutes,
} from './time.js';
import { matchRegular, regularsOverlapping, lapsedRegularHours, buildSessions } from './regulars.js';
import { recipients, adminName, channelName } from './config.js';

// Admin messages are never blocked by the daily message cap.
const ADMIN_KINDS = new Set([
  'regular-slot-check', 'mass-removal', 'open-regular-slots', 'renewal',
  'technical', 'technical-recovered', 'send-cap', 'admin-overnight',
]);
// A reminder may go out up to 5 min late (e.g. after a restart). When the agent
// only runs every few minutes, settings.reminderToleranceMinutes widens this.
const REMINDER_TOLERANCE_MIN = 5;
const MORNING_GRACE_MIN = 180; // send the morning update up to 3 h late, never in the evening
const MORNING_DATA_WAIT_MIN = 15; // wait this long for fresh Ticqet data before the morning update

const dateOf = (d) => ({ y: d.y, m: d.m, d: d.d, label: d.label });
const sameDay = (a, b) => a.y === b.y && a.m === b.m && a.d === b.d;

export class Engine {
  // source: { get(label) -> [record]|undefined, watch?(labels), probe?(labels),
  //           lastContactAt, oldestErrorAt }
  // sender: { send({ to, text, kind }) -> { ok } }
  // clock:  { now() -> Date }
  constructor({ cfg, source, sender, clock }) {
    this.cfg = cfg;
    this.source = source;
    this.sender = sender;
    this.clock = clock || { now: () => new Date() };

    this.snapshot = store.loadSnapshot(); // bookings already processed, per date
    this.reminders = store.loadReminders(); // reminder keys already sent
    this.deferred = store.loadDeferred(); // alerts held during quiet hours
    this.jobs = store.loadJobMarks(); // one-off jobs done + daily counters

    this.pending = new Map(); // label -> { fp, since }: changes waiting to settle
    this.watchedKey = '';
    this.watchedLabels = [];
    this.startedAt = this.nowMs();
    this.silence = { alerted: false, since: null };
    this.probeCursor = 0;
  }

  // ---------- basics ----------
  get settings() { return this.cfg.settings; }
  get regulars() { return this.cfg.regulars; }
  get court() { return this.settings.court?.name || 'Court'; }
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

  // ======================================================================
  // 1) Booking changes
  // ======================================================================

  async tick() {
    const n = this.now();
    const window = dateWindow(this.today(n), this.settings.watch.windowDays);
    const labels = window.map((d) => d.label);

    // Keep the watched dates in step with the calendar (rolls over at midnight).
    const key = labels.join('|');
    if (key !== this.watchedKey) {
      this.watchedKey = key;
      this.watchedLabels = labels;
      if (this.source.watch) this.source.watch(labels);
      const keep = new Set(labels);
      for (const label of Object.keys(this.snapshot.days)) if (!keep.has(label)) delete this.snapshot.days[label];
      for (const label of [...this.pending.keys()]) if (!keep.has(label)) this.pending.delete(label);
      store.saveSnapshot(this.snapshot);
    }

    const settleMs = (this.settings.watch.settleSeconds ?? 60) * 1000;
    const nowMs = this.nowMs();
    const events = [];
    let dirty = false;

    for (const day of window) {
      const raw = this.source.get(day.label);
      if (raw === undefined) continue; // not read from Ticqet yet
      const date = dateOf(day);
      const current = raw.map((r) => bookingFromDoc(r, date));
      const known = this.snapshot.days[day.label];

      // First time we see this date (first run, or the date just entered the
      // watch window): record what is there silently. These bookings already
      // existed before we were watching, so they are not "new".
      if (known === undefined) {
        this.snapshot.days[day.label] = current;
        dirty = true;
        for (const b of current) {
          store.appendBookingLog({ event: 'first-seen', at: this.stamp(), date: day.label, id: b.id, slots: b.slots });
        }
        continue;
      }

      const fpNow = fingerprint(current);
      if (fpNow === fingerprint(known)) {
        this.pending.delete(day.label);
        continue;
      }
      // Something changed. Wait until it has been stable for `settleSeconds`
      // so a record that Ticqet rewrites (delete + create) causes no alert.
      const p = this.pending.get(day.label);
      if (!p || p.fp !== fpNow) {
        this.pending.set(day.label, { fp: fpNow, since: nowMs });
        if (settleMs > 0) continue;
      } else if (nowMs - p.since < settleMs) {
        continue;
      }
      this.pending.delete(day.label);

      const diff = diffDay(known, current);
      const { added, removed, reissued } = pairReissues(diff.added, diff.removed);
      for (const r of reissued) {
        log.info(`[engine] ${day.label}: record re-issued (${r.before.id} -> ${r.after.id}) with the same hours - not alerted`);
      }
      for (const b of added) events.push({ type: 'added', booking: b });
      for (const b of removed) events.push({ type: 'removed', booking: b });
      for (const c of diff.changed) events.push({ type: 'changed', before: c.before, after: c.after });
      this.snapshot.days[day.label] = current;
      dirty = true;
    }

    if (dirty) store.saveSnapshot(this.snapshot);
    if (events.length) await this.dispatch(events);
    await this.maybeWelcome();
  }

  // Decide who hears about a batch of changes, and how.
  async dispatch(events) {
    const n = this.now();
    const teamAdds = [];
    const removals = [];
    const changes = [];
    const checks = []; // for the admin: bookings in a regular client's slot

    for (const ev of events) {
      if (ev.type === 'changed') {
        store.appendBookingLog({ event: 'changed', at: this.stamp(), date: ev.after.date.label, id: ev.after.id, from: ev.before.slots, to: ev.after.slots });
        if (!this.isPast(ev.after, n)) changes.push(ev);
        continue;
      }
      const b = ev.booking;
      const regular = matchRegular(b, this.regulars, b.date, this.court);
      store.appendBookingLog({ event: ev.type, at: this.stamp(), date: b.date.label, id: b.id, slots: b.slots, regular });
      if (this.isPast(b, n)) {
        log.info(`[engine] ${ev.type} on ${b.date.label} is for a time already past - not alerted`);
        continue;
      }
      if (ev.type === 'removed') {
        removals.push({ booking: b, regular });
      } else if (regular) {
        // Fully inside a regular's usual hours: most likely Zaria blocking the
        // slot for that client - but it could be a customer booking a regular's
        // hour that was left open. Not news for the team; the admin checks it.
        log.info(`[engine] booking in ${regular}'s usual slot on ${b.date.label} - asking admin to check`);
        checks.push({ booking: b, client: regular, inside: true });
      } else {
        teamAdds.push(b);
        const overlap = regularsOverlapping(b, this.regulars, b.date, this.court);
        if (overlap.length) checks.push({ booking: b, client: overlap[0].client, inside: false });
      }
    }

    const max = this.settings.maxAlertsAtOnce ?? 5;

    // New bookings: one message each, or one summary if many arrive together.
    if (teamAdds.length > max) {
      log.warn(`[engine] ${teamAdds.length} new bookings at once - sending one summary`);
      await this.teamAlert('bookings-digest', fmt.bookingsDigest(teamAdds, this.court), teamAdds.map((b) => fmt.overnightLine('new', b)));
      for (const b of teamAdds) if (this.isLastMinute(b, n)) await this.lastMinuteToAttendants(b, n);
    } else {
      for (const b of teamAdds) await this.announceNew(b, n);
    }

    // Cancellations: many vanishing at once is far more likely a Ticqet glitch
    // or data change than real cancellations - tell the admin, not the team.
    if (removals.length > max) {
      log.warn(`[engine] ${removals.length} bookings vanished at once - admin only`);
      await this.adminAlert('mass-removal', fmt.massRemoval(removals.map((r) => r.booking), this.court));
    } else {
      for (const { booking, regular } of removals) {
        await this.teamAlert('cancelled', fmt.cancelledBooking(booking, this.court, regular), [fmt.overnightLine('cancelled', booking)]);
      }
    }

    for (const c of changes) {
      await this.teamAlert('changed', fmt.changedBooking(c.before, c.after, this.court), [fmt.overnightLine('changed', c.before, c.after)]);
    }

    if (checks.length) await this.adminAlert('regular-slot-check', fmt.regularSlotCheck(checks, this.court));
  }

  async announceNew(b, n) {
    const text = fmt.newBooking(b, this.court);
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
    await this.send('last-minute', fmt.lastMinute({ startHour: r.startHour, endHour: r.endHour, client: null }, this.court, minutesToStart), recipients(this.cfg, 'attendants'));
    const iso = isoDate(this.today(n));
    for (const mb of this.settings.attendantReminderMinutes) this.reminders.add(`rem|${iso}|${r.startHour}|${mb}`);
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
  // others. A daily cap protects against runaway costs if something goes wrong.
  async send(kind, text, to) {
    if (!to.length) {
      log.warn(`[engine] nobody is set to receive "${kind}" messages`);
      return 0;
    }
    const day = isoDate(this.today());
    const countKey = `sent|${day}`;
    const cap = this.settings.maxMessagesPerDay ?? 300;
    let ok = 0;
    for (const phone of to) {
      if (!ADMIN_KINDS.has(kind) && (this.jobs[countKey] || 0) >= cap) {
        await this.capReached(day, cap);
        break;
      }
      this.jobs[countKey] = (this.jobs[countKey] || 0) + 1;
      try {
        const res = await this.sender.send({ to: phone, text, kind });
        if (res && res.ok === false) log.warn(`[send] ${kind} to ${mask(phone)} failed${res.error ? `: ${res.error}` : ''}`);
        else ok += 1;
      } catch (err) {
        log.error(`[send] ${kind} to ${mask(phone)} failed: ${err.message}`);
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
  // 3) Every minute: reminders, morning jobs, held alerts, silence alarm
  // ======================================================================

  async minuteTick() {
    await this.tickReminders();
    await this.morningJobs();
    await this.flushDeferredIfDue();
    await this.checkSilence();
    this.prune();
  }

  // Reminders before every session today (Ticqet and regular). The first one
  // (e.g. 60 min) goes to the "Reminder 1" people, later ones to "Reminder 2".
  async tickReminders() {
    const mins = this.settings.attendantReminderMinutes;
    if (!mins.length) return;
    const n = this.now();
    const today = this.today(n);
    const iso = isoDate(today);
    const cur = this.minuteOfDay(n);
    const readyGap = mins.length > 1 ? mins[mins.length - 1] : 0; // ready by the last reminder
    const tolerance = this.settings.reminderToleranceMinutes ?? REMINDER_TOLERANCE_MIN;
    const sessions = buildSessions(this.snapshot.days[today.label] || [], this.regulars, today, this.court);

    for (const s of sessions) {
      const start = s.startHour * 60;
      if (cur >= start) continue;
      for (let i = 0; i < mins.length; i++) {
        const fireAt = start - mins[i];
        const until = Math.min(fireAt + tolerance, i + 1 < mins.length ? start - mins[i + 1] : start);
        const key = `rem|${iso}|${s.startHour}|${mins[i]}`;
        if (this.reminders.has(key) || cur < fireAt || cur >= until) continue;
        this.reminders.add(key);
        store.saveReminders(this.reminders);
        await this.send('reminder', fmt.reminder(s, this.court, mins[i], i === 0, start - readyGap), recipients(this.cfg, i === 0 ? 'reminder1' : 'reminder2'));
      }
    }
  }

  // The morning message (daily update, or weekly overview on its day), then the
  // admin's morning notes: held checks, open regular slots, renewals.
  async morningJobs() {
    const n = this.now();
    const today = this.today(n);
    const key = `morning|${isoDate(today)}`;
    if (this.jobs[key]) return;
    const { weekly, at } = this.morningPlan(today);
    const cur = this.minuteOfDay(n);
    if (cur < at || cur >= at + MORNING_GRACE_MIN) return;
    // Just restarted? Give the live connection a few minutes to load today.
    if (this.snapshot.days[today.label] === undefined && cur < at + MORNING_DATA_WAIT_MIN) return;

    this.jobs[key] = true;
    this.saveJobs();
    const overnight = this.takeDeferred('team').flatMap((d) => d.lines);
    if (weekly) await this.sendWeekly(today, overnight);
    else await this.sendDaily(today, overnight);
    await this.flushAdminDeferred();
    await this.openSlotsDigest(today);
    await this.renewals(today);
  }

  async sendDaily(today, overnight = []) {
    const known = this.snapshot.days[today.label];
    const sessions = buildSessions(known || [], this.regulars, today, this.court);
    const dataOk = known !== undefined && this.healthy();
    await this.send('daily', fmt.dailyUpdate(today, sessions, this.court, overnight, dataOk), recipients(this.cfg, 'summaries'));
  }

  async sendWeekly(today, overnight = []) {
    const days = dateWindow(today, 7);
    let dataOk = this.healthy();
    const list = days.map((d) => {
      const known = this.snapshot.days[d.label];
      if (known === undefined) dataOk = false;
      return { label: WEEKDAYS[d.dow].slice(0, 3), sessions: buildSessions(known || [], this.regulars, dateOf(d), this.court) };
    });
    const range = `${shortDate(days[0].y, days[0].m, days[0].d)} - ${shortDate(days[6].y, days[6].m, days[6].d)}`;
    await this.send('weekly', fmt.weeklyOverview(range, list, this.court, overnight, dataOk), recipients(this.cfg, 'summaries'));
  }

  // Alerts held overnight normally ride along with the morning update. If that
  // update is already done (or was missed), send them on their own.
  async flushDeferredIfDue() {
    if (!this.deferred.length) return;
    const n = this.now();
    if (this.inQuietHours(n)) return;
    const today = this.today(n);
    const { at } = this.morningPlan(today);
    const done = this.jobs[`morning|${isoDate(today)}`] || this.minuteOfDay(n) >= at + MORNING_GRACE_MIN;
    if (!done) return; // the morning update will carry them
    const team = this.takeDeferred('team');
    if (team.length) await this.send('overnight', fmt.overnightUpdates(team.flatMap((d) => d.lines), this.court), recipients(this.cfg, 'team'));
    await this.flushAdminDeferred();
  }

  // Regular clients' usual hours that are OPEN on Ticqet in the coming days.
  // Each open slot is reported once.
  async openSlotsDigest(today) {
    const ahead = this.settings.openSlotCheckDaysAhead ?? 7;
    if (ahead <= 0) return;
    const items = [];
    for (const d of dateWindow(today, ahead)) {
      const known = this.snapshot.days[d.label];
      if (known === undefined) continue; // not read: do not guess
      const booked = new Set(known.flatMap((b) => b.slots));
      const date = dateOf(d);
      for (const lr of lapsedRegularHours(this.regulars, date, this.court, booked)) {
        for (const r of slotsToRanges(lr.openHours)) {
          const key = `open|${isoDate(date)}|${lr.client}|${r.startHour}`;
          if (this.jobs[key]) continue;
          this.jobs[key] = true;
          items.push({ day: date, client: lr.client, range: r });
        }
      }
    }
    if (!items.length) return;
    this.saveJobs();
    await this.adminAlert('open-regular-slots', fmt.openRegularSlots(items, this.court));
  }

  // Remind the admin before a regular arrangement's Until date.
  async renewals(today) {
    const before = this.settings.renewalReminderDaysBefore ?? 3;
    for (const r of this.regulars) {
      if (!r.until) continue;
      const until = dayFromIso(r.until);
      const left = daysBetween(today, until);
      const key = `renewal|${r.client}|${r.until}`;
      if (left < 0 || left > before || this.jobs[key]) continue;
      this.jobs[key] = true;
      this.saveJobs();
      await this.adminAlert('renewal', fmt.renewalReminder(r.client, until, left));
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
      log.error(`[engine] Ticqet unreadable for ${mins} min - alerting admin`);
      await this.send('technical', fmt.technicalAlert(mins), recipients(this.cfg, 'admin'));
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
    if (this.snapshot.days[this.today().label] === undefined) return;
    if (this.inQuietHours()) return;
    const everyone = recipients(this.cfg, 'everyone');
    if (!everyone.length) return;
    this.jobs[key] = this.stamp();
    this.saveJobs();
    await this.send('welcome', fmt.welcome({
      channelName: channelName(channel),
      courtName: this.court,
      dailyTime: clockLabelMinutes(hhmmToMinutes(this.settings.dailyUpdateTime)),
      adminName: adminName(this.cfg),
    }), everyone);
  }

  // Server double-check of today plus one other date, rotating through the window.
  async probe() {
    if (!this.source.probe || !this.watchedLabels.length) return;
    const labels = this.watchedLabels;
    this.probeCursor = labels.length > 1 ? (this.probeCursor % (labels.length - 1)) + 1 : 0;
    await this.source.probe([...new Set([labels[0], labels[this.probeCursor]])]);
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
      const m = k.match(/^(?:morning|sent|capNotice|open)\|(\d{4}-\d{2}-\d{2})/);
      if (m && m[1] < jobCut) delete this.jobs[k];
    }
    this.jobs.lastPrune = iso;
    store.saveReminders(this.reminders);
    this.saveJobs();
  }

  // A one-line status for the log.
  status() {
    const last = this.source.lastContactAt;
    const known = Object.keys(this.snapshot.days).length;
    const sent = this.jobs[`sent|${isoDate(this.today())}`] || 0;
    const ago = last ? `${Math.round((this.nowMs() - last) / 1000)}s ago` : 'never';
    return `watching ${this.watchedLabels.length} days (${known} loaded), Ticqet last answered ${ago}, ${sent} messages sent today, ${this.deferred.length} held`;
  }
}
