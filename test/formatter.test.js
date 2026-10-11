import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fmt from '../src/formatter.js';
import { bookingFromDoc } from '../src/bookings.js';
import { toEmail } from '../src/email.js';
import { nonGsmChars, smsSegments } from '../src/senders/pindo.js';

const day = { y: 2026, m: 10, d: 6, label: 'Tuesday 06 October 2026' };
const COURT = 'Multi-Purpose Court';
const booking = { ...bookingFromDoc({ id: 'x', seats: ['21', '22'] }, day), facility: COURT };
const PITCH_A = '5-a-side Pitch A';
const PITCH_B = '5-a-side Pitch B';

test('newBooking: facility, date and hours on one line (no names, no payment line)', () => {
  const m = fmt.newBooking(booking, COURT);
  assert.equal(m, 'ZARIA COURT: New booking\nMulti-Purpose Court, Tue 6 Oct, 9:00-11:00 PM (2 hrs)');
  assert.equal(toEmail(m, { kind: 'new-booking' }).subject, 'New booking: Multi-Purpose Court, Tue 6 Oct, 9:00-11:00 PM (2 hrs)');
});

test('reminders: first one says when to be ready, last one says players are arriving', () => {
  const s = { facility: COURT, startHour: 15, endHour: 17, client: null };
  const first = fmt.reminder([s], 60, true, 15 * 60 - 15);
  assert.equal(first, 'ZARIA COURT: Reminder\nMulti-Purpose Court, today 3:00-5:00 PM: Ticqet booking.\nPlease open it and have balls ready by 2:45 PM.');
  assert.match(first, /ready by 2:45 PM/, 'matches the example agreed with Zaria');
  assert.equal(
    fmt.reminder([{ ...s, client: 'MTN' }], 15, false, 0),
    'ZARIA COURT: Starts in 15 min\nMulti-Purpose Court, 3:00-5:00 PM: MTN (regular client).\nPlayers are arriving. It should be open, with balls ready.',
  );
});

test('reminders for sessions starting together are one message, naming every facility', () => {
  const a = { facility: PITCH_A, startHour: 18, endHour: 20, client: 'INSPIRE STARS' };
  const b = { facility: PITCH_B, startHour: 18, endHour: 20, client: 'INSPIRE STARS' };
  const m = fmt.reminder([a, b], 60, true, 17 * 60 + 45);
  assert.equal(m, [
    'ZARIA COURT: Reminder',
    'Today 6:00 PM: 5-a-side Pitch A and 5-a-side Pitch B.',
    '5-a-side Pitch A, 6:00-8:00 PM: INSPIRE STARS (regular client).',
    '5-a-side Pitch B, 6:00-8:00 PM: INSPIRE STARS (regular client).',
    'Please open them and have balls ready by 5:45 PM.',
  ].join('\n'));
  assert.equal(toEmail(m, { kind: 'reminder' }).subject, 'Reminder: Today 6:00 PM: 5-a-side Pitch A and 5-a-side Pitch B');
  const moved = { ...a, startHour: 12, endHour: 14, client: 'LOCAL CHAMPIONS', change: { kind: 'moved', reason: 'Car-free day', from: [{ startHour: 8, endHour: 10 }] } };
  assert.match(fmt.reminder([moved], 60, true, 11 * 60 + 45), /LOCAL CHAMPIONS \(regular client\) - moved from 8:00-10:00 AM \(Car-free day\)\./);
  assert.match(fmt.reminder([{ facility: COURT, startHour: 7, endHour: 24, event: true }], 60, true, 6 * 60 + 45), /Multi-Purpose Court, today 7:00 AM-12:00 AM: event \/ setup\.\nPlease open it by 6:45 AM\./);
});

