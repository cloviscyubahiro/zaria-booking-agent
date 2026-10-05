// Time helpers. Everything here is deterministic and timezone-explicit so the
// agent behaves the same no matter what timezone the server clock is set to.
//
// Ticqet stores each day's bookings under a string like:
//   "Thursday 01 October 2026"   (weekday, zero-padded day, month, year)
// We must reproduce that string EXACTLY, so we build it from fixed English
// name tables rather than the server's locale.

export const WEEKDAYS = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
];
export const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// The calendar weekday of a given Y/M/D (0 = Sunday). Uses a UTC anchor so it
// never shifts with the server timezone.
export function weekdayOf(y, m, d) {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// The Ticqet date label for a Y/M/D.
export function ticqetLabel(y, m, d) {
  const dd = String(d).padStart(2, '0');
  return `${WEEKDAYS[weekdayOf(y, m, d)]} ${dd} ${MONTHS[m - 1]} ${y}`;
}

// The current wall-clock date/time in a given IANA timezone (e.g. Africa/Kigali),
// returned as plain numbers. This is what "today" and "now" mean to the agent.
export function nowInZone(timezone, at = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  let hour = get('hour');
  if (hour === 24) hour = 0; // some environments emit 24 for midnight
  return { y: get('year'), m: get('month'), d: get('day'), hour, minute: get('minute') };
}

// Enumerate the next `days` calendar dates starting from a given Y/M/D.
// Returns [{ y, m, d, dow, label }].
export function dateWindow(start, days) {
  const out = [];
  for (let i = 0; i < days; i++) {
    const cur = new Date(Date.UTC(start.y, start.m - 1, start.d + i));
    const y = cur.getUTCFullYear();
    const m = cur.getUTCMonth() + 1;
    const d = cur.getUTCDate();
    out.push({ y, m, d, dow: cur.getUTCDay(), label: ticqetLabel(y, m, d) });
  }
  return out;
}

// "HH:MM" -> minutes since midnight.
export function hhmmToMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}

// Minutes since midnight -> "HH:MM" (24h).
export function minutesToHhmm(mins) {
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// Format a single 24h hour as a 12h clock piece, optionally with the meridiem.
function clock12(hour24, withMeridiem) {
  const mer = hour24 < 12 || hour24 === 24 ? 'AM' : 'PM';
  let h = hour24 % 12;
  if (h === 0) h = 12;
  return withMeridiem ? `${h}:00 ${mer}` : `${h}:00`;
}

// Format a booked range given start hour and (exclusive) end hour, both 24h ints.
// e.g. (17, 19) -> "5:00-7:00 PM";  (11, 13) -> "11:00 AM-1:00 PM".
// Midnight (24) is "AM" but never shares it: (7, 24) -> "7:00 AM-12:00 AM",
// not "7:00-12:00 AM", which reads as a morning booking.
export function formatRange(startHour, endHour) {
  const startMer = startHour < 12 ? 'AM' : 'PM';
  const endMer = endHour < 12 || endHour === 24 ? 'AM' : 'PM';
  if (startMer === endMer && endHour !== 24) {
    return `${clock12(startHour, false)}-${clock12(endHour, true)}`;
  }
  return `${clock12(startHour, true)}-${clock12(endHour, true)}`;
}

// A single clock time, e.g. clockLabel(17) -> "5:00 PM".
export function clockLabel(hour24) {
  const mer = hour24 < 12 || hour24 === 24 ? 'AM' : 'PM';
  let h = hour24 % 12;
  if (h === 0) h = 12;
  return `${h}:00 ${mer}`;
}

// A short weekday+date for message headers, e.g. "Thu 1 Oct".
export function shortDate(y, m, d) {
  const dow = WEEKDAYS[weekdayOf(y, m, d)].slice(0, 3);
  const mon = MONTHS[m - 1].slice(0, 3);
  return `${dow} ${d} ${mon}`;
}

// "YYYY-MM-DD" for a { y, m, d } date. Used for internal keys and log entries.
export function isoDate({ y, m, d }) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// "YYYY-MM-DD" -> { y, m, d }.
export function dayFromIso(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return { y, m, d };
}

// Whole calendar days from date a to date b (b - a). Both are { y, m, d }.
export function daysBetween(a, b) {
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86400000);
}

// A clock time from minutes since midnight, e.g. 1005 -> "4:45 PM".
export function clockLabelMinutes(totalMinutes) {
  const mins = ((totalMinutes % 1440) + 1440) % 1440;
  const h24 = Math.floor(mins / 60);
  const mm = String(mins % 60).padStart(2, '0');
  const mer = h24 < 12 ? 'AM' : 'PM';
  let h = h24 % 12;
  if (h === 0) h = 12;
  return `${h}:${mm} ${mer}`;
}

// Very compact range for dense messages, e.g. (17, 19) -> "5-7PM", (10, 12) -> "10AM-12PM".
export function compactRange(startHour, endHour) {
  const mer = (h) => (h < 12 || h === 24 ? 'AM' : 'PM');
  const h12 = (h) => {
    const x = h % 12;
    return x === 0 ? 12 : x;
  };
  if (mer(startHour) === mer(endHour) && endHour !== 24) return `${h12(startHour)}-${h12(endHour)}${mer(endHour)}`;
  return `${h12(startHour)}${mer(startHour)}-${h12(endHour)}${mer(endHour)}`;
}
