// End-to-end test of the built Google Apps Script file (Code.gs). It runs in a
// bare JavaScript context - no Node features, like Apps Script - against fake
// Google services: a sheet, script properties, Gmail, a timer, and a fake
// Ticqet answering the same HTTPS calls the real one does.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { buildAppsScript, localDefaults } from '../apps-script/build.mjs';

const KEY = `AIza${'K'.repeat(35)}`;
const EVENT = 'wyUcHcKLSP52EBIr9asf';

// ---------- fake Google services ----------

// Any formatting call (setFontWeight, setBackground, ...) is accepted and ignored.
function chainable(target) {
  const proxy = new Proxy(target, {
    get: (t, prop) => (prop in t ? t[prop] : () => proxy),
  });
  return proxy;
}

class FakeSheet {
  constructor(name) {
    this.name = name;
    this.cells = []; // rows of values
  }
  getName() { return this.name; }
  getLastRow() {
    for (let r = this.cells.length; r > 0; r--) if ((this.cells[r - 1] || []).some((v) => v !== '' && v !== undefined && v !== null)) return r;
    return 0;
  }
  getDataRange() {
    const rows = this.getLastRow();
    const cols = Math.max(0, ...this.cells.slice(0, rows).map((r) => (r || []).length));
    return this.getRange(1, 1, Math.max(rows, 1), Math.max(cols, 1));
  }
  getRange(row, col, numRows = 1, numCols = 1) {
    if (typeof row !== 'number') return chainable({}); // "A:D" style ranges: formatting only
    const sheet = this;
    return chainable({
      setValues(values) {
        values.forEach((vals, i) => vals.forEach((v, j) => sheet.set(row + i, col + j, v)));
        return this;
      },
      setValue(v) { sheet.set(row, col, v); return this; },
      getValues() {
        return Array.from({ length: numRows }, (_, i) => Array.from({ length: numCols }, (_, j) => sheet.get(row + i, col + j)));
      },
      insertCheckboxes() {
        for (let i = 0; i < numRows; i++) for (let j = 0; j < numCols; j++) if (sheet.get(row + i, col + j) === '') sheet.set(row + i, col + j, false);
        return this;
      },
    });
  }
  set(r, c, v) {
    while (this.cells.length < r) this.cells.push([]);
    const line = this.cells[r - 1];
    while (line.length < c) line.push('');
    line[c - 1] = v;
  }
  get(r, c) {
    const v = (this.cells[r - 1] || [])[c - 1];
    return v === undefined ? '' : v;
  }
  deleteRows(start, count) { this.cells.splice(start - 1, count); }
  insertColumnAfter(col) {
    for (const line of this.cells) if (line && line.length > col) line.splice(col, 0, '');
  }
  // test helpers
  rows() { return this.cells.slice(0, this.getLastRow()); }
  find(text) { return this.cells.findIndex((r) => (r || []).includes(text)) + 1; }
}

class FakeSpreadsheet {
  constructor() {
    this.sheets = [new FakeSheet('Sheet1')];
    this.toasts = [];
  }
  getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
  getSheets() { return [...this.sheets]; }
  insertSheet(name, index = this.sheets.length) {
    const s = chainable(new FakeSheet(name));
    this.sheets.splice(index, 0, s);
    return s;
  }
  deleteSheet(s) { this.sheets = this.sheets.filter((x) => x !== s); }
  getSpreadsheetTimeZone() { return 'Africa/Kigali'; }
  setSpreadsheetTimeZone() {}
  setSpreadsheetLocale() {}
  toast(msg) { this.toasts.push(msg); }
}