test('daily update: one facility reads as before; several get a heading each', () => {
  const sessions = [{ startHour: 17, endHour: 19, client: 'RwandAir' }, { startHour: 19, endHour: 21, client: 'Oxygen 250' }];
  assert.equal(
    fmt.dailyUpdate({ y: 2026, m: 9, d: 28 }, [{ name: COURT, sessions }]),
    'ZARIA COURT: Today, Mon 28 Sep\nMulti-Purpose Court\n5:00-7:00 PM RwandAir (regular)\n7:00-9:00 PM Oxygen 250 (regular)\nTotal booked: 4 hrs',
  );
  const sat = { y: 2026, m: 10, d: 10 };
  const moved = { startHour: 12, endHour: 14, client: 'LOCAL CHAMPIONS', change: { kind: 'moved', reason: 'Car-free day', from: [{ startHour: 8, endHour: 10 }] } };
  const m = fmt.dailyUpdate(sat, [
    { name: COURT, sessions: [{ startHour: 7, endHour: 24, client: null, event: true }] },
    { name: PITCH_A, sessions: [moved, { startHour: 18, endHour: 20, client: 'INSPIRE STARS' }] },
    { name: PITCH_B, sessions: [] },
  ], { notes: ['Bring bibs'] });
  assert.equal(m, [
    'ZARIA COURT: Today, Sat 10 Oct',
    'Multi-Purpose Court (17 hrs):',
    '7:00 AM-12:00 AM Event / setup',
    '5-a-side Pitch A (4 hrs):',
    '12:00-2:00 PM LOCAL CHAMPIONS (regular) - moved from 8:00-10:00 AM (Car-free day)',
    '6:00-8:00 PM INSPIRE STARS (regular)',
    '5-a-side Pitch B: no bookings yet.',
    'Notes:',
    'Bring bibs',
  ].join('\n'));
  assert.match(fmt.dailyUpdate(day, [{ name: COURT, sessions: [] }], { dataOk: false }), /may be incomplete/);
  const umuganda = fmt.dailyUpdate({ y: 2026, m: 10, d: 31 }, [{ name: PITCH_A, sessions: [{ startHour: 8, endHour: 10, client: 'LOCAL CHAMPIONS' }] }], { umuganda: { start: 480, end: 660 } });
  assert.match(umuganda, /Umuganda today, 8:00-11:00 AM\.\n5-a-side Pitch A\n8:00-10:00 AM LOCAL CHAMPIONS \(regular\) - during Umuganda/);
});

test('weekly overview: compact lines per facility', () => {
  const sessions = [{ startHour: 17, endHour: 19, client: 'RwandAir' }, { startHour: 19, endHour: 21, client: 'Oxygen 250' }];
  const w = fmt.weeklyOverview('Mon 28 Sep - Sun 4 Oct', [{ name: COURT, days: [
    { label: 'Mon', sessions },
    { label: 'Sat', sessions: [] },
    { label: 'Sun', sessions: [] },
  ] }]);
  assert.match(w, /Mon 5-7PM RwandAir, 7-9PM Oxygen 250\nSat, Sun: none yet\nTotal: 4 hrs/);
  const two = fmt.weeklyOverview('Mon 12 Oct - Sun 18 Oct', [
    { name: COURT, days: [{ label: 'Sat', sessions: [{ startHour: 7, endHour: 24, event: true }] }] },
    { name: PITCH_A, days: [{ label: 'Sat', sessions: [{ startHour: 8, endHour: 10, client: 'LOCAL CHAMPIONS' }], umuganda: { start: 480, end: 660 } }] },
  ]);
  assert.match(two, /Multi-Purpose Court \(17 hrs\):\nSat 7AM-12AM Event\n5-a-side Pitch A \(2 hrs\):\nSat \(Umuganda 8:00-11:00 AM\) 8-10AM LOCAL CHAMPIONS/);
});

test('event notice: the facility, the hours, and the teams to call', () => {
  const m = fmt.eventDay({
    facility: COURT,
    date: { y: 2026, m: 10, d: 9 },
    when: 'tomorrow',
    ranges: [{ startHour: 7, endHour: 19 }, { startHour: 21, endHour: 24 }],
    teams: [{ startHour: 15, endHour: 17, client: 'Horizon', displaced: true }, { startHour: 19, endHour: 21, client: 'Oxygen 250' }],
  });
  assert.equal(m, [
    'ZARIA COURT: Event tomorrow, Fri 9 Oct',
    'Multi-Purpose Court: booked 7:00 AM-7:00 PM + 9:00 PM-12:00 AM (15 hrs) for an event or setup.',
    'Please call these teams - Multi-Purpose Court is not available tomorrow:',
    '3:00-5:00 PM Horizon (regular) - their usual hours are inside the event booking',
    '7:00-9:00 PM Oxygen 250 (regular)',
  ].join('\n'));
  assert.equal(toEmail(m, { kind: 'event-day' }).subject,
    'Event tomorrow, Fri 9 Oct: Multi-Purpose Court: booked 7:00 AM-7:00 PM + 9:00 PM-12:00 AM (15 hrs) for an event or setup');
  assert.match(fmt.eventDay({ facility: COURT, date: { y: 2026, m: 10, d: 10 }, when: 'tomorrow', ranges: [{ startHour: 7, endHour: 24 }], teams: [] }),
    /No other team is booked at Multi-Purpose Court that day\./);
});

