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

// ---------- fakes ----------
class FakeClock {
  constructor(iso) { this.t = new Date(iso); }
  set(iso) { this.t = new Date(iso); }
  addMinutes(m) { this.t = new Date(this.t.getTime() + m * 60000); }
  addSeconds(s) { this.t = new Date(this.t.getTime() + s * 1000); }
  now() { return new Date(this.t); }
}

class FakeTicqet {
  constructor(clock) {
    this.clock = clock;
    this.days = new Map();
    this.watched = [];
    this.frozenAt = null; // set while "unreachable"
    this.oldestErrorAt = null;
  }
  watch(labels) { this.watched = labels; }
  get(label) { return this.watched.includes(label) ? this.days.get(label) || [] : undefined; }
  get lastContactAt() { return this.frozenAt ?? this.clock.now().getTime(); }
  set(label, records) { this.days.set(label, records); }
  add(label, record) { this.days.set(label, [...(this.days.get(label) || []), record]); }
  remove(label, id) { this.days.set(label, (this.days.get(label) || []).filter((r) => r.id !== id)); }
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
const TUE13 = 'Tuesday 13 October 2026';
const THU15 = 'Thursday 15 October 2026';
const TUE20 = 'Tuesday 20 October 2026';

function setup({ at = '2026-10-06T08:00:00Z', settings = {}, regulars = REGULARS, contacts = CONTACTS } = {}) {
  process.env.ZARIA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zaria-engine-'));
  const clock = new FakeClock(at);
  const ticqet = new FakeTicqet(clock);
  const phone = new FakePhone();
  const cfg = {
    settings: withDefaults({ timezone: 'UTC', sendWelcome: false, ...settings, watch: { windowDays: 14, settleSeconds: 0, probeMinutes: 5, ...settings.watch } }),
    regulars,
    contacts,
  };
  const make = () => new Engine({ cfg, source: ticqet, sender: phone, clock });
  return { clock, ticqet, phone, cfg, engine: make(), make };
}

const to = (msgs) => msgs.map((m) => m.to).sort();

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
  assert.match(nb[0].text, /New booking\nMulti-Purpose Court\nThu 8 Oct, 10:00 AM-12:00 PM \(2 hrs\)/);
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
  assert.match(msgs[0].text, /Fri 9 Oct, 3:00-5:00 PM \(2 hrs\) is now FREE\./);
});

