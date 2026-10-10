// Reads the facilities' bookings from Ticqet with plain HTTPS calls to
// Firestore's REST API - the same public schedule the Ticqet website shows.
// Each run reads the whole watch window at once: 30 dates per request, so 60
// days = 2 calls per facility.
//
// It offers the same interface the engine expects from the live watcher:
//   get(label, facilityId) -> [record] | undefined,  lastContactAt,
//   oldestErrorAt, failing (names of the facilities that could not be read)
// `state` is saved between runs by main.js, because every Apps Script run
// starts fresh: { apiKey, lastContactAt, errorSince, lastError, failing, verified }.

import { BUNDLE_URL, extractApiKey } from '../../src/ticqet-key.js';
import { nameKey } from '../../src/facilities.js';
import { log } from './logger.js';

const PER_QUERY = 30; // Firestore accepts up to 30 values in one "IN" filter
const VERIFY_EVERY_MS = 24 * 3600 * 1000;

const valueOf = (v) => String(v.stringValue ?? v.integerValue ?? v.doubleValue ?? '');

export class TicqetRest {
  // http: UrlFetchApp (or a fake with the same fetch()).
  constructor({ settings, http, state, now = () => Date.now() }) {
    this.settings = settings;
    this.http = http;
    this.state = state;
    this.now = now;
    this.days = new Map(); // facilityId -> Map(label -> [{ id, seats, section }])
    this.createTimes = new Map(); // record id -> when it was created on Ticqet (ISO)
    this.keyRetried = false;
  }

  watch() {} // the engine calls this; main.js reads with load() before the engine runs

  get(label, facilityId) {
    const id = facilityId || this.settings.court.ticqetEventId;
    const days = this.days.get(id);
    return days ? days.get(label) : undefined;
  }

  get lastContactAt() {
    return this.state.lastContactAt ?? null;
  }

  get oldestErrorAt() {
    return this.state.errorSince ?? null;
  }

  get failing() {
    return this.state.failing || [];
  }

  get project() {
    return (this.settings.firebase && this.settings.firebase.projectId) || 'kigali-arena';
  }

  // Read every date in `labels`, for every facility. A facility that cannot be
  // read returns nothing at all (never a partial or empty list), so a failed
  // read can never look like cancellations. Returns true if all were read.
  load(facilities, labels) {
    const failed = [];
    let lastError = null;
    for (const f of facilities) {
      try {
        const days = new Map(labels.map((l) => [l, []]));
        for (let i = 0; i < labels.length; i += PER_QUERY) {
          for (const doc of this.query(f.ticqetEventId, labels.slice(i, i + PER_QUERY))) {
            const fl = doc.fields || {};
            const label = fl.dateFormatted && fl.dateFormatted.stringValue;
            if (!days.has(label)) continue;
            const id = doc.name.split('/').pop();
            const seats = ((fl.seats && fl.seats.arrayValue && fl.seats.arrayValue.values) || []).map(valueOf);
            days.get(label).push({ id, seats, section: (fl.section && fl.section.stringValue) || null });
            if (doc.createTime) this.createTimes.set(id, doc.createTime);
          }
        }
        this.days.set(f.ticqetEventId, days);
      } catch (err) {
        this.days.delete(f.ticqetEventId);
        failed.push(f.name);
        lastError = `${f.name}: ${err.message}`;
        log.warn(`[ticqet] could not read ${f.name}: ${err.message}`);
      }
    }
    if (failed.length < facilities.length) this.state.lastContactAt = this.now();
    if (failed.length) {
      this.state.errorSince = this.state.errorSince || this.now();
      this.state.lastError = lastError;
    } else {
      this.state.errorSince = null;
      this.state.lastError = null;
    }
    this.state.failing = failed;
    return !failed.length;
  }

