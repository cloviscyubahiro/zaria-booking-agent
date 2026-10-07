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

// Every setting has a safe default, so an older settings.json never crashes the agent.
export const DEFAULT_SETTINGS = {
  timezone: 'Africa/Kigali',
  venue: { name: 'Zaria Court', ticqetVenueId: 'mTNigTpKron5hpoNE2ws' },
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
  if (!s.court?.ticqetEventId) problems.push('court.ticqetEventId is missing.');
  const wd = Number(s.watch?.windowDays);
  if (!Number.isInteger(wd) || wd < 1 || wd > 90) problems.push('watch.windowDays must be between 1 and 90.');
  if (problems.length) throw new Error(`Settings problem: ${problems.join(' ')}`);
  return s;
}

// Check and normalize regular client rows. Bad rows are skipped with a warning
// rather than stopping the agent.
export function cleanRegulars(rows) {
  const out = [];
  for (const [i, r] of (rows || []).entries()) {
    const where = `regular client row ${i + 1} (${r.client || 'no name'})`;
    if (!r.client) continue;
    if (!WEEKDAYS.includes(r.day)) { log.warn(`[config] ${where}: day "${r.day}" is not a weekday name - skipped.`); continue; }
    if (!HHMM.test(String(r.start)) || !HHMM.test(String(r.end))) { log.warn(`[config] ${where}: start/end must be HH:MM - skipped.`); continue; }
    if (r.end <= r.start) { log.warn(`[config] ${where}: end must be after start - skipped.`); continue; }
    if (!r.start.endsWith(':00') || !r.end.endsWith(':00')) log.warn(`[config] ${where}: Ticqet works in whole hours; ${r.start}-${r.end} is rounded to the hour.`);
    const iso = (v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
    out.push({ ...r, from: iso(r.from), until: iso(r.until) });
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
    const flags = { alerts: !!c.alerts, summaries: !!c.summaries, reminders: !!c.reminders, admin: !!c.admin };
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

// Load everything. Returns { settings, regulars, contacts } plus file mtimes.
export function loadConfig(dir = path.resolve('config')) {
  const settings = readJson(dir, 'settings.json');
  const regulars = readJson(dir, 'regular-clients.json');
  const contacts = readJson(dir, 'contacts.json');

  const cfg = {
    settings: withDefaults(settings.data),
    regulars: cleanRegulars(regulars.data),
    contacts: cleanContacts(contacts.data),
    _dir: dir,
    _mtimes: { 'settings.json': settings.mtime, 'regular-clients.json': regulars.mtime, 'contacts.json': contacts.mtime },
  };
  if (!cfg.contacts.some((c) => c.admin)) log.warn('[config] no admin contact set - technical, clash and renewal alerts will have nowhere to go.');
  if (!cfg.contacts.some((c) => c.reminders)) log.warn('[config] nobody has attendant reminders switched on.');
  return cfg;
}

// Have any config files changed since this config was loaded?
export function configChanged(cfg) {
  try {
    for (const [file, prev] of Object.entries(cfg._mtimes)) {
      if (fs.statSync(path.join(cfg._dir, file)).mtimeMs !== prev) return true;
    }
  } catch { /* a file briefly missing mid-edit: ignore */ }
  return false;
}

// Who receives what:
//   team       -> "New booking alerts" = Yes   (new / cancelled / changed bookings)
//   attendants -> "Attendant reminders" = Yes  (reminders, last-minute bookings)
//   summaries  -> "Daily & weekly updates" = Yes
//   admin      -> "Admin alerts" = Yes         (technical, clash, renewal, checks)
//   everyone   -> every listed contact         (welcome message)
const GROUP_FLAG = { team: 'alerts', attendants: 'reminders', summaries: 'summaries', admin: 'admin' };

// Where a contact is reached on a channel: the email address for email, the
// phone number for WhatsApp/SMS. Preview shows whichever the contact has.
export function addressOf(contact, channel) {
  if (channel === 'email') return contact.email || null;
  if (channel === 'preview') return contact.phone || contact.email || null;
  return contact.phone || null;
}

export function recipients(cfg, group) {
  const channel = cfg.settings?.channel;
  const list = group === 'everyone' ? cfg.contacts : cfg.contacts.filter((c) => c[GROUP_FLAG[group]]);
  return [...new Set(list.map((c) => addressOf(c, channel)).filter(Boolean))];
}

export function adminName(cfg) {
  const a = cfg.contacts.find((c) => c.admin && c.name);
  return a?.name || cfg.settings.adminName || 'the admin';
}