test('a freed regular block says whose slot it was', async () => {
  const { ticqet, phone, engine } = setup();
  ticqet.set(TUE13, [{ id: 'mtn13', seats: ['17', '18'] }]);
  await engine.tick();
  ticqet.remove(TUE13, 'mtn13');
  await engine.tick();
  assert.match(phone.kind('cancelled')[0].text, /FREE \(was MTN's regular slot\)/);
});

test('a booking inside a regular slot goes to the admin as a check, not to the team', async () => {
  const { ticqet, phone, engine } = setup();
  await engine.tick();
  ticqet.add(TUE13, { id: 'r1', seats: ['17', '18'] });
  await engine.tick();
  assert.equal(phone.kind('new-booking').length, 0, 'no team alert');
  const check = phone.kind('regular-slot-check');
  assert.deepEqual(to(check), [ADMIN]);
  assert.match(check[0].text, /in MTN's usual slot, Tue 13 Oct 5:00-7:00 PM/);
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

test('many regular blocks at once produce ONE admin message', async () => {
  const { ticqet, phone, engine } = setup();
  await engine.tick();
  ticqet.add(TUE13, { id: 'm1', seats: ['17', '18'] });
  ticqet.add('Monday 12 October 2026', { id: 'm2', seats: ['17'] }); // RwandAir ended 9 Oct -> not a regular now
  ticqet.add(TUE6, { id: 'm3', seats: ['17', '18'] });
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
  assert.match(lm[0].text, /Starts in 40 min/);
  assert.deepEqual(to(phone.kind('new-booking')), [TEAM1, TEAM3].sort(), 'attendant is not messaged twice');
  phone.clear();
  clock.set('2026-10-06T15:45:00Z');
  await engine.minuteTick();
  assert.equal(phone.kind('reminder').length, 0, 'no 15-min reminder for the 4 PM booking');
  clock.set('2026-10-06T16:00:00Z');
  await engine.minuteTick();
  assert.match(phone.kind('reminder')[0].text, /5:00-7:00 PM \(MTN \(regular client\)\)/, 'the 5 PM session still gets its reminder');
});

test('a booking made after its start time asks attendants to open the court now', async () => {
  const { ticqet, phone, engine } = setup({ at: '2026-10-06T10:10:00Z' });
  await engine.tick();
  ticqet.add(TUE6, { id: 'late', seats: ['10', '11'] });
  await engine.tick();
  assert.match(phone.kind('last-minute')[0].text, /already started - please open the court now/);
});

test('reminders go to attendants only, 60 and 15 minutes before, once each, up to 5 min late', async () => {
  const { clock, ticqet, phone, engine } = setup({ at: '2026-10-06T15:00:00Z' });
  ticqet.set(TUE6, [{ id: 'mtn', seats: ['17', '18'] }]);
  await engine.tick();
  clock.set('2026-10-06T16:00:00Z');
  await engine.minuteTick();
  const r60 = phone.kind('reminder');
  assert.deepEqual(to(r60), [ATTENDANT]);
  assert.match(r60[0].text, /Reminder\nMulti-Purpose Court is booked today 5:00-7:00 PM \(MTN \(regular client\)\)\.\nPlease open the court and have balls ready by 4:45 PM\./);
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
  assert.match(daily[0].text, /Overnight:\nNew: Fri 9 Oct, 10:00 AM-12:00 PM \(2 hrs\)/);
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
  assert.match(weekly[0].text, /Overnight:\nNew: Thu 15 Oct, 6:00-7:00 PM \(1 hr\)/);
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
  assert.match(mass[0].text, /6 bookings disappeared from Ticqet at once \(Wed 7 Oct - Fri 16 Oct\)/);
});

test('many new bookings at once send ONE summary to the team', async () => {
  const { ticqet, phone, engine } = setup();
  await engine.tick();
  for (let h = 8; h < 15; h++) ticqet.add(THU8, { id: `n${h}`, seats: [String(h)] });
  await engine.tick();
  assert.equal(phone.kind('new-booking').length, 0);
  const digest = phone.kind('bookings-digest');
  assert.equal(digest.length, 3);
  assert.match(digest[0].text, /7 new bookings/);
  assert.match(digest[0].text, /\+1 more - see the daily update\./);
});

test('morning digest tells the admin about regular slots open on Ticqet, once per slot', async () => {
  const { clock, phone, engine } = setup({ at: '2026-10-06T06:30:00Z' });
  await engine.tick(); // nothing blocked on Ticqet at all
  await engine.minuteTick();
  const open = phone.kind('open-regular-slots');
  assert.deepEqual(to(open), [ADMIN]);
  assert.match(open[0].text, /Tue 6 Oct 5-7PM MTN/);
  assert.doesNotMatch(open[0].text, /RwandAir/, 'RwandAir ended on 9 Oct, Mon 12 Oct is not theirs');
  clock.set('2026-10-07T06:30:00Z');
  await engine.tick();
  await engine.minuteTick();
  const open2 = phone.kind('open-regular-slots');
  assert.equal(open2.length, 2, 'a new day came into range');
  assert.match(open2[1].text, /Tue 13 Oct 5-7PM MTN/);
  assert.doesNotMatch(open2[1].text, /Tue 6 Oct/);
});

test('renewal reminder goes to the admin once, 3 days before Until', async () => {
  const { clock, phone, engine } = setup({ at: '2026-10-06T06:30:00Z' });
  await engine.tick();
  await engine.minuteTick();
  const ren = phone.kind('renewal');
  assert.deepEqual(to(ren), [ADMIN]);
  assert.match(ren[0].text, /RwandAir's arrangement ends Fri 9 Oct \(in 3 days\)/);
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

test('daily message cap pauses team messages and tells the admin once', async () => {
  const { ticqet, phone, engine } = setup({ settings: { maxMessagesPerDay: 4 } });
  await engine.tick();
  ticqet.add(THU8, { id: 'k1', seats: ['9'] });
  await engine.tick(); // 3 messages
  ticqet.add(FRI9, { id: 'k2', seats: ['9'] });
  await engine.tick(); // 1 more, then the cap
  ticqet.add(TUE13, { id: 'k3', seats: ['9'] });
  await engine.tick();
  assert.equal(phone.kind('new-booking').length, 4);
  const cap = phone.kind('send-cap');
  assert.deepEqual(to(cap), [ADMIN]);
  assert.match(cap[0].text, /Daily message limit of 4 reached/);
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
