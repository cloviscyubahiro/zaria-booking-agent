// Minimal logger: prints to the console and appends to data/agent.log.
// No dependencies. Phone numbers are masked in log lines by the callers.

import fs from 'node:fs';
import path from 'node:path';

// Where runtime files live. Tests point this at a temp folder.
export function dataDir() {
  return process.env.ZARIA_DATA_DIR ? path.resolve(process.env.ZARIA_DATA_DIR) : path.resolve('data');
}

function write(level, args) {
  const line = `${new Date().toISOString()} [${level}] ${args
    .map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : JSON.stringify(a)))
    .join(' ')}`;
  if (!process.env.ZARIA_QUIET) {
    // eslint-disable-next-line no-console
    (level === 'ERROR' ? console.error : console.log)(line);
  }
  try {
    const dir = dataDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'agent.log'), line + '\n');
  } catch {
    // Never let logging crash the agent.
  }
}

export const log = {
  info: (...a) => write('INFO', a),
  warn: (...a) => write('WARN', a),
  error: (...a) => write('ERROR', a),
};

// "+250788123456" -> "+25078***456" so logs do not spread full numbers around.
export function mask(phone) {
  const s = String(phone);
  return s.length > 8 ? `${s.slice(0, 6)}***${s.slice(-3)}` : s;
}
