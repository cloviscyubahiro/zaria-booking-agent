// Loads all configuration: the .env secrets, and the three JSON files under
// config/ (settings, regular-clients, contacts). Those JSON files are normally
// produced from the Excel setup workbook by `npm run config`.
//
// Config is reloaded automatically when a file changes on disk, so staff or
// schedule edits take effect without restarting the agent.

import fs from 'node:fs';
import path from 'node:path';
import { log } from './logger.js';
import { WEEKDAYS, zoneSupported } from './time.js';
import { KNOWN_FACILITIES, resolveFacility, sameName } from './facilities.js';
import { cleanChanges } from './changes.js';

export { KNOWN_FACILITIES, resolveFacility };

// Every setting has a safe default, so an older settings.json never crashes the agent.
export const DEFAULT_SETTINGS = {
  timezone: 'Africa/Kigali',
  venue: { name: 'Zaria Court', ticqetVenueId: 'mTNigTpKron5hpoNE2ws', facilities: KNOWN_FACILITIES },
  // The main facility. "facilities" (the list of watched facilities) defaults
  // to just this one; the first watched facility is always also "court".
  court: { name: 'Multi-Purpose Court', ticqetEventId: 'wyUcHcKLSP52EBIr9asf' },
  firebase: { projectId: 'kigali-arena', authDomain: 'kigali-arena.firebaseapp.com', apiKey: 'AUTO' },
  // windowDays: how far ahead to watch. settleSeconds: wait this long after a
  // change before alerting (absorbs Ticqet re-writing a record). probeMinutes:
  // how often to double-check the live connection against the server.
  watch: { windowDays: 60, settleSeconds: 60, probeMinutes: 5 },
  channel: 'preview', // preview | whatsapp-cloud | pindo | email
  smsSenderName: 'ZariaCourt',
  emailSenderName: 'Zaria Court Bookings',
  dailyUpdateTime: '06:30',
  weeklyOverviewDay: 'Monday',
  weeklyOverviewTime: '06:30',
  attendantReminderMinutes: [60, 15],
  quietHours: { start: '23:00', end: '06:00' },
  technicalAlertAfterMinutes: 15,
  renewalReminderDaysBefore: 3,
  openSlotCheckDaysAhead: 7,
  maxAlertsAtOnce: 5,
  maxMessagesPerDay: 300,
  sendWelcome: true,
  adminName: 'the admin',
  // One Ticqet booking this many hours long (or longer) is an event or event
  // setup: the team gets a notice the day before, with the teams to call. 0 = off.
  eventMinHours: 6,
  // Umuganda, the last Saturday of every month. null = not shown.
  umuganda: { start: '08:00', end: '11:00' },
};

const CHANNEL_ALIASES = {
  preview: 'preview',
  whatsapp: 'whatsapp-cloud',
  'whatsapp-cloud': 'whatsapp-cloud',
  sms: 'pindo',
  pindo: 'pindo',
  email: 'email',
  'e-mail': 'email',
  gmail: 'email',
};

export function normalizeChannel(value) {
  const c = CHANNEL_ALIASES[String(value || 'preview').trim().toLowerCase()];
  if (!c) throw new Error(`Unknown channel "${value}". Use preview, email, whatsapp or sms.`);
  return c;
}

export function channelName(channel) {
  return { 'whatsapp-cloud': 'WhatsApp', pindo: 'SMS', email: 'email', preview: 'preview' }[channel] || channel;
}

// --- .env loading (no dependency) ---
export function loadEnv(file = '.env') {
  const envPath = path.resolve(file);
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m || process.env[m[1]] !== undefined) continue;
      process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  return process.env;
}

