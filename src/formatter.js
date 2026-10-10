// All the message wording lives here, in one place, so it is easy to review and
// change. Messages use plain characters only (no emoji, no special dashes or
// quotes) so each one stays within a single 160-character SMS where possible.
//
// Every message is several short lines. The first line is always
// "ZARIA COURT: <title>". The WhatsApp sender turns that first line into the
// bold title of the template and joins the other lines with " | "; the email
// sender makes "<title>: <first detail line>" the subject.
//
// Several facilities are watched (the Multi-Purpose Court and the 5-a-side
// pitches), so every booking line starts with the facility's name.

import { shortDate, formatRange, compactRange, clockLabel, clockLabelMinutes, joinNames, dayFromIso } from './time.js';
import { rangesText } from './bookings.js';

export const HEAD = 'ZARIA COURT';

const plural = (n, one, many) => (n === 1 ? one : many);
const hrsText = (n) => `${n} ${plural(n, 'hr', 'hrs')}`;
const dayText = (date) => shortDate(date.y, date.m, date.d);
const possessive = (name) => (/s$/i.test(name) ? `${name}'` : `${name}'s`);
const noDot = (s) => String(s).replace(/[.\s]+$/, '');

// "8:00-11:00 AM" from minutes since midnight (whole hours read best).
function minuteSpan(startMin, endMin) {
  if (startMin % 60 === 0 && endMin % 60 === 0) return formatRange(startMin / 60, endMin / 60);
  return `${clockLabelMinutes(startMin)}-${clockLabelMinutes(endMin)}`;
}

// What a schedule change did to a session: " - moved from 8:00-10:00 AM (Car-free day)".
function changeNote(s) {
  const c = s.change;
  if (!c) return '';
  const why = c.reason ? ` (${noDot(c.reason)})` : '';
  if (c.kind === 'moved' && s.off) return ` - moved to ${formatRange(c.to.startHour, c.to.endHour)}${why}`;
  if (c.kind === 'moved') {
    return c.from && c.from.length
      ? ` - moved from ${c.from.map((r) => formatRange(r.startHour, r.endHour)).join(' + ')}${why}`
      : ` - extra session${why}`;
  }
  if (c.kind === 'cancelled') return ` - NOT PLAYING${why}`;
  if (c.kind === 'note' && c.reason) return ` - note: ${noDot(c.reason)}`;
  return '';
}

// Who a session is for, in full ("Inspire Stars (regular client)").
function who(s) {
  if (s.event) return 'event / setup';
  return `${s.client ? `${s.client} (regular client)` : 'Ticqet booking'}${changeNote(s)}`;
}

// One line of a schedule: "6:00-8:00 PM Inspire Stars (regular)".
function scheduleLine(s, umuganda = null) {
  const range = formatRange(s.startHour, s.endHour);
  if (s.event) return `${range} Event / setup`;
  if (s.off) return `${range} ${s.client}${changeNote(s)}`;
  const during = umuganda && s.startHour * 60 < umuganda.end && s.endHour * 60 > umuganda.start ? ' - during Umuganda' : '';
  return `${range} ${s.client ? `${s.client} (regular)` : 'Ticqet booking'}${changeNote(s)}${during}`;
}

// The same, very short, for the weekly overview: "6-8PM Inspire Stars".
function weekItem(s) {
  const range = compactRange(s.startHour, s.endHour);
  if (s.event) return `${range} Event`;
  if (s.off) return `${range} ${s.client} ${s.change && s.change.kind === 'moved' ? 'moved' : 'not playing'}`;
  return `${range} ${s.client || 'Ticqet'}${s.change && s.change.kind === 'moved' ? ' (moved)' : ''}`;
}

// ---------- team alerts ----------

// A new online booking on Ticqet.
export function newBooking(booking, facility = booking.facility) {
  return [
    `${HEAD}: New booking`,
    `${facility}, ${dayText(booking.date)}, ${rangesText(booking.ranges)}`,
  ].join('\n');
}

