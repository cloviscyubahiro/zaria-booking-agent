import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fmt from '../src/formatter.js';
import { bookingFromDoc } from '../src/bookings.js';
import { nonGsmChars, smsSegments } from '../src/senders/pindo.js';

const day = { y: 2026, m: 10, d: 6, label: 'Tuesday 06 October 2026' };
const booking = bookingFromDoc({ id: 'x', seats: ['21', '22'] }, day);
const COURT = 'Multi-Purpose Court';

test('newBooking shows facility + date + hours only (no names, no payment line)', () => {
  const m = fmt.newBooking(booking, COURT);
  assert.equal(m, 'ZARIA COURT: New booking\nMulti-Purpose Court\nTue 6 Oct, 9:00-11:00 PM (2 hrs)');
});

test('reminders: first one says when to be ready, last one says players are arriving', () => {
  const s = { startHour: 15, endHour: 17, client: null };
  const first = fmt.reminder(s, COURT, 60, true, 15 * 60 - 15);
  assert.match(first, /Reminder\nMulti-Purpose Court is booked today 3:00-5:00 PM \(Ticqet booking\)\./);
  assert.match(first, /ready by 2:45 PM/, 'matches the example agreed with Zaria');
  assert.match(fmt.reminder({ ...s, client: 'MTN' }, COURT, 15, false, 0), /Starts in 15 min\nMulti-Purpose Court, 3:00-5:00 PM, MTN \(regular client\)\./);
});

test('dailyUpdate and weeklyOverview read like the agreed examples', () => {
  const sessions = [{ startHour: 17, endHour: 19, client: 'RwandAir' }, { startHour: 19, endHour: 21, client: 'Oxygen 250' }];
  assert.equal(
    fmt.dailyUpdate({ y: 2026, m: 9, d: 28 }, sessions, COURT),
    'ZARIA COURT: Today, Mon 28 Sep\nMulti-Purpose Court\n5:00-7:00 PM RwandAir (regular)\n7:00-9:00 PM Oxygen 250 (regular)\nTotal booked: 4 hrs',
  );
  const w = fmt.weeklyOverview('Mon 28 Sep - Sun 4 Oct', [
    { label: 'Mon', sessions },
    { label: 'Sat', sessions: [] },
    { label: 'Sun', sessions: [] },
  ], COURT);
  assert.match(w, /Mon 5-7PM RwandAir, 7-9PM Oxygen 250\nSat, Sun: none yet\nTotal: 4 hrs/);
  assert.match(fmt.dailyUpdate(day, [], COURT, [], false), /may be incomplete/);
});

test('cancelled message says the slot is free', () => {
  assert.match(fmt.cancelledBooking(booking, COURT), /Tue 6 Oct, 9:00-11:00 PM \(2 hrs\) is now FREE\./);
});

test('every message uses plain SMS characters, and alerts fit in one SMS', () => {
  const s = { startHour: 17, endHour: 19, client: 'Oxygen 250' };
  const all = [
    fmt.newBooking(booking, COURT), fmt.cancelledBooking(booking, COURT, 'Oxygen 250'),
    fmt.changedBooking(booking, booking, COURT), fmt.reminder(s, COURT, 60, true, 1005),
    fmt.reminder(s, COURT, 15, false, 0), fmt.lastMinute(s, COURT, 40), fmt.lastMinute(s, COURT, -5),
    fmt.dailyUpdate(day, [s], COURT, ['New: Fri 9 Oct, 10:00 AM-12:00 PM (2 hrs)']),
    fmt.bookingsDigest([booking, booking], COURT), fmt.regularSlotCheck([{ booking, client: 'MTN', inside: true }], COURT),
    fmt.openRegularSlots([{ day, client: 'MTN', range: { startHour: 17, endHour: 19 } }], COURT),
    fmt.massRemoval([booking], COURT), fmt.technicalAlert(16), fmt.technicalRecovered(20),
    fmt.renewalReminder('RwandAir', day, 3), fmt.sendCapReached(300), fmt.testMessage('WhatsApp'),
    fmt.welcome({ channelName: 'WhatsApp', courtName: COURT, dailyTime: '6:30 AM', adminName: 'Clovis' }),
  ];
  for (const m of all) assert.deepEqual(nonGsmChars(m), [], m);
  for (const m of all.slice(0, 7)) assert.equal(smsSegments(m), 1, `one SMS: ${m}`);
});