// --- phone normalization ---
// Accepts "0788123456", "250788123456", "+250788123456", "788123456" (Excel
// sometimes drops the leading 0). Returns "+250788123456" or throws.
export function normalizePhone(raw) {
  const s = String(raw).replace(/[\s\-()]/g, '');
  let digits;
  if (s.startsWith('+250')) digits = s.slice(4);
  else if (s.startsWith('250') && s.length === 12) digits = s.slice(3);
  else if (s.startsWith('0')) digits = s.slice(1);
  else digits = s;
  if (!/^7\d{8}$/.test(digits)) throw new Error(`Invalid Rwandan mobile number: "${raw}"`);
  return `+250${digits}`;
}

// --- email normalization ---
// " Clovis@Gmail.com " -> "clovis@gmail.com". Throws on anything that is not a
// single plain address (no names, no lists).
export function normalizeEmail(raw) {
  const s = String(raw).trim().toLowerCase();
  if (!/^[^\s@,;<>()]+@[^\s@,;<>()]+\.[a-z]{2,}$/.test(s)) throw new Error(`Invalid email address: "${raw}"`);
  return s;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object'
      ? deepMerge(base[k], v)
      : v;
  }
  return out;
}

// Merge a (possibly partial) settings object with defaults and check it.
// Throws with a plain-English message on anything that would break the agent.
export function withDefaults(raw = {}) {
  const s = deepMerge(DEFAULT_SETTINGS, raw);
  const problems = [];
  try { s.channel = normalizeChannel(s.channel); } catch (e) { problems.push(e.message); }
  if (!zoneSupported(s.timezone)) problems.push(`Unknown timezone "${s.timezone}".`);
  for (const [label, v] of [
    ['dailyUpdateTime', s.dailyUpdateTime], ['weeklyOverviewTime', s.weeklyOverviewTime],
    ['quietHours.start', s.quietHours?.start], ['quietHours.end', s.quietHours?.end],
  ]) {
    if (v != null && !HHMM.test(String(v))) problems.push(`${label} must be a 24-hour time like 06:30 (got "${v}").`);
  }
  if (!WEEKDAYS.includes(s.weeklyOverviewDay)) problems.push(`weeklyOverviewDay must be a weekday name (got "${s.weeklyOverviewDay}").`);
  const mins = [...new Set((s.attendantReminderMinutes || []).map(Number))].filter((n) => Number.isInteger(n) && n > 0);
  s.attendantReminderMinutes = mins.sort((a, b) => b - a);

  // The facilities to watch. Older settings name only "court".
  const listed = Array.isArray(s.facilities) && s.facilities.length ? s.facilities : [s.court];
  const facilities = [];
  for (const f of listed) {
    const name = String(f?.name ?? '').trim();
    const id = String(f?.ticqetEventId ?? '').trim();
    if (!name || !id) { problems.push(`Every watched facility needs a name and a Ticqet ID (got "${name}" / "${id}").`); continue; }
    if (facilities.some((x) => x.ticqetEventId === id)) { problems.push(`The Ticqet ID ${id} is used for more than one facility.`); continue; }
    if (facilities.some((x) => sameName(x.name, name))) { problems.push(`The facility "${name}" is listed twice.`); continue; }
    facilities.push({ name, ticqetEventId: id });
  }
  if (!facilities.length && !problems.length) problems.push('No facility to watch: set one facility to Watch = Yes, with its Ticqet ID.');
  s.facilities = facilities;
  if (facilities.length) s.court = { ...facilities[0] };

  const ev = Number(s.eventMinHours ?? 0);
  if (!Number.isInteger(ev) || ev < 0 || ev > 24) problems.push(`eventMinHours must be a whole number of hours from 0 to 24 (got "${s.eventMinHours}").`);
  else s.eventMinHours = ev;
  if (s.umuganda) {
    const { start, end } = s.umuganda;
    if (!HHMM.test(String(start)) || !HHMM.test(String(end)) || end <= start) problems.push(`umuganda must be two 24-hour times like 08:00-11:00 (got "${start}-${end}").`);
  } else {
    s.umuganda = null;
  }

  const wd = Number(s.watch?.windowDays);
  if (!Number.isInteger(wd) || wd < 1 || wd > 90) problems.push('watch.windowDays must be between 1 and 90.');
  if (problems.length) throw new Error(`Settings problem: ${problems.join(' ')}`);
  return s;
}

