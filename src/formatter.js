// All the message wording lives here, in one place, so it is easy to review and
// change. Messages use plain characters only (no emoji, no special dashes or
// quotes) so each one stays within a single 160-character SMS where possible.
//
// Every message is several short lines. The first line is always
// "ZARIA COURT: <title>". The WhatsApp sender turns that first line into the
// bold title of the template and joins the other lines with " | ".

import { shortDate, formatRange, compactRange, clockLabelMinutes } from './time.js';
import { rangesText } from './bookings.js';

export const HEAD = 'ZARIA COURT';

const who = (client) => (client ? `${client} (regular client)` : 'Ticqet booking');
const plural = (n, one, many) => (n === 1 ? one : many);
const dayText = (date) => shortDate(date.y, date.m, date.d);

// ---------- team alerts ----------

// A new online booking on Ticqet.
export function newBooking(booking, courtName) {
  return [
    `${HEAD}: New booking`,
    courtName,
    `${dayText(booking.date)}, ${rangesText(booking.ranges)}`,
  ].join('\n');
}

// Several new bookings arrived at once (e.g. the agent was offline for a while,
// or someone booked many dates in one go). One message instead of many.
export function bookingsDigest(bookings, courtName, maxLines = 6) {
  const lines = [`${HEAD}: ${bookings.length} new bookings`, courtName];
  const sorted = [...bookings].sort((a, b) => dateNum(a.date) - dateNum(b.date) || a.slots[0] - b.slots[0]);
  for (const b of sorted.slice(0, maxLines)) lines.push(`${dayText(b.date)}, ${rangesText(b.ranges)}`);
  if (sorted.length > maxLines) lines.push(`+${sorted.length - maxLines} more - see the daily update.`);
  return lines.join('\n');
}

// A booking that disappeared (cancelled / freed up). `regular` is the client's
// name when the freed hours were a regular client's block.
export function cancelledBooking(booking, courtName, regular = null) {
  const whose = regular ? ` (was ${regular}'s regular slot)` : '';
  return [
    `${HEAD}: Booking cancelled`,
    courtName,
    `${dayText(booking.date)}, ${rangesText(booking.ranges)} is now FREE${whose}.`,
  ].join('\n');
}

// A booking whose hours changed.
export function changedBooking(before, after, courtName) {
  return [
    `${HEAD}: Booking changed`,
    courtName,
    `${dayText(after.date)}: was ${rangesText(before.ranges)}, now ${rangesText(after.ranges)}.`,
  ].join('\n');
}

// One compact line per alert that was held overnight (quiet hours). These are
// added to the morning update instead of being sent in the night.
export function overnightLine(type, booking, after = null) {
  const d = dayText(booking.date);
  if (type === 'new') return `New: ${d}, ${rangesText(booking.ranges)}`;
  if (type === 'cancelled') return `Cancelled: ${d}, ${rangesText(booking.ranges)} (now free)`;
  if (type === 'changed') return `Changed: ${d}, now ${rangesText(after.ranges)}`;
  if (type === 'digest') return `New: ${d}, ${rangesText(booking.ranges)}`;
  return `${type}: ${d}`;
}

// Stand-alone message for overnight alerts when no morning update is going out.
export function overnightUpdates(lines, courtName) {
  return [`${HEAD}: Overnight updates`, courtName, ...lines].join('\n');
}

// ---------- attendant messages ----------

// Reminder before a session. `minutesBefore` is one of the configured reminder
// times; `isFirst` is true for the earliest (e.g. 60 min) reminder.
// `readyByMinutes` is the clock time (minutes since midnight) the court should
// be ready by - start time minus the last reminder, e.g. 2:45 PM for 3 PM.
export function reminder(session, courtName, minutesBefore, isFirst, readyByMinutes) {
  const range = formatRange(session.startHour, session.endHour);
  if (isFirst) {
    return [
      `${HEAD}: Reminder`,
      `${courtName} is booked today ${range} (${who(session.client)}).`,
      `Please open the court and have balls ready by ${clockLabelMinutes(readyByMinutes)}.`,
    ].join('\n');
  }
  return [
    `${HEAD}: Starts in ${minutesBefore} min`,
    `${courtName}, ${range}, ${who(session.client)}.`,
    'Players are arriving. Court open, balls ready.',
  ].join('\n');
}

