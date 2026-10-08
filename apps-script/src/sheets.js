// The Google Sheet: the tabs the team edits (Contacts, Regular Clients,
// Settings, Facilities) and the tabs the agent writes (Status, Bookings Log,
// Preview). setupTabs() only creates tabs that are missing, so running setup
// again never overwrites anything the team typed.

import { nowInZone, dayFromLabel, shortDate } from '../../src/time.js';
import { slotsToRanges, rangesText } from '../../src/bookings.js';
import { matchRegular } from '../../src/regulars.js';

export const TABS = {
  status: 'Status',
  log: 'Bookings Log',
  contacts: 'Contacts',
  regulars: 'Regular Clients',
  settings: 'Settings',
  facilities: 'Facilities',
  preview: 'Preview',
};

const NAVY = '#093254';
const FILL_ME = '#fff2cc'; // light yellow: cells someone needs to fill in
const ZONE = 'Africa/Kigali';
const pad = (n) => String(n).padStart(2, '0');
const isDate = (v) => Object.prototype.toString.call(v) === '[object Date]';

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
  for (const name of [TABS.contacts, TABS.regulars, TABS.settings, TABS.facilities]) {
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

// `cfg` (optional) names the regular client for bookings in their usual hours.
export function appendBookingLog(ss, entries, createTimes, cfg = null) {
  if (!entries.length) return;
  const sh = ss.getSheetByName(TABS.log);
  if (!sh) return;
  const rows = entries.map((e) => {
    const day = dayFromLabel(e.date);
    const slots = e.event === 'changed' ? e.to : e.slots || [];
    const time = e.event === 'changed' ? `was ${hoursText(e.from)}, now ${hoursText(e.to)}` : hoursText(slots);
    const created = createTimes.get(e.id);
    const regular = e.regular || (cfg && day ? matchRegular({ slots: slots.map(Number) }, cfg.regulars, day, cfg.settings.court.name) : null);
    return [
      kigaliStamp(e.at),
      WHAT[e.event] || e.event,
      day ? `${shortDate(day.y, day.m, day.d)} ${day.y}` : e.date,
      time,
      slots.length,
      regular || '',
      created ? kigaliStamp(created) : '',
      e.id,
    ];
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

// ---------- setup ----------

function header(sh, row, labels, widths) {
  sh.getRange(row, 1, 1, labels.length).setValues([labels])
    .setFontWeight('bold').setFontColor('#ffffff').setBackground(NAVY).setWrap(true);
  sh.setFrozenRows(row);
  widths.forEach((w, i) => sh.setColumnWidth(i + 1, w));
}

function title(sh, text, note) {
  sh.getRange(1, 1).setValue(text).setFontSize(14).setFontWeight('bold').setFontColor(NAVY);
  if (note) sh.getRange(2, 1).setValue(note).setFontColor('#5b6475');
}

const list = (values) => SpreadsheetApp.newDataValidation().requireValueInList(values, true).setAllowInvalid(false).build();

// Column titles for the two reminders, e.g. "Reminder 1 (60 min before)". The
// agent finds the columns by their start ("Reminder 1"), so the rest is a label.
function reminderLabels(settings) {
  const [a = 60, b = 15] = settings.attendantReminderMinutes || [];
  return [`Reminder 1 (${a} min before)`, `Reminder 2 (${b} min before)`];
}

// Sheets made before reminders had a column each have one "Attendant
// reminders" column (= both reminders). Turn it into "Reminder 1" and add a
// "Reminder 2" column next to it with the same ticks, so nobody loses a
// reminder. Returns true if the sheet was changed.
export function upgradeContacts(ss, settings) {
  const sh = ss.getSheetByName(TABS.contacts);
  if (!sh) return false;
  const values = sh.getDataRange().getValues();
  const norm = (v) => String(v).trim().toLowerCase();
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

const BUILDERS = {
  [TABS.status](sh) {
    title(sh, 'Agent status', 'Updated every time the agent checks Ticqet (every 5 minutes).');
    sh.setColumnWidth(1, 210);
    sh.setColumnWidth(2, 520);
    sh.getRange(3, 1, 12, 1).setFontWeight('bold');
    sh.getRange(3, 2, 12, 1).setWrap(true);
  },

  [TABS.log](sh) {
    header(sh, 1, ['Logged (Kigali time)', 'What happened', 'Date', 'Time', 'Hours', 'Regular client', 'Created on Ticqet', 'Ticqet record'],
      [150, 150, 130, 230, 60, 140, 150, 190]);
    sh.getRange('A:D').setNumberFormat('@');
    sh.getRange('F:H').setNumberFormat('@');
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
    sh.getRange(5, 4, 40, 2).setNumberFormat('@');
    sh.getRange(5, 7, 40, 2).setNumberFormat('@');
    sh.getRange(5, 3, 40, 1).setDataValidation(list(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']));
    const iso = (s) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : '');
    const rows = defaults.regulars.map((r) => [r.client, r.facility || '', r.day, r.start, r.end, r.type || '', iso(r.from), iso(r.until)]);
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
    ];
    sh.getRange(4, 2, rows.length, 1).setNumberFormat('@');
    sh.getRange(4, 1, rows.length, 3).setValues(rows);
    sh.getRange(4, 3, rows.length, 1).setWrap(true).setFontColor('#5b6475');
    sh.getRange(4, 2).setDataValidation(list(['Preview', 'Email'])).setBackground(FILL_ME);
    sh.getRange(7, 2).setDataValidation(list(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']));
    sh.getRange(19, 2).setDataValidation(list(['Yes', 'No']));
  },

  [TABS.facilities](sh, defaults) {
    title(sh, 'Facilities on Ticqet', 'Only the facility with Watch = Yes is watched.');
    header(sh, 3, ['Facility', 'Ticqet ID', 'Watch', 'Notes'], [190, 210, 70, 420]);
    const court = defaults.settings.court;
    const closed = 'Closed for new carpet. Add its Ticqet ID when it is back on sale.';
    sh.getRange(4, 1, 3, 4).setValues([
      [court.name, court.ticqetEventId, 'Yes', ''],
      ['5-a-side Pitch A', '', 'No', closed],
      ['5-a-side Pitch B', '', 'No', closed],
    ]);
    sh.getRange(4, 3, 3, 1).setDataValidation(list(['Yes', 'No']));
  },

  [TABS.preview](sh) {
    header(sh, 1, ['Time (Kigali)', 'Type', 'To', 'Subject', 'Message'], [130, 120, 200, 360, 480]);
    sh.getRange('A:E').setNumberFormat('@');
  },
};

// Create every missing tab, in order. Returns the names of the tabs created.
export function setupTabs(ss, defaults) {
  const created = [];
  const order = [TABS.status, TABS.log, TABS.contacts, TABS.regulars, TABS.settings, TABS.facilities, TABS.preview];
  order.forEach((name, i) => {
    if (ss.getSheetByName(name)) return;
    const sh = ss.insertSheet(name, i);
    BUILDERS[name](sh, defaults);
    created.push(name);
  });
  // A brand-new spreadsheet comes with one empty "Sheet1": remove it.
  for (const sh of ss.getSheets()) {
    if (/^(sheet|feuille|hoja|blatt)\s*\d+$/i.test(sh.getName()) && sh.getLastRow() === 0) ss.deleteSheet(sh);
  }
  return created;
}