// Several new bookings arrived at once (e.g. the agent was offline for a while,
// or someone booked many dates in one go). One message instead of many.
// Each booking carries its facility's name.
export function bookingsDigest(bookings, maxLines = 6) {
  const lines = [`${HEAD}: ${bookings.length} new bookings`];
  const sorted = [...bookings].sort((a, b) => dateNum(a.date) - dateNum(b.date) || String(a.facility).localeCompare(String(b.facility)) || a.slots[0] - b.slots[0]);
  for (const b of sorted.slice(0, maxLines)) lines.push(`${b.facility}, ${dayText(b.date)}, ${rangesText(b.ranges)}`);
  if (sorted.length > maxLines) lines.push(`+${sorted.length - maxLines} more - see the daily update.`);
  return lines.join('\n');
}

// A booking that disappeared (cancelled / freed up). `regular` is the client's
// name when the freed hours were a regular client's block.
export function cancelledBooking(booking, facility = booking.facility, regular = null) {
  const whose = regular ? ` (was ${possessive(regular)} regular slot)` : '';
  return [
    `${HEAD}: Booking cancelled`,
    `${facility}, ${dayText(booking.date)}, ${rangesText(booking.ranges)} is now FREE${whose}.`,
  ].join('\n');
}

// A booking whose hours changed.
export function changedBooking(before, after, facility = after.facility) {
  return [
    `${HEAD}: Booking changed`,
    `${facility}, ${dayText(after.date)}: was ${rangesText(before.ranges)}, now ${rangesText(after.ranges)}.`,
  ].join('\n');
}

// One compact line per alert that was held overnight (quiet hours). These are
// added to the morning update instead of being sent in the night.
export function overnightLine(type, booking, after = null) {
  const at = `${booking.facility}, ${dayText(booking.date)}`;
  if (type === 'new' || type === 'digest') return `New: ${at}, ${rangesText(booking.ranges)}`;
  if (type === 'cancelled') return `Cancelled: ${at}, ${rangesText(booking.ranges)} (now free)`;
  if (type === 'changed') return `Changed: ${at}, now ${rangesText(after.ranges)}`;
  if (type === 'event') return `Event booked: ${at}, ${rangesText(booking.ranges)}`;
  return `${type}: ${at}`;
}

// Stand-alone message for overnight alerts when no morning update is going out.
export function overnightUpdates(lines) {
  return [`${HEAD}: Overnight updates`, ...lines].join('\n');
}

// ---------- events ----------

// A team to call because of an event: "7:00-9:00 PM Oxygen 250 (regular)".
function teamLine(t) {
  const name = t.client ? `${t.client} (regular)` : 'Ticqet booking';
  return `${formatRange(t.startHour, t.endHour)} ${name}${t.displaced ? ' - their usual hours are inside the event booking' : changeNote(t)}`;
}

// The day before (or the morning of) an event or event setup: the facility is
// not available, so the teams booked there that day need a call.
// `ranges` = the event's hours; `teams` = [{ startHour, endHour, client, displaced? }].
export function eventDay({ facility, date, when, ranges, teams }) {
  const lines = [
    `${HEAD}: Event ${when}, ${dayText(date)}`,
    `${facility}: booked ${rangesText(ranges)} for an event or setup.`,
  ];
  if (teams.length) {
    lines.push(`Please call these teams - ${facility} is not available ${when}:`);
    for (const t of teams) lines.push(teamLine(t));
  } else {
    lines.push(`No other team is booked at ${facility} ${when === 'today' ? 'today' : 'that day'}.`);
  }
  return lines.join('\n');
}

// A new Ticqet booking long enough to be an event or setup. `when` is 'today',
// 'tomorrow' or null (later).
export function eventBooked({ booking, facility = booking.facility, when, teams }) {
  const lines = [
    `${HEAD}: ${when ? `Event booked for ${when}` : 'Event booked'}`,
    `${facility}, ${dayText(booking.date)}, ${rangesText(booking.ranges)}: an event or setup.`,
  ];
  if (!teams.length) lines.push(`No other team is booked at ${facility} that day.`);
  else {
    lines.push(when
      ? `Please call these teams - ${facility} is not available ${when}:`
      : `Teams also booked at ${facility} that day (a reminder to call them comes the day before):`);
    for (const t of teams) lines.push(teamLine(t));
  }
  return lines.join('\n');
}