// A booking made less than an hour before it starts (or after it started).
// Attendants get this one message instead of their usual two reminders.
export function lastMinute(session, courtName, minutesToStart) {
  const range = formatRange(session.startHour, session.endHour);
  const action = minutesToStart <= 0
    ? 'It has already started - please open the court now.'
    : `Starts in ${minutesToStart} min. Please open the court and have balls ready.`;
  return [
    `${HEAD}: Booking starting soon`,
    `${courtName}, today ${range}, just booked on Ticqet.`,
    action,
  ].join('\n');
}

// ---------- summaries ----------

// Today's schedule (daily update). `sessions` is an ordered list of
// { startHour, endHour, client|null }.
export function dailyUpdate(date, sessions, courtName, overnight = [], dataOk = true) {
  const lines = [`${HEAD}: Today, ${dayText(date)}`, courtName];
  if (!sessions.length) {
    lines.push('No bookings yet.');
  } else {
    for (const s of sessions) {
      lines.push(`${formatRange(s.startHour, s.endHour)} ${s.client ? `${s.client} (regular)` : 'Ticqet booking'}`);
    }
    const hrs = sessions.reduce((n, s) => n + (s.endHour - s.startHour), 0);
    lines.push(`Total booked: ${hrs} ${plural(hrs, 'hr', 'hrs')}`);
  }
  if (!dataOk) lines.push('(Ticqet could not be read - this list may be incomplete.)');
  if (overnight.length) lines.push('Overnight:', ...overnight);
  return lines.join('\n');
}

// The week ahead (weekly overview). `days` is a list of
// { label: "Mon", sessions: [{startHour,endHour,client|null}] }.
export function weeklyOverview(rangeText, days, courtName, overnight = [], dataOk = true) {
  const lines = [`${HEAD}: Week of ${rangeText}`, courtName];
  let total = 0;
  const empty = [];
  for (const day of days) {
    if (!day.sessions.length) {
      empty.push(day.label);
      continue;
    }
    const items = day.sessions.map((s) => {
      total += s.endHour - s.startHour;
      return `${compactRange(s.startHour, s.endHour)} ${s.client || 'Ticqet'}`;
    });
    lines.push(`${day.label} ${items.join(', ')}`);
  }
  if (empty.length === days.length) lines.push('No bookings yet.');
  else {
    if (empty.length) lines.push(`${empty.join(', ')}: none yet`);
    lines.push(`Total: ${total} ${plural(total, 'hr', 'hrs')}`);
  }
  if (!dataOk) lines.push('(Ticqet could not be read - this list may be incomplete.)');
  if (overnight.length) lines.push('Overnight:', ...overnight);
  return lines.join('\n');
}

// ---------- admin messages ----------

// A Ticqet booking landed in a regular client's usual slot. Either Zaria blocked
// it for the regular (fine) or an online customer booked it (double-booking).
// `items` = [{ booking, client, inside }].
export function regularSlotCheck(items, courtName, maxLines = 5) {
  if (items.length === 1) {
    const { booking, client, inside } = items[0];
    const where = inside ? `in ${client}'s usual slot` : `overlapping ${client}'s usual slot`;
    return [
      `${HEAD}: Check booking`,
      `${courtName}: Ticqet booking ${where}, ${dayText(booking.date)} ${rangesText(booking.ranges)}.`,
      `If Zaria blocked it for ${client}, ignore this. If not, it may be double-booked.`,
    ].join('\n');
  }
  const sorted = [...items].sort((a, b) => dateNum(a.booking.date) - dateNum(b.booking.date));
  const lines = [
    `${HEAD}: Check bookings`,
    `${courtName}: ${items.length} Ticqet bookings in regular clients' usual slots:`,
  ];
  for (const { booking, client } of sorted.slice(0, maxLines)) {
    const r = booking.ranges[0];
    lines.push(`${dayText(booking.date)} ${compactRange(r.startHour, booking.ranges[booking.ranges.length - 1].endHour)} (${client})`);
  }
  if (sorted.length > maxLines) lines.push(`+${sorted.length - maxLines} more.`);
  lines.push('If Zaria blocked these for the regulars, ignore this. If not, they may be double-booked.');
  return lines.join('\n');
}

