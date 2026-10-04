import { test } from 'node:test';
import assert from 'node:assert/strict';
import { regularsForDate, matchRegular, lapsedRegularHours } from '../src/regulars.js';
import { bookingFromDoc } from '../src/bookings.js';

const REGS = [
  { client: 'MTN', facility: 'Multi-Purpose Court', day: 'Tuesday', start: '17:00', end: '19:00', type: 'Monthly', from: null, until: null },
  { client: 'Horizon', facility: 'Multi-Purpose Court', day: 'Friday', start: '15:00', end: '17:00', type: 'Monthly', from: '2026-10-01', until: '2026-10-31' },
];
const TUE = { y: 2026, m: 10, d: 6 };   // Tuesday
const FRI_SEP = { y: 2026, m: 9, d: 25 }; // Friday, before Horizon's "from"
const FRI_OCT = { y: 2026, m: 10, d: 2 }; // Friday, within Horizon's range

test('regularsForDate filters by weekday, facility and active range', () => {
  assert.deepEqual(regularsForDate(REGS, TUE, 'Multi-Purpose Court').map((r) => r.client), ['MTN']);
  assert.deepEqual(regularsForDate(REGS, FRI_SEP, 'Multi-Purpose Court').map((r) => r.client), []); // before "from"
  assert.deepEqual(regularsForDate(REGS, FRI_OCT, 'Multi-Purpose Court').map((r) => r.client), ['Horizon']);
});

test('matchRegular labels a booking that sits inside a regular block, else null', () => {
  const inside = bookingFromDoc({ id: '1', seats: ['17', '18'] }, TUE);
  const outside = bookingFromDoc({ id: '2', seats: ['20', '21'] }, TUE);
  assert.equal(matchRegular(inside, REGS, TUE, 'Multi-Purpose Court'), 'MTN');
  assert.equal(matchRegular(outside, REGS, TUE, 'Multi-Purpose Court'), null);
});

test('lapsedRegularHours reports a regular hour left open on Ticqet', () => {
  // MTN slot 17,18 expected; only 17 is booked -> 18 is open
  const lapses = lapsedRegularHours(REGS, TUE, 'Multi-Purpose Court', new Set([17]));
  assert.equal(lapses.length, 1);
  assert.equal(lapses[0].client, 'MTN');
  assert.deepEqual(lapses[0].openHours, [18]);
  // fully booked -> no lapse
  assert.deepEqual(lapsedRegularHours(REGS, TUE, 'Multi-Purpose Court', new Set([17, 18])), []);
});

import { buildSessions, regularsOverlapping } from '../src/regulars.js';

test('buildSessions merges a regular block split across records, and adds unblocked regular hours', () => {
  const regs = [
    { client: 'RwandAir', facility: 'Multi-Purpose Court', day: 'Monday', start: '17:00', end: '19:00' },
    { client: 'Oxygen 250', facility: 'Multi-Purpose Court', day: 'Monday', start: '19:00', end: '21:00' },
  ];
  const mon = { y: 2026, m: 10, d: 5 };
  const bookings = [bookingFromDoc({ id: 'a', seats: ['17'] }, mon), bookingFromDoc({ id: 'b', seats: ['18'] }, mon), bookingFromDoc({ id: 'c', seats: ['9', '10'] }, mon)];
  assert.deepEqual(buildSessions(bookings, regs, mon, 'Multi-Purpose Court'), [
    { startHour: 9, endHour: 11, client: null },
    { startHour: 17, endHour: 19, client: 'RwandAir' },
    { startHour: 19, endHour: 21, client: 'Oxygen 250' },
  ]);
});

test('regularsOverlapping finds partial overlaps', () => {
  const b = bookingFromDoc({ id: 'x', seats: ['18', '19'] }, TUE);
  assert.deepEqual(regularsOverlapping(b, REGS, TUE, 'Multi-Purpose Court').map((r) => r.client), ['MTN']);
});
