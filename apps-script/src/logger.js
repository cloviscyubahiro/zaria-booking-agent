// Apps Script stand-in for src/logger.js (the build swaps it in). Log lines go
// to the Apps Script execution log; warnings and errors from the current run
// are also kept so they can be shown on the Status sheet.

export const recent = []; // [{ level, text }]

export function dataDir() {
  return '';
}

function write(level, args) {
  const text = args
    .map((a) => (typeof a === 'string' ? a : a && a.message ? a.message : JSON.stringify(a)))
    .join(' ');
  if (level === 'ERROR') console.error(text);
  else if (level === 'WARN') console.warn(text);
  else console.log(text);
  if (level !== 'INFO') {
    recent.push({ level, text });
    if (recent.length > 20) recent.shift();
  }
}

export const log = {
  info: (...a) => write('INFO', a),
  warn: (...a) => write('WARN', a),
  error: (...a) => write('ERROR', a),
};

// "clovis@gmail.com" -> "cl***@gmail.com", "+250788123456" -> "+25078***456".
export function mask(address) {
  const s = String(address);
  const at = s.indexOf('@');
  if (at > 0) return `${s.slice(0, Math.min(2, at))}***${s.slice(at)}`;
  return s.length > 8 ? `${s.slice(0, 6)}***${s.slice(-3)}` : s;
}
