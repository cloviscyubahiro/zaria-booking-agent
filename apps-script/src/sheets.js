// The Google Sheet: the tabs the team edits (Schedule Changes, Contacts,
// Regular Clients, Settings, Facilities) and the tabs the agent writes (Status,
// Bookings Log, Preview, and the "Agent status" column of Schedule Changes).
// setupTabs() only creates tabs that are missing, and the upgrade steps only
// add what an older sheet lacks, so nothing the team typed is overwritten.

import { nowInZone, dayFromLabel, shortDate, isoDate } from '../../src/time.js';
import { slotsToRanges, rangesText } from '../../src/bookings.js';
import { matchRegular } from '../../src/regulars.js';
import { resolveFacility, nameKey } from '../../src/facilities.js';

export const TABS = {
  status: 'Status',
  changes: 'Schedule Changes',
  log: 'Bookings Log',
  contacts: 'Contacts',
  regulars: 'Regular Clients',
  settings: 'Settings',
  facilities: 'Facilities',
  preview: 'Preview',
};

const NAVY = '#093254';
const GREY = '#5b6475';
const FILL_ME = '#fff2cc'; // light yellow: cells someone needs to fill in
const ZONE = 'Africa/Kigali';
const pad = (n) => String(n).padStart(2, '0');
const isDate = (v) => Object.prototype.toString.call(v) === '[object Date]';
const norm = (v) => String(v ?? '').trim().toLowerCase();

// "2026-10-07 14:05" in Kigali time, from a Date, ISO string or milliseconds.
export function kigaliStamp(at) {
  const n = nowInZone(ZONE, at instanceof Date ? at : new Date(at));
  return `${n.y}-${pad(n.m)}-${pad(n.d)} ${pad(n.hour)}:${pad(n.minute)}`;
}

// ---------- reading the tabs the team edits ----------

// Dates and times typed into the sheet arrive as Date objects; turn them back
// into the text the agent reads ("17:00", "2026-10-31"), in the sheet's own
// time zone so nothing shifts.
function cellValue(v, tz) {
  if (!isDate(v)) return v;
  return v.getFullYear() < 1900 ? Utilities.formatDate(v, tz, 'HH:mm') : Utilities.formatDate(v, tz, 'yyyy-MM-dd');
}

export function readConfigSheets(ss) {
  const tz = ss.getSpreadsheetTimeZone() || ZONE;
  const out = [];
  for (const name of [TABS.contacts, TABS.regulars, TABS.settings, TABS.facilities, TABS.changes]) {
    const sh = ss.getSheetByName(name);
    if (!sh) continue;
    out.push({ sheet: name, data: sh.getDataRange().getValues().map((row) => row.map((v) => cellValue(v, tz))) });
  }
  return out;
}

// ---------- writing ----------

const WHAT = {
  'first-seen': 'Already on Ticqet',
  added: 'New booking',
  removed: 'Cancelled / freed',
  changed: 'Hours changed',
};

const hoursText = (slots) => rangesText(slotsToRanges(slots)).replace(/ \(\d+ hrs?\)$/, '');

// The first row of a tab, as lower-case labels (at most 12 columns, never
// more than the sheet has).
function headerOf(sh, row = 1) {
  let cols = 12;
  try {
    const max = sh.getMaxColumns();
    if (typeof max === 'number' && max > 0) cols = Math.min(max, 12);
  } catch { /* keep 12 */ }
  return sh.getRange(row, 1, 1, cols).getValues()[0].map(norm);
}

// `cfg` (optional) names the regular client for bookings in their usual hours.
export function appendBookingLog(ss, entries, createTimes, cfg = null) {
  if (!entries.length) return;
  const sh = ss.getSheetByName(TABS.log);
  if (!sh) return;
  const withFacility = headerOf(sh).includes('facility');
  const eventHours = cfg ? cfg.settings.eventMinHours : 0;
  const rows = entries.map((e) => {
    const day = dayFromLabel(e.date);
    const slots = e.event === 'changed' ? e.to : e.slots || [];
    const time = e.event === 'changed' ? `was ${hoursText(e.from)}, now ${hoursText(e.to)}` : hoursText(slots);
    const created = createTimes.get(e.id);
    const facility = e.facility || (cfg ? cfg.settings.court.name : '');
    const isEvent = eventHours > 0 && new Set(slots.map(Number)).size >= eventHours;
    const regular = isEvent ? '' : e.regular || (cfg && day ? matchRegular({ slots: slots.map(Number) }, cfg.regulars, day, facility, cfg.changes || []) : null);
    const row = [
      kigaliStamp(e.at),
      `${WHAT[e.event] || e.event}${isEvent ? ' (event / setup)' : ''}`,
      day ? `${shortDate(day.y, day.m, day.d)} ${day.y}` : e.date,
      time,
      new Set(slots.map(Number)).size,
      regular || '',
      created ? kigaliStamp(created) : '',
      e.id,
    ];
    if (withFacility) row.splice(2, 0, facility);
    return row;
  });
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
}

