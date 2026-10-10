// Regular clients booked DIRECTLY with Zaria (monthly / annual), not through
// Ticqet online. The agent uses this list to:
//   - not announce a regular's own hours as if they were a fresh online booking,
//   - still include regulars in daily/weekly summaries and attendant reminders,
//   - warn if a regular's hour is left open on Ticqet (a lapse someone could book
//     over), or is genuinely double-booked.
//
// One-off changes from the "Schedule Changes" tab (changes.js) adjust a date:
// a regular moved to other hours (car-free day), or not playing (Umuganda).

import { WEEKDAYS, hhmmToMinutes, isoDate } from './time.js';
import { sameName } from './facilities.js';

// Is a regular arrangement active on a given calendar date?
// `from`/`until` are "YYYY-MM-DD" strings or null (null = open-ended).
function activeOn(regular, y, m, d) {
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  if (regular.from && iso < regular.from) return false;
  if (regular.until && iso > regular.until) return false;
  return true;
}

// The regular arrangements for a date (right weekday, active, at the given
// facility), as hour windows - before any schedule change.
export function baseRegularsForDate(regulars, date, facilityName) {
  const wanted = WEEKDAYS[new Date(Date.UTC(date.y, date.m - 1, date.d)).getUTCDay()];
  return regulars
    .filter((r) => r.day === wanted)
    .filter((r) => !facilityName || !r.facility || sameName(r.facility, facilityName))
    .filter((r) => activeOn(r, date.y, date.m, date.d))
    .map((r) => ({
      client: r.client,
      startHour: Math.floor(hhmmToMinutes(r.start) / 60),
      endHour: Math.floor(hhmmToMinutes(r.end) / 60),
      until: r.until || null,
      type: r.type || null,
    }));
}

const sameClient = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

// A date's plan for one facility, with the schedule changes for that date:
//   windows: where regular clients play  [{ client, startHour, endHour, change? }]
//   off:     usual windows given up that date (moved away or not playing)
//            [{ client, startHour, endHour, change }]
// `change` = { kind: 'moved'|'cancelled'|'note', reason, from?, to? }.
export function planForDate(regulars, date, facilityName, changes = []) {
  const base = baseRegularsForDate(regulars, date, facilityName);
  const iso = isoDate(date);
  let windows = base.map((w) => ({ ...w, change: null }));
  const off = [];
  for (const c of changes) {
    if (c.problem || c.date !== iso || !c.client) continue;
    if (c.facility && facilityName && !sameName(c.facility, facilityName)) continue;
    const mine = windows.filter((w) => sameClient(w.client, c.client));
    if (c.kind === 'note') {
      for (const w of mine) if (!w.change) w.change = { kind: 'note', reason: c.reason };
      continue;
    }
    if (c.kind !== 'moved' && c.kind !== 'cancelled') continue;
    windows = windows.filter((w) => !mine.includes(w));
    const to = c.kind === 'moved' ? { startHour: c.startHour, endHour: c.endHour } : null;
    for (const w of mine) off.push({ client: w.client, startHour: w.startHour, endHour: w.endHour, change: { kind: c.kind, reason: c.reason, to } });
    // The new hours count here if the client usually plays here that day, or
    // if the change names this facility (an extra session).
    if (c.kind === 'moved' && (mine.length || (c.facility && facilityName))) {
      windows.push({
        client: mine.length ? mine[0].client : c.client,
        startHour: c.startHour,
        endHour: c.endHour,
        until: mine.length ? mine[0].until : null,
        type: mine.length ? mine[0].type : null,
        change: { kind: 'moved', reason: c.reason, from: mine.map((w) => ({ startHour: w.startHour, endHour: w.endHour })) },
      });
    }
  }
  windows.sort((a, b) => a.startHour - b.startHour);
  return { windows, off };
}

// Where regulars play on a date (schedule changes applied).
export function regularsForDate(regulars, date, facilityName, changes = []) {
  return planForDate(regulars, date, facilityName, changes).windows;
}

// The window (if any) that holds every hour of a booking.
export function windowHolding(booking, windows) {
  if (!booking.slots.length) return null;
  return windows.find((w) => booking.slots.every((h) => h >= w.startHour && h < w.endHour)) || null;
}

// The set of hour-slots covered by regulars on a date, e.g. Set{17,18,19,20}.
export function regularSlotSet(regulars, date, facilityName, changes = []) {
  const set = new Set();
  for (const r of regularsForDate(regulars, date, facilityName, changes)) {
    for (let h = r.startHour; h < r.endHour; h++) set.add(h);
  }
  return set;
}

