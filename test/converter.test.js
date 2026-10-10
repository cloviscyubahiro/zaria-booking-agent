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

test('Google Sheet contacts: a column per reminder, and a warning if one has nobody', () => {
  const sheets = googleSheet({ contacts: [] });
  sheets[0].data[2] = ['Name', 'Role', 'Email', 'New booking alerts', 'Daily & weekly updates', 'Reminder 1 (60 min before)', 'Reminder 2 (15 min before)', 'Admin alerts'];
  sheets[0].data.push(
    ['Jimmy', 'Operations', 'jimmy@gmail.com', true, true, true, false, false],
    ['Alex', 'Attendant', '', true, true, false, true, false],
  );
  const res = convertSheets(sheets);
  assert.deepEqual(res.errors, []);
  assert.deepEqual(res.contacts[0], {
    number: '', email: 'jimmy@gmail.com', role: 'Operations', name: 'Jimmy',
    alerts: true, summaries: true, reminders: true, reminder1: true, reminder2: false, admin: false,
  });
  assert.ok(res.warnings.some((w) => /Nobody gets Reminder 2 \(15 min before a session\)/.test(w)), res.warnings.join('\n'));
  assert.ok(!res.warnings.some((w) => /Reminder 1/.test(w)));
});

test('Facilities: every facility with Watch = Yes is watched; a missing ID is a warning, not a stop', () => {
  const sheets = googleSheet({ contacts: [['Clovis', 'Admin', 'clovis@example.com', 'No', 'No', 'No', 'Yes']] });
  sheets.push({ sheet: 'Facilities', data: [
    ['Facilities on Ticqet'], ['Every facility with Watch = Yes is watched.'],
    ['Facility', 'Ticqet ID', 'Watch', 'Notes'],
    ['Multi-Purpose Court', 'wyUcHcKLSP52EBIr9asf', 'Yes', ''],
    ['5-a-side Pitch A', 'MX9KuPLIoNeBGlskCFba', 'Yes', ''],
    ['5-a-side Pitch B', 'lfbaTFIZ2wc1rS5QjbUs', 'Yes', ''],
    ['Swimming pool', '', 'Yes', 'Not on Ticqet yet'],
  ] });
  sheets[1].data.push(['KESA', 'Pitch B', 'Monday', '18:00', '19:00', 'Monthly', '09/10/2026', '31/10/2026']);
  sheets[1].data.push(['Ghost', 'Pitch Z', 'Monday', '18:00', '19:00', 'Monthly', '', '']);
  sheets[2].data.push(['Event day: one booking of at least (hours)', '8'], ['Umuganda (last Saturday of the month)', '07:00-10:00']);
  const res = convertSheets(sheets);
  assert.deepEqual(res.errors, []);
  assert.deepEqual(res.settings.facilities.map((f) => f.name), ['Multi-Purpose Court', '5-a-side Pitch A', '5-a-side Pitch B']);
  assert.equal(res.settings.court.name, 'Multi-Purpose Court');
  assert.equal(res.settings.eventMinHours, 8);
  assert.deepEqual(res.settings.umuganda, { start: '07:00', end: '10:00' });
  assert.equal(res.regulars.find((r) => r.client === 'KESA').facility, '5-a-side Pitch B', '"Pitch B" means 5-a-side Pitch B');
  assert.ok(res.warnings.some((w) => /Swimming pool\): not watched until its Ticqet ID is filled in/.test(w)), res.warnings.join('\n'));
  assert.ok(res.warnings.some((w) => /\(Ghost\): facility "Pitch Z" is not on the Facilities tab/.test(w)), res.warnings.join('\n'));

  const off = convertSheets([...sheets.slice(0, 2), { sheet: 'Settings', data: [['Setting', 'Value'], ['Umuganda', 'No'], ['Event day', '0']] }]);
  assert.equal(off.settings.umuganda, null);
  assert.equal(off.settings.eventMinHours, 0);
});

test('Schedule Changes: rows become changes, a mistake stays in its row', () => {
  const sheets = googleSheet({ contacts: [['Clovis', 'Admin', 'clovis@example.com', 'No', 'No', 'No', 'Yes']] });
  sheets.push({ sheet: 'Schedule Changes', data: [
    ['Schedule changes'], ['For one-off changes...'], [],
    ['Date', 'Facility', 'Client', 'New time', 'Reason / message', 'Email everyone', 'Agent status'],
    ['2026-10-13', '', 'MTN', '18:00-20:00', 'Car-free day', true, 'old status'],
    ['13/10/2026', '', 'Unknown FC', 'Cancelled', 'x', false, ''],
    ['', '', '', '', '', false, ''],
  ] });
  const res = convertSheets(sheets);
  assert.deepEqual(res.errors, [], 'never fatal');
  assert.equal(res.changes.length, 2);
  assert.deepEqual([res.changes[0].row, res.changes[0].kind, res.changes[0].email, res.changes[0].summary],
    [5, 'moved', true, 'MTN play 6:00-8:00 PM instead of 5:00-7:00 PM, at Multi-Purpose Court.']);
  assert.match(res.changes[1].problem, /Unknown FC has no usual session on Tue 13 Oct to cancel/);
  assert.ok(res.warnings.some((w) => /^Schedule Changes row 6: Unknown FC/.test(w)));
  assert.deepEqual(res.changeRows[0], { date: '2026-10-13', facility: '', client: 'MTN', newTime: '18:00-20:00', reason: 'Car-free day', email: true });
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