test('schedule change email: what changed, where, and why', () => {
  const c = { date: '2026-10-10', kind: 'moved', client: 'LOCAL CHAMPIONS', reason: 'Car-free day.', summary: 'LOCAL CHAMPIONS play 12:00-2:00 PM instead of 8:00-10:00 AM, at 5-a-side Pitch A and 5-a-side Pitch B.' };
  const m = fmt.scheduleChange(c);
  assert.equal(m, 'ZARIA COURT: Schedule change, Sat 10 Oct\nLOCAL CHAMPIONS play 12:00-2:00 PM instead of 8:00-10:00 AM, at 5-a-side Pitch A and 5-a-side Pitch B.\nReason: Car-free day.');
  assert.ok(toEmail(m, { kind: 'schedule-change' }).subject.length <= 140);
  assert.match(fmt.scheduleChange(c, { updated: true }), /^ZARIA COURT: Updated: Schedule change/);
  assert.equal(fmt.scheduleChange({ date: '2026-10-10', kind: 'notice', facility: PITCH_A, reason: 'Closed 2-4 PM for repairs' }), 'ZARIA COURT: Notice for Sat 10 Oct\n5-a-side Pitch A: Closed 2-4 PM for repairs');
});

test('event today: one short message with the hours and when to open', () => {
  const m = fmt.eventToday({ facility: COURT, date: { y: 2026, m: 10, d: 11 }, ranges: [{ startHour: 7, endHour: 10 }, { startHour: 12, endHour: 24 }], readyBy: 6 * 60 + 45 });
  assert.equal(m, 'ZARIA COURT: Event today, Sun 11 Oct\nMulti-Purpose Court is booked 7:00-10:00 AM and 12:00 PM-12:00 AM for an event or setup.\nPlease open it by 6:45 AM.');
  assert.equal(toEmail(m, { kind: 'event-today' }).subject, 'Event today, Sun 11 Oct: Multi-Purpose Court is booked 7:00-10:00 AM and 12:00 PM-12:00 AM for an event or setup');
  assert.match(fmt.eventToday({ facility: COURT, date: { y: 2026, m: 10, d: 11 }, ranges: [{ startHour: 7, endHour: 24 }], readyBy: 405, started: true }), /It has started - please make sure it is open\.$/);
});

test('car-free day: the email to everyone, and the admin\'s heads-up', () => {
  const sun18 = { y: 2026, m: 10, d: 18 };
  assert.equal(fmt.scheduleChange({ date: '2026-10-18', kind: 'carfree', reason: 'Car-free day', span: { start: 420, end: 600 } }),
    'ZARIA COURT: Car-free day on Sun 18 Oct\nKigali car-free day, 7:00-10:00 AM.');
  assert.equal(fmt.scheduleChange({ date: '2026-10-18', kind: 'carfree', reason: 'Car free day: players use the back gate', span: { start: 420, end: 660 }, facility: PITCH_A }),
    'ZARIA COURT: Car-free day on Sun 18 Oct\nKigali car-free day, 7:00-11:00 AM (5-a-side Pitch A).\nPlayers use the back gate.');
  assert.equal(fmt.carFreeHeadsUp(sun18, { start: 420, end: 600 }, [{ facility: PITCH_A, startHour: 8, endHour: 10, client: 'LOCAL CHAMPIONS' }]), [
    'ZARIA COURT: Car-free day on Sun 18 Oct',
    'Car-free day is 7:00-10:00 AM. Booked during it:',
    '5-a-side Pitch A: 8:00-10:00 AM LOCAL CHAMPIONS (regular)',
    'If they move or will not play, add a row on the Schedule Changes tab and tick Email everyone.',
  ].join('\n'));
  const daily = fmt.dailyUpdate(sun18, [{ name: PITCH_A, sessions: [{ startHour: 8, endHour: 10, client: 'LOCAL CHAMPIONS' }, { startHour: 15, endHour: 17, client: null }] }], { carFree: { start: 420, end: 600 } });
  assert.match(daily, /^ZARIA COURT: Today, Sun 18 Oct\nCar-free day today, 7:00-10:00 AM\.\n5-a-side Pitch A\n8:00-10:00 AM LOCAL CHAMPIONS \(regular\) - during car-free day\n3:00-5:00 PM Ticqet booking\n/);
  const week = fmt.weeklyOverview('Mon 12 Oct - Sun 18 Oct', [{ name: PITCH_A, days: [{ label: 'Sun', sessions: [{ startHour: 8, endHour: 10, client: 'LOCAL CHAMPIONS' }], carFree: { start: 420, end: 600 } }] }]);
  assert.match(week, /Sun \(Car-free day 7:00-10:00 AM\) 8-10AM LOCAL CHAMPIONS/);
});

