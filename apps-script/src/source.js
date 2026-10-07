// Reads the court's bookings from Ticqet with plain HTTPS calls to Firestore's
// REST API - the same public schedule the Ticqet website shows. Each run reads
// the whole watch window at once (30 dates per request, so 60 days = 2 calls).
//
// It offers the same interface the engine expects from the live watcher:
//   get(label) -> [record] | undefined,  lastContactAt,  oldestErrorAt
// `state` is saved between runs by main.js, because every Apps Script run
// starts fresh: { apiKey, lastContactAt, errorSince, lastError }.

import { BUNDLE_URL, extractApiKey } from '../../src/ticqet-key.js';
import { log } from './logger.js';

const PER_QUERY = 30; // Firestore accepts up to 30 values in one "IN" filter

const valueOf = (v) => String(v.stringValue ?? v.integerValue ?? v.doubleValue ?? '');

export class TicqetRest {
  // http: UrlFetchApp (or a fake with the same fetch()).
  constructor({ settings, http, state, now = () => Date.now() }) {
    this.settings = settings;
    this.http = http;
    this.state = state;
    this.now = now;
    this.days = new Map(); // label -> [{ id, seats, section }]
    this.createTimes = new Map(); // record id -> when it was created on Ticqet (ISO)
    this.keyRetried = false;
  }

  watch() {} // the engine calls this; main.js reads with load() before the engine runs

  get(label) {
    return this.days.get(label);
  }

  get lastContactAt() {
    return this.state.lastContactAt ?? null;
  }

  get oldestErrorAt() {
    return this.state.errorSince ?? null;
  }

  // Read every date in `labels`. Returns true on success. On failure nothing is
  // returned for any date, so a failed read can never look like cancellations.
  load(labels) {
    const fb = this.settings.firebase || {};
    const project = fb.projectId || 'kigali-arena';
    const eventId = this.settings.court && this.settings.court.ticqetEventId;
    try {
      if (!eventId) throw new Error('the court\'s Ticqet ID is missing (Facilities sheet).');
      const days = new Map(labels.map((l) => [l, []]));
      for (let i = 0; i < labels.length; i += PER_QUERY) {
        for (const doc of this.query(project, eventId, labels.slice(i, i + PER_QUERY))) {
          const f = doc.fields || {};
          const label = f.dateFormatted && f.dateFormatted.stringValue;
          if (!days.has(label)) continue;
          const id = doc.name.split('/').pop();
          const seats = ((f.seats && f.seats.arrayValue && f.seats.arrayValue.values) || []).map(valueOf);
          days.get(label).push({ id, seats, section: (f.section && f.section.stringValue) || null });
          if (doc.createTime) this.createTimes.set(id, doc.createTime);
        }
      }
      this.days = days;
      this.state.lastContactAt = this.now();
      this.state.errorSince = null;
      this.state.lastError = null;
      return true;
    } catch (err) {
      this.days = new Map();
      this.state.errorSince = this.state.errorSince || this.now();
      this.state.lastError = err.message;
      log.warn(`[ticqet] could not read Ticqet: ${err.message}`);
      return false;
    }
  }

  query(project, eventId, labels) {
    const key = this.apiKey(project);
    const url = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/events/${eventId}:runQuery?key=${encodeURIComponent(key)}`;
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
      return this.query(project, eventId, labels);
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
  apiKey(project) {
    const fixed = this.fixedKey();
    if (fixed) return fixed;
    if (this.state.apiKey) return this.state.apiKey;
    const res = this.http.fetch(BUNDLE_URL, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw new Error(`could not download the Ticqet app (HTTP ${res.getResponseCode()})`);
    const key = extractApiKey(res.getContentText(), project);
    if (!key) throw new Error('no Firebase key found in the Ticqet app - Ticqet may have changed its system');
    this.state.apiKey = key;
    log.info('[ticqet] read the Firebase web key from ticqet.rw');
    return key;
  }
}