// ---------- attendant messages ----------

// Reminder before sessions. `items` = the sessions starting at the same time,
// each { facility, startHour, endHour, client, event?, change? } (one item is
// the usual case). `minutesBefore` is one of the configured reminder times;
// `isFirst` is true for the earliest (e.g. 60 min) reminder. `readyByMinutes`
// is the clock time (minutes since midnight) to be ready by - start time minus
// the last reminder, e.g. 2:45 PM for 3 PM.
export function reminder(items, minutesBefore, isFirst, readyByMinutes) {
  const list = Array.isArray(items) ? items : [items];
  const one = list.length === 1;
  const it = one ? 'it' : 'them';
  const events = list.every((s) => s.event);
  const head = isFirst ? `${HEAD}: Reminder` : `${HEAD}: Starts in ${minutesBefore} min`;
  const lines = [head];
  if (one) {
    const s = list[0];
    lines.push(`${s.facility}, ${isFirst ? 'today ' : ''}${formatRange(s.startHour, s.endHour)}: ${who(s)}.`);
  } else {
    lines.push(`${isFirst ? 'Today ' : ''}${clockLabel(list[0].startHour)}: ${joinNames(list.map((s) => s.facility))}.`);
    for (const s of list) lines.push(`${s.facility}, ${formatRange(s.startHour, s.endHour)}: ${who(s)}.`);
  }
  if (isFirst) {
    const by = clockLabelMinutes(readyByMinutes);
    lines.push(events ? `Please open ${it} by ${by}.` : `Please open ${it} and have balls ready by ${by}.`);
  } else {
    lines.push(events
      ? `The event or setup team is arriving. ${one ? 'It' : 'They'} should be open.`
      : `Players are arriving. ${one ? 'It' : 'They'} should be open, with balls ready.`);
  }
  return lines.join('\n');
}

// A booking made less than an hour before it starts (or after it started).
// Attendants get this one message instead of their usual two reminders.
export function lastMinute(session, facility, minutesToStart) {
  const range = formatRange(session.startHour, session.endHour);
  const action = minutesToStart <= 0
    ? 'It has already started - please open it now.'
    : `Starts in ${minutesToStart} min. Please open it and have balls ready.`;
  return [
    `${HEAD}: Booking starting soon`,
    `${facility}, today ${range}, just booked on Ticqet.`,
    action,
  ].join('\n');
}

// ---------- summaries ----------

// Today's schedule (daily update). `sections` = one per facility:
// [{ name, sessions: [{ startHour, endHour, client|null, event?, off?, change? }] }].
// With one facility the layout is: name, sessions, total. With several, each
// facility is a heading with its hours.
// `umuganda` = { start, end } in minutes, on Umuganda days. `notes` = lines
// from the Schedule Changes tab.
export function dailyUpdate(date, sections, { overnight = [], dataOk = true, notes = [], umuganda = null } = {}) {
  const lines = [`${HEAD}: Today, ${dayText(date)}`];
  if (umuganda) lines.push(`Umuganda today, ${minuteSpan(umuganda.start, umuganda.end)}.`);
  const single = sections.length === 1;
  let total = 0;
  for (const sec of sections) {
    const hrs = sec.sessions.filter((s) => !s.off).reduce((n, s) => n + (s.endHour - s.startHour), 0);
    total += hrs;
    if (single) {
      lines.push(sec.name);
      if (!sec.sessions.length) lines.push('No bookings yet.');
    } else {
      lines.push(sec.sessions.length ? `${sec.name} (${hrsText(hrs)}):` : `${sec.name}: no bookings yet.`);
    }
    for (const s of sec.sessions) lines.push(scheduleLine(s, umuganda));
  }
  if (single && sections[0].sessions.length) lines.push(`Total booked: ${hrsText(total)}`);
  if (notes.length) lines.push('Notes:', ...notes);
  if (!dataOk) lines.push('(Ticqet could not be read - this list may be incomplete.)');
  if (overnight.length) lines.push('Overnight:', ...overnight);
  return lines.join('\n');
}