// Regular clients' hours that are OPEN on Ticqet in the coming days - anyone
// could book them online. `items` = [{ day, client, range }].
export function openRegularSlots(items, courtName) {
  const byDay = new Map();
  for (const it of items) {
    const k = dateNum(it.day);
    if (!byDay.has(k)) byDay.set(k, { day: it.day, parts: [] });
    byDay.get(k).parts.push(`${compactRange(it.range.startHour, it.range.endHour)} ${it.client}`);
  }
  const lines = [`${HEAD}: Regular slots open on Ticqet`, courtName];
  for (const [, v] of [...byDay].sort((a, b) => a[0] - b[0])) lines.push(`${dayText(v.day)} ${v.parts.join(', ')}`);
  lines.push('Anyone can book these online. Block them on Ticqet, or set an Until date if the client stopped.');
  return lines.join('\n');
}

// Many bookings vanished at once - more likely a Ticqet glitch or change than
// real cancellations, so the team is not alerted.
export function massRemoval(bookings, courtName) {
  const dates = [...bookings].sort((a, b) => dateNum(a.date) - dateNum(b.date));
  const first = dayText(dates[0].date);
  const last = dayText(dates[dates.length - 1].date);
  const span = first === last ? first : `${first} - ${last}`;
  return [
    `${HEAD}: Agent check`,
    `${courtName}: ${bookings.length} bookings disappeared from Ticqet at once (${span}).`,
    'Team NOT alerted. Please check Ticqet. If Zaria removed them, nothing to do.',
  ].join('\n');
}

// The agent could not read Ticqet for a while.
export function technicalAlert(minutes) {
  return [
    `${HEAD}: Agent alert`,
    `Could not read Ticqet bookings for ${minutes} min.`,
    'Alerts may be delayed. Please check the agent/server.',
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

// A regular arrangement is about to end.
export function renewalReminder(client, untilDate, daysLeft) {
  const when = daysLeft === 0 ? 'today' : `in ${daysLeft} ${plural(daysLeft, 'day', 'days')}`;
  return [
    `${HEAD}: Renewal due`,
    `${client}'s arrangement ends ${dayText(untilDate)} (${when}).`,
    'Renew it, or free the hours on Ticqet.',
  ].join('\n');
}

// The daily message limit was reached - a safety stop against runaway costs.
export function sendCapReached(cap) {
  return [
    `${HEAD}: Agent paused`,
    `Daily message limit of ${cap} reached. Team messages are paused until tomorrow.`,
    'Please check the agent log for what caused it.',
  ].join('\n');
}

// Held admin notes from the night, as one morning message.
export function adminOvernight(lines) {
  return [`${HEAD}: Overnight checks`, ...lines].join('\n');
}

// ---------- setup ----------

// Sent once to everyone when the agent first goes live on a channel.
export function welcome({ channelName, courtName, dailyTime, adminName }) {
  return [
    `${HEAD}: Booking alerts are on`,
    `You will now get ${courtName} alerts on ${channelName}: new Ticqet bookings, a daily update at ${dailyTime}, and reminders for attendants.`,
    `This is a trial. Tell ${adminName} if anything is wrong or missing.`,
  ].join('\n');
}

// Used by `npm run send-test` to check that a phone can be reached.
export function testMessage(channelName) {
  return [
    `${HEAD}: Test message`,
    `If you can read this, the booking agent can reach you on ${channelName}.`,
  ].join('\n');
}

// ---------- helpers ----------

function dateNum(d) {
  return d.y * 10000 + d.m * 100 + d.d;
}
