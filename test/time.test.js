import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ticqetLabel, weekdayOf, formatRange, compactRange, dateWindow, clockLabel, shortDate, WEEKDAYS,
  dayFromLabel, nowInZone, nowAtOffset, zoneSupported, addDays, isLastSaturday, joinNames,
} from '../src/time.js';
import { resolveFacility, KNOWN_FACILITIES } from '../src/facilities.js';

test('addDays crosses months and gives the Ticqet label', () => {
  assert.deepEqual(addDays({ y: 2026, m: 10, d: 31 }, 1), { y: 2026, m: 11, d: 1, label: 'Sunday 01 November 2026' });
  assert.equal(addDays({ y: 2026, m: 10, d: 9 }, 1).label, 'Saturday 10 October 2026');
});

test('Umuganda is the last Saturday of the month', () => {
  assert.ok(isLastSaturday(2026, 10, 31));
  assert.ok(isLastSaturday(2026, 11, 28));
  assert.ok(isLastSaturday(2026, 12, 26));
  assert.ok(!isLastSaturday(2026, 10, 24), 'a week earlier');
  assert.ok(!isLastSaturday(2026, 10, 30), 'a Friday');
});

test('joinNames reads like English', () => {
  assert.equal(joinNames(['A']), 'A');
  assert.equal(joinNames(['A', 'B']), 'A and B');
  assert.equal(joinNames(['A', 'B', 'C']), 'A, B and C');
});

test('facility names typed loosely find the right facility', () => {
  assert.equal(resolveFacility('Pitch A', KNOWN_FACILITIES).ticqetEventId, 'MX9KuPLIoNeBGlskCFba');
  assert.equal(resolveFacility('5-A-SIDE PITCH (B)', KNOWN_FACILITIES).ticqetEventId, 'lfbaTFIZ2wc1rS5QjbUs');
  assert.equal(resolveFacility('multi-purpose court', KNOWN_FACILITIES).ticqetEventId, 'wyUcHcKLSP52EBIr9asf');
  assert.equal(resolveFacility('Pitch', KNOWN_FACILITIES), null, 'which pitch? - unclear');
  assert.equal(resolveFacility('', KNOWN_FACILITIES), null);
});

test('ticqetLabel zero-pads the day (the 1st-9th trap)', () => {
  assert.equal(ticqetLabel(2026, 10, 1), 'Thursday 01 October 2026');
  assert.equal(ticqetLabel(2026, 10, 6), 'Tuesday 06 October 2026');
  assert.equal(ticqetLabel(2026, 10, 22), 'Thursday 22 October 2026');
});

test('weekdayOf is correct', () => {
  assert.equal(WEEKDAYS[weekdayOf(2026, 1, 1)], 'Thursday');
  assert.equal(WEEKDAYS[weekdayOf(2026, 10, 6)], 'Tuesday');
});

test('formatRange shows meridiem once when both sides share it', () => {
  assert.equal(formatRange(17, 19), '5:00-7:00 PM');
  assert.equal(formatRange(15, 17), '3:00-5:00 PM');
  assert.equal(formatRange(10, 12), '10:00 AM-12:00 PM'); // crosses noon
  assert.equal(formatRange(11, 13), '11:00 AM-1:00 PM');
  assert.equal(formatRange(22, 24), '10:00 PM-12:00 AM'); // crosses midnight
});

test('a morning-to-midnight booking does not read as a morning one', () => {
  // Real case: Sat 10 Oct 2026 was booked 7 AM to midnight.
  assert.equal(formatRange(7, 24), '7:00 AM-12:00 AM');
  assert.equal(compactRange(7, 24), '7AM-12AM');
  assert.equal(compactRange(22, 24), '10PM-12AM');
  assert.equal(compactRange(17, 19), '5-7PM');
});

test('dateWindow rolls across a month boundary', () => {
  const w = dateWindow({ y: 2026, m: 9, d: 30 }, 3);
  assert.deepEqual(w.map((d) => d.label), [
    'Wednesday 30 September 2026',
    'Thursday 01 October 2026',
    'Friday 02 October 2026',
  ]);
});

test('dayFromLabel reads Ticqet labels back', () => {
  assert.deepEqual(dayFromLabel('Thursday 01 October 2026'), { y: 2026, m: 10, d: 1, label: 'Thursday 01 October 2026' });
  assert.equal(dayFromLabel('Someday 99 Smarch 2026'), null);
});

test('Kigali time: the fixed UTC+2 fallback agrees with the time-zone database', () => {
  const at = new Date('2026-10-05T22:30:00Z'); // 00:30 on 6 Oct in Kigali
  assert.deepEqual(nowInZone('Africa/Kigali', at), { y: 2026, m: 10, d: 6, hour: 0, minute: 30 });
  assert.deepEqual(nowAtOffset(120, at), nowInZone('Africa/Kigali', at));
  assert.ok(zoneSupported('Africa/Kigali'));
  assert.ok(!zoneSupported('Mars/Olympus'));
});

test('clockLabel and shortDate', () => {
  assert.equal(clockLabel(17), '5:00 PM');
  assert.equal(clockLabel(9), '9:00 AM');
  assert.equal(shortDate(2026, 10, 1), 'Thu 1 Oct');
});
