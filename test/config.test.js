import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ZARIA_QUIET = '1';
const { normalizePhone, withDefaults, cleanContacts, recipients, normalizeChannel } = await import('../src/config.js');

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
  assert.throws(() => withDefaults({ channel: 'telegram' }), /Use preview, whatsapp or sms/);
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
