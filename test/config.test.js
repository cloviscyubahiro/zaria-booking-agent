import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ZARIA_QUIET = '1';
const { normalizePhone, normalizeEmail, withDefaults, cleanContacts, cleanRegulars, recipients, normalizeChannel } = await import('../src/config.js');

const PITCH_A = { name: '5-a-side Pitch A', ticqetEventId: 'MX9KuPLIoNeBGlskCFba' };

test('facilities: older settings name one court; newer ones list several, checked', () => {
  const old = withDefaults({ court: { name: 'Multi-Purpose Court', ticqetEventId: 'wyUcHcKLSP52EBIr9asf' } });
  assert.deepEqual(old.facilities, [{ name: 'Multi-Purpose Court', ticqetEventId: 'wyUcHcKLSP52EBIr9asf' }]);
  const three = withDefaults({ facilities: [{ name: 'Multi-Purpose Court', ticqetEventId: 'wyUcHcKLSP52EBIr9asf' }, PITCH_A] });
  assert.equal(three.facilities.length, 2);
  assert.deepEqual(three.court, three.facilities[0], 'the first one is the main one');
  assert.equal(three.venue.facilities.length, 3, 'all known facilities, for pre-filling');
  assert.throws(() => withDefaults({ facilities: [PITCH_A, { ...PITCH_A, name: 'Other' }] }), /used for more than one facility/);
  assert.throws(() => withDefaults({ facilities: [{ name: 'X', ticqetEventId: '' }] }), /needs a name and a Ticqet ID/);
});

test('event days and Umuganda: defaults and checks', () => {
  const s = withDefaults({});
  assert.equal(s.eventMinHours, 6);
  assert.deepEqual(s.umuganda, { start: '08:00', end: '11:00' });
  assert.equal(withDefaults({ umuganda: null }).umuganda, null);
  assert.throws(() => withDefaults({ umuganda: { start: '11:00', end: '08:00' } }), /umuganda/);
  assert.throws(() => withDefaults({ eventMinHours: 30 }), /eventMinHours/);
});

test('regular clients: a loosely typed facility name is matched to the watched one', () => {
  const rows = cleanRegulars([
    { client: 'KESA', facility: 'Pitch B', day: 'Monday', start: '18:00', end: '19:00' },
    { client: 'MTN', facility: '', day: 'Tuesday', start: '17:00', end: '19:00' },
  ], [{ name: 'Multi-Purpose Court', ticqetEventId: 'c' }, PITCH_A, { name: '5-a-side Pitch B', ticqetEventId: 'b' }]);
  assert.deepEqual(rows.map((r) => r.facility), ['5-a-side Pitch B', 'Multi-Purpose Court']);
});

test('phone numbers: every way they are typed becomes +250', () => {
  for (const raw of ['0788123456', '788123456', '250788123456', '+250788123456', '078 812 3456', '078-812-3456']) {
    assert.equal(normalizePhone(raw), '+250788123456', raw);
  }
  assert.throws(() => normalizePhone('0712'), /Invalid/);
  assert.throws(() => normalizePhone('0588123456'), /Invalid/, 'not a mobile number');
});

test('settings: defaults fill gaps, mistakes get plain-English errors', () => {
  const s = withDefaults({});
  assert.equal(s.court.ticqetEventId, 'wyUcHcKLSP52EBIr9asf');
  assert.equal(s.watch.windowDays, 60);
  assert.deepEqual(withDefaults({ attendantReminderMinutes: [15, 60, 60] }).attendantReminderMinutes, [60, 15]);
  assert.throws(() => withDefaults({ channel: 'telegram' }), /Use preview, email, whatsapp or sms/);
  assert.throws(() => withDefaults({ quietHours: { start: '11pm', end: '06:00' } }), /quietHours.start/);
  assert.throws(() => withDefaults({ weeklyOverviewDay: 'Mon' }), /weekday name/);
  assert.equal(normalizeChannel('WhatsApp'), 'whatsapp-cloud');
});

test('contacts: duplicates merge, numbers without digits are skipped, groups resolve', () => {
  const contacts = cleanContacts([
    { number: '0780000001', alerts: true },
    { number: '780000001', reminders: true },
    { number: '', role: 'Admin (Clovis)', admin: true },
    { number: '0780000002', admin: true },
  ]);
  assert.equal(contacts.length, 2);
  const cfg = { contacts, settings: {} };
  assert.deepEqual(recipients(cfg, 'team'), ['+250780000001']);
  assert.deepEqual(recipients(cfg, 'attendants'), ['+250780000001']);
  assert.deepEqual(recipients(cfg, 'admin'), ['+250780000002']);
  assert.equal(recipients(cfg, 'everyone').length, 2);
});

test('reminders: one column each, or the older single tick meaning both', () => {
  const contacts = cleanContacts([
    { number: '0780000001', reminder1: true, reminder2: false },
    { number: '0780000002', reminder1: false, reminder2: true },
    { number: '0780000003', reminders: true }, // older sheet: both
  ]);
  const cfg = { contacts, settings: {} };
  assert.deepEqual(recipients(cfg, 'reminder1'), ['+250780000001', '+250780000003']);
  assert.deepEqual(recipients(cfg, 'reminder2'), ['+250780000002', '+250780000003']);
  assert.equal(recipients(cfg, 'attendants').length, 3, 'anyone with a reminder gets last-minute bookings');
});

test('email addresses: tidied, and anything that is not one address is refused', () => {
  assert.equal(normalizeEmail('  Clovis.C@Gmail.com '), 'clovis.c@gmail.com');
  for (const bad of ['clovis', 'clovis@gmail', 'a b@gmail.com', 'a@x.com, b@y.com', 'Clovis <c@gmail.com>']) {
    assert.throws(() => normalizeEmail(bad), /Invalid email/, bad);
  }
  assert.equal(normalizeChannel('Email'), 'email');
});

test('contacts by email: each channel uses the right address, duplicates merge', () => {
  const contacts = cleanContacts([
    { email: 'Team@Zaria.rw', alerts: true },
    { email: 'team@zaria.rw', reminders: true },
    { number: '0780000002', email: 'boss@gmail.com', admin: true },
    { number: '0780000003', alerts: true },
    { name: 'Clovis', role: 'Admin (Clovis)', admin: true },
  ]);
  assert.equal(contacts.length, 3, 'duplicate merged, empty row skipped');
  const email = { contacts, settings: { channel: 'email' } };
  assert.deepEqual(recipients(email, 'team'), ['team@zaria.rw'], 'phone-only contact gets nothing by email');
  assert.deepEqual(recipients(email, 'attendants'), ['team@zaria.rw']);
  assert.deepEqual(recipients(email, 'admin'), ['boss@gmail.com']);
  const sms = { contacts, settings: { channel: 'pindo' } };
  assert.deepEqual(recipients(sms, 'team'), ['+250780000003'], 'email-only contact gets nothing by SMS');
  const preview = { contacts, settings: { channel: 'preview' } };
  assert.deepEqual(recipients(preview, 'everyone').sort(), ['+250780000002', '+250780000003', 'team@zaria.rw']);
});
