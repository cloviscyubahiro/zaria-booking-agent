import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ZARIA_QUIET = '1';
const { convertWorkbook, toHHMM, toISODate } = await import('../tools/xlsx-to-config.js');

test('time and date cells are read however Excel stores them', () => {
  assert.equal(toHHMM(new Date(Date.UTC(1899, 11, 30, 17, 0))), '17:00');
  assert.equal(toHHMM(0.75), '18:00');
  assert.equal(toHHMM('5:00 PM'), '17:00');
  assert.equal(toHHMM('5pm'), '17:00');
  assert.equal(toHHMM('17:30'), '17:30');
  assert.equal(toHHMM('later'), null);
  assert.equal(toISODate(new Date(Date.UTC(2026, 9, 1))), '2026-10-01');
  assert.equal(toISODate('01/10/2026'), '2026-10-01');
  assert.equal(toISODate(46296), '2026-10-01');
  assert.equal(toISODate(null), null);
  assert.equal(toISODate('soon'), undefined);
});

test('the example workbook converts to valid config', async () => {
  const res = await convertWorkbook('config/zaria-setup.example.xlsx');
  assert.deepEqual(res.errors, []);
  assert.equal(res.regulars.length, 3);
  assert.deepEqual(res.regulars[0], {
    client: 'Example Club', facility: 'Multi-Purpose Court', day: 'Monday', start: '17:00', end: '19:00',
    type: 'Monthly', from: '2026-10-01', until: '2026-10-31',
  });
  assert.equal(res.contacts.length, 8);
  assert.equal(res.contacts.filter((c) => c.reminders).length, 2);
  assert.equal(res.contacts.filter((c) => c.admin).length, 1);
  assert.equal(res.settings.channel, 'preview');
  assert.equal(res.settings.court.ticqetEventId, 'wyUcHcKLSP52EBIr9asf');
  assert.equal(res.settings.watch.windowDays, 60);
  assert.deepEqual(res.settings.attendantReminderMinutes, [60, 15]);
  assert.deepEqual(res.settings.quietHours, { start: '23:00', end: '06:00' });
  assert.equal(res.settings.adminName, 'Clovis');
  assert.ok(res.contacts.every((c) => !('email' in c)), 'no Email column, no email field');
});

const { convertSheets } = await import('../src/workbook.js');

// The Google Sheet layout used by the Apps Script version: Email instead of Number.
function googleSheet({ contacts, channel = 'Email' }) {
  return [
    { sheet: 'Contacts', data: [
      ['Contacts - who receives what'],
      [],
      ['Name', 'Role', 'Email', 'New booking alerts', 'Daily & weekly updates', 'Attendant reminders', 'Admin alerts'],
      ...contacts,
    ] },
    { sheet: 'Regular Clients', data: [
      ['Client', 'Facility', 'Day', 'Start', 'End', 'Type', 'From', 'Until'],
      ['MTN', 'Multi-Purpose Court', 'Tuesday', '17:00', '19:00', 'Monthly', '', '2026-10-31'],
    ] },
    { sheet: 'Settings', data: [['Setting', 'Value'], ['Channel', channel], ['Email sender name', 'Zaria Court Alerts']] },
  ];
}

test('Google Sheet contacts: emails are read, checked and matched to the channel', () => {
  const res = convertSheets(googleSheet({ contacts: [
    ['Alex', 'Attendant', ' Alex@Gmail.com', 'Yes', 'Yes', 'Yes', 'No'],
    ['Jimmy', 'Operations', '', 'Yes', 'Yes', 'No', 'No'],
    ['Clovis', 'Admin', 'clovis@example.com', 'No', 'No', 'No', 'Yes'],
  ] }));
  assert.deepEqual(res.errors, []);
  assert.deepEqual(res.contacts.map((c) => c.email), ['alex@gmail.com', 'clovis@example.com']);
  assert.equal(res.contacts[0].number, '');
  assert.equal(res.settings.channel, 'email');
  assert.equal(res.settings.emailSenderName, 'Zaria Court Alerts');
  assert.equal(res.settings.adminName, 'Clovis');
  assert.equal(res.regulars[0].until, '2026-10-31');
  assert.ok(res.warnings.some((w) => /row 5 \(Jimmy\): no email yet - skipped/.test(w)), res.warnings.join('\n'));
});

test('Google Sheet contacts: a bad or repeated email is an error naming the row', () => {
  const res = convertSheets(googleSheet({ contacts: [
    ['Alex', 'Attendant', 'alex@gmail', 'Yes', 'Yes', 'Yes', 'No'],
    ['Vianney', 'Attendant', 'v@gmail.com', 'Yes', 'Yes', 'Yes', 'No'],
    ['Vianney again', 'Attendant', 'V@Gmail.com', 'Yes', 'Yes', 'Yes', 'No'],
  ] }));
  assert.ok(res.errors.some((e) => /row 4: "alex@gmail" is not a valid email/.test(e)), res.errors.join('\n'));
  assert.ok(res.errors.some((e) => /row 6: V@Gmail.com is listed twice/.test(e)), res.errors.join('\n'));
});
