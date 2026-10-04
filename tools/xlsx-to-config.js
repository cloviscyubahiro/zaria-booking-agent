#!/usr/bin/env node
// Turns the Excel setup workbook into the agent's three config files:
//   config/settings.json, config/regular-clients.json, config/contacts.json
//
//   npm run config                         reads config/zaria-setup.xlsx
//   npm run config -- path/to/file.xlsx    reads another file
//
// Nothing is written if the workbook has errors. The running agent notices the
// new files within a minute; no restart needed.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import readExcelFile from 'read-excel-file/node';
import { DEFAULT_SETTINGS, withDefaults, normalizePhone, normalizeChannel } from '../src/config.js';
import { WEEKDAYS } from '../src/time.js';

const pad = (n) => String(n).padStart(2, '0');
const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const yes = (v) => /^(yes|y|true|1)$/i.test(str(v));

// Excel time -> "HH:MM". Accepts Date (how Excel times are read), a day
// fraction (0.75), or text like "17:00" / "5:00 PM" / "5pm".
export function toHHMM(v) {
  if (v instanceof Date) return `${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}`;
  if (typeof v === 'number') {
    const mins = Math.round((v % 1) * 1440);
    return `${pad(Math.floor(mins / 60) % 24)}:${pad(mins % 60)}`;
  }
  const m = str(v).toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] || 0);
  if (m[3] === 'pm' && h < 12) h += 12;
  if (m[3] === 'am' && h === 12) h = 0;
  return h < 24 && min < 60 ? `${pad(h)}:${pad(min)}` : null;
}

// Excel date -> "YYYY-MM-DD" or null. Accepts Date, an Excel serial number, or
// text as DD/MM/YYYY or YYYY-MM-DD.
export function toISODate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
  if (typeof v === 'number') {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  const s = str(v);
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? s : undefined; // undefined = present but unreadable
}

function weekday(v) {
  const s = str(v).toLowerCase();
  return WEEKDAYS.find((d) => d.toLowerCase() === s || d.toLowerCase().slice(0, 3) === s) || null;
}

// Find a table by the text in its first header cell; columns are found by name,
// so adding or moving columns in Excel does not break anything.
function table(rows, firstHeader) {
  const hi = rows.findIndex((r) => str(r?.[0]).toLowerCase() === firstHeader.toLowerCase());
  if (hi < 0) return null;
  const headers = rows[hi].map((h) => str(h).toLowerCase());
  const col = (...names) => {
    for (const n of names) {
      const i = headers.findIndex((h) => h === n || h.startsWith(n));
      if (i >= 0) return i;
    }
    return -1;
  };
  return { col, rows: rows.slice(hi + 1).map((r, i) => ({ r, excelRow: hi + 2 + i })) };
}

const SETTINGS_ROWS = [
  ['channel', (v, s) => { s.channel = normalizeChannel(v); }],
  ['sms sender name', (v, s) => { s.smsSenderName = str(v); }],
  ['daily update time', (v, s) => { s.dailyUpdateTime = toHHMM(v); }],
  ['weekly overview day', (v, s) => { s.weeklyOverviewDay = weekday(v) || str(v); }],
  ['weekly overview time', (v, s) => { s.weeklyOverviewTime = toHHMM(v); }],
  ['attendant reminder 1', (v, s) => { s._rem1 = Number(v); }],
  ['attendant reminder 2', (v, s) => { s._rem2 = Number(v); }],
  ['quiet hours start', (v, s) => { s.quietHours = { ...s.quietHours, start: toHHMM(v) }; }],
  ['quiet hours end', (v, s) => { s.quietHours = { ...s.quietHours, end: toHHMM(v) }; }],
  ['technical alert after', (v, s) => { s.technicalAlertAfterMinutes = Number(v); }],
  ['renewal reminder', (v, s) => { s.renewalReminderDaysBefore = Number(v); }],
  ['open regular slot check', (v, s) => { s.openSlotCheckDaysAhead = Number(v); }],
  ['watch ticqet', (v, s) => { s.watch = { ...s.watch, windowDays: Number(v) }; }],
  ['max separate alerts', (v, s) => { s.maxAlertsAtOnce = Number(v); }],
  ['max messages per day', (v, s) => { s.maxMessagesPerDay = Number(v); }],
  ['send welcome message', (v, s) => { s.sendWelcome = yes(v); }],
];

