import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNewTime, cleanChanges } from '../src/changes.js';
import { planForDate, buildSessions } from '../src/regulars.js';
import { bookingFromDoc } from '../src/bookings.js';

const FACILITIES = [
  { name: 'Multi-Purpose Court', ticqetEventId: 'wyUcHcKLSP52EBIr9asf' },
  { name: '5-a-side Pitch A', ticqetEventId: 'MX9KuPLIoNeBGlskCFba' },
  { name: '5-a-side Pitch B', ticqetEventId: 'lfbaTFIZ2wc1rS5QjbUs' },
];
// Saturdays on both pitches, as on Zaria's timetable.
const REGULARS = [
  { client: 'LOCAL CHAMPIONS', facility: '5-a-side Pitch A', day: 'Saturday', start: '08:00', end: '10:00', type: 'Monthly', from: '2026-10-09', until: '2026-10-31' },
  { client: 'LOCAL CHAMPIONS', facility: '5-a-side Pitch B', day: 'Saturday', start: '08:00', end: '10:00', type: 'Monthly', from: '2026-10-09', until: '2026-10-31' },
  { client: 'INSPIRE STARS', facility: '5-a-side Pitch A', day: 'Saturday', start: '18:00', end: '20:00', type: 'Monthly', from: '2026-10-09', until: '2026-10-31' },
];
const SAT10 = { y: 2026, m: 10, d: 10, label: 'Saturday 10 October 2026' };
const SAT31 = { y: 2026, m: 10, d: 31, label: 'Saturday 31 October 2026' };
const clean = (rows) => cleanChanges(rows.map((r, i) => ({ row: 5 + i, ...r })), { regulars: REGULARS, facilities: FACILITIES });

test('New time: ranges however they are typed, Cancelled, or empty for a note', () => {
  const t = (s) => parseNewTime(s);
  assert.deepEqual(t('12:00-14:00'), { kind: 'moved', startHour: 12, endHour: 14 });
  assert.deepEqual(t('12-2pm'), { kind: 'moved', startHour: 12, endHour: 14 });
  assert.deepEqual(t('12 PM to 2 PM'), { kind: 'moved', startHour: 12, endHour: 14 });
  assert.deepEqual(t('12:00 - 2:00 PM'), { kind: 'moved', startHour: 12, endHour: 14 });
  assert.deepEqual(t('11-1pm'), { kind: 'moved', startHour: 11, endHour: 13 });
  assert.deepEqual(t('8-10am'), { kind: 'moved', startHour: 8, endHour: 10 });
  assert.deepEqual(t('9pm-12am'), { kind: 'moved', startHour: 21, endHour: 24 });
  assert.deepEqual(t('12h-14h'), { kind: 'moved', startHour: 12, endHour: 14 });
  assert.deepEqual(t('18.00-20.00'), { kind: 'moved', startHour: 18, endHour: 20 });
  assert.deepEqual(t('Cancelled'), { kind: 'cancelled' });
  assert.deepEqual(t('not playing - umuganda'), { kind: 'cancelled' });
  assert.deepEqual(t(''), { kind: 'note' });
  assert.match(t('12:30-14:00').problem, /whole hours/);
  assert.match(t('later').problem, /not a time like 12:00-14:00/);
  assert.match(t('14:00-12:00').problem, /not a time/);
});

test('a car-free day move: both pitches, explained in plain words', () => {
  const [c] = clean([{ date: '2026-10-10', facility: '', client: 'Local Champions', newTime: '12:00-14:00', reason: 'Car-free day', email: true }]);
  assert.equal(c.problem, undefined);
  assert.equal(c.kind, 'moved');
  assert.equal(c.client, 'LOCAL CHAMPIONS', 'the name as written on Regular Clients');
  assert.equal(c.summary, 'LOCAL CHAMPIONS play 12:00-2:00 PM instead of 8:00-10:00 AM, at 5-a-side Pitch A and 5-a-side Pitch B.');
  assert.equal(c.email, true);

  // The plan for the day: the morning hours are given up, the new hours count.
  const plan = planForDate(REGULARS, SAT10, '5-a-side Pitch A', [c]);
  assert.deepEqual(plan.windows.map((w) => [w.client, w.startHour, w.endHour]), [['LOCAL CHAMPIONS', 12, 14], ['INSPIRE STARS', 18, 20]]);
  assert.deepEqual(plan.off.map((w) => [w.client, w.startHour, w.change.kind]), [['LOCAL CHAMPIONS', 8, 'moved']]);

  // Ticqet has the new hours booked: labelled, and the old hours are not a session.
  const sessions = buildSessions([bookingFromDoc({ id: 'lc', seats: ['12', '13'] }, SAT10)], REGULARS, SAT10, '5-a-side Pitch A', { changes: [c] });
  assert.deepEqual(sessions.map((s) => [s.startHour, s.endHour, s.client, !!s.off]), [[12, 14, 'LOCAL CHAMPIONS', false], [18, 20, 'INSPIRE STARS', false]]);
  assert.deepEqual(sessions[0].change.from, [{ startHour: 8, endHour: 10 }]);
});

