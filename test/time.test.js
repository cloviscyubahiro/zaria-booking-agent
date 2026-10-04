import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ticqetLabel, weekdayOf, formatRange, dateWindow, clockLabel, shortDate, WEEKDAYS } from '../src/time.js';

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

test('dateWindow rolls across a month boundary', () => {
  const w = dateWindow({ y: 2026, m: 9, d: 30 }, 3);
  assert.deepEqual(w.map((d) => d.label), [
    'Wednesday 30 September 2026',
    'Thursday 01 October 2026',
    'Friday 02 October 2026',
  ]);
});

test('clockLabel and shortDate', () => {
  assert.equal(clockLabel(17), '5:00 PM');
  assert.equal(clockLabel(9), '9:00 AM');
  assert.equal(shortDate(2026, 10, 1), 'Thu 1 Oct');
});