export async function convertWorkbook(file, baseSettings = DEFAULT_SETTINGS) {
  const sheets = await readExcelFile(file);
  const byName = new Map(sheets.map((s) => [s.sheet.trim().toLowerCase(), s.data]));
  const errors = [];
  const warnings = [];
  let adminNameFromSheet = null;

  // ---------- Regular Clients ----------
  const regulars = [];
  const rc = table(byName.get('regular clients') || [], 'Client');
  if (!rc) errors.push('Sheet "Regular Clients" (with a "Client" header) not found.');
  else {
    const c = {
      client: rc.col('client'), facility: rc.col('facility'), day: rc.col('day'), start: rc.col('start'),
      end: rc.col('end'), type: rc.col('type'), from: rc.col('from'), until: rc.col('until'),
    };
    let missingDates = 0;
    for (const { r, excelRow } of rc.rows) {
      const client = str(r[c.client]);
      if (!client || /^regular hours per week/i.test(client)) continue;
      const where = `Regular Clients row ${excelRow} (${client})`;
      const day = weekday(r[c.day]);
      const start = toHHMM(r[c.start]);
      const end = toHHMM(r[c.end]);
      const from = toISODate(r[c.from]);
      const until = toISODate(r[c.until]);
      if (!day) { errors.push(`${where}: Day must be a weekday name.`); continue; }
      if (!start || !end) { errors.push(`${where}: Start and End must be times like 17:00.`); continue; }
      if (end <= start) { errors.push(`${where}: End must be after Start.`); continue; }
      if (from === undefined || until === undefined) { errors.push(`${where}: From/Until must be dates (DD/MM/YYYY).`); continue; }
      if (from && until && until < from) { errors.push(`${where}: Until is before From.`); continue; }
      if (!from || !until) missingDates += 1;
      regulars.push({
        client,
        facility: str(r[c.facility]) || baseSettings.court?.name || 'Multi-Purpose Court',
        day, start, end,
        type: str(r[c.type]) || null,
        from: from || null,
        until: until || null,
      });
    }
    for (let i = 0; i < regulars.length; i++) {
      for (let j = i + 1; j < regulars.length; j++) {
        const a = regulars[i];
        const b = regulars[j];
        if (a.facility === b.facility && a.day === b.day && a.start < b.end && b.start < a.end) {
          warnings.push(`${a.client} and ${b.client} overlap on ${a.day} (${a.start}-${a.end} / ${b.start}-${b.end}).`);
        }
      }
    }
    if (missingDates) warnings.push(`${missingDates} regular client row(s) have no From/Until date - treated as ongoing. Add dates so the agent knows when an arrangement ends.`);
  }

  // ---------- Contacts ----------
  const contacts = [];
  const ct = table(byName.get('contacts') || [], 'Number');
  if (!ct) errors.push('Sheet "Contacts" (with a "Number" header) not found.');
  else {
    const c = {
      number: ct.col('number'), role: ct.col('role'), name: ct.col('name'),
      alerts: ct.col('new booking alerts'), summaries: ct.col('daily & weekly updates', 'daily'),
      reminders: ct.col('attendant reminders'), admin: ct.col('admin alerts', 'technical alerts'),
    };
    const seen = new Set();
    for (const { r, excelRow } of ct.rows) {
      const number = str(r[c.number]);
      const role = str(r[c.role]);
      if (!number && !role) continue;
      // The admin's name is used in messages ("Tell Clovis ..."), even before the number is filled in.
      if (yes(r[c.admin]) && str(r[c.name]) && !adminNameFromSheet) adminNameFromSheet = str(r[c.name]);
      if (!number) { warnings.push(`Contacts row ${excelRow} (${role}): no number yet - skipped.`); continue; }
      let phone;
      try { phone = normalizePhone(number); } catch { errors.push(`Contacts row ${excelRow}: "${number}" is not a valid Rwandan mobile number.`); continue; }
      if (seen.has(phone)) { errors.push(`Contacts row ${excelRow}: ${number} is listed twice.`); continue; }
      seen.add(phone);
      contacts.push({
        number: `0${phone.slice(4)}`,
        role,
        name: str(r[c.name]),
        alerts: yes(r[c.alerts]),
        summaries: yes(r[c.summaries]),
        reminders: yes(r[c.reminders]),
        admin: yes(r[c.admin]),
      });
    }
    if (!contacts.some((x) => x.admin)) warnings.push('No admin number yet: technical alerts, clash checks and renewal reminders will not be sent.');
    if (!contacts.some((x) => x.reminders)) warnings.push('Nobody has "Attendant reminders" set to Yes.');
  }

  // ---------- Settings ----------
  const overrides = {};
  const st = table(byName.get('settings') || [], 'Setting');
  if (!st) warnings.push('Sheet "Settings" not found - keeping current settings.');
  else {
    const cv = st.col('value');
    for (const { r, excelRow } of st.rows) {
      const label = str(r[0]).toLowerCase();
      if (!label) continue;
      const rule = SETTINGS_ROWS.find(([prefix]) => label.startsWith(prefix));
      if (!rule) continue;
      try { rule[1](r[cv], overrides); } catch (e) { errors.push(`Settings row ${excelRow}: ${e.message}`); }
    }
  }

  // ---------- Facilities ----------
  const fa = table(byName.get('facilities') || [], 'Facility');
  if (fa) {
    const c = { name: fa.col('facility'), id: fa.col('ticqet id', 'ticqet'), watch: fa.col('watch') };
    const watched = fa.rows.filter(({ r }) => str(r[c.name]) && yes(r[c.watch]));
    if (watched.length > 1) errors.push('Facilities: only one facility can have Watch = Yes in this version of the agent.');
    else if (watched.length === 1) {
      const { r, excelRow } = watched[0];
      if (!str(r[c.id])) errors.push(`Facilities row ${excelRow}: Watch is Yes but the Ticqet ID is empty.`);
      else overrides.court = { name: str(r[c.name]), ticqetEventId: str(r[c.id]) };
    } else warnings.push('Facilities: no facility has Watch = Yes - keeping the current court.');
  }

  if (adminNameFromSheet) overrides.adminName = adminNameFromSheet;

  // Merge onto the current settings and validate the result.
  const reminders = [overrides._rem1, overrides._rem2].filter((n) => Number.isInteger(n) && n > 0);
  delete overrides._rem1;
  delete overrides._rem2;
  if (reminders.length) overrides.attendantReminderMinutes = reminders;
  let settings = null;
  try {
    settings = withDefaults({
      ...baseSettings,
      ...overrides,
      watch: { ...baseSettings.watch, ...overrides.watch },
      quietHours: { ...baseSettings.quietHours, ...overrides.quietHours },
      court: { ...baseSettings.court, ...overrides.court },
    });
  } catch (e) {
    errors.push(e.message);
  }

  return { settings, regulars, contacts, errors, warnings };
}