export function appendPreview(ss, items, keepRows = 2000) {
  if (!items.length) return;
  const sh = ss.getSheetByName(TABS.preview);
  if (!sh) return;
  const rows = items.map((m) => [kigaliStamp(new Date()), m.kind, m.to, m.subject, m.text]);
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  const extra = sh.getLastRow() - 1 - keepRows;
  if (extra > 0) sh.deleteRows(2, extra); // keep the newest rows only
}

export function writeStatus(ss, rows) {
  const sh = ss.getSheetByName(TABS.status);
  if (!sh) return;
  const values = rows.map(([k, v]) => [k, v === null || v === undefined ? '' : String(v)]);
  sh.getRange(3, 1, values.length, 2).setValues(values);
}

// The "Agent status" column of the Schedule Changes tab: what the agent made
// of each row. `statuses` = Map(sheet row -> text). Only changed cells are written.
export function writeChangeStatuses(ss, statuses) {
  const sh = ss.getSheetByName(TABS.changes);
  if (!sh || !statuses) return;
  const values = sh.getDataRange().getValues();
  const hi = values.findIndex((r) => norm(r[0]) === 'date');
  if (hi < 0) return;
  const col = values[hi].map(norm).findIndex((h) => h.startsWith('agent status'));
  if (col < 0) return;
  const out = [];
  let changed = false;
  for (let i = hi + 1; i < values.length; i++) {
    const text = statuses.get(i + 1) || '';
    if (String(values[i][col] ?? '') !== text) changed = true;
    out.push([text]);
  }
  if (changed && out.length) sh.getRange(hi + 2, col + 1, out.length, 1).setValues(out);
}

// ---------- setup ----------

function header(sh, row, labels, widths) {
  sh.getRange(row, 1, 1, labels.length).setValues([labels])
    .setFontWeight('bold').setFontColor('#ffffff').setBackground(NAVY).setWrap(true);
  sh.setFrozenRows(row);
  widths.forEach((w, i) => sh.setColumnWidth(i + 1, w));
}

function title(sh, text, note) {
  sh.getRange(1, 1).setValue(text).setFontSize(14).setFontWeight('bold').setFontColor(NAVY);
  if (note) sh.getRange(2, 1).setValue(note).setFontColor(GREY);
}

const list = (values) => SpreadsheetApp.newDataValidation().requireValueInList(values, true).setAllowInvalid(false).build();

// Column titles for the two reminders, e.g. "Reminder 1 (60 min before)". The
// agent finds the columns by their start ("Reminder 1"), so the rest is a label.
function reminderLabels(settings) {
  const [a = 60, b = 15] = settings.attendantReminderMinutes || [];
  return [`Reminder 1 (${a} min before)`, `Reminder 2 (${b} min before)`];
}

// "2026-10-10" -> "10/10/2026", as dates are typed in Rwanda.
const dmy = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');

const FACILITIES_NOTE = 'Every facility with Watch = Yes is watched. The Ticqet ID is the code at the end of its link on ticqet.rw.';
const CHANGES_NOTE = 'For one-off changes: car-free day, Umuganda, an event, a team not coming. New time like 12:00-14:00, or Cancelled; leave it empty for a note. Tick Email everyone when the row is ready - the agent emails it within 5 minutes and uses it in reminders and the daily update.';

const SETTING_ROWS_ADDED = [
  ['Event day: one booking of at least (hours)', (s) => String(s.eventMinHours), 'A booking this long is an event or setup: the team and the admin are told the day before, with the teams to call. 0 = off.'],
  ['Umuganda (last Saturday of the month)', (s) => (s.umuganda ? `${s.umuganda.start}-${s.umuganda.end}` : ''), 'Shown in the daily update. The admin hears 3 days before about sessions booked during Umuganda. Empty = off.'],
];

