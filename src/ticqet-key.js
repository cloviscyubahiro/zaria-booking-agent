// Ticqet's public Firebase web API key, and where to find it. Shared by the
// live watcher (ticqet.js) and the Google Apps Script version, which reads
// Ticqet with plain HTTPS calls.

export const BUNDLE_URL = 'https://ticqet.rw/main.dart.js';

// The key is embedded in Ticqet's JS bundle (as in every Firebase web app - it
// identifies the project, it is not a secret). If several keys appear, take the
// one closest to the project id.
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