async function main() {
  const file = process.argv[2] || path.join('config', 'zaria-setup.xlsx');
  if (!fs.existsSync(file)) {
    console.error(`Workbook not found: ${file}\nCopy the setup workbook to config/zaria-setup.xlsx, or give its path: npm run config -- path/to/file.xlsx`);
    process.exit(1);
  }
  const current = ['config/settings.json', 'config/settings.example.json'].find((f) => fs.existsSync(f));
  const base = current ? JSON.parse(fs.readFileSync(current, 'utf8')) : DEFAULT_SETTINGS;

  const res = await convertWorkbook(file, base);
  console.log(`\nRead ${file}`);
  if (res.settings) {
    const clients = [...new Set(res.regulars.map((r) => r.client))];
    console.log(`  Regular clients: ${res.regulars.length} rows (${clients.join(', ') || 'none'})`);
    console.log(`  Contacts: ${res.contacts.length} numbers - ${res.contacts.filter((x) => x.reminders).length} attendant(s), ${res.contacts.filter((x) => x.admin).length} admin`);
    console.log(`  Channel: ${res.settings.channel}   Court: ${res.settings.court.name}`);
  }
  if (res.warnings.length) {
    console.log('\nWarnings:');
    for (const w of res.warnings) console.log(`  - ${w}`);
  }
  if (res.errors.length) {
    console.error('\nErrors:');
    for (const e of res.errors) console.error(`  - ${e}`);
    console.error('\nNothing was written. Fix the rows above and run again.\n');
    process.exit(1);
  }
  fs.mkdirSync('config', { recursive: true });
  fs.writeFileSync('config/settings.json', `${JSON.stringify(res.settings, null, 2)}\n`);
  fs.writeFileSync('config/regular-clients.json', `${JSON.stringify(res.regulars, null, 2)}\n`);
  fs.writeFileSync('config/contacts.json', `${JSON.stringify(res.contacts, null, 2)}\n`);
  console.log('\nWrote config/settings.json, config/regular-clients.json, config/contacts.json');
  console.log('A running agent picks this up within a minute.\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
