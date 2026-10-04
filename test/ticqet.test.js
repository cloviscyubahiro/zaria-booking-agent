import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.ZARIA_QUIET = '1';
process.env.ZARIA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zaria-ticqet-'));
const { TicqetWatcher, extractApiKey } = await import('../src/ticqet.js');

const KEY_A = `AIza${'A'.repeat(35)}`;
const KEY_B = `AIza${'B'.repeat(35)}`;
const SETTINGS = { firebase: { projectId: 'kigali-arena', apiKey: 'AUTO' }, court: { ticqetEventId: 'COURT' } };

// A fake Firebase: lets the test push snapshots and errors into listeners.
function fakeFirebase() {
  const live = new Map(); // label -> { next, error }
  const server = new Map(); // label -> records (what a direct server read returns)
  let subscriptions = 0;
  const snap = (records, fromCache = false) => ({
    metadata: { fromCache },
    docs: records.map((r) => ({ id: r.id, data: () => ({ seats: r.seats, section: 'MULTI PURPOSE COURT' }) })),
  });
  const deps = {
    initializeApp: () => ({}), deleteApp: async () => {}, initializeFirestore: () => ({}), setLogLevel: () => {},
    collection: (_db, ...p) => ({ path: p.join('/') }),
    where: (_f, _op, value) => ({ value }),
    query: (ref, w) => ({ path: ref.path, label: w.value }),
    onSnapshot: (q, opts, next, error) => {
      subscriptions += 1;
      assert.equal(q.path, 'events/COURT/seats');
      assert.equal(opts.includeMetadataChanges, true);
      live.set(q.label, { next, error });
      return () => live.delete(q.label);
    },
    getDocsFromServer: async (q) => snap(server.get(q.label) || []),
    terminate: async () => {},
  };
  return { deps, live, server, snap, subs: () => subscriptions };
}

test('extractApiKey picks the key nearest the project id', () => {
  const js = `var a="${KEY_A}"; ${'x'.repeat(5000)} apiKey:"${KEY_B}",projectId:"kigali-arena"`;
  assert.equal(extractApiKey(js), KEY_B);
  assert.equal(extractApiKey('no key here'), null);
});

test('start(): reads the key from ticqet.rw and remembers it for outages', async () => {
  const fb = fakeFirebase();
  const fetchOk = async () => ({ ok: true, text: async () => `projectId:"kigali-arena",apiKey:"${KEY_A}"` });
  const w = new TicqetWatcher({ settings: SETTINGS, env: {}, deps: fb.deps, fetchImpl: fetchOk });
  assert.equal(await w.resolveApiKey('kigali-arena'), KEY_A);
  const fetchDown = async () => { throw new Error('ENOTFOUND'); };
  const w2 = new TicqetWatcher({ settings: SETTINGS, env: {}, deps: fb.deps, fetchImpl: fetchDown });
  assert.equal(await w2.resolveApiKey('kigali-arena'), KEY_A, 'falls back to the saved key');
  const w3 = new TicqetWatcher({ settings: SETTINGS, env: { FIREBASE_API_KEY: 'from-env' }, deps: fb.deps, fetchImpl: fetchDown });
  assert.equal(await w3.resolveApiKey('kigali-arena'), 'from-env');
});

test('offline/cached snapshots are ignored, so a network drop never looks like cancellations', async () => {
  const fb = fakeFirebase();
  const w = new TicqetWatcher({ settings: SETTINGS, env: { FIREBASE_API_KEY: 'k' }, deps: fb.deps });
  await w.start();
  w.watch(['Thursday 01 October 2026']);
  const l = fb.live.get('Thursday 01 October 2026');
  l.next(fb.snap([], true)); // what the SDK emits while offline with an empty cache
  assert.equal(w.get('Thursday 01 October 2026'), undefined);
  assert.equal(w.lastContactAt, null);
  l.next(fb.snap([{ id: 'a', seats: ['17', '18'] }]));
  assert.deepEqual(w.get('Thursday 01 October 2026'), [{ id: 'a', seats: ['17', '18'], section: 'MULTI PURPOSE COURT' }]);
  assert.ok(w.lastContactAt);
  l.next(fb.snap([], true)); // connection drops again: keep the last server data
  assert.equal(w.get('Thursday 01 October 2026').length, 1);
});

test('watch() follows the window: new dates subscribed, old dates dropped', async () => {
  const fb = fakeFirebase();
  const w = new TicqetWatcher({ settings: SETTINGS, env: { FIREBASE_API_KEY: 'k' }, deps: fb.deps });
  await w.start();
  w.watch(['A', 'B']);
  w.watch(['B', 'C']);
  assert.deepEqual([...fb.live.keys()].sort(), ['B', 'C']);
  assert.equal(fb.subs(), 3, 'B was not re-subscribed');
});

test('a failed listener is retried after a delay', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fb = fakeFirebase();
  const w = new TicqetWatcher({ settings: SETTINGS, env: { FIREBASE_API_KEY: 'k' }, deps: fb.deps, now: () => 1000 });
  await w.start();
  w.watch(['A']);
  fb.live.get('A').error({ code: 'unavailable', message: 'backend down' });
  assert.equal(w.oldestErrorAt, 1000);
  assert.equal(fb.subs(), 1);
  t.mock.timers.tick(15000);
  assert.equal(fb.subs(), 2, 're-subscribed after 15 s');
  fb.live.get('A').next(fb.snap([]));
  assert.equal(w.oldestErrorAt, null, 'recovered');
});

test('probe: two mismatches in a row with the server restart all listeners', async () => {
  const fb = fakeFirebase();
  const w = new TicqetWatcher({ settings: SETTINGS, env: { FIREBASE_API_KEY: 'k' }, deps: fb.deps });
  await w.start();
  w.watch(['A', 'B']);
  fb.live.get('A').next(fb.snap([]));
  fb.server.set('A', [{ id: 'missed', seats: ['9'] }]); // the listener missed this
  await w.probe(['A']);
  assert.equal(fb.subs(), 2, 'one mismatch can be timing - wait');
  await w.probe(['A']);
  assert.equal(fb.subs(), 4, 'both listeners restarted');
});