// The week ahead (weekly overview). `sections` = one per facility:
// [{ name, days: [{ label: "Mon", sessions: [...], umuganda? }] }].
export function weeklyOverview(rangeText, sections, { overnight = [], dataOk = true } = {}) {
  const lines = [`${HEAD}: Week of ${rangeText}`];
  const single = sections.length === 1;
  let grand = 0;
  let anything = false;
  for (const sec of sections) {
    let total = 0;
    const empty = [];
    const body = [];
    for (const day of sec.days) {
      if (!day.sessions.length) {
        empty.push(day.label);
        continue;
      }
      for (const s of day.sessions) if (!s.off) total += s.endHour - s.startHour;
      const label = day.umuganda ? `${day.label} (Umuganda ${minuteSpan(day.umuganda.start, day.umuganda.end)})` : day.label;
      body.push(`${label} ${day.sessions.map(weekItem).join(', ')}`);
    }
    grand += total;
    if (body.length) anything = true;
    if (single) {
      lines.push(sec.name);
      if (!body.length) {
        lines.push('No bookings yet.');
        continue;
      }
    } else {
      lines.push(body.length ? `${sec.name} (${hrsText(total)}):` : `${sec.name}: no bookings yet.`);
      if (!body.length) continue;
    }
    lines.push(...body);
    if (empty.length) lines.push(`${empty.join(', ')}: none yet`);
  }
  if (single && anything) lines.push(`Total: ${hrsText(grand)}`);
  if (!dataOk) lines.push('(Ticqet could not be read - this list may be incomplete.)');
  if (overnight.length) lines.push('Overnight:', ...overnight);
  return lines.join('\n');
}

// ---------- schedule changes (from the admin, via the sheet) ----------

// One row of the Schedule Changes tab, as it is emailed to everyone.
// `c` comes from changes.js (kind, date, client, facility, reason, summary).
export function scheduleChange(c, { updated = false } = {}) {
  const d = dayFromIso(c.date);
  const day = dayText(d);
  const pre = updated ? 'Updated: ' : '';
  if (c.kind === 'notice') return [`${HEAD}: ${pre}Notice for ${day}`, `${c.facility ? `${c.facility}: ` : ''}${c.reason}`].join('\n');
  if (c.kind === 'note') return [`${HEAD}: ${pre}Note for ${day}`, `${c.client}${c.facility ? ` (${c.facility})` : ''}: ${c.reason}`].join('\n');
  const lines = [`${HEAD}: ${pre}Schedule change, ${day}`, c.summary];
  if (c.reason) lines.push(`Reason: ${noDot(c.reason)}.`);
  return lines.join('\n');
}

// Umuganda is coming: sessions booked during it. `items` = sessions with their
// facility; `umuganda` = { start, end } in minutes.
export function umugandaHeadsUp(date, umuganda, items) {
  return [
    `${HEAD}: Umuganda on ${dayText(date)}`,
    `Umuganda is ${minuteSpan(umuganda.start, umuganda.end)}. Booked during Umuganda:`,
    ...items.map((s) => `${s.facility}: ${formatRange(s.startHour, s.endHour)} ${s.client ? `${s.client} (regular)` : 'Ticqet booking'}`),
    'If they move or will not play, add a row on the Schedule Changes tab and tick Email everyone.',
  ].join('\n');
}

// ---------- admin messages ----------