test('cancelled message says the slot is free, and whose it was', () => {
  assert.match(fmt.cancelledBooking(booking, COURT), /Multi-Purpose Court, Tue 6 Oct, 9:00-11:00 PM \(2 hrs\) is now FREE\./);
  assert.match(fmt.cancelledBooking(booking, COURT, 'LOCAL CHAMPIONS'), /FREE \(was LOCAL CHAMPIONS' regular slot\)/);
  assert.match(fmt.cancelledBooking(booking, COURT, 'MTN'), /FREE \(was MTN's regular slot\)/);
});

test('renewals due the same morning come as one message', () => {
  const until = { y: 2026, m: 10, d: 31 };
  const one = fmt.renewals([{ client: 'KESA', until, daysLeft: 3, hours: '5-a-side Pitch B: Mon 6-7PM' }]);
  assert.equal(one, 'ZARIA COURT: Renewal due\nKESA\'s arrangement ends Sat 31 Oct (in 3 days).\n5-a-side Pitch B: Mon 6-7PM\nWhen renewed, update the Until date on the Regular Clients tab. If not, free the hours on Ticqet.');
  const many = fmt.renewals([
    { client: 'LIONS', until, daysLeft: 3, hours: '5-a-side Pitch B: Wed 7-9PM' },
    { client: 'KESA', until, daysLeft: 3, hours: '5-a-side Pitch B: Mon 6-7PM' },
  ]);
  assert.match(many, /^ZARIA COURT: Renewals due\nEnding Sat 31 Oct \(in 3 days\):\nKESA - 5-a-side Pitch B: Mon 6-7PM\nLIONS - 5-a-side Pitch B: Wed 7-9PM\n/);
});

test('every message uses plain SMS characters, and alerts fit in one SMS', () => {
  const s = { facility: COURT, startHour: 17, endHour: 19, client: 'Oxygen 250' };
  const all = [
    fmt.newBooking(booking, COURT), fmt.cancelledBooking(booking, COURT, 'Oxygen 250'),
    fmt.changedBooking(booking, booking, COURT), fmt.reminder([s], 60, true, 1005),
    fmt.reminder([s], 15, false, 0), fmt.lastMinute(s, COURT, 40), fmt.lastMinute(s, COURT, -5),
    fmt.dailyUpdate(day, [{ name: COURT, sessions: [s] }], { overnight: ['New: Multi-Purpose Court, Fri 9 Oct, 10:00 AM-12:00 PM (2 hrs)'] }),
    fmt.bookingsDigest([booking, booking]), fmt.regularSlotCheck([{ booking, client: 'MTN', inside: true }]),
    fmt.openRegularSlots([{ day, facility: COURT, client: 'MTN', range: { startHour: 17, endHour: 19 } }]),
    fmt.massRemoval([booking]), fmt.technicalAlert(16), fmt.technicalRecovered(20),
    fmt.renewals([{ client: 'RwandAir', until: day, daysLeft: 3, hours: 'Multi-Purpose Court: Mon 5-7PM' }]), fmt.sendCapReached(300),
    fmt.alertsPaused(60, 90), fmt.testMessage('WhatsApp'), fmt.facilitiesAdded([PITCH_A, PITCH_B]),
    fmt.welcome({ channelName: 'WhatsApp', facilities: [COURT, PITCH_A], dailyTime: '6:30 AM', adminName: 'Clovis' }),
    fmt.eventDay({ facility: COURT, date: day, when: 'today', ranges: [{ startHour: 7, endHour: 24 }], teams: [s] }),
    fmt.umugandaHeadsUp(day, { start: 480, end: 660 }, [s]),
    fmt.carFreeHeadsUp(day, { start: 420, end: 600 }, [s]),
    fmt.eventToday({ facility: COURT, date: day, ranges: [{ startHour: 7, endHour: 10 }, { startHour: 12, endHour: 24 }], readyBy: 405 }),
    fmt.scheduleChange({ date: '2026-10-18', kind: 'carfree', reason: 'Car-free day - roads closed near the court', span: { start: 420, end: 600 } }),
  ];
  for (const m of all) assert.deepEqual(nonGsmChars(m), [], m);
  for (const m of all.slice(0, 7)) assert.equal(smsSegments(m), 1, `one SMS: ${m}`);
});