  // Check, once a day, that each Ticqet ID belongs to an active facility with a
  // matching name - a typo in an ID would otherwise just look like "no bookings".
  // Returns { errors, warnings } for the Status tab.
  verify(facilities) {
    const out = { errors: [], warnings: [] };
    const seen = this.state.verified || {};
    const kept = {};
    for (const f of facilities) {
      const id = f.ticqetEventId;
      let v = seen[id];
      if (!v || this.now() - v.at > VERIFY_EVERY_MS) {
        try {
          v = { at: this.now(), ...this.fetchEvent(id) };
        } catch (err) {
          log.warn(`[ticqet] could not check the Ticqet ID of ${f.name}: ${err.message}`);
          if (seen[id]) kept[id] = seen[id];
          continue; // try again next run
        }
      }
      kept[id] = v;
      if (!v.found) {
        out.errors.push(`Facilities: Ticqet does not know the ID "${id}" (${f.name}). Copy it again from the end of the facility's link on ticqet.rw.`);
      } else {
        const a = nameKey(v.name);
        const b = nameKey(f.name);
        if (a && b && !a.includes(b) && !b.includes(a)) {
          out.warnings.push(`Facilities: the Ticqet ID of "${f.name}" belongs to "${v.name.trim()}" on Ticqet - check that it is the right one.`);
        }
        if (v.status && v.status !== 'Active') out.warnings.push(`Facilities: Ticqet shows "${v.name.trim()}" as ${v.status}.`);
      }
    }
    this.state.verified = kept;
    return out;
  }

  // The facility's Ticqet event: { found, name, status }.
  fetchEvent(id) {
    const fields = ['name', 'status', 'cancelled'].map((p) => `mask.fieldPaths=${p}`).join('&');
    const url = `https://firestore.googleapis.com/v1/projects/${this.project}/databases/(default)/documents/events/${encodeURIComponent(id)}?key=${encodeURIComponent(this.apiKey())}&${fields}`;
    const res = this.http.fetch(url, { muteHttpExceptions: true });
    const code = res.getResponseCode();
    const text = res.getContentText();
    // A missing (or private) event answers "permission denied"; a refused key mentions the key.
    if ((code === 403 || code === 404) && !/api.?key/i.test(text)) return { found: false };
    if (code !== 200) throw new Error(`Ticqet answered HTTP ${code}`);
    const fl = JSON.parse(text).fields || {};
    const status = fl.cancelled && fl.cancelled.booleanValue ? 'cancelled' : (fl.status && fl.status.stringValue) || null;
    return { found: true, name: (fl.name && fl.name.stringValue) || '', status };
  }

  query(eventId, labels) {
    const key = this.apiKey();
    const url = `https://firestore.googleapis.com/v1/projects/${this.project}/databases/(default)/documents/events/${encodeURIComponent(eventId)}:runQuery?key=${encodeURIComponent(key)}`;
    const body = {
      structuredQuery: {
        from: [{ collectionId: 'seats' }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'dateFormatted' },
            op: 'IN',
            value: { arrayValue: { values: labels.map((l) => ({ stringValue: l })) } },
          },
        },
      },
    };
    const res = this.http.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(body),
      muteHttpExceptions: true,
    });
    const code = res.getResponseCode();
    const text = res.getContentText();
    // A rejected key (Ticqet changed it): fetch the new one from ticqet.rw once.
    if ((code === 400 || code === 403) && /api.?key/i.test(text) && !this.keyRetried && !this.fixedKey()) {
      this.keyRetried = true;
      this.state.apiKey = null;
      log.warn('[ticqet] the saved Ticqet key was refused - reading the current one from ticqet.rw');
      return this.query(eventId, labels);
    }
    if (code !== 200) throw new Error(`Ticqet answered HTTP ${code}: ${text.slice(0, 200)}`);
    return JSON.parse(text).filter((x) => x.document).map((x) => x.document);
  }

  fixedKey() {
    const k = this.settings.firebase && this.settings.firebase.apiKey;
    return k && k !== 'AUTO' ? k : null;
  }

  // Ticqet's public web key: from the settings if pinned, else read from the
  // Ticqet app once and remembered between runs.
  apiKey() {
    const fixed = this.fixedKey();
    if (fixed) return fixed;
    if (this.state.apiKey) return this.state.apiKey;
    const res = this.http.fetch(BUNDLE_URL, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw new Error(`could not download the Ticqet app (HTTP ${res.getResponseCode()})`);
    const key = extractApiKey(res.getContentText(), this.project);
    if (!key) throw new Error('no Firebase key found in the Ticqet app - Ticqet may have changed its system');
    this.state.apiKey = key;
    log.info('[ticqet] read the Firebase web key from ticqet.rw');
    return key;
  }
}
