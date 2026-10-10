// Scenario tests for the engine, run against a fake clock, a fake Ticqet and a
// fake phone. Each scenario gets a fresh data folder. Times are in UTC here
// (except the Kigali test) so the wall clock is easy to read.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.ZARIA_QUIET = '1';
const { Engine } = await import('../src/engine.js');
const { withDefaults } = await import('../src/config.js');
const { cleanChanges } = await import('../src/changes.js');

// ---------- fakes ----------
class FakeClock {
  constructor(iso) { this.t = new Date(iso); }
  set(iso) { this.t = new Date(iso); }
  addMinutes(m) { this.t = new Date(this.t.getTime() + m * 60000); }
  addSeconds(s) { this.t = new Date(this.t.getTime() + s * 1000); }
  now() { return new Date(this.t); }
}

const COURT = 'wyUcHcKLSP52EBIr9asf';
const PITCH_A = 'MX9KuPLIoNeBGlskCFba';
const PITCH_B = 'lfbaTFIZ2wc1rS5QjbUs';
const FACILITIES = [
  { name: 'Multi-Purpose Court', ticqetEventId: COURT },
  { name: '5-a-side Pitch A', ticqetEventId: PITCH_A },
  { name: '5-a-side Pitch B', ticqetEventId: PITCH_B },
];

// Bookings per facility and date. Without a facility, the court.
class FakeTicqet {
  constructor(clock) {
    this.clock = clock;
    this.days = new Map();
    this.watched = [];
    this.frozenAt = null; // set while "unreachable"
    this.oldestErrorAt = null;
  }
  watch(labels) { this.watched = labels; }
  get(label, fid = COURT) { return this.watched.includes(label) ? this.days.get(`${fid}|${label}`) || [] : undefined; }
  get lastContactAt() { return this.frozenAt ?? this.clock.now().getTime(); }
  set(label, records, fid = COURT) { this.days.set(`${fid}|${label}`, records); }
  add(label, record, fid = COURT) { this.days.set(`${fid}|${label}`, [...(this.days.get(`${fid}|${label}`) || []), record]); }
  remove(label, id, fid = COURT) { this.days.set(`${fid}|${label}`, (this.days.get(`${fid}|${label}`) || []).filter((r) => r.id !== id)); }
  goDown() { this.frozenAt = this.clock.now().getTime(); }
  goUp() { this.frozenAt = null; }
}

class FakePhone {
  constructor() { this.sent = []; this.broken = new Set(); }
  async send(m) {
    if (this.broken.has(m.to)) throw new Error('network down');
    this.sent.push(m);
    return { ok: true };
  }
  kind(k) { return this.sent.filter((s) => s.kind === k); }
  clear() { this.sent = []; }
}

// ---------- fixtures ----------
const TEAM1 = '+250780000001';
const ATTENDANT = '+250780000002';
const TEAM3 = '+250780000003';
const ADMIN = '+250780000009';
const CONTACTS = [
  { phone: TEAM1, alerts: true, summaries: true, reminders: false, admin: false },
  { phone: ATTENDANT, alerts: true, summaries: true, reminders: true, admin: false },
  { phone: TEAM3, alerts: true, summaries: true, reminders: false, admin: false },
  { phone: ADMIN, alerts: false, summaries: false, reminders: false, admin: true, name: 'Clovis' },
];
const REGULARS = [
  { client: 'MTN', facility: 'Multi-Purpose Court', day: 'Tuesday', start: '17:00', end: '19:00', type: 'Monthly', from: null, until: null },
  { client: 'RwandAir', facility: 'Multi-Purpose Court', day: 'Monday', start: '17:00', end: '19:00', type: 'Monthly', from: null, until: '2026-10-09' },
];

// Tue 6 Oct 2026 is a Tuesday (an MTN day).
const TUE6 = 'Tuesday 06 October 2026';
const WED7 = 'Wednesday 07 October 2026';
const THU8 = 'Thursday 08 October 2026';
const FRI9 = 'Friday 09 October 2026';
const SAT10 = 'Saturday 10 October 2026';
const TUE13 = 'Tuesday 13 October 2026';
const THU15 = 'Thursday 15 October 2026';
const SAT17 = 'Saturday 17 October 2026';
const TUE20 = 'Tuesday 20 October 2026';
const SAT31 = 'Saturday 31 October 2026';
const hours = (from, to) => Array.from({ length: to - from }, (_, i) => String(from + i));

function setup({ at = '2026-10-06T08:00:00Z', settings = {}, regulars = REGULARS, contacts = CONTACTS, changes = [], dir = null } = {}) {
  process.env.ZARIA_DATA_DIR = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'zaria-engine-'));
  const clock = new FakeClock(at);
  const ticqet = new FakeTicqet(clock);
  const phone = new FakePhone();
  const cfg = {
    settings: withDefaults({ timezone: 'UTC', sendWelcome: false, ...settings, watch: { windowDays: 14, settleSeconds: 0, probeMinutes: 5, ...settings.watch } }),
    regulars,
    contacts,
  };
  cfg.changes = cleanChanges(changes.map((c, i) => ({ row: 5 + i, ...c })), { regulars, facilities: cfg.settings.facilities });
  const make = () => new Engine({ cfg, source: ticqet, sender: phone, clock });
  return { clock, ticqet, phone, cfg, engine: make(), make };
}

