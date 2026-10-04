import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slotsToRanges, rangesText, bookingFromDoc, diffDay } from '../src/bookings.js';

test('slotsToRanges merges consecutive slots and dedupes', () => {
  assert.deepEqual(slotsToRanges(['17', '18']), [{ startHour: 17, endHour: 19 }]);
  // duplicated hour (a real Ticqet quirk) collapses to one
  assert.deepEqual(slotsToRanges(['17', '18', '18']), [{ startHour: 17, endHour: 19 }]);
  // a gap yields two ranges
  assert.deepEqual(slotsToRanges(['15', '16', '19', '20']), [
    { startHour: 15, endHour: 17 },
    { startHour: 19, endHour: 21 },
  ]);
});

test('rangesText reads naturally with hours', () => {
  assert.equal(rangesText([{ startHour: 17, endHour: 19 }]), '5:00-7:00 PM (2 hrs)');
  assert.equal(
    rangesText([{ startHour: 17, endHour: 19 }, { startHour: 20, endHour: 21 }]),
    '5:00-7:00 PM + 8:00-9:00 PM (3 hrs)',
  );
});

test('bookingFromDoc normalizes a raw seats record', () => {
  const b = bookingFromDoc({ id: 'abc', seats: ['18', '17', '17'], section: 'MULTI PURPOSE COURT' },
    { y: 2026, m: 10, d: 6, label: 'Tuesday 06 October 2026' });
  assert.equal(b.id, 'abc');
  assert.deepEqual(b.slots, [17, 18]);
  assert.equal(b.hours, 2);
  assert.deepEqual(b.ranges, [{ startHour: 17, endHour: 19 }]);
});

test('diffDay detects added, removed, and changed by document id', () => {
  const mk = (id, seats) => bookingFromDoc({ id, seats }, { y: 2026, m: 10, d: 6, label: 'L' });
  const prev = [mk('a', ['17', '18']), mk('b', ['20', '21'])];
  const cur = [mk('a', ['17', '18', '19']), mk('c', ['9', '10'])];
  const { added, removed, changed } = diffDay(prev, cur);
  assert.deepEqual(added.map((x) => x.id), ['c']);
  assert.deepEqual(removed.map((x) => x.id), ['b']);
  assert.deepEqual(changed.map((x) => x.after.id), ['a']);
});

import { fingerprint, pairReissues } from '../src/bookings.js';

test('fingerprint ignores record order', () => {
  const mk = (id, seats) => bookingFromDoc({ id, seats }, { y: 2026, m: 10, d: 6, label: 'L' });
  assert.equal(fingerprint([mk('a', ['9']), mk('b', ['10'])]), fingerprint([mk('b', ['10']), mk('a', ['9'])]));
});

test('pairReissues drops a delete+create with identical hours', () => {
  const mk = (id, seats) => bookingFromDoc({ id, seats }, { y: 2026, m: 10, d: 6, label: 'L' });
  const r = pairReissues([mk('new', ['17', '18']), mk('other', ['9'])], [mk('old', ['18', '17'])]);
  assert.deepEqual(r.added.map((b) => b.id), ['other']);
  assert.deepEqual(r.removed, []);
  assert.equal(r.reissued.length, 1);
});
