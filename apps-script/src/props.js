// A small JSON store on top of Apps Script's Script Properties: read once at the
// start of a run, written back in one call at the end. Each property value is
// limited to 9 KB, so every value is stored in chunks: "<key>#n" holds the
// chunk count and "<key>#0", "<key>#1", ... the JSON text.

const CHUNK = 2500; // characters: under 9 KB even if every character took 3 bytes

export class Props {
  constructor(service) {
    this.service = service; // PropertiesService.getScriptProperties()
    this.raw = service.getProperties() || {};
    this.dirty = new Map(); // key -> latest value, written by flush()
  }

  get(key, fallback) {
    if (this.dirty.has(key)) return this.dirty.get(key);
    const n = Number(this.raw[`${key}#n`] || 0);
    if (!n) return fallback;
    let text = '';
    for (let i = 0; i < n; i++) text += this.raw[`${key}#${i}`] || '';
    try {
      return JSON.parse(text);
    } catch {
      return fallback;
    }
  }

  set(key, value) {
    this.dirty.set(key, value);
  }

  flush() {
    if (!this.dirty.size) return;
    const out = {};
    const stale = [];
    for (const [key, value] of this.dirty) {
      const text = JSON.stringify(value);
      const n = Math.max(1, Math.ceil(text.length / CHUNK));
      for (let i = 0; i < n; i++) out[`${key}#${i}`] = text.slice(i * CHUNK, (i + 1) * CHUNK);
      out[`${key}#n`] = String(n);
      for (let i = n; i < Number(this.raw[`${key}#n`] || 0); i++) stale.push(`${key}#${i}`);
    }
    this.service.setProperties(out); // other keys are kept
    for (const k of stale) this.service.deleteProperty(k);
    Object.assign(this.raw, out);
    for (const k of stale) delete this.raw[k];
    this.dirty.clear();
  }
}