// A Ticqet booking landed in a regular client's usual slot. Either Zaria blocked
// it for the regular (fine) or an online customer booked it (double-booking).
// `items` = [{ booking, client, inside }], each booking with its facility.
export function regularSlotCheck(items, maxLines = 5) {
  if (items.length === 1) {
    const { booking, client, inside } = items[0];
    const where = inside ? `in ${possessive(client)} usual slot` : `overlapping ${possessive(client)} usual slot`;
    return [
      `${HEAD}: Check booking`,
      `${booking.facility}: Ticqet booking ${where}, ${dayText(booking.date)} ${rangesText(booking.ranges)}.`,
      `If Zaria blocked it for ${client}, ignore this. If not, it may be double-booked.`,
    ].join('\n');
  }
  const sorted = [...items].sort((a, b) => dateNum(a.booking.date) - dateNum(b.booking.date));
  const lines = [
    `${HEAD}: Check bookings`,
    `${items.length} Ticqet bookings in regular clients' usual slots:`,
  ];
  for (const { booking, client } of sorted.slice(0, maxLines)) {
    const r = booking.ranges[0];
    lines.push(`${dayText(booking.date)} ${compactRange(r.startHour, booking.ranges[booking.ranges.length - 1].endHour)} ${booking.facility} (${client})`);
  }
  if (sorted.length > maxLines) lines.push(`+${sorted.length - maxLines} more.`);
  lines.push('If Zaria blocked these for the regulars, ignore this. If not, they may be double-booked.');
  return lines.join('\n');
}

// Regular clients' hours that are OPEN on Ticqet in the coming days - anyone
// could book them online. `items` = [{ day, facility, client, range }].
export function openRegularSlots(items) {
  const byDay = new Map();
  for (const it of items) {
    const k = dateNum(it.day);
    if (!byDay.has(k)) byDay.set(k, { day: it.day, parts: [] });
    byDay.get(k).parts.push(`${it.facility} ${compactRange(it.range.startHour, it.range.endHour)} ${it.client}`);
  }
  const lines = [`${HEAD}: Regular slots open on Ticqet`];
  for (const [, v] of [...byDay].sort((a, b) => a[0] - b[0])) lines.push(`${dayText(v.day)}: ${v.parts.join('; ')}`);
  lines.push('Anyone can book these online. Block them on Ticqet, or set an Until date if the client stopped.');
  return lines.join('\n');
}

// Many bookings vanished at once - more likely a Ticqet glitch or change than
// real cancellations, so the team is not alerted.
export function massRemoval(bookings) {
  const dates = [...bookings].sort((a, b) => dateNum(a.date) - dateNum(b.date));
  const first = dayText(dates[0].date);
  const last = dayText(dates[dates.length - 1].date);
  const span = first === last ? first : `${first} - ${last}`;
  const places = joinNames([...new Set(bookings.map((b) => b.facility))]);
  return [
    `${HEAD}: Agent check`,
    `${bookings.length} bookings disappeared from Ticqet at once (${span}), at ${places}.`,
    'Team NOT alerted. Please check Ticqet. If Zaria removed them, nothing to do.',
  ].join('\n');
}

// The agent could not read Ticqet for a while. `what` names the facilities
// that failed, when only some did.
export function technicalAlert(minutes, what = '') {
  return [
    `${HEAD}: Agent alert`,
    `Could not read Ticqet bookings${what ? ` (${what})` : ''} for ${minutes} min.`,
    'Alerts may be delayed. Please check the agent (Status tab).',
  ].join('\n');
}

// Ticqet is readable again after a technical alert.
export function technicalRecovered(minutesDown) {
  return [
    `${HEAD}: Agent back to normal`,
    `Ticqet can be read again (after about ${minutesDown} min).`,
    'Any bookings made meanwhile are being alerted now.',
  ].join('\n');
}

