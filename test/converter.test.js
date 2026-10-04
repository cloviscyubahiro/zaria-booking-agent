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
});