test('Umuganda: a team not playing is shown as such; a stale Ticqet block gets no reminder', () => {
  const [c] = clean([{ date: '2026-10-31', facility: '5-a-side Pitch A', client: 'local champions', newTime: 'Cancelled', reason: 'Umuganda' }]);
  assert.equal(c.summary, 'LOCAL CHAMPIONS do not play (usually 8:00-10:00 AM at 5-a-side Pitch A).');
  const block = bookingFromDoc({ id: 'old', seats: ['8', '9'] }, SAT31);
  const s = buildSessions([block], REGULARS, SAT31, '5-a-side Pitch A', { changes: [c] });
  assert.deepEqual(s[0], { startHour: 8, endHour: 10, client: 'LOCAL CHAMPIONS', off: true, change: { kind: 'cancelled', reason: 'Umuganda', to: null } });
  // Pitch B was not named, so Local Champions still play there.
  assert.equal(buildSessions([], REGULARS, SAT31, '5-a-side Pitch B', { changes: [c] })[0].off, undefined);
  // A booking made after the change (exempt) is a real booking.
  const fresh = buildSessions([bookingFromDoc({ id: 'new', seats: ['8'] }, SAT31)], REGULARS, SAT31, '5-a-side Pitch A', { changes: [c], exempt: new Set(['new']) });
  assert.deepEqual(fresh.map((x) => [x.startHour, x.client, !!x.off]), [[8, null, false], [9, 'LOCAL CHAMPIONS', true], [18, 'INSPIRE STARS', false]]);
});

test('an event booking is an event, not anybody\'s session', () => {
  const day = bookingFromDoc({ id: 'ev', seats: Array.from({ length: 17 }, (_, i) => String(7 + i)) }, SAT10);
  const s = buildSessions([day], REGULARS, SAT10, '5-a-side Pitch A', { eventMinHours: 6 });
  assert.deepEqual(s, [{ startHour: 7, endHour: 24, client: null, event: true }]);
});

test('mistakes in a row are explained, and only that row is skipped', () => {
  const res = clean([
    { date: undefined, client: 'Local Champions', newTime: '12-14' },
    { date: '2026-10-10', client: 'Local Champions', newTime: '12:30-14:00' },
    { date: '2026-10-10', facility: 'Pitch C', client: 'Local Champions', newTime: '12-14' },
    { date: '2026-10-10', client: 'KESA', newTime: 'Cancelled' },
    { date: '2026-10-10', newTime: '12-14', reason: 'x' },
    { date: '2026-10-10', reason: '' , client: '' , facility: 'Pitch A' },
    { date: '2026-10-10', reason: 'Pitch A closed 2-4 PM for repairs' },
    {},
  ]);
  assert.match(res[0].problem, /Date is not a date/);
  assert.match(res[1].problem, /whole hours/);
  assert.match(res[2].problem, /"Pitch C" is not one of the watched facilities/);
  assert.match(res[3].problem, /KESA has no usual session on Sat 10 Oct to cancel/);
  assert.match(res[4].problem, /Choose the Client/);
  assert.match(res[5].problem, /Write the message/);
  assert.equal(res[6].kind, 'notice');
  assert.equal(res.length, 7, 'the empty row is ignored');
});

test('the same row keeps its id when edited, so a re-send says "Updated"', () => {
  const [a] = clean([{ date: '2026-10-10', client: 'Local Champions', newTime: '12-14', reason: 'Car-free day' }]);
  const [b] = clean([{ date: '2026-10-10', client: 'Local Champions', newTime: '13-15', reason: 'Car-free day' }]);
  assert.equal(a.id, b.id);
  assert.notEqual(a.key, b.key);
});
