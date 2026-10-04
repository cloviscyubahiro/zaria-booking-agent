// Regular clients booked DIRECTLY with Zaria (monthly / annual), not through
// Ticqet online. The agent uses this list to:
//   - not announce a regular's own hours as if they were a fresh online booking,
//   - still include regulars in daily/weekly summaries and attendant reminders,
//   - warn if a regular's hour is left open on Ticqet (a lapse someone could book
//     over), or is genuinely double-booked.

import { WEEKDAYS, hhmmToMinutes } from './time.js';

// Is a regular arrangement active on a given calendar date?
// `from`/`until` are "YYYY-MM-DD" strings or null (null = open-ended).
function activeOn(regular, y, m, d) {
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  if (regular.from && iso < regular.from) return false;
  if (regular.until && iso > regular.until) return false;
  return true;
}

// All regular arrangements that apply to a given date (right weekday, active, and
// for the given facility). Returns each with its start/end as hour integers.
export function regularsForDate(regulars, date, facilityName) {
  const wanted = WEEKDAYS[new Date(Date.UTC(date.y, date.m - 1, date.d)).getUTCDay()];
  return regulars
    .filter((r) => r.day === wanted)
    .filter((r) => !facilityName || !r.facility || r.facility === facilityName)
    .filter((r) => activeOn(r, date.y, date.m, date.d))
    .map((r) => ({
      client: r.client,
      startHour: Math.floor(hhmmToMinutes(r.start) / 60),
      endHour: Math.floor(hhmmToMinutes(r.end) / 60),
      until: r.until || null,
      type: r.type || null,
    }));
}

// The set of hour-slots covered by regulars on a date, e.g. Set{17,18,19,20}.
export function regularSlotSet(regulars, date, facilityName) {
  const set = new Set();
  for (const r of regularsForDate(regulars, date, facilityName)) {
    for (let h = r.startHour; h < r.endHour; h++) set.add(h);
  }
  return set;
}

// Which regular does a given set of slots match, if any? A booking counts as a
// regular's own block when every one of its slots falls inside that regular's
// hours. Returns the client name, or null if it looks like an ordinary booking.
export function matchRegular(booking, regulars, date, facilityName) {
  for (const r of regularsForDate(regulars, date, facilityName)) {
    const inside = booking.slots.every((h) => h >= r.startHour && h < r.endHour);
    if (inside && booking.slots.length) return r.client;
  }
  return null;
}

// Regular slots that are NOT booked on Ticqet for a date — i.e. the regular's
// hour is showing as available. That is a lapse/clash worth flagging: someone
// could book over it, or the arrangement quietly ended. `bookedSlots` is the
// Set of hour-slots currently taken on Ticqet for that date.
export function lapsedRegularHours(regulars, date, facilityName, bookedSlots) {
  const out = [];
  for (const r of regularsForDate(regulars, date, facilityName)) {
    const openHours = [];
    for (let h = r.startHour; h < r.endHour; h++) {
      if (!bookedSlots.has(h)) openHours.push(h);
    }
    if (openHours.length) {
      out.push({ client: r.client, startHour: r.startHour, endHour: r.endHour, openHours });
    }
  }
  return out;
}

// Regular arrangements whose hours intersect a booking's hours on that date.
// Used to spot possible double-bookings: a Ticqet booking that lands (fully or
// partly) in a regular client's usual slot.
export function regularsOverlapping(booking, regulars, date, facilityName) {
  return regularsForDate(regulars, date, facilityName).filter((r) =>
    booking.slots.some((h) => h >= r.startHour && h < r.endHour),
  );
}

// Everything that happens on the court on a date, in time order:
//   - every Ticqet booking (labelled with the regular client's name when it sits
//     inside that client's usual hours, otherwise client = null), plus
//   - regular clients' hours that are NOT on Ticqet (the regular still plays).
// Adjacent pieces for the same regular client are merged, so a regular's
// 5-7 PM block counts as one session even if Ticqet stores it as two records.
// Returns [{ startHour, endHour, client }].
export function buildSessions(bookings, regulars, date, facilityName) {
  const sessions = [];
  const bookedSlots = new Set();
  for (const b of bookings) for (const s of b.slots) bookedSlots.add(s);

  for (const b of bookings) {
    const client = matchRegular(b, regulars, date, facilityName);
    for (const r of b.ranges) sessions.push({ startHour: r.startHour, endHour: r.endHour, client });
  }
  for (const lr of lapsedRegularHours(regulars, date, facilityName, bookedSlots)) {
    // group the open hours into consecutive runs
    let run = null;
    for (const h of lr.openHours) {
      if (run && h === run.endHour) run.endHour = h + 1;
      else {
        if (run) sessions.push(run);
        run = { startHour: h, endHour: h + 1, client: lr.client };
      }
    }
    if (run) sessions.push(run);
  }
  sessions.sort((a, b) => a.startHour - b.startHour || a.endHour - b.endHour);

  const merged = [];
  for (const s of sessions) {
    const last = merged[merged.length - 1];
    if (last && s.client && last.client === s.client && s.startHour <= last.endHour) {
      last.endHour = Math.max(last.endHour, s.endHour);
    } else {
      merged.push({ ...s });
    }
  }
  return merged;
}