// Which regular does a given set of slots match, if any? A booking counts as a
// regular's own block when every one of its slots falls inside that regular's
// hours. Returns the client name, or null if it looks like an ordinary booking.
export function matchRegular(booking, regulars, date, facilityName, changes = []) {
  return windowHolding(booking, regularsForDate(regulars, date, facilityName, changes))?.client || null;
}

// Regular slots that are NOT booked on Ticqet for a date — i.e. the regular's
// hour is showing as available. That is a lapse/clash worth flagging: someone
// could book over it, or the arrangement quietly ended. `bookedSlots` is the
// Set of hour-slots currently taken on Ticqet for that date.
export function lapsedRegularHours(regulars, date, facilityName, bookedSlots, changes = []) {
  const out = [];
  for (const r of regularsForDate(regulars, date, facilityName, changes)) {
    const openHours = [];
    for (let h = r.startHour; h < r.endHour; h++) {
      if (!bookedSlots.has(h)) openHours.push(h);
    }
    if (openHours.length) {
      out.push({ client: r.client, startHour: r.startHour, endHour: r.endHour, openHours, change: r.change || null });
    }
  }
  return out;
}

// Regular arrangements whose hours intersect a booking's hours on that date.
// Used to spot possible double-bookings: a Ticqet booking that lands (fully or
// partly) in a regular client's usual slot.
export function regularsOverlapping(booking, regulars, date, facilityName, changes = []) {
  return regularsForDate(regulars, date, facilityName, changes).filter((r) =>
    booking.slots.some((h) => h >= r.startHour && h < r.endHour),
  );
}

// Consecutive hours -> [{ startHour, endHour }].
function runs(hours) {
  const out = [];
  for (const h of hours) {
    const last = out[out.length - 1];
    if (last && h === last.endHour) last.endHour = h + 1;
    else out.push({ startHour: h, endHour: h + 1 });
  }
  return out;
}

// Everything that happens at a facility on a date, in time order:
//   - every Ticqet booking: an event or event setup when one booking is at
//     least `eventMinHours` long; labelled with the regular client's name when
//     it sits inside that client's hours; otherwise client = null;
//   - regular clients' hours that are NOT on Ticqet (the regular still plays);
//   - regulars not playing that date (schedule change), marked `off`.
// A Ticqet booking left in hours a regular gave up that date is marked `off`
// too (no reminders) - unless its id is in `exempt` (booked after the change,
// so a real booking).
// Adjacent pieces for the same regular client are merged, so a regular's
// 5-7 PM block counts as one session even if Ticqet stores it as two records.
// Returns [{ startHour, endHour, client, event?, off?, change? }].
export function buildSessions(bookings, regulars, date, facilityName, opts = {}) {
  const { changes = [], eventMinHours = 0, exempt = new Set() } = opts;
  const { windows, off } = planForDate(regulars, date, facilityName, changes);
  const sessions = [];
  const bookedSlots = new Set();
  for (const b of bookings) for (const s of b.slots) bookedSlots.add(s);

  const withChange = (change) => (change ? { change } : {});
  for (const b of bookings) {
    const piece = (extra) => b.ranges.forEach((r) => sessions.push({ startHour: r.startHour, endHour: r.endHour, client: null, ...extra }));
    if (eventMinHours > 0 && b.hours >= eventMinHours) {
      piece({ event: true });
      continue;
    }
    const w = windowHolding(b, windows);
    if (w) {
      piece({ client: w.client, ...withChange(w.change) });
      continue;
    }
    const o = exempt.has(b.id) ? null : windowHolding(b, off);
    if (o) piece({ client: o.client, off: true, change: o.change });
    else piece({});
  }
  for (const w of windows) {
    const open = [];
    for (let h = w.startHour; h < w.endHour; h++) if (!bookedSlots.has(h)) open.push(h);
    for (const r of runs(open)) sessions.push({ ...r, client: w.client, ...withChange(w.change) });
  }
  // A regular not playing: shown, without reminders, so nobody waits for them.
  for (const o of off) {
    if (o.change.kind !== 'cancelled') continue;
    const open = [];
    for (let h = o.startHour; h < o.endHour; h++) if (!bookedSlots.has(h)) open.push(h);
    for (const r of runs(open)) sessions.push({ ...r, client: o.client, off: true, change: o.change });
  }
  sessions.sort((a, b) => a.startHour - b.startHour || a.endHour - b.endHour);

  const merged = [];
  for (const s of sessions) {
    const last = merged[merged.length - 1];
    if (last && s.client && last.client === s.client && !!last.off === !!s.off && !last.event && !s.event
      && last.change === s.change && s.startHour <= last.endHour) {
      last.endHour = Math.max(last.endHour, s.endHour);
    } else {
      merged.push({ ...s });
    }
  }
  return merged;
}