class FakeTicqet {
  constructor() {
    this.days = new Map(); // label -> [{ id, seats, created }]
    this.down = false;
    this.calls = 0;
  }
  add(label, id, seats, created = '2026-10-07T07:00:00.123456Z') {
    this.days.set(label, [...(this.days.get(label) || []), { id, seats, created }]);
  }
  remove(label, id) { this.days.set(label, (this.days.get(label) || []).filter((r) => r.id !== id)); }
  fetch(url, options = {}) {
    const reply = (code, text) => ({ getResponseCode: () => code, getContentText: () => text });
    if (url === 'https://ticqet.rw/main.dart.js') return reply(200, `x="kigali-arena";y="${KEY}"`);
    this.calls += 1;
    if (this.down) return reply(503, 'Service Unavailable');
    assert.ok(url.includes(`/events/${EVENT}:runQuery?key=${KEY}`), url);
    const labels = JSON.parse(options.payload).structuredQuery.where.fieldFilter.value.arrayValue.values.map((v) => v.stringValue);
    assert.ok(labels.length <= 30, 'Firestore allows at most 30 values per IN filter');
    const docs = labels.flatMap((label) => (this.days.get(label) || []).map((r) => ({
      document: {
        name: `projects/kigali-arena/databases/(default)/documents/events/${EVENT}/seats/${r.id}`,
        fields: {
          dateFormatted: { stringValue: label },
          seats: { arrayValue: { values: r.seats.map((s) => ({ stringValue: s })) } },
          section: { stringValue: 'MULTI PURPOSE COURT' },
        },
        createTime: r.created,
      },
      readTime: '2026-10-07T08:00:00Z',
    })));
    return reply(200, JSON.stringify(docs.length ? docs : [{ readTime: '2026-10-07T08:00:00Z' }]));
  }
}

function makeGoogle(startIso) {
  const clock = { now: Date.parse(startIso) };
  const RealDate = Date;
  class ClockDate extends RealDate {
    constructor(...args) { if (args.length) super(...args); else super(clock.now); }
    static now() { return clock.now; }
  }
  const ss = new FakeSpreadsheet();
  const ticqet = new FakeTicqet();
  const props = {};
  const sent = [];
  const triggers = [];
  const logs = [];
  const services = {
    Date: ClockDate,
    console: { log: (m) => logs.push(m), warn: (m) => logs.push(`WARN ${m}`), error: (m) => logs.push(`ERROR ${m}`) },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      newDataValidation: () => chainable({}),
      getUi: () => chainable({}),
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperties: () => ({ ...props }),
        setProperties: (o) => Object.assign(props, o),
        deleteProperty: (k) => { delete props[k]; },
      }),
    },
    MailApp: {
      sendEmail: (m) => { sent.push(m); },
      getRemainingDailyQuota: () => 100 - sent.length,
    },
    UrlFetchApp: { fetch: (url, o) => ticqet.fetch(url, o) },
    ScriptApp: {
      getProjectTriggers: () => triggers.map((t) => ({ getHandlerFunction: () => t.fn, t })),
      deleteTrigger: (h) => triggers.splice(triggers.indexOf(h.t), 1),
      newTrigger: (fn) => ({ timeBased: () => ({ everyMinutes: (minutes) => ({ create: () => triggers.push({ fn, minutes }) }) }) }),
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    Session: { getActiveUser: () => ({ getEmail: () => 'owner@example.com' }) },
    Utilities: {
      formatDate: (d, tz, f) => {
        const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
          timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
        }).formatToParts(d).map((x) => [x.type, x.value]));
        return f === 'HH:mm' ? `${p.hour}:${p.minute}` : `${p.year}-${p.month}-${p.day}`;
      },
    },
  };
  const context = vm.createContext(services);
  return {
    context, clock, ss, ticqet, props, sent, triggers, logs,
    at: (iso) => { clock.now = Date.parse(iso); },
    run: (fn) => vm.runInContext(`${fn}()`, context),
    sheet: (name) => ss.getSheetByName(name),
    clearSent: () => sent.splice(0),
  };
}

// The pre-fill the build takes from the local config: names and ticks only.
const DEFAULTS = {
  regulars: [
    { client: 'MTN', facility: 'Multi-Purpose Court', day: 'Thursday', start: '17:00', end: '19:00', type: 'Monthly', from: null, until: null },
  ],
  contacts: [
    { name: 'Jimmy', role: 'Operations', alerts: true, summaries: true, reminders: false, admin: false },
    { name: 'Alex', role: 'Attendant', alerts: true, summaries: true, reminders: true, admin: false },
    { name: 'Clovis', role: 'Admin', alerts: false, summaries: false, reminders: false, admin: true },
  ],
};
const EMAILS = { Jimmy: 'jimmy@zaria.rw', Alex: 'alex@gmail.com', Clovis: 'clovis@gmail.com' };

const code = await buildAppsScript({ defaults: DEFAULTS, write: false });

// Fill in the Email column and the channel, as the admin does after setup.
function goLive(g, channel = 'Email') {
  const contacts = g.sheet('Contacts');
  for (let r = 5; r <= contacts.getLastRow(); r++) contacts.set(r, 3, EMAILS[contacts.get(r, 1)] || '');
  const settings = g.sheet('Settings');
  settings.set(settings.find('Channel'), 2, channel);
}

