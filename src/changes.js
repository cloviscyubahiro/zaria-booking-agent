// One-off changes the admin tells the agent about on the "Schedule Changes" tab:
//
//   Date        Facility   Client           New time     Reason / message
//   10/10/2026             Local Champions  12:00-14:00  Car-free day     -> moved
//   31/10/2026             Local Champions  Cancelled    Umuganda         -> not playing
//   10/10/2026             Local Champions               Bring bibs       -> a note about them
//   10/10/2026  Pitch A                                  Closed 2-4 PM    -> a notice for everyone
//
// An empty Facility means every facility where the client usually plays that
// day. The agent uses the changes in reminders, the daily update and the
// open-slot check (regulars.js), and emails a row to everyone when it is ticked.

import { formatRange, joinNames, shortDate, dayFromIso } from './time.js';
import { resolveFacility } from './facilities.js';
import { baseRegularsForDate } from './regulars.js';

const CANCELLED = /^(cancel+ed|cancel|off|no session|no play|not playing|not coming|none|closed)\b/i;

// "12", "12:00", "12h", "12h00", "12.00", "12pm", "12:00 PM" -> { h, min, mer: 'a'|'p'|null }
function parseClock(text) {
  const m = String(text).toLowerCase().replace(/\s+/g, '').replace(/\./g, ':')
    .match(/^(\d{1,2})(?:[:h](\d{2})?)?(am|pm|a:m:|p:m:)?$/);
  if (!m) return null;
  return { h: Number(m[1]), min: Number(m[2] || 0), mer: m[3] ? m[3][0] : null };
}

function hour24(c, mer) {
  if (!mer) return c.h;
  if (c.h < 1 || c.h > 12) return null;
  if (mer === 'a') return c.h === 12 ? 0 : c.h;
  return c.h === 12 ? 12 : c.h + 12;
}

// The "New time" cell: empty -> a note; "Cancelled" (or Off, Not playing ...)
// -> not playing; a range ("12:00-14:00", "12-2pm", "12 PM to 2 PM") -> moved.
// Times without AM/PM are 24-hour times. Returns { kind, startHour?, endHour? }
// or { problem }.
export function parseNewTime(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { kind: 'note' };
  if (CANCELLED.test(s)) return { kind: 'cancelled' };
  const bad = { problem: `New time "${s}" is not a time like 12:00-14:00 (or write Cancelled).` };
  const parts = s.toLowerCase().replace(/[–—]/g, '-').split(/\s*(?:-|\bto\b|\buntil\b)\s*/).filter(Boolean);
  if (parts.length !== 2) return bad;
  const a = parseClock(parts[0]);
  const b = parseClock(parts[1]);
  if (!a || !b) return bad;
  if (a.min || b.min) return { problem: `New time "${s}": Ticqet books whole hours, so use times like 12:00-14:00.` };
  let start;
  let end;
  if (a.mer && b.mer) {
    start = hour24(a, a.mer);
    end = hour24(b, b.mer);
  } else if (b.mer) { // "12-2pm": the start takes the end's AM/PM when that fits
    end = hour24(b, b.mer);
    const same = hour24(a, b.mer);
    start = same !== null && same < (end === 0 ? 24 : end) ? same : hour24(a, b.mer === 'p' ? 'a' : 'p');
  } else if (a.mer) { // "11am-1": the end is after the start
    start = hour24(a, a.mer);
    const same = hour24(b, a.mer);
    end = same !== null && (same > start || same === 0) ? same : hour24(b, a.mer === 'a' ? 'p' : 'a');
  } else {
    start = a.h;
    end = b.h;
  }
  if (end === 0) end = 24; // midnight
  if (start === null || end === null || start < 0 || start > 23 || end > 24 || end <= start) return bad;
  return { kind: 'moved', startHour: start, endHour: end };
}

// A short, stable fingerprint of a text (FNV-1a), for "already emailed" marks.
function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

const dayText = (iso) => {
  const d = dayFromIso(iso);
  return shortDate(d.y, d.m, d.d);
};

// The client's usual hours on a date, per facility: [{ facility, startHour, endHour, client }].
function usualHours(client, date, facilities, regulars) {
  const out = [];
  for (const f of facilities) {
    for (const w of baseRegularsForDate(regulars, date, f.name)) {
      if (w.client.trim().toLowerCase() === client.trim().toLowerCase()) out.push({ facility: f.name, ...w });
    }
  }
  return out;
}