// Check and normalize regular client rows. Bad rows are skipped with a warning
// rather than stopping the agent. A row without a facility belongs to the main
// facility; a facility name is matched loosely ("Pitch A" = "5-a-side Pitch A").
export function cleanRegulars(rows, facilities = null) {
  const out = [];
  for (const [i, r] of (rows || []).entries()) {
    const where = `regular client row ${i + 1} (${r.client || 'no name'})`;
    if (!r.client) continue;
    if (!WEEKDAYS.includes(r.day)) { log.warn(`[config] ${where}: day "${r.day}" is not a weekday name - skipped.`); continue; }
    if (!HHMM.test(String(r.start)) || !HHMM.test(String(r.end))) { log.warn(`[config] ${where}: start/end must be HH:MM - skipped.`); continue; }
    if (r.end <= r.start) { log.warn(`[config] ${where}: end must be after start - skipped.`); continue; }
    if (!r.start.endsWith(':00') || !r.end.endsWith(':00')) log.warn(`[config] ${where}: Ticqet works in whole hours; ${r.start}-${r.end} is rounded to the hour.`);
    const iso = (v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
    let facility = r.facility || null;
    if (facilities?.length) {
      const f = facility ? resolveFacility(facility, facilities) : facilities[0];
      if (f) facility = f.name;
      else log.warn(`[config] ${where}: facility "${facility}" is not one of the watched facilities.`);
    }
    out.push({ ...r, facility, from: iso(r.from), until: iso(r.until) });
  }
  return out;
}

// Check and normalize contacts. A contact is reached by phone (WhatsApp/SMS),
// by email, or both. Duplicates are merged (any Yes wins).
export function cleanContacts(rows) {
  const out = [];
  const byAddress = new Map(); // phone or email -> contact
  for (const c of rows || []) {
    let phone = null;
    let email = null;
    if (c.number) {
      try { phone = normalizePhone(c.number); } catch (e) { log.warn(`[config] ${e.message} - number ignored.`); }
    }
    if (c.email) {
      try { email = normalizeEmail(c.email); } catch (e) { log.warn(`[config] ${e.message} - email ignored.`); }
    }
    if (!phone && !email) {
      if (c.role || c.name) log.warn(`[config] contact "${c.name || c.role}" has no number or email yet - skipped. Fill it in on the Contacts sheet.`);
      continue;
    }
    // reminder1 / reminder2: the first (e.g. 60 min) and second (e.g. 15 min)
    // reminder before a session. The older single "reminders" tick means both.
    const r1 = !!(c.reminder1 ?? c.reminders);
    const r2 = !!(c.reminder2 ?? c.reminders);
    const flags = { alerts: !!c.alerts, summaries: !!c.summaries, reminders: r1 || r2, reminder1: r1, reminder2: r2, admin: !!c.admin };
    const prev = (phone && byAddress.get(phone)) || (email && byAddress.get(email));
    if (prev) {
      log.warn(`[config] ${c.number || c.email} is listed twice - merged.`);
      for (const k of Object.keys(flags)) prev[k] = prev[k] || flags[k];
      if (!prev.phone && phone) prev.phone = phone;
      if (!prev.email && email) prev.email = email;
      if (phone) byAddress.set(phone, prev);
      if (email) byAddress.set(email, prev);
      continue;
    }
    const entry = { number: c.number ? String(c.number) : '', email: email || '', role: c.role || '', name: c.name || '', phone, ...flags };
    out.push(entry);
    if (phone) byAddress.set(phone, entry);
    if (email) byAddress.set(email, entry);
  }
  return out;
}

function readJson(dir, name) {
  const full = path.join(dir, name);
  if (!fs.existsSync(full)) {
    throw new Error(`Missing ${full}. Run "npm run config" to create it from the Excel workbook (see README).`);
  }
  try {
    return { data: JSON.parse(fs.readFileSync(full, 'utf8')), mtime: fs.statSync(full).mtimeMs };
  } catch (e) {
    throw new Error(`${full} is not valid JSON: ${e.message}`);
  }
}

// Load everything. Returns { settings, regulars, contacts, changes } plus file
// mtimes. config/schedule-changes.json (one-off changes, see changes.js) is optional.
export function loadConfig(dir = path.resolve('config')) {
  const settings = readJson(dir, 'settings.json');
  const regulars = readJson(dir, 'regular-clients.json');
  const contacts = readJson(dir, 'contacts.json');
  const changesFile = path.join(dir, 'schedule-changes.json');
  const changes = fs.existsSync(changesFile) ? readJson(dir, 'schedule-changes.json') : { data: [], mtime: 0 };

  const s = withDefaults(settings.data);
  const cfg = {
    settings: s,
    regulars: cleanRegulars(regulars.data, s.facilities),
    contacts: cleanContacts(contacts.data),
    _dir: dir,
    _mtimes: { 'settings.json': settings.mtime, 'regular-clients.json': regulars.mtime, 'contacts.json': contacts.mtime, 'schedule-changes.json': changes.mtime },
  };
  const rows = (Array.isArray(changes.data) ? changes.data : []).map((c, i) => ({ row: i + 1, ...c }));
  cfg.changes = cleanChanges(rows, { regulars: cfg.regulars, facilities: s.facilities });
  for (const c of cfg.changes) if (c.problem) log.warn(`[config] schedule change ${c.row}: ${c.problem}`);
  if (!cfg.contacts.some((c) => c.admin)) log.warn('[config] no admin contact set - technical, clash and renewal alerts will have nowhere to go.');
  if (!cfg.contacts.some((c) => c.reminders)) log.warn('[config] nobody has attendant reminders switched on.');
  return cfg;
}

// Have any config files changed since this config was loaded?
export function configChanged(cfg) {
  try {
    for (const [file, prev] of Object.entries(cfg._mtimes)) {
      const full = path.join(cfg._dir, file);
      const now = fs.existsSync(full) ? fs.statSync(full).mtimeMs : 0;
      if (now !== prev) return true;
    }
  } catch { /* a file briefly missing mid-edit: ignore */ }
  return false;
}

// Who receives what:
//   team       -> "New booking alerts" = Yes   (new / cancelled / changed bookings)
//   reminder1  -> "Reminder 1" = Yes           (first reminder, e.g. 60 min before)
//   reminder2  -> "Reminder 2" = Yes           (second reminder, e.g. 15 min before)
//   attendants -> either reminder              (last-minute bookings)
//   summaries  -> "Daily & weekly updates" = Yes
//   admin      -> "Admin alerts" = Yes         (technical, clash, renewal, checks)
//   everyone   -> every listed contact         (welcome message)
// An older contact with only "reminders" (Attendant reminders) gets both reminders.
const GROUP_FLAG = { team: 'alerts', summaries: 'summaries', admin: 'admin' };

function inGroup(c, group) {
  if (group === 'everyone') return true;
  if (group === 'attendants') return !!(c.reminders || c.reminder1 || c.reminder2);
  if (group === 'reminder1' || group === 'reminder2') return !!(c[group] ?? c.reminders);
  return !!c[GROUP_FLAG[group]];
}

// Where a contact is reached on a channel: the email address for email, the
// phone number for WhatsApp/SMS. Preview shows whichever the contact has.
export function addressOf(contact, channel) {
  if (channel === 'email') return contact.email || null;
  if (channel === 'preview') return contact.phone || contact.email || null;
  return contact.phone || null;
}

export function recipients(cfg, group) {
  const channel = cfg.settings?.channel;
  const list = cfg.contacts.filter((c) => inGroup(c, group));
  return [...new Set(list.map((c) => addressOf(c, channel)).filter(Boolean))];
}

export function adminName(cfg) {
  const a = cfg.contacts.find((c) => c.admin && c.name);
  return a?.name || cfg.settings.adminName || 'the admin';
}