const to = (msgs) => msgs.map((m) => m.to).sort();

test('Code.gs runs in a plain JavaScript context and exposes only the four entry points', () => {
  const g = makeGoogle('2026-10-07T08:00:00Z');
  vm.runInContext(code, g.context);
  for (const fn of ['setup', 'runAgent', 'sendTestEmail', 'onOpen']) assert.equal(typeof g.context[fn], 'function', fn);
  assert.match(code, /@OnlyCurrentDoc/);
  assert.doesNotMatch(code, /\brequire\(|\bprocess\.|setTimeout|setInterval/, 'no Node-only features');
  assert.doesNotMatch(code, /07\d{8}/, 'no phone numbers in the built file');
});

test('setup creates the tabs and the 5-minute timer; the first check is silent', async () => {
  const g = makeGoogle('2026-10-07T08:00:00Z'); // Wed 7 Oct, 10:00 in Kigali
  g.ticqet.add('Thursday 08 October 2026', 'mtn8', ['17', '18'], '2026-07-02T09:14:03.571518Z');
  g.ticqet.add('Saturday 10 October 2026', 'sat10', Array.from({ length: 17 }, (_, i) => String(7 + i)));
  vm.runInContext(code, g.context);
  await g.run('setup');

  assert.deepEqual(g.ss.getSheets().map((s) => s.getName()),
    ['Status', 'Bookings Log', 'Contacts', 'Regular Clients', 'Settings', 'Facilities', 'Preview'], 'Sheet1 removed');
  assert.deepEqual(g.triggers, [{ fn: 'runAgent', minutes: 5 }]);
  assert.equal(g.sent.length, 0, 'nothing emailed: channel is Preview and no emails are filled in yet');

  const contacts = g.sheet('Contacts').rows();
  assert.deepEqual(contacts[3].slice(5, 7), ['Reminder 1 (60 min before)', 'Reminder 2 (15 min before)']);
  assert.deepEqual(contacts[4], ['Jimmy', 'Operations', '', true, true, false, false, false]);
  assert.deepEqual(contacts[5].slice(0, 7), ['Alex', 'Attendant', '', true, true, true, true]);
  assert.equal(g.sheet('Settings').get(g.sheet('Settings').find('Channel'), 2), 'Preview');

  const log = g.sheet('Bookings Log').rows();
  assert.equal(log.length, 3, 'header + the two bookings already on Ticqet');
  assert.deepEqual(log[1].slice(1, 7), ['Already on Ticqet', 'Thu 8 Oct 2026', '5:00-7:00 PM', 2, 'MTN', '2026-07-02 11:14']);
  assert.deepEqual(log[2].slice(2, 5), ['Sat 10 Oct 2026', '7:00 AM-12:00 AM', 17]);

  const status = Object.fromEntries(g.sheet('Status').rows().slice(2));
  assert.match(status.Ticqet, /^OK - last read 2026-10-07 10:00/);
  assert.match(status.Channel, /^Preview/);
  assert.match(status['Things to check'], /Contacts row 5 \(Jimmy\): no email yet/);
  assert.equal(status['Errors in the last check'], 'None');

  // Running setup again (the menu's "Set up / repair") changes nothing the team typed.
  goLive(g, 'Preview');
  await g.run('setup');
  assert.equal(g.sheet('Contacts').get(5, 3), 'jimmy@zaria.rw');
  assert.equal(g.triggers.length, 1, 'still one timer');
});

test('preview, then email: welcome, new booking, nothing twice, reminders, Ticqet down and back', async () => {
  const g = makeGoogle('2026-10-07T08:00:00Z'); // Wed 7 Oct, 10:00 Kigali
  g.ticqet.add('Thursday 08 October 2026', 'mtn8', ['17', '18']);
  vm.runInContext(code, g.context);
  await g.run('setup');

  // Preview day: emails are only written to the Preview tab.
  goLive(g, 'Preview');
  g.at('2026-10-07T08:05:00Z');
  await g.run('runAgent');
  assert.equal(g.sent.length, 0);
  const preview = g.sheet('Preview').rows();
  assert.equal(preview.length, 4, 'header + one welcome per person');
  assert.equal(preview[1][1], 'welcome');
  assert.equal(preview[1][3], 'Booking alerts are on');
  assert.match(preview[1][4], /Multi-Purpose Court alerts: new Ticqet bookings/);

  // Switch to Email: the welcome goes out once more, for real.
  g.sheet('Settings').set(g.sheet('Settings').find('Channel'), 2, 'Email');
  g.at('2026-10-07T08:10:00Z');
  await g.run('runAgent');
  assert.deepEqual(to(g.sent), ['alex@gmail.com', 'clovis@gmail.com', 'jimmy@zaria.rw']);
  const welcome = g.sent.find((m) => m.to === 'jimmy@zaria.rw');
  assert.equal(welcome.subject, 'Booking alerts are on');
  assert.equal(welcome.name, 'Zaria Court Bookings');
  assert.equal(welcome.replyTo, 'clovis@gmail.com', 'replies reach the admin');
  assert.match(welcome.body, /alerts by email: new Ticqet bookings, a daily update at 6:30 AM/);
  assert.match(welcome.body, /Tell Clovis/);
  assert.match(welcome.htmlBody, /#093254/);
  g.clearSent();

  // A new online booking reaches the team (not the admin) at the next check.
  g.ticqet.add('Friday 09 October 2026', 'new1', ['10', '11'], '2026-10-07T08:12:30.5Z');
  g.at('2026-10-07T08:15:00Z');
  await g.run('runAgent');
  assert.deepEqual(to(g.sent), ['alex@gmail.com', 'jimmy@zaria.rw']);
  assert.equal(g.sent[0].subject, 'New booking: Fri 9 Oct, 10:00 AM-12:00 PM (2 hrs)');
  const last = g.sheet('Bookings Log').rows().at(-1);
  assert.deepEqual(last.slice(1, 8), ['New booking', 'Fri 9 Oct 2026', '10:00 AM-12:00 PM', 2, '', '2026-10-07 10:12', 'new1']);
  g.clearSent();

  // The next checks remember what was already sent.
  g.at('2026-10-07T08:20:00Z');
  await g.run('runAgent');
  g.at('2026-10-07T08:25:00Z');
  await g.run('runAgent');
  assert.equal(g.sent.length, 0, 'nothing twice');

  // Thursday: MTN plays 5-7 PM. Checks every 5 minutes, slightly off the hour.
  for (const t of ['13:52', '13:57', '14:02', '14:07', '14:12', '14:17', '14:22', '14:27', '14:32', '14:37', '14:42', '14:47', '14:52', '14:57']) {
    g.at(`2026-10-08T${t}:30Z`);
    await g.run('runAgent');
  }
  const reminders = g.sent.filter((m) => /Reminder|Starts in/.test(m.subject));
  assert.deepEqual(reminders.map((m) => [m.to, m.subject.split(':')[0]]), [
    ['alex@gmail.com', 'Reminder'],
    ['alex@gmail.com', 'Starts in 15 min'],
  ], 'each reminder once, to the attendant only');
  g.clearSent();

  // Ticqet stops answering: the admin hears once, after 15 minutes, and again when it is back.
  g.ticqet.down = true;
  for (const t of ['15:02', '15:07', '15:12', '15:17', '15:22']) {
    g.at(`2026-10-08T${t}:30Z`);
    await g.run('runAgent');
  }
  assert.deepEqual(g.sent.map((m) => [m.to, m.subject.split(':')[0]]), [['clovis@gmail.com', 'Agent alert']]);
  assert.match(Object.fromEntries(g.sheet('Status').rows().slice(2)).Ticqet, /NOT READABLE since 2026-10-08 17:02/);
  g.ticqet.down = false;
  g.at('2026-10-08T15:27:30Z');
  await g.run('runAgent');
  assert.equal(g.sent.at(-1).subject.split(':')[0], 'Agent back to normal');
});

test('a mistake in the sheet keeps the last good settings and tells the admin once', async () => {
  const g = makeGoogle('2026-10-07T08:00:00Z');
  vm.runInContext(code, g.context);
  await g.run('setup');
  goLive(g);
  g.at('2026-10-07T08:05:00Z');
  await g.run('runAgent');
  g.clearSent();

  g.sheet('Contacts').set(6, 3, 'alex@gmail'); // a typo
  g.ticqet.add('Friday 09 October 2026', 'b2', ['15']);
  g.at('2026-10-07T08:10:00Z');
  await g.run('runAgent');
  const problem = g.sent.find((m) => m.subject === 'Settings problem');
  assert.equal(problem.to, 'clovis@gmail.com');
  assert.match(problem.body, /Contacts row 6: "alex@gmail" is not a valid email address/);
  assert.ok(g.sent.some((m) => m.to === 'alex@gmail.com' && /^New booking/.test(m.subject)), 'alerts continue with the last good settings');
  assert.match(Object.fromEntries(g.sheet('Status').rows().slice(2))['Mistakes in the sheet'], /row 6/);

  g.clearSent();
  g.at('2026-10-07T08:15:00Z');
  await g.run('runAgent');
  assert.equal(g.sent.length, 0, 'the same mistake is reported only once');
});

test('a sheet made before the split gets Reminder 1 and Reminder 2 columns, with the same ticks', async () => {
  const g = makeGoogle('2026-10-08T08:00:00Z'); // Thu 8 Oct, 10:00 Kigali; MTN plays 5-7 PM
  g.ticqet.add('Thursday 08 October 2026', 'mtn8', ['17', '18']);
  vm.runInContext(code, g.context);
  await g.run('setup');
  // Rebuild the Contacts tab the way the first version made it (one reminder column).
  const sh = g.sheet('Contacts');
  sh.cells.splice(3);
  sh.cells.push(
    ['Name', 'Role', 'Email', 'New booking alerts', 'Daily & weekly updates', 'Attendant reminders', 'Admin alerts'],
    ['Jimmy', 'Operations', 'jimmy@zaria.rw', true, true, false, false],
    ['Alex', 'Attendant', 'alex@gmail.com', true, true, true, false],
    ['Clovis', 'Admin', 'clovis@gmail.com', false, false, false, true],
    ['', '', '', false, false, false, false],
  );
  g.sheet('Settings').set(g.sheet('Settings').find('Channel'), 2, 'Email');
  g.at('2026-10-08T08:05:00Z');
  await g.run('runAgent');
  assert.deepEqual(sh.rows()[3], ['Name', 'Role', 'Email', 'New booking alerts', 'Daily & weekly updates',
    'Reminder 1 (60 min before)', 'Reminder 2 (15 min before)', 'Admin alerts']);
  assert.deepEqual(sh.rows()[5], ['Alex', 'Attendant', 'alex@gmail.com', true, true, true, true, false], 'same ticks in both');
  assert.deepEqual(sh.rows()[6].slice(5), [false, false, true], 'Admin alerts moved one column right, still ticked');

  // The team then moves the 60-min reminder to Jimmy, and keeps Alex on the 15-min one.
  sh.set(5, 6, true);
  sh.set(6, 6, false);
  g.clearSent();
  for (const t of ['13:57', '14:02', '14:47']) {
    g.at(`2026-10-08T${t}:30Z`);
    await g.run('runAgent');
  }
  assert.deepEqual(g.sent.filter((m) => /^(Reminder|Starts in)/.test(m.subject)).map((m) => [m.to, m.subject.split(':')[0]]), [
    ['jimmy@zaria.rw', 'Reminder'],
    ['alex@gmail.com', 'Starts in 15 min'],
  ]);
});

test('the build pre-fills names and emails from config/, never phone numbers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaria-build-'));
  fs.writeFileSync(path.join(dir, 'contacts.json'), JSON.stringify([
    { number: '0788123456', email: 'boss@example.com', role: 'Admin', name: 'Clovis', alerts: false, summaries: false, reminders: false, admin: true },
    { number: '0788123457', role: 'Attendant', name: 'Alex', alerts: true, summaries: true, reminders: true, admin: false },
  ]));
  const d = localDefaults(dir);
  assert.deepEqual(d.contacts.map((c) => [c.name, c.email]), [['Clovis', 'boss@example.com'], ['Alex', '']]);
  assert.doesNotMatch(JSON.stringify(d), /0788/, 'no phone numbers');
});

test('the test email goes to the admin and to whoever runs it', async () => {
  const g = makeGoogle('2026-10-07T08:00:00Z');
  vm.runInContext(code, g.context);
  await g.run('setup');
  goLive(g, 'Preview');
  await g.run('sendTestEmail');
  assert.deepEqual(to(g.sent), ['clovis@gmail.com', 'owner@example.com']);
  assert.equal(g.sent[0].subject, 'Test message');
  assert.match(g.ss.toasts.at(-1), /clovis@gmail.com: sent/);
});