const to = (msgs) => msgs.map((m) => m.to).sort();
const readLog = () => fs.readFileSync(path.join(process.env.ZARIA_DATA_DIR, 'bookings-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

// ---------- scenarios ----------

test('first run records existing bookings silently and sends one welcome', async () => {
  const { ticqet, phone, engine } = setup({ settings: { sendWelcome: true } });
  ticqet.set(TUE6, [{ id: 'mtn', seats: ['17', '18'] }, { id: 'a', seats: ['20', '21'] }]);
  await engine.tick();
  assert.equal(phone.kind('new-booking').length, 0, 'existing bookings are not "new"');
  assert.deepEqual(to(phone.kind('welcome')), [TEAM1, ATTENDANT, TEAM3, ADMIN].sort());
  assert.match(phone.kind('welcome')[0].text, /Tell Clovis/);
  await engine.tick();
  assert.equal(phone.kind('welcome').length, 4, 'welcome only once');
});

test('a new booking is announced to the team after the settle time, not before', async () => {
  const { clock, ticqet, phone, engine } = setup({ settings: { watch: { settleSeconds: 60 } } });
  await engine.tick();
  ticqet.add(THU8, { id: 'b1', seats: ['10', '11'] });
  await engine.tick();
  clock.addSeconds(30);
  await engine.tick();
  assert.equal(phone.sent.length, 0, 'still settling');
  clock.addSeconds(31);
  await engine.tick();
  const nb = phone.kind('new-booking');
  assert.deepEqual(to(nb), [TEAM1, ATTENDANT, TEAM3].sort(), 'team only, not the admin');
  assert.match(nb[0].text, /New booking\nMulti-Purpose Court, Thu 8 Oct, 10:00 AM-12:00 PM \(2 hrs\)/);
  assert.doesNotMatch(nb[0].text, /Paid/i);
});

test('a booking that appears and vanishes within the settle time is never announced', async () => {
  const { clock, ticqet, phone, engine } = setup({ settings: { watch: { settleSeconds: 60 } } });
  await engine.tick();
  ticqet.add(THU8, { id: 'flash', seats: ['10'] });
  await engine.tick();
  ticqet.remove(THU8, 'flash');
  clock.addSeconds(70);
  await engine.tick();
  assert.equal(phone.sent.length, 0);
});

test('a re-issued record (new id, same hours) is not news', async () => {
  const { ticqet, phone, engine } = setup();
  ticqet.set(THU8, [{ id: 'x', seats: ['10', '11'] }]);
  await engine.tick();
  ticqet.set(THU8, [{ id: 'y', seats: ['11', '10'] }]);
  await engine.tick();
  assert.equal(phone.sent.length, 0);
});

test('a date entering the watch window is recorded silently (no false alerts at midnight)', async () => {
  const { clock, ticqet, phone, engine } = setup();
  ticqet.set(TUE20, [{ id: 'far', seats: ['9', '10'] }]); // 14 days ahead: just outside the window
  await engine.tick();
  clock.set('2026-10-07T08:00:00Z');
  await engine.tick();
  assert.equal(phone.sent.length, 0);
});

test('a cancellation tells the team the slot is free', async () => {
  const { ticqet, phone, engine } = setup();
  ticqet.set(FRI9, [{ id: 'c1', seats: ['15', '16'] }]);
  await engine.tick();
  ticqet.remove(FRI9, 'c1');
  await engine.tick();
  const msgs = phone.kind('cancelled');
  assert.equal(msgs.length, 3);
  assert.match(msgs[0].text, /Multi-Purpose Court, Fri 9 Oct, 3:00-5:00 PM \(2 hrs\) is now FREE\./);
});

test('a freed regular block says whose slot it was', async () => {
  const { ticqet, phone, engine } = setup();
  ticqet.set(TUE13, [{ id: 'mtn13', seats: ['17', '18'] }]);
  await engine.tick();
  ticqet.remove(TUE13, 'mtn13');
  await engine.tick();
  assert.match(phone.kind('cancelled')[0].text, /FREE \(was MTN's regular slot\)/);
});

test('a regular\'s exact block is Zaria blocking it: no message at all', async () => {
  const { ticqet, phone, engine } = setup();
  await engine.tick();
  ticqet.add(TUE13, { id: 'r1', seats: ['17', '18'] });
  await engine.tick();
  assert.equal(phone.sent.length, 0);
  const last = readLog().at(-1);
  assert.deepEqual([last.event, last.regular, last.facility], ['added', 'MTN', 'Multi-Purpose Court'], 'logged with the client');
});

test('a booking for part of a regular slot goes to the admin as a check, not to the team', async () => {
  const { ticqet, phone, engine } = setup();
  await engine.tick();
  ticqet.add(TUE13, { id: 'r1', seats: ['18'] });
  await engine.tick();
  assert.equal(phone.kind('new-booking').length, 0, 'no team alert');
  const check = phone.kind('regular-slot-check');
  assert.deepEqual(to(check), [ADMIN]);
  assert.match(check[0].text, /Multi-Purpose Court: Ticqet booking in MTN's usual slot, Tue 13 Oct 6:00-7:00 PM/);
  assert.match(check[0].text, /double-booked/);
});

test('a booking overlapping a regular slot alerts the team AND asks the admin to check', async () => {
  const { ticqet, phone, engine } = setup();
  await engine.tick();
  ticqet.add(TUE13, { id: 'o1', seats: ['18', '19'] }); // 6-8 PM overlaps MTN 5-7 PM
  await engine.tick();
  assert.equal(phone.kind('new-booking').length, 3);
  assert.match(phone.kind('regular-slot-check')[0].text, /overlapping MTN's usual slot/);
});

test('several partial regular bookings at once produce ONE admin message', async () => {
  const { ticqet, phone, engine } = setup();
  await engine.tick();
  ticqet.add(TUE13, { id: 'm1', seats: ['17'] });
  ticqet.add('Monday 12 October 2026', { id: 'm2', seats: ['17'] }); // RwandAir ended 9 Oct -> not a regular now
  ticqet.add(TUE6, { id: 'm3', seats: ['18'] });
  await engine.tick();
  const checks = phone.kind('regular-slot-check');
  assert.equal(checks.length, 1);
  assert.match(checks[0].text, /2 Ticqet bookings in regular clients' usual slots/);
  assert.equal(phone.kind('new-booking').length, 3, 'the Monday one is a normal booking (RwandAir ended)');
});

test('last-minute booking: attendants get one message instead of reminders, the rest get the normal alert', async () => {
  const { clock, ticqet, phone, engine } = setup({ at: '2026-10-06T15:20:00Z' });
  ticqet.set(TUE6, [{ id: 'mtn', seats: ['17', '18'] }]);
  await engine.tick();
  ticqet.add(TUE6, { id: 'lm', seats: ['16'] }); // 4-5 PM, starts in 40 min
  await engine.tick();
  const lm = phone.kind('last-minute');
  assert.deepEqual(to(lm), [ATTENDANT]);
  assert.match(lm[0].text, /Multi-Purpose Court, today 4:00-5:00 PM, just booked on Ticqet\.\nStarts in 40 min/);
  assert.deepEqual(to(phone.kind('new-booking')), [TEAM1, TEAM3].sort(), 'attendant is not messaged twice');
  phone.clear();
  clock.set('2026-10-06T15:45:00Z');
  await engine.minuteTick();
  assert.equal(phone.kind('reminder').length, 0, 'no 15-min reminder for the 4 PM booking');
  clock.set('2026-10-06T16:00:00Z');
  await engine.minuteTick();
  assert.match(phone.kind('reminder')[0].text, /Multi-Purpose Court, today 5:00-7:00 PM: MTN \(regular client\)\./, 'the 5 PM session still gets its reminder');
});

test('a booking made after its start time asks attendants to open it now', async () => {
  const { ticqet, phone, engine } = setup({ at: '2026-10-06T10:10:00Z' });
  await engine.tick();
  ticqet.add(TUE6, { id: 'late', seats: ['10', '11'] });
  await engine.tick();
  assert.match(phone.kind('last-minute')[0].text, /already started - please open it now/);
});

test('reminders go to attendants only, 60 and 15 minutes before, once each, up to 5 min late', async () => {
  const { clock, ticqet, phone, engine } = setup({ at: '2026-10-06T15:00:00Z' });
  ticqet.set(TUE6, [{ id: 'mtn', seats: ['17', '18'] }]);
  await engine.tick();
  clock.set('2026-10-06T16:00:00Z');
  await engine.minuteTick();
  const r60 = phone.kind('reminder');
  assert.deepEqual(to(r60), [ATTENDANT]);
  assert.equal(r60[0].text, 'ZARIA COURT: Reminder\nMulti-Purpose Court, today 5:00-7:00 PM: MTN (regular client).\nPlease open it and have balls ready by 4:45 PM.');
  clock.set('2026-10-06T16:01:00Z');
  await engine.minuteTick();
  assert.equal(phone.kind('reminder').length, 1, 'not repeated');
  clock.set('2026-10-06T16:47:00Z'); // 2 minutes late (e.g. after a restart)
  await engine.minuteTick();
  assert.match(phone.kind('reminder')[1].text, /Starts in 15 min/);
  clock.set('2026-10-06T16:52:00Z');
  await engine.minuteTick();
  assert.equal(phone.kind('reminder').length, 2);
});

test('split reminders: a colleague gets the 60-min one, the attendant the 15-min one', async () => {
  const contacts = [
    { phone: TEAM1, alerts: true, summaries: true, reminder1: true, reminder2: false, admin: false },
    { phone: ATTENDANT, alerts: true, summaries: true, reminder1: false, reminder2: true, admin: false },
    { phone: TEAM3, alerts: true, summaries: true, reminders: false, admin: false },
  ];
  const { clock, ticqet, phone, engine } = setup({ at: '2026-10-06T15:00:00Z', contacts });
  ticqet.set(TUE6, [{ id: 'mtn', seats: ['17', '18'] }]);
  await engine.tick();
  clock.set('2026-10-06T16:00:00Z');
  await engine.minuteTick();
  assert.deepEqual(to(phone.kind('reminder')), [TEAM1], '60 min before: the colleague only');
  phone.clear();
  clock.set('2026-10-06T16:45:00Z');
  await engine.minuteTick();
  assert.deepEqual(to(phone.kind('reminder')), [ATTENDANT], '15 min before: the attendant only');
  assert.match(phone.kind('reminder')[0].text, /Starts in 15 min/);
});

test('regulars not blocked on Ticqet still get reminders (the list is the truth for regulars)', async () => {
  const { clock, phone, engine } = setup({ at: '2026-10-06T15:00:00Z' });
  await engine.tick(); // Ticqet shows nothing today
  clock.set('2026-10-06T16:00:00Z');
  await engine.minuteTick();
  assert.match(phone.kind('reminder')[0].text, /MTN \(regular client\)/);
});

test('quiet hours: alerts are held and ride along with the daily update', async () => {
  const { clock, ticqet, phone, engine } = setup({ at: '2026-10-06T23:30:00Z' });
  await engine.tick();
  ticqet.add(FRI9, { id: 'night', seats: ['10', '11'] });
  await engine.tick();
  assert.equal(phone.sent.length, 0, 'nothing sent at night');
  clock.set('2026-10-07T06:00:00Z');
  await engine.tick();
  await engine.minuteTick();
  assert.equal(phone.sent.length, 0, 'quiet hours over, but the 6:30 update will carry it');
  clock.set('2026-10-07T06:30:00Z');
  await engine.minuteTick();
  const daily = phone.kind('daily');
  assert.deepEqual(to(daily), [TEAM1, ATTENDANT, TEAM3].sort());
  assert.match(daily[0].text, /Today, Wed 7 Oct/);
  assert.match(daily[0].text, /Overnight:\nNew: Multi-Purpose Court, Fri 9 Oct, 10:00 AM-12:00 PM \(2 hrs\)/);
  assert.equal(phone.kind('new-booking').length, 0, 'not sent separately as well');
});

test('on Monday the weekly overview replaces the daily and carries the overnight alerts', async () => {
  const { clock, ticqet, phone, engine } = setup({ at: '2026-10-11T23:30:00Z' }); // Sunday night
  await engine.tick();
  ticqet.add(THU15, { id: 'sun-night', seats: ['18'] });
  await engine.tick();
  clock.set('2026-10-12T06:30:00Z');
  await engine.tick();
  await engine.minuteTick();
  assert.equal(phone.kind('daily').length, 0);
  const weekly = phone.kind('weekly');
  assert.equal(weekly.length, 3);
  assert.match(weekly[0].text, /Week of Mon 12 Oct - Sun 18 Oct/);
  assert.match(weekly[0].text, /Tue 5-7PM MTN/);
  assert.match(weekly[0].text, /Thu 6-7PM Ticqet/);
  assert.match(weekly[0].text, /Overnight:\nNew: Multi-Purpose Court, Thu 15 Oct, 6:00-7:00 PM \(1 hr\)/);
  assert.equal(engine.deferred.length, 0);
});

test('many bookings vanishing at once alerts the admin only', async () => {
  const { ticqet, phone, engine } = setup();
  const days = [WED7, THU8, FRI9, TUE13, THU15, 'Friday 16 October 2026'];
  days.forEach((d, i) => ticqet.set(d, [{ id: `v${i}`, seats: ['9'] }]));
  await engine.tick();
  days.forEach((d) => ticqet.set(d, []));
  await engine.tick();
  assert.equal(phone.kind('cancelled').length, 0, 'team not alerted');
  const mass = phone.kind('mass-removal');
  assert.deepEqual(to(mass), [ADMIN]);
  assert.match(mass[0].text, /6 bookings disappeared from Ticqet at once \(Wed 7 Oct - Fri 16 Oct\), at Multi-Purpose Court/);
});

test('many new bookings at once send ONE summary to the team', async () => {
  const { ticqet, phone, engine } = setup();
  await engine.tick();
  for (let h = 8; h < 15; h++) ticqet.add(THU8, { id: `n${h}`, seats: [String(h)] });
  await engine.tick();
  assert.equal(phone.kind('new-booking').length, 0);
  const digest = phone.kind('bookings-digest');
  assert.equal(digest.length, 3);
  assert.match(digest[0].text, /7 new bookings\nMulti-Purpose Court, Thu 8 Oct, 8:00-9:00 AM \(1 hr\)/);
  assert.match(digest[0].text, /\+1 more - see the daily update\./);
});

test('morning digest tells the admin about regular slots open on Ticqet, once per slot', async () => {
  const { clock, phone, engine } = setup({ at: '2026-10-06T06:30:00Z' });
  await engine.tick(); // nothing blocked on Ticqet at all
  await engine.minuteTick();
  const open = phone.kind('open-regular-slots');
  assert.deepEqual(to(open), [ADMIN]);
  assert.match(open[0].text, /Tue 6 Oct: Multi-Purpose Court 5-7PM MTN/);
  assert.doesNotMatch(open[0].text, /RwandAir/, 'RwandAir ended on 9 Oct, Mon 12 Oct is not theirs');
  clock.set('2026-10-07T06:30:00Z');
  await engine.tick();
  await engine.minuteTick();
  const open2 = phone.kind('open-regular-slots');
  assert.equal(open2.length, 2, 'a new day came into range');
  assert.match(open2[1].text, /Tue 13 Oct: Multi-Purpose Court 5-7PM MTN/);
  assert.doesNotMatch(open2[1].text, /Tue 6 Oct/);
});

test('renewal reminder goes to the admin once, 3 days before Until', async () => {
  const { clock, phone, engine } = setup({ at: '2026-10-06T06:30:00Z' });
  await engine.tick();
  await engine.minuteTick();
  const ren = phone.kind('renewal');
  assert.deepEqual(to(ren), [ADMIN]);
  assert.match(ren[0].text, /RwandAir's arrangement ends Fri 9 Oct \(in 3 days\)\.\nMulti-Purpose Court: Mon 5-7PM/);
  clock.set('2026-10-07T06:30:00Z');
  await engine.tick();
  await engine.minuteTick();
  assert.equal(phone.kind('renewal').length, 1);
});

test('silence alarm: admin told once when Ticqet is unreadable, and when it is back', async () => {
  const { clock, ticqet, phone, engine } = setup({ at: '2026-10-06T10:00:00Z' });
  await engine.tick();
  ticqet.goDown();
  clock.addMinutes(16);
  await engine.minuteTick();
  const alarm = phone.kind('technical');
  assert.deepEqual(to(alarm), [ADMIN]);
  assert.match(alarm[0].text, /Could not read Ticqet bookings for 16 min/);
  clock.addMinutes(5);
  await engine.minuteTick();
  assert.equal(phone.kind('technical').length, 1, 'not repeated');
  ticqet.goUp();
  await engine.minuteTick();
  assert.match(phone.kind('technical-recovered')[0].text, /back to normal/);
});

test('silence alarm waits for the end of quiet hours', async () => {
  const { clock, ticqet, phone, engine } = setup({ at: '2026-10-06T23:10:00Z' });
  await engine.tick();
  ticqet.goDown();
  clock.addMinutes(30);
  await engine.minuteTick();
  assert.equal(phone.kind('technical').length, 0, 'nobody woken up');
  clock.set('2026-10-07T06:00:00Z');
  await engine.minuteTick();
  assert.equal(phone.kind('technical').length, 1, 'still down in the morning -> alert');
});

test('near the daily limit, booking alerts pause first so reminders still go out; then the hard stop', async () => {
  // Limit 9: booking alerts stop at 6 messages, the rest is kept for reminders.
  const { clock, ticqet, phone, engine } = setup({ at: '2026-10-06T10:00:00Z', settings: { maxMessagesPerDay: 9 } });
  ticqet.set(TUE6, [{ id: 'mtn', seats: ['17', '18'] }]);
  await engine.tick();
  ticqet.add(THU8, { id: 'k1', seats: ['9'] });
  await engine.tick(); // 3 messages
  ticqet.add(FRI9, { id: 'k2', seats: ['9'] });
  await engine.tick(); // 6 messages
  ticqet.add(TUE13, { id: 'k3', seats: ['9'] });
  await engine.tick(); // alerts pause; the admin is told (7)
  assert.equal(phone.kind('new-booking').length, 6);
  const paused = phone.kind('send-cap');
  assert.deepEqual(to(paused), [ADMIN]);
  assert.match(paused[0].text, /Booking alerts paused\n6 messages sent today/);
  ticqet.add(THU15, { id: 'k4', seats: ['9'] });
  await engine.tick();
  assert.equal(phone.kind('new-booking').length, 6, 'still paused');
  assert.equal(phone.kind('send-cap').length, 1, 'the admin is told once');
  clock.set('2026-10-06T16:00:00Z');
  await engine.minuteTick();
  clock.set('2026-10-06T16:45:00Z');
  await engine.minuteTick();
  assert.equal(phone.kind('reminder').length, 2, 'both reminders still go out (8, 9)');
  ticqet.add('Friday 16 October 2026', { id: 'k5', seats: ['9'] });
  await engine.tick();
  assert.match(phone.kind('send-cap').at(-1).text, /Daily message limit of 9 reached/, 'then the hard stop');
});

test('a failing number does not stop the others', async () => {
  const { ticqet, phone, engine } = setup();
  phone.broken.add(TEAM1);
  await engine.tick();
  ticqet.add(THU8, { id: 'f1', seats: ['9'] });
  await engine.tick();
  assert.deepEqual(to(phone.kind('new-booking')), [ATTENDANT, TEAM3].sort());
});

test('restarting repeats nothing, and announces what changed while the agent was off', async () => {
  const { ticqet, phone, engine, make } = setup();
  ticqet.set(THU8, [{ id: 'keep', seats: ['9'] }, { id: 'gone', seats: ['12'] }]);
  await engine.tick();
  const again = make(); // simulated restart: state comes back from disk
  await again.tick();
  assert.equal(phone.sent.length, 0);
  ticqet.remove(THU8, 'gone'); // happened while the agent was off
  ticqet.add(FRI9, { id: 'new', seats: ['14'] });
  const third = make();
  await third.tick();
  assert.equal(phone.kind('cancelled').length, 3);
  assert.equal(phone.kind('new-booking').length, 3);
});

test('after a restart at 6:30, the daily update waits for fresh Ticqet data', async () => {
  const { clock, ticqet, phone, engine } = setup({ at: '2026-10-07T06:30:00Z' });
  ticqet.set(WED7, [{ id: 'w', seats: ['18', '19'] }]);
  await engine.minuteTick(); // no data loaded yet
  assert.equal(phone.kind('daily').length, 0);
  await engine.tick();
  clock.addMinutes(1);
  await engine.minuteTick();
  assert.match(phone.kind('daily')[0].text, /6:00-8:00 PM Ticqet booking\nTotal booked: 2 hrs/);
});

test('Kigali time: the 6:30 AM daily goes out at 04:30 UTC', async () => {
  const { ticqet, phone, engine } = setup({ at: '2026-10-07T04:30:00Z', settings: { timezone: 'Africa/Kigali' } });
  ticqet.set(WED7, []);
  await engine.tick();
  await engine.minuteTick();
  assert.match(phone.kind('daily')[0].text, /Today, Wed 7 Oct\nMulti-Purpose Court\nNo bookings yet\./);
});

test('changes to sessions that already ended today are not alerted', async () => {
  const { ticqet, phone, engine } = setup({ at: '2026-10-06T20:00:00Z' });
  ticqet.set(TUE6, [{ id: 'mtn', seats: ['17', '18'] }]);
  await engine.tick();
  ticqet.set(TUE6, []);
  await engine.tick();
  assert.equal(phone.sent.length, 0);
});

test('switching channel (preview -> WhatsApp) sends the welcome once more, on the new channel', async () => {
  const { cfg, phone, engine } = setup({ settings: { sendWelcome: true } });
  await engine.tick();
  assert.equal(phone.kind('welcome').length, 4);
  cfg.settings.channel = 'whatsapp-cloud';
  await engine.tick();
  await engine.tick();
  assert.equal(phone.kind('welcome').length, 8);
  assert.match(phone.kind('welcome')[7].text, /on WhatsApp/);
});

// ---------- several facilities ----------

const PITCH_REGULARS = [
  ...REGULARS,
  { client: 'LOCAL CHAMPIONS', facility: '5-a-side Pitch A', day: 'Saturday', start: '08:00', end: '10:00', type: 'Monthly', from: '2026-10-09', until: '2026-10-31' },
  { client: 'LOCAL CHAMPIONS', facility: '5-a-side Pitch B', day: 'Saturday', start: '08:00', end: '10:00', type: 'Monthly', from: '2026-10-09', until: '2026-10-31' },
  { client: 'INSPIRE STARS', facility: '5-a-side Pitch A', day: 'Saturday', start: '18:00', end: '20:00', type: 'Monthly', from: '2026-10-09', until: '2026-10-31' },
  { client: 'INSPIRE STARS', facility: '5-a-side Pitch B', day: 'Saturday', start: '18:00', end: '20:00', type: 'Monthly', from: '2026-10-09', until: '2026-10-31' },
];

test('pitches added to a running agent: their bookings are noted quietly, everyone is told once, alerts name the pitch', async () => {
  const s = setup({ at: '2026-10-09T08:00:00Z', settings: { sendWelcome: true }, regulars: PITCH_REGULARS });
  s.ticqet.set(SAT10, [{ id: 'ev', seats: hours(7, 24) }]);
  await s.engine.tick(); // the court only, as before
  assert.equal(s.phone.kind('welcome').length, 4);
  // The sheet now watches the pitches too (pitches with many bookings already).
  s.cfg.settings = withDefaults({ ...s.cfg.settings, facilities: FACILITIES });
  s.ticqet.set(SAT10, [{ id: 'lc', seats: ['12', '13'] }, { id: 'is', seats: ['18', '19'] }], PITCH_A);
  s.ticqet.set(SAT17, [{ id: 'lc17', seats: ['8', '9'] }], PITCH_B);
  const engine = s.make();
  s.phone.clear();
  await engine.tick();
  assert.equal(s.phone.kind('new-booking').length, 0, 'existing pitch bookings are not "new"');
  const added = s.phone.kind('facilities-added');
  assert.deepEqual(to(added), [TEAM1, ATTENDANT, TEAM3, ADMIN].sort());
  assert.match(added[0].text, /Now also watching 5-a-side Pitch A and 5-a-side Pitch B\n/);
  await engine.tick();
  assert.equal(s.phone.kind('facilities-added').length, 4, 'told once');

  s.ticqet.add('Wednesday 14 October 2026', { id: 'w', seats: ['20'] }, PITCH_B);
  await engine.tick();
  assert.match(s.phone.kind('new-booking')[0].text, /New booking\n5-a-side Pitch B, Wed 14 Oct, 8:00-9:00 PM \(1 hr\)/);
  const log = readLog();
  assert.ok(log.some((e) => e.event === 'first-seen' && e.facility === '5-a-side Pitch A' && e.id === 'lc'));
});

test('sessions starting together at different facilities share one reminder', async () => {
  const { clock, ticqet, phone, engine } = setup({ at: '2026-10-17T16:00:00Z', settings: { facilities: FACILITIES }, regulars: PITCH_REGULARS });
  ticqet.set(SAT17, [{ id: 'a', seats: ['18', '19'] }], PITCH_A);
  ticqet.set(SAT17, [{ id: 'b', seats: ['18', '19'] }], PITCH_B);
  await engine.tick();
  clock.set('2026-10-17T17:00:00Z');
  await engine.minuteTick();
  const r = phone.kind('reminder');
  assert.deepEqual(to(r), [ATTENDANT], 'one email, not one per pitch');
  assert.equal(r[0].text, [
    'ZARIA COURT: Reminder',
    'Today 6:00 PM: 5-a-side Pitch A and 5-a-side Pitch B.',
    '5-a-side Pitch A, 6:00-8:00 PM: INSPIRE STARS (regular client).',
    '5-a-side Pitch B, 6:00-8:00 PM: INSPIRE STARS (regular client).',
    'Please open them and have balls ready by 5:45 PM.',
  ].join('\n'));
  clock.set('2026-10-17T17:45:00Z');
  await engine.minuteTick();
  assert.equal(phone.kind('reminder').length, 2);
  assert.match(phone.kind('reminder')[1].text, /^ZARIA COURT: Starts in 15 min\n6:00 PM: 5-a-side Pitch A and 5-a-side Pitch B\./);
});

test('daily update covers every facility', async () => {
  const { ticqet, phone, engine } = setup({ at: '2026-10-10T06:30:00Z', settings: { facilities: FACILITIES }, regulars: PITCH_REGULARS });
  ticqet.set(SAT10, [{ id: 'ev', seats: hours(7, 24) }]);
  ticqet.set(SAT10, [{ id: 'is', seats: ['18', '19'] }], PITCH_A);
  await engine.tick();
  await engine.minuteTick();
  const daily = phone.kind('daily')[0].text;
  assert.match(daily, /Multi-Purpose Court \(17 hrs\):\n7:00 AM-12:00 AM Event \/ setup\n5-a-side Pitch A \(4 hrs\):\n8:00-10:00 AM LOCAL CHAMPIONS \(regular\)\n6:00-8:00 PM INSPIRE STARS \(regular\)\n5-a-side Pitch B \(4 hrs\):/);
});

// ---------- event days ----------

const COURT_REGULARS = [
  { client: 'Horizon', facility: 'Multi-Purpose Court', day: 'Friday', start: '15:00', end: '17:00', type: 'Monthly', from: null, until: null },
  { client: 'Oxygen 250', facility: 'Multi-Purpose Court', day: 'Friday', start: '19:00', end: '21:00', type: 'Monthly', from: null, until: null },
];

test('event day: the day before, after the morning update, the team and admin get the teams to call', async () => {
  const { clock, ticqet, phone, engine } = setup({ at: '2026-10-08T05:00:00Z', regulars: COURT_REGULARS });
  // Friday: the court is booked 7 AM-7 PM and 9 PM-midnight, around Oxygen 250's block.
  ticqet.set(FRI9, [{ id: 'ev', seats: [...hours(7, 19), ...hours(21, 24)] }, { id: 'ox', seats: ['19', '20'] }]);
  await engine.tick();
  await engine.minuteTick();
  assert.equal(phone.kind('event-day').length, 0, 'not before the morning update');
  clock.set('2026-10-08T06:30:00Z');
  await engine.tick();
  await engine.minuteTick();
  assert.equal(phone.sent.findIndex((m) => m.kind === 'daily') < phone.sent.findIndex((m) => m.kind === 'event-day'), true, 'after the daily update');
  const ev = phone.kind('event-day');
  assert.deepEqual(to(ev), [TEAM1, ATTENDANT, TEAM3, ADMIN].sort());
  assert.equal(ev[0].text, [
    'ZARIA COURT: Event tomorrow, Fri 9 Oct',
    'Multi-Purpose Court: booked 7:00 AM-7:00 PM + 9:00 PM-12:00 AM (15 hrs) for an event or setup.',
    'Please call these teams - Multi-Purpose Court is not available tomorrow:',
    '3:00-5:00 PM Horizon (regular) - their usual hours are inside the event booking',
    '7:00-9:00 PM Oxygen 250 (regular)',
  ].join('\n'));
  clock.addMinutes(30);
  await engine.minuteTick();
  assert.equal(phone.kind('event-day').length, 4, 'once');
});

test('event booked: alert with the teams to call; for tomorrow it is the day-before notice', async () => {
  const { clock, ticqet, phone, engine } = setup({ at: '2026-10-08T10:00:00Z', regulars: COURT_REGULARS });
  ticqet.set(FRI9, [{ id: 'ox', seats: ['19', '20'] }]);
  await engine.tick();
  ticqet.add(FRI9, { id: 'ev', seats: hours(8, 19) });
  await engine.tick();
  const booked = phone.kind('event-booked');
  assert.deepEqual(to(booked), [TEAM1, ATTENDANT, TEAM3, ADMIN].sort());
  assert.match(booked[0].text, /^ZARIA COURT: Event booked for tomorrow\nMulti-Purpose Court, Fri 9 Oct, 8:00 AM-7:00 PM \(11 hrs\): an event or setup\.\nPlease call these teams - Multi-Purpose Court is not available tomorrow:\n3:00-5:00 PM Horizon/);
  assert.equal(phone.kind('new-booking').length, 0, 'not also a plain new-booking alert');
  await engine.minuteTick();
  assert.equal(phone.kind('event-day').length, 0, 'no second notice for tomorrow');
  // Further ahead: no call list yet; the day-before notice will follow.
  ticqet.add(SAT17, { id: 'ev2', seats: hours(8, 22) });
  await engine.tick();
  assert.match(phone.kind('event-booked').at(-1).text, /^ZARIA COURT: Event booked\nMulti-Purpose Court, Sat 17 Oct, 8:00 AM-10:00 PM \(14 hrs\): an event or setup\.\nNo other team is booked at Multi-Purpose Court that day\./);
  clock.set('2026-10-16T06:30:00Z');
  await engine.tick();
  await engine.minuteTick();
  assert.match(phone.kind('event-day').at(-1).text, /^ZARIA COURT: Event tomorrow, Sat 17 Oct/);
});

test('an event booked overnight: in the morning update, and a same-day call list if teams play later', async () => {
  const regulars = [...COURT_REGULARS, { client: 'Weekend Club', facility: 'Multi-Purpose Court', day: 'Saturday', start: '18:00', end: '20:00', type: 'Monthly', from: null, until: null }];
  const { clock, ticqet, phone, engine } = setup({ at: '2026-10-09T23:30:00Z', regulars });
  await engine.tick();
  ticqet.add(SAT10, { id: 'ev', seats: hours(7, 17) });
  await engine.tick();
  assert.equal(phone.sent.length, 0, 'quiet hours');
  clock.set('2026-10-10T06:30:00Z');
  await engine.tick();
  await engine.minuteTick();
  assert.match(phone.kind('daily')[0].text, /Overnight:\nEvent booked: Multi-Purpose Court, Sat 10 Oct, 7:00 AM-5:00 PM \(10 hrs\)/);
  const today = phone.kind('event-day');
  assert.equal(today.length, 4);
  assert.match(today[0].text, /^ZARIA COURT: Event today, Sat 10 Oct\n.*\nPlease call these teams - Multi-Purpose Court is not available today:\n6:00-8:00 PM Weekend Club \(regular\)$/);
});

// ---------- schedule changes ----------

const EMAIL_CONTACTS = CONTACTS.map((c, i) => ({ ...c, email: `p${i}@zaria.rw` }));
const EMAILS = EMAIL_CONTACTS.map((c) => c.email).sort();

test('a ticked schedule change is emailed to everyone once, again as "Updated" when edited', async () => {
  const change = { date: '2026-10-13', client: 'mtn', newTime: '18:00-20:00', reason: 'Car-free day', email: true };
  const s = setup({ at: '2026-10-06T10:00:00Z', settings: { channel: 'email' }, contacts: EMAIL_CONTACTS, changes: [change, { date: '2026-10-13', client: 'MTN', reason: 'Bring bibs' }] });
  s.ticqet.set(TUE13, [{ id: 'old', seats: ['17', '18'] }]); // MTN's usual block, already on Ticqet
  await s.engine.tick();
  await s.engine.minuteTick();
  const sent = s.phone.kind('schedule-change');
  assert.deepEqual(to(sent), EMAILS, 'everyone');
  assert.equal(sent[0].text, 'ZARIA COURT: Schedule change, Tue 13 Oct\nMTN play 6:00-8:00 PM instead of 5:00-7:00 PM, at Multi-Purpose Court.\nReason: Car-free day.');
  assert.equal(s.engine.changeStatus.get(5), 'OK: MTN play 6:00-8:00 PM instead of 5:00-7:00 PM, at Multi-Purpose Court. Emailed to 4 people on Tue 6 Oct, 10:00 AM.');
  assert.equal(s.engine.changeStatus.get(6), 'OK: Note about MTN, shown in the daily update. Not emailed (tick Email everyone to send it).');
  await s.engine.minuteTick();
  assert.equal(s.phone.kind('schedule-change').length, 4, 'not twice');

  // Edited: sent again, marked as an update.
  s.cfg.changes = cleanChanges([{ row: 5, ...change, newTime: '19:00-21:00' }], { regulars: REGULARS, facilities: s.cfg.settings.facilities });
  await s.engine.minuteTick();
  assert.match(s.phone.kind('schedule-change').at(-1).text, /^ZARIA COURT: Updated: Schedule change, Tue 13 Oct\nMTN play 7:00-9:00 PM instead of 5:00-7:00 PM/);

  // On the day: no reminder for the usual hours (still blocked on Ticqet), reminders for the new ones.
  s.clock.set('2026-10-13T16:00:00Z');
  await s.engine.tick();
  await s.engine.minuteTick();
  assert.equal(s.phone.kind('reminder').length, 0, 'no reminder at 5 PM: MTN moved');
  s.clock.set('2026-10-13T18:00:00Z');
  await s.engine.minuteTick();
  assert.match(s.phone.kind('reminder')[0].text, /Multi-Purpose Court, today 7:00-9:00 PM: MTN \(regular client\) - moved from 5:00-7:00 PM \(Car-free day\)\./);
});

test('schedule changes wait for the end of quiet hours, and go out for real after Preview', async () => {
  const change = { date: '2026-10-13', client: 'MTN', newTime: 'Cancelled', reason: 'Umuganda', email: true };
  const s = setup({ at: '2026-10-06T23:30:00Z', changes: [change] });
  await s.engine.tick();
  await s.engine.minuteTick();
  assert.equal(s.phone.sent.length, 0);
  assert.match(s.engine.changeStatus.get(5), /Will be emailed at 6:00 AM, when quiet hours end\./);
  s.clock.set('2026-10-07T06:00:00Z');
  await s.engine.minuteTick();
  assert.equal(s.phone.kind('schedule-change').length, 4);
  assert.match(s.engine.changeStatus.get(5), /Written to the Preview tab .*Channel is Preview/);
  s.cfg.settings.channel = 'email';
  s.cfg.contacts = CONTACTS.map((c, i) => ({ ...c, email: `p${i}@zaria.rw` }));
  await s.engine.minuteTick();
  assert.equal(s.phone.kind('schedule-change').length, 8, 'sent for real once Channel is Email');
  assert.match(s.engine.changeStatus.get(5), /Emailed to 4 people/);
});

test('a change whose new time is already over is not emailed', async () => {
  const s = setup({ at: '2026-10-13T19:30:00Z', changes: [{ date: '2026-10-13', client: 'MTN', newTime: '18:00-19:00', reason: 'Late start', email: true }] });
  await s.engine.tick();
  await s.engine.minuteTick();
  assert.equal(s.phone.kind('schedule-change').length, 0);
  assert.equal(s.engine.changeStatus.get(5), 'Over: MTN play 6:00-7:00 PM instead of 5:00-7:00 PM, at Multi-Purpose Court. That time has passed, so it is not emailed.');
});

test('a team not playing gets no reminder; a booking made later in those hours is real', async () => {
  const s = setup({ at: '2026-10-13T15:00:00Z', changes: [{ date: '2026-10-13', client: 'MTN', newTime: 'Cancelled', reason: 'Team away' }] });
  s.ticqet.set(TUE13, [{ id: 'mtn', seats: ['17', '18'] }]);
  await s.engine.tick();
  s.clock.set('2026-10-13T16:00:00Z');
  await s.engine.minuteTick();
  assert.equal(s.phone.kind('reminder').length, 0, 'MTN is not coming');
  assert.equal(s.phone.kind('open-regular-slots').length, 0);
  // Zaria frees the hours; a customer books 5-6 PM.
  s.clock.set('2026-10-13T16:02:00Z');
  s.ticqet.set(TUE13, []);
  await s.engine.tick();
  assert.match(s.phone.kind('cancelled')[0].text, /FREE \(was MTN's regular slot\)/);
  s.ticqet.add(TUE13, { id: 'cust', seats: ['17'] });
  await s.engine.tick();
  assert.deepEqual(to(s.phone.kind('new-booking')), [TEAM1, TEAM3].sort(), 'a real new booking for the team');
  assert.deepEqual(to(s.phone.kind('last-minute')), [ATTENDANT], 'starts within the hour: the attendant is told now');
});

test('Umuganda: the admin hears 3 days before about sessions booked during it', async () => {
  const s = setup({ at: '2026-10-28T06:30:00Z', settings: { facilities: FACILITIES }, regulars: PITCH_REGULARS });
  s.ticqet.set(SAT31, [{ id: 'lc', seats: ['8', '9'] }], PITCH_A);
  await s.engine.tick();
  await s.engine.minuteTick();
  const u = s.phone.kind('umuganda');
  assert.deepEqual(to(u), [ADMIN]);
  assert.equal(u[0].text, [
    'ZARIA COURT: Umuganda on Sat 31 Oct',
    'Umuganda is 8:00-11:00 AM. Booked during Umuganda:',
    '5-a-side Pitch A: 8:00-10:00 AM LOCAL CHAMPIONS (regular)',
    '5-a-side Pitch B: 8:00-10:00 AM LOCAL CHAMPIONS (regular)',
    'If they move or will not play, add a row on the Schedule Changes tab and tick Email everyone.',
  ].join('\n'));
  s.clock.set('2026-10-29T06:30:00Z');
  await s.engine.tick();
  await s.engine.minuteTick();
  assert.equal(s.phone.kind('umuganda').length, 1, 'once');
  s.clock.set('2026-10-31T06:30:00Z');
  await s.engine.tick();
  await s.engine.minuteTick();
  assert.match(s.phone.kind('daily').at(-1).text, /Today, Sat 31 Oct\nUmuganda today, 8:00-11:00 AM\.\n.*\n.*\n8:00-10:00 AM LOCAL CHAMPIONS \(regular\) - during Umuganda/);
});

// ---------- upgrading from the court-only version ----------

test('state saved by the court-only version carries over: nothing logged or reminded twice', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaria-engine-'));
  const write = (f, v) => fs.writeFileSync(path.join(dir, f), JSON.stringify(v));
  const day = { y: 2026, m: 10, d: 6, label: TUE6 };
  write('snapshot.json', { days: { [TUE6]: [{ id: 'mtn', date: day, slots: [17, 18], ranges: [{ startHour: 17, endHour: 19 }], hours: 2, section: null }] } });
  write('reminders.json', ['rem|2026-10-06|17|60']);
  write('jobs.json', { 'welcome|preview': '2026-10-05T08:00:00Z', 'open|2026-10-06|MTN|17': true });
  const s = setup({ at: '2026-10-06T16:05:00Z', dir, settings: { facilities: FACILITIES }, regulars: PITCH_REGULARS });
  s.ticqet.set(TUE6, [{ id: 'mtn', seats: ['17', '18'] }]);
  s.ticqet.set(SAT10, [{ id: 'lc', seats: ['12', '13'] }], PITCH_A);
  await s.engine.tick();
  await s.engine.minuteTick();
  assert.equal(s.phone.kind('reminder').length, 0, 'the 60-min reminder was sent by the old version');
  assert.ok(!readLog().some((e) => e.facility === 'Multi-Purpose Court'), 'court bookings not logged again');
  assert.ok(readLog().some((e) => e.facility === '5-a-side Pitch A' && e.event === 'first-seen'), 'the pitch\'s bookings are');
  assert.equal(s.phone.kind('facilities-added').length, 4, 'everyone hears about the pitches');
  assert.ok(s.engine.jobs['open|2026-10-06|wyUcHcKLSP52EBIr9asf|MTN|17']);
});