const BUILDERS = {
  [TABS.status](sh) {
    title(sh, 'Agent status', 'Updated every time the agent checks Ticqet (every 5 minutes).');
    sh.setColumnWidth(1, 210);
    sh.setColumnWidth(2, 560);
    sh.getRange(3, 1, 14, 1).setFontWeight('bold');
    sh.getRange(3, 2, 14, 1).setWrap(true);
  },

  [TABS.changes](sh, defaults) {
    title(sh, 'Schedule changes', CHANGES_NOTE);
    sh.getRange(2, 1).setWrap(false);
    header(sh, 4, ['Date', 'Facility', 'Client', 'New time', 'Reason / message', 'Email everyone', 'Agent status'],
      [105, 170, 160, 110, 300, 90, 480]);
    sh.getRange(5, 4, 300, 1).setNumberFormat('@');
    sh.getRange(5, 6, 300, 1).insertCheckboxes();
    sh.getRange(5, 7, 300, 1).setFontColor(GREY).setWrap(true);
    const today = isoDate(nowInZone(ZONE));
    const rows = (defaults.changes || [])
      .filter((c) => c.date && c.date >= today)
      .map((c) => [dmy(c.date), c.facility || '', c.client || '', c.newTime || '', c.reason || '', !!c.email, '']);
    if (rows.length) sh.getRange(5, 1, rows.length, 7).setValues(rows);
  },

  [TABS.log](sh) {
    header(sh, 1, ['Logged (Kigali time)', 'What happened', 'Facility', 'Date', 'Time', 'Hours', 'Regular client', 'Created on Ticqet', 'Ticqet record'],
      [150, 170, 150, 130, 230, 60, 140, 150, 190]);
    sh.getRange('A:E').setNumberFormat('@');
    sh.getRange('G:I').setNumberFormat('@');
  },

  [TABS.contacts](sh, defaults) {
    title(sh, 'Who gets the emails', 'One person per row. Tick what each person gets. Admin alerts = possible double-bookings, technical problems, regular hours left open on Ticqet.');
    const [m1, m2] = reminderLabels(defaults.settings);
    header(sh, 4, ['Name', 'Role', 'Email', 'New booking alerts', 'Daily & weekly updates', m1, m2, 'Admin alerts'],
      [140, 170, 250, 110, 120, 120, 120, 100]);
    const rows = defaults.contacts.map((c) => [
      c.name || '', c.role || '', c.email || '', !!c.alerts, !!c.summaries,
      !!(c.reminder1 ?? c.reminders), !!(c.reminder2 ?? c.reminders), !!c.admin,
    ]);
    sh.getRange(5, 4, 20, 5).insertCheckboxes();
    if (rows.length) sh.getRange(5, 1, rows.length, 8).setValues(rows);
    rows.forEach((r, i) => {
      if (!r[2]) sh.getRange(5 + i, 3).setBackground(FILL_ME); // email still to fill in
    });
    sh.getRange(5, 3, 20, 1).setDataValidation(
      SpreadsheetApp.newDataValidation().requireTextIsEmail().setAllowInvalid(false).setHelpText('One email address, e.g. name@gmail.com').build(),
    );
  },

  [TABS.regulars](sh, defaults) {
    title(sh, 'Regular clients (booked directly with Zaria)', 'Their hours are never announced as new bookings. Times like 17:00. Dates like 31/10/2026; leave From/Until empty if ongoing.');
    header(sh, 4, ['Client', 'Facility', 'Day', 'Start', 'End', 'Type', 'From', 'Until'], [150, 170, 110, 70, 70, 100, 100, 100]);
    sh.getRange(5, 4, 100, 2).setNumberFormat('@');
    sh.getRange(5, 7, 100, 2).setNumberFormat('@');
    sh.getRange(5, 3, 100, 1).setDataValidation(list(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']));
    const rows = defaults.regulars.map((r) => [r.client, r.facility || '', r.day, r.start, r.end, r.type || '', dmy(r.from), dmy(r.until)]);
    if (rows.length) sh.getRange(5, 1, rows.length, 8).setValues(rows);
  },

  [TABS.settings](sh, defaults) {
    title(sh, 'Settings', 'Changes apply at the next check (within 5 minutes).');
    header(sh, 3, ['Setting', 'Value', 'What it does'], [270, 190, 480]);
    const s = defaults.settings;
    const rows = [
      ['Channel', 'Preview', 'Preview = nothing is sent, emails are written to the Preview tab. Email = send for real.'],
      ['Email sender name', s.emailSenderName, 'The name people see as the sender.'],
      ['Daily update time', s.dailyUpdateTime, 'Today\'s bookings, every morning (24-hour time).'],
      ['Weekly overview day', s.weeklyOverviewDay, 'On this day the week ahead replaces the daily update.'],
      ['Weekly overview time', s.weeklyOverviewTime, ''],
      ['Attendant reminder 1 (minutes before)', String(s.attendantReminderMinutes[0] ?? ''), 'Reminders to attendants before every session.'],
      ['Attendant reminder 2 (minutes before)', String(s.attendantReminderMinutes[1] ?? ''), ''],
      ['Quiet hours start', s.quietHours.start, 'No booking emails during quiet hours; they join the morning update.'],
      ['Quiet hours end', s.quietHours.end, ''],
      ['Technical alert after (minutes)', String(s.technicalAlertAfterMinutes), 'Email the admin if Ticqet cannot be read for this long.'],
      ['Renewal reminder (days before Until)', String(s.renewalReminderDaysBefore), 'Remind the admin before a regular client\'s Until date.'],
      ['Open regular slot check (days ahead)', String(s.openSlotCheckDaysAhead), 'Each morning: regular clients\' hours still open for anyone on Ticqet.'],
      ['Watch Ticqet (days ahead)', String(s.watch.windowDays), 'How far ahead bookings are watched (up to 90).'],
      ['Max separate alerts', String(s.maxAlertsAtOnce), 'More new bookings at once than this become one summary email.'],
      ['Max messages per day', String(s.maxMessagesPerDay), 'Safety limit. A free Google account can email at most 100 people a day.'],
      ['Send welcome message', s.sendWelcome ? 'Yes' : 'No', 'One welcome email to everyone when Channel changes.'],
      ...SETTING_ROWS_ADDED.map(([label, value, what]) => [label, value(s), what]),
    ];
    sh.getRange(4, 2, rows.length, 1).setNumberFormat('@');
    sh.getRange(4, 1, rows.length, 3).setValues(rows);
    sh.getRange(4, 3, rows.length, 1).setWrap(true).setFontColor(GREY);
    sh.getRange(4, 2).setDataValidation(list(['Preview', 'Email'])).setBackground(FILL_ME);
    sh.getRange(7, 2).setDataValidation(list(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']));
    sh.getRange(19, 2).setDataValidation(list(['Yes', 'No']));
  },

  [TABS.facilities](sh, defaults) {
    title(sh, 'Facilities on Ticqet', FACILITIES_NOTE);
    header(sh, 3, ['Facility', 'Ticqet ID', 'Watch', 'Notes'], [190, 210, 70, 420]);
    const known = defaults.settings.venue.facilities;
    sh.getRange(4, 1, known.length, 4).setValues(known.map((f) => [f.name, f.ticqetEventId, 'Yes', '']));
    sh.getRange(4, 3, 20, 1).setDataValidation(list(['Yes', 'No']));
  },

  [TABS.preview](sh) {
    header(sh, 1, ['Time (Kigali)', 'Type', 'To', 'Subject', 'Message'], [130, 120, 200, 360, 480]);
    sh.getRange('A:E').setNumberFormat('@');
  },
};

const ORDER = [TABS.status, TABS.changes, TABS.log, TABS.contacts, TABS.regulars, TABS.settings, TABS.facilities, TABS.preview];

// Create every missing tab, in order. Returns the names of the tabs created.
export function setupTabs(ss, defaults) {
  const created = [];
  ORDER.forEach((name, i) => {
    if (ss.getSheetByName(name)) return;
    const sh = ss.insertSheet(name, Math.min(i, ss.getSheets().length));
    BUILDERS[name](sh, defaults);
    created.push(name);
  });
  // A brand-new spreadsheet comes with one empty "Sheet1": remove it.
  for (const sh of ss.getSheets()) {
    if (/^(sheet|feuille|hoja|blatt)\s*\d+$/i.test(sh.getName()) && sh.getLastRow() === 0) ss.deleteSheet(sh);
  }
  if (created.length) applyValidations(ss);
  return created;
}

// Drop-down lists that point at other tabs: the facility of a regular client or
// of a schedule change comes from the Facilities tab, a schedule change's
// client from the Regular Clients tab (other names are allowed too).
export function applyValidations(ss) {
  const fac = ss.getSheetByName(TABS.facilities);
  const reg = ss.getSheetByName(TABS.regulars);
  const chg = ss.getSheetByName(TABS.changes);
  const fromRange = (range, strict, help) => SpreadsheetApp.newDataValidation()
    .requireValueInRange(range, true).setAllowInvalid(!strict).setHelpText(help).build();
  if (fac && reg) {
    reg.getRange(5, 2, 100, 1).setDataValidation(fromRange(fac.getRange(4, 1, 20, 1), true, 'Pick the facility (from the Facilities tab).'));
  }
  if (chg) {
    // A date picker; text like 31/10/2026 is accepted too (the agent reads it).
    chg.getRange(5, 1, 300, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(true).setHelpText('A date, e.g. 31/10/2026').build());
    if (fac) chg.getRange(5, 2, 300, 1).setDataValidation(fromRange(fac.getRange(4, 1, 20, 1), true, 'Leave empty for every facility where the client plays that day.'));
    if (reg) chg.getRange(5, 3, 300, 1).setDataValidation(fromRange(reg.getRange(5, 1, 100, 1), false, 'A regular client, or leave empty for a notice to everyone.'));
  }
}

// ---------- upgrading an older sheet ----------

// Sheets made before reminders had a column each have one "Attendant
// reminders" column (= both reminders). Turn it into "Reminder 1" and add a
// "Reminder 2" column next to it with the same ticks, so nobody loses a
// reminder. Returns true if the sheet was changed.
export function upgradeContacts(ss, settings) {
  const sh = ss.getSheetByName(TABS.contacts);
  if (!sh) return false;
  const values = sh.getDataRange().getValues();
  const hi = values.findIndex((r) => r.some((v) => norm(v) === 'email' || norm(v) === 'number'));
  if (hi < 0) return false;
  const head = values[hi].map(norm);
  const old = head.indexOf('attendant reminders');
  if (old < 0 || head.some((h) => h.startsWith('reminder 1'))) return false;

  const col = old + 1; // 1-based
  const [m1, m2] = reminderLabels(settings);
  sh.insertColumnAfter(col);
  sh.getRange(hi + 1, col, 1, 2).setValues([[m1, m2]])
    .setFontWeight('bold').setFontColor('#ffffff').setBackground(NAVY).setWrap(true);
  const rows = values.length - hi - 1;
  if (rows > 0) {
    const ticks = values.slice(hi + 1).map((r) => [r[old] === true]);
    sh.getRange(hi + 2, col + 1, rows, 1).insertCheckboxes().setValues(ticks);
  }
  sh.setColumnWidth(col, 120);
  sh.setColumnWidth(col + 1, 120);
  return true;
}

// Fill in the Ticqet ID of known facilities (the pitches, back on sale), and
// drop their old "closed for new carpet" note.
export function upgradeFacilities(ss, known) {
  const sh = ss.getSheetByName(TABS.facilities);
  if (!sh) return [];
  const values = sh.getDataRange().getValues();
  const done = [];
  if (/only the facility with watch = yes is watched/i.test(String((values[1] || [])[0] ?? ''))) sh.getRange(2, 1).setValue(FACILITIES_NOTE);
  const hi = values.findIndex((r) => norm(r[0]) === 'facility');
  if (hi < 0) return done;
  const head = values[hi].map(norm);
  const cId = head.findIndex((h) => h.startsWith('ticqet'));
  const cNotes = head.indexOf('notes');
  if (cId < 0) return done;
  values.slice(hi + 1).forEach((r, i) => {
    const name = String(r[0] ?? '').trim();
    if (!name || String(r[cId] ?? '').trim()) return;
    const k = resolveFacility(name, known);
    if (!k) return;
    sh.getRange(hi + 2 + i, cId + 1).setValue(k.ticqetEventId);
    if (cNotes >= 0 && /closed for new carpet/i.test(String(r[cNotes] ?? ''))) sh.getRange(hi + 2 + i, cNotes + 1).setValue('');
    done.push(`Facilities: added the Ticqet ID of ${name}`);
  });
  return done;
}

// Add the settings rows newer versions read, with their default values.
export function upgradeSettings(ss, settings) {
  const sh = ss.getSheetByName(TABS.settings);
  if (!sh) return [];
  const values = sh.getDataRange().getValues();
  if (!values.some((r) => norm(r[0]) === 'setting')) return [];
  const labels = values.map((r) => norm(r[0]));
  const missing = SETTING_ROWS_ADDED.filter(([label]) => !labels.some((l) => l.startsWith(norm(label).split(/[:(]/)[0].trim())));
  if (!missing.length) return [];
  const at = sh.getLastRow() + 1;
  const rows = missing.map(([label, value, what]) => [label, value(settings), what]);
  sh.getRange(at, 2, rows.length, 1).setNumberFormat('@');
  sh.getRange(at, 1, rows.length, 3).setValues(rows);
  sh.getRange(at, 3, rows.length, 1).setWrap(true).setFontColor(GREY);
  return missing.map(([label]) => `Settings: added "${label}"`);
}

// Logs made when only the court was watched get a Facility column (all their
// rows are the court's).
export function upgradeBookingsLog(ss, courtName) {
  const sh = ss.getSheetByName(TABS.log);
  if (!sh) return [];
  const head = headerOf(sh);
  const what = head.indexOf('what happened');
  if (what < 0 || head.includes('facility')) return [];
  sh.insertColumnAfter(what + 1);
  sh.getRange(1, what + 2).setValue('Facility').setFontWeight('bold').setFontColor('#ffffff').setBackground(NAVY).setWrap(true);
  const rows = sh.getLastRow() - 1;
  if (rows > 0) sh.getRange(2, what + 2, rows, 1).setValues(Array.from({ length: rows }, () => [courtName]));
  sh.setColumnWidth(what + 2, 150);
  return ['Bookings Log: added a Facility column'];
}

// Regular clients from the build (the pitches' timetable) for facilities that
// have no rows yet - once per facility, so rows the team deletes stay deleted.
// Facility names are written as on the Facilities tab (`known`).
export function prefillRegulars(ss, regulars, props, known = []) {
  const sh = ss.getSheetByName(TABS.regulars);
  if (!sh || !regulars.length) return [];
  const done = new Set(props.get('prefilled', []));
  const values = sh.getDataRange().getValues();
  const hi = values.findIndex((r) => norm(r[0]) === 'client');
  if (hi < 0) return [];
  const fcol = values[hi].map(norm).indexOf('facility');
  if (fcol < 0) return [];
  const present = new Set(values.slice(hi + 1).filter((r) => String(r[0] ?? '').trim()).map((r) => nameKey(r[fcol])));
  const byFacility = new Map();
  for (const r of regulars) {
    const k = (resolveFacility(r.facility, known) || { name: r.facility || '' }).name;
    if (!byFacility.has(k)) byFacility.set(k, []);
    byFacility.get(k).push({ ...r, facility: k });
  }
  const out = [];
  let next = Math.max(sh.getLastRow(), hi + 1) + 1;
  for (const [facility, rows] of byFacility) {
    const flag = `regulars:${nameKey(facility)}`;
    if (!facility || done.has(flag)) continue;
    done.add(flag);
    if (present.has(nameKey(facility))) continue; // the team already has rows for it
    const cells = rows.map((r) => [r.client, r.facility, r.day, r.start, r.end, r.type || '', dmy(r.from), dmy(r.until)]);
    sh.getRange(next, 4, cells.length, 2).setNumberFormat('@');
    sh.getRange(next, 7, cells.length, 2).setNumberFormat('@');
    sh.getRange(next, 1, cells.length, 8).setValues(cells);
    next += cells.length;
    out.push(`Regular Clients: added ${cells.length} rows for ${facility}`);
  }
  props.set('prefilled', [...done]);
  return out;
}

// Everything an older sheet needs, every run (cheap when nothing is missing).
// Each step stands alone: one that fails is reported, and the agent still runs.
// Returns { done, failed } - what was changed, and what could not be.
export function upgradeSheet(ss, { settings, prefill, props }) {
  const done = [];
  const failed = [];
  const step = (name, fn) => {
    try {
      done.push(...[].concat(fn() || []));
    } catch (e) {
      failed.push(`${name}: ${e.message}`);
    }
  };
  const known = settings.venue.facilities || [];
  step('new tabs', () => {
    const created = setupTabs(ss, { ...prefill, settings });
    return created.length ? `created the tab(s) ${created.join(', ')}` : [];
  });
  step('Contacts', () => (upgradeContacts(ss, settings) ? 'Contacts: reminders now have one column each' : []));
  step('Facilities', () => upgradeFacilities(ss, known));
  step('Settings', () => upgradeSettings(ss, settings));
  step('Bookings Log', () => upgradeBookingsLog(ss, settings.court.name));
  step('Regular Clients', () => prefillRegulars(ss, prefill.regulars || [], props, known));
  step('drop-down lists', () => {
    const steps = new Set(props.get('sheetUpgrades', []));
    if (steps.has('validations-2')) return [];
    applyValidations(ss);
    steps.add('validations-2');
    props.set('sheetUpgrades', [...steps]);
    return [];
  });
  return { done, failed };
}
