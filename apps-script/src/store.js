// Apps Script stand-in for src/store.js (the build swaps it in): the same
// functions, backed by Script Properties instead of files. Booking-log entries
// are collected during the run and written to the "Bookings Log" sheet by main.js.

import { bookingFromDoc } from '../../src/bookings.js';
import { dayFromLabel } from '../../src/time.js';

let props = null;
const logEntries = [];

// Called by main.js at the start of every run.
export function begin(p) {
  props = p;
  logEntries.length = 0;
}

// --- bookings already processed, per facility and Ticqet date label ---
// Stored compactly as facilityId -> label -> [[id, [slots...]], ...]; that is
// all the engine compares, and it keeps 60 days of three facilities well inside
// the storage limits. Snapshots from before several facilities were watched
// (label -> [...]) are returned as they are; the engine assigns them.
const toBookings = (days) => {
  const out = {};
  for (const [label, list] of Object.entries(days || {})) {
    const date = dayFromLabel(label);
    if (date) out[label] = list.map(([id, slots]) => bookingFromDoc({ id, seats: slots.map(String) }, date));
  }
  return out;
};

export function loadSnapshot() {
  const compact = props.get('snapshot', null);
  if (!compact || !compact.days) return { days: {} };
  if (compact.v !== 2) return { days: toBookings(compact.days) };
  const days = {};
  for (const [fid, labels] of Object.entries(compact.days)) days[fid] = toBookings(labels);
  return { days };
}
export function saveSnapshot(snap) {
  const days = {};
  for (const [fid, labels] of Object.entries(snap.days)) {
    days[fid] = {};
    for (const [label, list] of Object.entries(labels)) days[fid][label] = list.map((b) => [b.id, b.slots]);
  }
  props.set('snapshot', { v: 2, days });
}

// --- reminder flags already sent ---
export function loadReminders() {
  return new Set(props.get('reminders', []));
}
export function saveReminders(set) {
  props.set('reminders', [...set]);
}

// --- alerts held during quiet hours ---
export function loadDeferred() {
  return props.get('deferred', []);
}
export function saveDeferred(list) {
  props.set('deferred', list);
}

// --- one-off jobs done and daily counters ---
export function loadJobMarks() {
  return props.get('jobs', {});
}
export function saveJobMarks(marks) {
  props.set('jobs', marks);
}

// --- booking log (written to the "Bookings Log" sheet at the end of the run) ---
export function appendBookingLog(entry) {
  logEntries.push(entry);
}
export function takeBookingLog() {
  return logEntries.splice(0);
}
