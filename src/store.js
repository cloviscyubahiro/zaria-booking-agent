// Local persistence, as plain JSON files under data/. This lets the agent
// remember what it has already seen and already sent, so restarting it does not
// re-announce old bookings or fire reminders twice.

import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './logger.js';

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir(), file), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, file);
  const tmp = full + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, full); // atomic replace so a crash never leaves half a file
}

// --- bookings already processed, keyed by Ticqet date label -> [booking...] ---
export function loadSnapshot() {
  const s = readJson('snapshot.json', null);
  return s && s.days ? s : { days: {} };
}
export function saveSnapshot(snap) {
  writeJson('snapshot.json', snap);
}

// --- reminder flags: "rem|YYYY-MM-DD|startHour|minutes" keys already sent ---
export function loadReminders() {
  return new Set(readJson('reminders.json', []));
}
export function saveReminders(set) {
  writeJson('reminders.json', [...set]);
}

// --- deferred queue: alerts held during quiet hours, flushed in the morning ---
export function loadDeferred() {
  return readJson('deferred.json', []);
}
export function saveDeferred(list) {
  writeJson('deferred.json', list);
}

// --- one-off jobs already done (morning update, digests, renewals, counters) ---
export function loadJobMarks() {
  return readJson('jobs.json', {});
}
export function saveJobMarks(marks) {
  writeJson('jobs.json', marks);
}

// --- append-only booking log (for settling "did they book?" disputes) ---
export function appendBookingLog(entry) {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'bookings-log.jsonl'), JSON.stringify(entry) + '\n');
}
