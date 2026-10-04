// Reads Zaria Court's bookings from Ticqet, live.
//
// Ticqet (ticqet.rw) is a Flutter web app backed by Google Firebase, project
// "kigali-arena". The court's schedule is public: each day's reservations are
// documents in  events/<COURT_EVENT_ID>/seats  with a `dateFormatted` field like
// "Thursday 01 October 2026". We read exactly what the website reads - no login,
// and no customer data (names and phone numbers live in separate, locked
// collections that are never touched).
//
// How it works:
//   - one realtime listener per watched date (the same mechanism the Ticqet
//     website uses), so a new booking reaches us within seconds and Ticqet's
//     database is barely loaded;
//   - snapshots served from the local cache (i.e. while offline) are IGNORED, so
//     a network drop can never look like "all bookings were cancelled";
//   - a failed listener is retried with a growing delay;
//   - every few minutes a direct server read ("probe") proves the connection is
//     alive (that feeds the silence alarm) and catches a listener that has
//     silently gone stale.

import fs from 'node:fs';
import path from 'node:path';
import { log, dataDir } from './logger.js';

const BUNDLE_URL = 'https://ticqet.rw/main.dart.js';

// Ticqet's public Firebase web API key is embedded in its JS bundle (as in every
// Firebase web app - it identifies the project, it is not a secret). If several
// keys appear, take the one closest to the project id.
export function extractApiKey(js, anchor = 'kigali-arena') {
  const keys = [...js.matchAll(/AIza[0-9A-Za-z_-]{35}/g)];
  if (!keys.length) return null;
  const anchors = [];
  let i = js.indexOf(anchor);
  while (i !== -1) {
    anchors.push(i);
    i = js.indexOf(anchor, i + 1);
  }
  if (!anchors.length) return keys[0][0];
  let best = keys[0][0];
  let bestDist = Infinity;
  for (const k of keys) {
    for (const a of anchors) {
      const dist = Math.abs(k.index - a);
      if (dist < bestDist) {
        bestDist = dist;
        best = k[0];
      }
    }
  }
  return best;
}

// One raw seats document -> the plain record the rest of the agent uses.
export function toRecord(doc) {
  const d = doc.data() || {};
  return {
    id: doc.id,
    seats: Array.isArray(d.seats) ? d.seats.map(String) : [],
    section: d.section ?? null,
  };
}

const fp = (records) => records.map((r) => `${r.id}:${[...new Set(r.seats)].sort().join(',')}`).sort().join('|');

function withTimeout(promise, ms, what) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

async function loadFirebase() {
  const app = await import('firebase/app');
  const fsdk = await import('firebase/firestore');
  return {
    initializeApp: app.initializeApp,
    deleteApp: app.deleteApp,
    initializeFirestore: fsdk.initializeFirestore,
    setLogLevel: fsdk.setLogLevel,
    collection: fsdk.collection,
    query: fsdk.query,
    where: fsdk.where,
    onSnapshot: fsdk.onSnapshot,
    getDocsFromServer: fsdk.getDocsFromServer,
    terminate: fsdk.terminate,
  };
}

export class TicqetWatcher {
  // deps: Firebase functions (injected by tests); fetchImpl: for the key lookup.
  constructor({ settings, env = process.env, deps = null, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
    this.settings = settings;
    this.env = env;
    this.deps = deps;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.listeners = new Map(); // label -> listener state
    this.lastContactAt = null; // last time the server answered (ms)
    this.lastError = null;
    this.stopped = false;
  }

  async start() {
    this.deps = this.deps || (await loadFirebase());
    const fb = this.settings.firebase || {};
    const projectId = fb.projectId || 'kigali-arena';
    const apiKey = await this.resolveApiKey(projectId);
    const { initializeApp, initializeFirestore, setLogLevel, collection } = this.deps;
    if (setLogLevel) setLogLevel('error');
    this.app = initializeApp({ apiKey, projectId, authDomain: fb.authDomain || `${projectId}.firebaseapp.com` }, `zaria-agent-${this.now()}`);
    this.db = initializeFirestore(this.app, {});
    const eventId = this.settings.court?.ticqetEventId;
    if (!eventId) throw new Error('settings.court.ticqetEventId is not set.');
    this.seats = collection(this.db, 'events', eventId, 'seats');
    log.info(`[ticqet] connected to Firebase project "${projectId}", court ${eventId}`);
  }

  // API key: .env override, then settings, then read it from ticqet.rw (and
  // remember it, so a temporary website outage does not stop a restart).
  async resolveApiKey(projectId) {
    const configured = this.env.FIREBASE_API_KEY || (this.settings.firebase?.apiKey !== 'AUTO' ? this.settings.firebase?.apiKey : null);
    if (configured) return configured;
    const cacheFile = path.join(dataDir(), 'ticqet-key.json');
    try {
      const res = await withTimeout(this.fetchImpl(BUNDLE_URL), 60000, 'Downloading the Ticqet app');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const key = extractApiKey(await res.text(), projectId);
      if (!key) throw new Error('no Firebase key found in the Ticqet app bundle');
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify({ apiKey: key, foundAt: new Date(this.now()).toISOString() }));
      log.info('[ticqet] read the Firebase web key from ticqet.rw');
      return key;
    } catch (err) {
      try {
        const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8')).apiKey;
        if (cached) {
          log.warn(`[ticqet] could not read ticqet.rw (${err.message}); using the key saved earlier.`);
          return cached;
        }
      } catch { /* no cache */ }
      throw new Error(`Could not get Ticqet's Firebase key from ${BUNDLE_URL} (${err.message}). Check the server's internet connection, or set FIREBASE_API_KEY in .env.`);
    }
  }

