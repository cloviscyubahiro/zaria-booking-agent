// Turns the setup workbook's sheets into the agent's config: settings, regular
// clients, contacts and schedule changes. Pure: it is handed the sheets as rows
// of cell values, so the same checks run for the Excel workbook
// (tools/xlsx-to-config.js) and for the Google Sheet (apps-script/).
//
//   convertSheets([{ sheet: 'Contacts', data: [[...], ...] }, ...], baseSettings)
//     -> { settings, regulars, contacts, changes, errors, warnings }

import { DEFAULT_SETTINGS, withDefaults, normalizePhone, normalizeEmail, normalizeChannel } from './config.js';
import { WEEKDAYS } from './time.js';
import { resolveFacility, sameName } from './facilities.js';
import { cleanChanges } from './changes.js';

const pad = (n) => String(n).padStart(2, '0');
const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const yes = (v) => /^(yes|y|true|1)$/i.test(str(v));
const isDate = (v) => Object.prototype.toString.call(v) === '[object Date]';

// Excel time -> "HH:MM". Accepts Date (how Excel times are read), a day
// fraction (0.75), or text like "17:00" / "5:00 PM" / "5pm".
export function toHHMM(v) {
  if (isDate(v)) return `${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}`;
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
  if (isDate(v)) return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
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

// Find a table by its header row; columns are found by name, so adding or
// moving columns in the sheet does not break anything. The header row is the
// first row whose first cell is one of `firstHeaders`, or (anyCell) the first
// row with one of them in any cell.
function table(rows, firstHeaders, { anyCell = false } = {}) {
  const wanted = firstHeaders.map((h) => h.toLowerCase());
  const hi = rows.findIndex((r) => (anyCell ? (r || []) : [r?.[0]]).some((c) => wanted.includes(str(c).toLowerCase())));
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
  ['email sender name', (v, s) => { if (str(v)) s.emailSenderName = str(v); }],
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
  ['event day', (v, s) => { s.eventMinHours = str(v) === '' ? 0 : Number(v); }],
  ['umuganda', (v, s) => { s.umuganda = toSpan(v); }],
];

// "08:00-11:00" -> { start: '08:00', end: '11:00' }; empty or "No" -> null.
function toSpan(v) {
  const s = str(v);
  if (!s || /^(no|off|none)$/i.test(s)) return null;
  const parts = s.split(/\s*(?:-|–|\bto\b)\s*/i);
  const start = parts.length === 2 ? toHHMM(parts[0]) : null;
  const end = parts.length === 2 ? toHHMM(parts[1]) : null;
  if (!start || !end) throw new Error(`"${s}" is not two times like 08:00-11:00.`);
  return { start, end };
}

export function convertSheets(sheets, baseSettings = DEFAULT_SETTINGS) {
  const byName = new Map(sheets.map((s) => [s.sheet.trim().toLowerCase(), s.data]));
  const errors = [];
  const warnings = [];
  let adminNameFromSheet = null;

  // ---------- Facilities ----------
  // Every facility with Watch = Yes is watched; the first one is the main one.
  const overrides = {};
  const fa = table(byName.get('facilities') || [], ['Facility']);
  let listedFacilities = null; // every facility on the tab, watched or not
  if (fa) {
    const c = { name: fa.col('facility'), id: fa.col('ticqet id', 'ticqet'), watch: fa.col('watch') };
    listedFacilities = fa.rows.filter(({ r }) => str(r[c.name])).map(({ r }) => ({ name: str(r[c.name]), ticqetEventId: str(r[c.id]) }));
    const watched = [];
    for (const { r, excelRow } of fa.rows) {
      const name = str(r[c.name]);
      if (!name || !yes(r[c.watch])) continue;
      const id = str(r[c.id]);
      if (!id) { warnings.push(`Facilities row ${excelRow} (${name}): not watched until its Ticqet ID is filled in.`); continue; }
      const twin = watched.find((f) => f.ticqetEventId === id);
      if (twin) { errors.push(`Facilities row ${excelRow} (${name}): Ticqet ID ${id} is already used by ${twin.name}.`); continue; }
      if (watched.some((f) => sameName(f.name, name))) { errors.push(`Facilities row ${excelRow}: "${name}" is listed twice.`); continue; }
      watched.push({ name, ticqetEventId: id });
    }
    if (watched.length) {
      overrides.facilities = watched;
      overrides.court = watched[0];
    } else warnings.push('Facilities: no facility has Watch = Yes with a Ticqet ID - keeping the current ones.');
  }
  const watchedNow = overrides.facilities || baseSettings.facilities || [baseSettings.court].filter(Boolean);

  // ---------- Regular Clients ----------
  const regulars = [];
  const rc = table(byName.get('regular clients') || [], ['Client']);
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
      // The facility as written on the Facilities tab ("Pitch A" -> "5-a-side Pitch A").
      const typed = str(r[c.facility]);
      let facility = watchedNow[0]?.name || baseSettings.court?.name || 'Multi-Purpose Court';
      if (typed) {
        const known = resolveFacility(typed, listedFacilities || watchedNow) || resolveFacility(typed, watchedNow);
        if (known) facility = known.name;
        else {
          facility = typed;
          warnings.push(`${where}: facility "${typed}" is not on the Facilities tab - this row is not used.`);
        }
      }
      regulars.push({
        client,
        facility,
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
        if (sameName(a.facility, b.facility) && a.day === b.day && a.start < b.end && b.start < a.end) {
          warnings.push(`${a.client} and ${b.client} overlap on ${a.day} at ${a.facility} (${a.start}-${a.end} / ${b.start}-${b.end}).`);
        }
      }
    }
    if (missingDates) warnings.push(`${missingDates} regular client row(s) have no From/Until date - treated as ongoing. Add dates so the agent knows when an arrangement ends.`);
  }

  // ---------- Contacts ----------
  // Each contact has a phone number (WhatsApp/SMS), an email address, or both.
  const contacts = [];
  const contactRows = []; // excel row per contact, for channel warnings below
  const ct = table(byName.get('contacts') || [], ['Number', 'Email'], { anyCell: true });
  if (!ct) errors.push('Sheet "Contacts" (with a "Number" or "Email" header) not found.');
  else {
    const c = {
      number: ct.col('number', 'phone'), email: ct.col('email'), role: ct.col('role'), name: ct.col('name'),
      alerts: ct.col('new booking alerts'), summaries: ct.col('daily & weekly updates', 'daily'),
      reminders: ct.col('attendant reminders'), admin: ct.col('admin alerts', 'technical alerts'),
      // Separate columns per reminder ("Reminder 1 (60 min before)", "Reminder 2 ...")
      // replace the single "Attendant reminders" column when present.
      reminder1: ct.col('reminder 1'), reminder2: ct.col('reminder 2'),
    };
    const split = c.reminder1 >= 0 || c.reminder2 >= 0;
    const cell = (r, i) => (i >= 0 ? str(r[i]) : '');
    const seen = new Set();
    for (const { r, excelRow } of ct.rows) {
      const number = cell(r, c.number);
      const email = cell(r, c.email);
      const role = cell(r, c.role);
      const name = cell(r, c.name);
      if (!number && !email && !role && !name) continue;
      // The admin's name is used in messages ("Tell Clovis ..."), even before the address is filled in.
      if (yes(r[c.admin]) && name && !adminNameFromSheet) adminNameFromSheet = name;
      const who = name || role || 'contact';
      if (!number && !email) { warnings.push(`Contacts row ${excelRow} (${who}): no ${c.email >= 0 ? 'email' : 'number'} yet - skipped.`); continue; }
      let phone = null;
      let mail = null;
      if (number) {
        try { phone = normalizePhone(number); } catch { errors.push(`Contacts row ${excelRow}: "${number}" is not a valid Rwandan mobile number.`); continue; }
      }
      if (email) {
        try { mail = normalizeEmail(email); } catch { errors.push(`Contacts row ${excelRow}: "${email}" is not a valid email address.`); continue; }
      }
      const dup = [phone, mail].find((a) => a && seen.has(a));
      if (dup) { errors.push(`Contacts row ${excelRow}: ${dup === phone ? number : email} is listed twice.`); continue; }
      if (phone) seen.add(phone);
      if (mail) seen.add(mail);
      const r1 = yes(r[c.reminder1]);
      const r2 = yes(r[c.reminder2]);
      contacts.push({
        number: phone ? `0${phone.slice(4)}` : '',
        ...(c.email >= 0 ? { email: mail || '' } : {}),
        role,
        name,
        alerts: yes(r[c.alerts]),
        summaries: yes(r[c.summaries]),
        reminders: split ? r1 || r2 : yes(r[c.reminders]),
        ...(split ? { reminder1: r1, reminder2: r2 } : {}),
        admin: yes(r[c.admin]),
      });
      contactRows.push({ excelRow, who });
    }
    if (!contacts.some((x) => x.admin)) warnings.push('No admin contact yet: technical alerts, double-booking checks and renewal reminders will not be sent.');
    if (!split && !contacts.some((x) => x.reminders)) warnings.push('Nobody gets reminders before sessions ("Attendant reminders" column).');
  }

  // ---------- Settings ----------
  const st = table(byName.get('settings') || [], ['Setting']);
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

  // A reminder column nobody is ticked in (or only people without an address).
  if (settings && ct && (ct.col('reminder 1') >= 0 || ct.col('reminder 2') >= 0)) {
    settings.attendantReminderMinutes.slice(0, 2).forEach((mins, i) => {
      const key = i === 0 ? 'reminder1' : 'reminder2';
      if (!contacts.some((x) => x[key])) warnings.push(`Nobody gets Reminder ${i + 1} (${mins} min before a session): tick someone in that column.`);
    });
  }

  // Contacts who cannot be reached on the chosen channel.
  if (settings && ['email', 'whatsapp-cloud', 'pindo'].includes(settings.channel)) {
    const needEmail = settings.channel === 'email';
    contacts.forEach((x, i) => {
      if (needEmail ? !x.email : !x.number) {
        const { excelRow, who } = contactRows[i];
        warnings.push(`Contacts row ${excelRow} (${who}): no ${needEmail ? 'email' : 'number'} - gets nothing while Channel is ${needEmail ? 'Email' : settings.channel === 'pindo' ? 'SMS' : 'WhatsApp'}.`);
      }
    });
  }

  // ---------- Schedule Changes ----------
  // A mistake in one row only affects that row: it is reported, not fatal.
  const changes = [];
  let changeRows = null; // as typed, for config/schedule-changes.json
  const sc = table(byName.get('schedule changes') || [], ['Date']);
  if (sc) {
    const c = {
      date: sc.col('date'), facility: sc.col('facility'), client: sc.col('client'),
      newTime: sc.col('new time'), reason: sc.col('reason', 'message'), email: sc.col('email'),
    };
    const cell = (r, i) => (i >= 0 ? r[i] : '');
    const rows = sc.rows.map(({ r, excelRow }) => ({
      row: excelRow,
      date: toISODate(cell(r, c.date)),
      facility: cell(r, c.facility),
      client: cell(r, c.client),
      newTime: cell(r, c.newTime),
      reason: cell(r, c.reason),
      email: cell(r, c.email),
    }));
    for (const x of cleanChanges(rows, { regulars, facilities: settings ? settings.facilities : watchedNow })) {
      changes.push(x);
      if (x.problem) warnings.push(`Schedule Changes row ${x.row}: ${x.problem}`);
    }
    changeRows = rows
      .filter((x) => x.date || str(x.client) || str(x.reason) || str(x.newTime))
      .map(({ row, ...x }) => ({ ...x, facility: str(x.facility), client: str(x.client), newTime: str(x.newTime), reason: str(x.reason), email: yes(x.email) }));
  }

  return { settings, regulars, contacts, changes, changeRows, errors, warnings };
}