// Usual hours grouped by time: [{ range: "8:00-10:00 AM", places: [facility...] }].
function groupUsual(usual) {
  const groups = new Map();
  for (const u of usual) {
    const k = `${u.startHour}-${u.endHour}`;
    if (!groups.has(k)) groups.set(k, { range: formatRange(u.startHour, u.endHour), places: [] });
    if (!groups.get(k).places.includes(u.facility)) groups.get(k).places.push(u.facility);
  }
  return [...groups.values()];
}

// "8:00-10:00 AM at 5-a-side Pitch A and 5-a-side Pitch B"
const hoursAt = (groups) => joinNames(groups.map((g) => `${g.range} at ${joinNames(g.places)}`));

function movedText(client, to, usual) {
  const groups = groupUsual(usual);
  if (groups.length === 1) return `${client} play ${to} instead of ${groups[0].range}, at ${joinNames(groups[0].places)}.`;
  return `${client} play ${to} instead of ${hoursAt(groups)}.`;
}

// Check the rows typed on the sheet and work out what each one means.
//   rows: [{ row, date: "YYYY-MM-DD" | "" | undefined (unreadable), facility,
//            client, newTime, reason, email }]
// Returns one entry per non-empty row: { row, date, facility, client, kind,
// startHour, endHour, reason, email, summary, key, id } or { row, problem }.
export function cleanChanges(rows, { regulars = [], facilities = [] } = {}) {
  const out = [];
  for (const raw of rows || []) {
    const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
    const facilityText = str(raw.facility);
    const clientText = str(raw.client);
    const reason = str(raw.reason);
    const timeText = str(raw.newTime);
    const email = raw.email === true || /^(yes|y|true|1)$/i.test(str(raw.email));
    if (!raw.date && !facilityText && !clientText && !reason && !timeText) continue; // empty row
    const entry = { row: raw.row, email, reason };
    const fail = (problem) => out.push({ ...entry, problem });

    if (!raw.date) { fail(raw.date === undefined ? 'The Date is not a date: type it like 10/10/2026.' : 'Add the Date.'); continue; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.date)) { fail('The Date is not a date: type it like 10/10/2026.'); continue; }
    entry.date = raw.date;
    const date = dayFromIso(raw.date);
    let facility = null;
    if (facilityText) {
      const f = resolveFacility(facilityText, facilities);
      if (!f) { fail(`"${facilityText}" is not one of the watched facilities (${joinNames(facilities.map((x) => x.name))}).`); continue; }
      facility = f.name;
    }
    const parsed = parseNewTime(timeText);
    if (parsed.problem) { fail(parsed.problem); continue; }

    let kind = parsed.kind;
    let summary;
    let client = clientText || null;
    if (!client) {
      if (kind !== 'note') { fail('Choose the Client whose time changes (or leave New time empty for a notice).'); continue; }
      if (!reason) { fail('Write the message in the Reason / message column.'); continue; }
      kind = 'notice';
      summary = `Notice${facility ? ` about ${facility}` : ''}, shown in the daily update.`;
    } else {
      const usual = usualHours(client, date, facility ? [{ name: facility }] : facilities, regulars);
      if (usual.length) client = usual[0].client; // the name as written on Regular Clients
      if (kind === 'moved') {
        const to = formatRange(parsed.startHour, parsed.endHour);
        if (usual.length) summary = movedText(client, to, usual);
        else if (facility) summary = `${client} play ${to} at ${facility} (not one of their usual sessions).`;
        else { fail(`${client} has no usual session on ${dayText(raw.date)}: choose the Facility where they play.`); continue; }
      } else if (kind === 'cancelled') {
        if (!usual.length) { fail(`${client} has no usual session on ${dayText(raw.date)}${facility ? ` at ${facility}` : ''} to cancel. A one-off Ticqet booking is cancelled on Ticqet.`); continue; }
        summary = `${client} do not play (usually ${hoursAt(groupUsual(usual))}).`;
      } else {
        if (!reason) { fail('Write the note in the Reason / message column.'); continue; }
        summary = `Note about ${client}, shown in the daily update.`;
      }
    }
    const what = [entry.date, facility || '', (client || '').toLowerCase(), kind, parsed.startHour ?? '', parsed.endHour ?? '', reason].join('|');
    out.push({
      ...entry,
      facility,
      client,
      kind,
      ...(kind === 'moved' ? { startHour: parsed.startHour, endHour: parsed.endHour } : {}),
      summary,
      key: hash(what),
      // Same date + client (or same row for a notice): a later edit is an update.
      id: client ? hash(`${entry.date}|${facility || ''}|${client.toLowerCase()}`) : `row${raw.row}`,
    });
  }
  return out;
}
