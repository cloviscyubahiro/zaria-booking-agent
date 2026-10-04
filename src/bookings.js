// Turning Ticqet's raw seat records into bookings, and working out what changed.
//
// On Ticqet, each reservation for the court is one document in the day's "seats"
// collection. Its `seats` array holds the booked hour-slots as strings, where
// each slot integer is a START hour on a 24h clock:
//   "17" = the 17:00-18:00 slot (5-6 PM), "18" = 18:00-19:00 (6-7 PM), etc.
// So a booking with seats ["17","18"] runs 17:00-19:00, i.e. 5:00-7:00 PM.

import { formatRange } from './time.js';

// Group a set of slot integers into consecutive ranges.
// [15,16,19,20] -> [{startHour:15,endHour:17},{startHour:19,endHour:21}]
export function slotsToRanges(slots) {
  const nums = [...new Set(slots.map(Number))].filter((n) => !Number.isNaN(n)).sort((a, b) => a - b);
  const ranges = [];
  let run = null;
  for (const n of nums) {
    if (run && n === run.end + 1) {
      run.end = n;
    } else {
      if (run) ranges.push({ startHour: run.start, endHour: run.end + 1 });
      run = { start: n, end: n };
    }
  }
  if (run) ranges.push({ startHour: run.start, endHour: run.end + 1 });
  return ranges;
}

// Total booked hours across all ranges.
export function totalHours(ranges) {
  return ranges.reduce((sum, r) => sum + (r.endHour - r.startHour), 0);
}

// Human text for a booking's hours, e.g. "5:00-7:00 PM (2 hrs)" or, with a gap,
// "5:00-7:00 PM + 8:00-9:00 PM (3 hrs)".
export function rangesText(ranges) {
  const parts = ranges.map((r) => formatRange(r.startHour, r.endHour));
  const hrs = totalHours(ranges);
  const label = hrs === 1 ? '1 hr' : `${hrs} hrs`;
  return `${parts.join(' + ')} (${label})`;
}

// Build a normalized booking object from one raw seats document.
// `raw` is { id, seats: [...], section, ... }.
export function bookingFromDoc(raw, date) {
  const ranges = slotsToRanges(raw.seats || []);
  return {
    id: raw.id,
    date,                       // { y, m, d, label }
    slots: [...new Set((raw.seats || []).map(Number))].sort((a, b) => a - b),
    ranges,
    hours: totalHours(ranges),
    section: raw.section || null,
  };
}

// The earliest start hour of a booking (used for reminders / ordering).
export function firstStartHour(booking) {
  return booking.ranges.length ? booking.ranges[0].startHour : null;
}

// Compare a previous snapshot of a day's bookings with the current one.
// Both are arrays of booking objects. Returns { added, removed, changed }.
// Keyed by document id, so "added" = a new reservation, "removed" = a cancelled
// one, "changed" = same reservation with different hours.
export function diffDay(previous, current) {
  const prevById = new Map(previous.map((b) => [b.id, b]));
  const curById = new Map(current.map((b) => [b.id, b]));

  const added = [];
  const removed = [];
  const changed = [];

  for (const [id, cur] of curById) {
    const prev = prevById.get(id);
    if (!prev) {
      added.push(cur);
    } else if (prev.slots.join(',') !== cur.slots.join(',')) {
      changed.push({ before: prev, after: cur });
    }
  }
  for (const [id, prev] of prevById) {
    if (!curById.has(id)) removed.push(prev);
  }
  return { added, removed, changed };
}

// A stable text fingerprint of a day's bookings, used to tell whether anything
// changed since we last looked (order of documents does not matter).
export function fingerprint(bookings) {
  return bookings
    .map((b) => `${b.id}:${b.slots.join(',')}`)
    .sort()
    .join('|');
}

// If one reservation disappears and another with exactly the same hours appears
// in the same check, Ticqet has re-issued the record (same booking, new id).
// That is not news for the team, so pair those up and drop them.
export function pairReissues(added, removed) {
  const keyOf = (b) => b.slots.join(',');
  const leftRemoved = [...removed];
  const keptAdded = [];
  const reissued = [];
  for (const a of added) {
    const i = leftRemoved.findIndex((r) => keyOf(r) === keyOf(a));
    if (i >= 0) {
      reissued.push({ before: leftRemoved[i], after: a });
      leftRemoved.splice(i, 1);
    } else {
      keptAdded.push(a);
    }
  }
  return { added: keptAdded, removed: leftRemoved, reissued };
}