// Regular arrangements about to end. `items` = [{ client, until: {y,m,d},
// daysLeft, hours: "5-a-side Pitch B Mon 6-7PM" }], one per client and end date.
export function renewals(items) {
  const when = (n) => (n === 0 ? 'today' : `in ${n} ${plural(n, 'day', 'days')}`);
  if (items.length === 1) {
    const it = items[0];
    return [
      `${HEAD}: Renewal due`,
      `${possessive(it.client)} arrangement ends ${dayText(it.until)} (${when(it.daysLeft)}).`,
      it.hours,
      'When renewed, update the Until date on the Regular Clients tab. If not, free the hours on Ticqet.',
    ].join('\n');
  }
  const lines = [`${HEAD}: Renewals due`];
  const byDate = new Map();
  for (const it of [...items].sort((a, b) => dateNum(a.until) - dateNum(b.until) || a.client.localeCompare(b.client))) {
    const k = dateNum(it.until);
    if (!byDate.has(k)) byDate.set(k, { it, list: [] });
    byDate.get(k).list.push(it);
  }
  for (const { it, list } of byDate.values()) {
    lines.push(`Ending ${dayText(it.until)} (${when(it.daysLeft)}):`);
    for (const x of list) lines.push(`${x.client} - ${x.hours}`);
  }
  lines.push('When renewed, update the Until dates on the Regular Clients tab. If not, free the hours on Ticqet.');
  return lines.join('\n');
}

// The daily message limit was reached - a safety stop against runaway costs.
export function sendCapReached(cap) {
  return [
    `${HEAD}: Agent paused`,
    `Daily message limit of ${cap} reached. Team messages are paused until tomorrow.`,
    'Please check the agent log for what caused it.',
  ].join('\n');
}

// Booking alerts stop early, so the rest of the day's messages stay free for
// reminders and updates.
export function alertsPaused(sent, cap) {
  return [
    `${HEAD}: Booking alerts paused`,
    `${sent} messages sent today. New-booking alerts are paused until tomorrow, so the rest of today's limit (${cap}) stays free for reminders and updates.`,
    'Every booking is still logged and shows in the daily update.',
  ].join('\n');
}

// Held admin notes from the night, as one morning message.
export function adminOvernight(lines) {
  return [`${HEAD}: Overnight checks`, ...lines].join('\n');
}

// The setup sheet has a mistake. The agent keeps the last good settings.
export function configProblem(errors, maxLines = 5) {
  return [
    `${HEAD}: Settings problem`,
    ...errors.slice(0, maxLines),
    ...(errors.length > maxLines ? [`+${errors.length - maxLines} more.`] : []),
    'Alerts continue with the last good settings until this is fixed in the sheet.',
  ].join('\n');
}

// ---------- setup ----------

// " on WhatsApp", " on SMS", " by email" - and nothing in preview.
const via = (channelName) => {
  if (channelName === 'email') return ' by email';
  return channelName && channelName !== 'preview' ? ` on ${channelName}` : '';
};

// Sent once to everyone when the agent first goes live on a channel.
// `facilities` = the watched facilities' names (or one name).
export function welcome({ channelName, facilities, courtName, dailyTime, adminName }) {
  const names = joinNames([].concat(facilities || courtName || []));
  return [
    `${HEAD}: Booking alerts are on`,
    `You will now get ${names} alerts${via(channelName)}: new Ticqet bookings, a daily update at ${dailyTime}, and reminders for attendants.`,
    `This is a trial. Tell ${adminName} if anything is wrong or missing.`,
  ].join('\n');
}

// Sent once to everyone when facilities are added to an agent already running.
export function facilitiesAdded(names) {
  const list = joinNames(names);
  return [
    `${HEAD}: Now also watching ${list}`,
    `From now on, the booking alerts also cover ${list}: new Ticqet bookings, the daily update and reminders before sessions.`,
    `Bookings already on Ticqet for ${names.length === 1 ? 'it' : 'them'} were noted quietly, not announced one by one.`,
  ].join('\n');
}

// Used by `npm run send-test` to check that a phone can be reached.
export function testMessage(channelName) {
  return [
    `${HEAD}: Test message`,
    `If you can read this, the booking agent can reach you${via(channelName)}.`,
  ].join('\n');
}

// ---------- helpers ----------

function dateNum(d) {
  return d.y * 10000 + d.m * 100 + d.d;
}