  queryFor(label) {
    const { query, where } = this.deps;
    return query(this.seats, where('dateFormatted', '==', label));
  }

  // Keep exactly these dates under watch: start new listeners, stop old ones.
  watch(labels) {
    const want = new Set(labels);
    for (const [label, l] of this.listeners) {
      if (!want.has(label)) {
        this.closeListener(l);
        this.listeners.delete(label);
      }
    }
    for (const label of labels) if (!this.listeners.has(label)) this.subscribe(label);
  }

  subscribe(label, existing = null) {
    const l = existing || { label, docs: undefined, serverAt: null, errors: 0, errorSince: null, mismatches: 0, unsub: null, timer: null };
    this.listeners.set(label, l);
    l.unsub = this.deps.onSnapshot(
      this.queryFor(label),
      { includeMetadataChanges: true },
      (snap) => {
        if (snap.metadata.fromCache) return; // offline/cached view: never trust it
        l.docs = snap.docs.map(toRecord);
        l.serverAt = this.now();
        l.errors = 0;
        l.errorSince = null;
        this.lastContactAt = l.serverAt;
      },
      (err) => {
        l.unsub = null;
        l.errors += 1;
        l.errorSince = l.errorSince || this.now();
        this.lastError = `${err.code || ''} ${err.message || err}`.trim();
        const delay = Math.min(300000, 15000 * 2 ** Math.min(l.errors - 1, 5));
        log.warn(`[ticqet] listener for "${label}" stopped (${this.lastError}); retrying in ${Math.round(delay / 1000)}s`);
        l.timer = setTimeout(() => {
          if (!this.stopped && this.listeners.get(label) === l) this.subscribe(label, l);
        }, delay);
        if (l.timer.unref) l.timer.unref();
      },
    );
  }

  closeListener(l) {
    if (l.unsub) l.unsub();
    if (l.timer) clearTimeout(l.timer);
    l.unsub = null;
    l.timer = null;
  }

  // Latest server-confirmed records for a date, or undefined if not known yet.
  get(label) {
    return this.listeners.get(label)?.docs;
  }

  // Earliest time any listener started failing (and has not recovered), or null.
  get oldestErrorAt() {
    let oldest = null;
    for (const l of this.listeners.values()) if (l.errorSince && (oldest === null || l.errorSince < oldest)) oldest = l.errorSince;
    return oldest;
  }

  // Direct server read of a few dates. Proves the connection works and compares
  // with what the listeners hold; two mismatches in a row = stale listeners, so
  // restart them all (which re-reads everything fresh from the server).
  async probe(labels) {
    let stale = false;
    for (const label of labels) {
      try {
        const snap = await withTimeout(this.deps.getDocsFromServer(this.queryFor(label)), 30000, 'Ticqet check');
        const docs = snap.docs.map(toRecord);
        this.lastContactAt = this.now();
        const l = this.listeners.get(label);
        if (l && l.docs !== undefined) {
          if (fp(l.docs) !== fp(docs)) {
            l.mismatches += 1;
            if (l.mismatches >= 2) stale = true;
          } else {
            l.mismatches = 0;
          }
        }
      } catch (err) {
        this.lastError = err.message;
        log.warn(`[ticqet] server check failed for "${label}": ${err.message}`);
      }
    }
    if (stale) {
      log.warn('[ticqet] live data differs from the server twice in a row - restarting all listeners');
      this.resubscribeAll();
    }
  }

  resubscribeAll() {
    for (const [label, l] of this.listeners) {
      this.closeListener(l);
      l.mismatches = 0;
      this.subscribe(label, l);
    }
  }

  async stop() {
    this.stopped = true;
    for (const l of this.listeners.values()) this.closeListener(l);
    this.listeners.clear();
    try {
      if (this.db && this.deps.terminate) await this.deps.terminate(this.db);
      if (this.app && this.deps.deleteApp) await this.deps.deleteApp(this.app);
    } catch { /* shutting down anyway */ }
  }
}
