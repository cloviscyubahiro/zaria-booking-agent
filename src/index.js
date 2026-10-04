// Entry point. Connects to Ticqet, wires the configured sender into the engine,
// and runs the timers.
//
//   npm start         run continuously (use the systemd service on the server)
//   npm run check     read the next 14 days from Ticqet, print them, send nothing

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv, loadConfig, configChanged, recipients } from './config.js';
import { makeSender } from './senders/index.js';
import { TicqetWatcher } from './ticqet.js';
import { Engine } from './engine.js';
import { log } from './logger.js';
import { nowInZone, dateWindow, shortDate, formatRange, compactRange } from './time.js';
import { bookingFromDoc, slotsToRanges } from './bookings.js';
import { matchRegular, lapsedRegularHours } from './regulars.js';

const CHECK = process.argv.includes('--check');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// All engine work runs one job at a time, so two timers can never interleave
// (and, say, send the same reminder twice). A job that is already waiting is
// not queued again.
function makeRunner() {
  let chain = Promise.resolve();
  const waiting = new Set();
  return (name, fn) => {
    if (waiting.has(name)) return chain;
    waiting.add(name);
    chain = chain.then(async () => {
      waiting.delete(name);
      try {
        await fn();
      } catch (err) {
        log.error(`[${name}] ${err.stack || err.message}`);
      }
    });
    return chain;
  };
}

// --check: print what the agent sees on Ticqet for the next 14 days.
export async function runCheck(cfg, watcher) {
  const court = cfg.settings.court.name;
  const days = dateWindow(nowInZone(cfg.settings.timezone), 14);
  watcher.watch(days.map((d) => d.label));
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline && days.some((d) => watcher.get(d.label) === undefined)) await sleep(1000);

  console.log(`\n${court} on Ticqet - next 14 days (R = regular client)\n`);
  let read = 0;
  for (const d of days) {
    const raw = watcher.get(d.label);
    const head = shortDate(d.y, d.m, d.d).padEnd(11);
    if (raw === undefined) {
      console.log(`  ${head} COULD NOT READ`);
      continue;
    }
    read += 1;
    const date = { y: d.y, m: d.m, d: d.d, label: d.label };
    const bookings = raw.map((r) => bookingFromDoc(r, date)).sort((a, b) => a.slots[0] - b.slots[0]);
    const parts = bookings.map((b) => {
      const reg = matchRegular(b, cfg.regulars, date, court);
      return b.ranges.map((r) => formatRange(r.startHour, r.endHour)).join(' + ') + (reg ? ` R:${reg}` : ' online');
    });
    const booked = new Set(bookings.flatMap((b) => b.slots));
    const open = lapsedRegularHours(cfg.regulars, date, court, booked)
      .flatMap((lr) => slotsToRanges(lr.openHours).map((r) => `${compactRange(r.startHour, r.endHour)} ${lr.client}`));
    console.log(`  ${head} ${parts.length ? parts.join(', ') : '-'}${open.length ? `   ! regular hours OPEN on Ticqet: ${open.join(', ')}` : ''}`);
  }
  console.log(`\nRead ${read} of ${days.length} days from Ticqet.${read === days.length ? ' Reading works.' : ' Some days could not be read - see the log above.'}\n`);
  return read === days.length;
}

async function main() {
  const env = loadEnv();
  let cfg = loadConfig();
  let sender = makeSender(cfg.settings, env);

  log.info(`[start] Zaria Court booking agent - channel: ${sender.describe()}`);
  log.info(`[start] ${recipients(cfg, 'team').length} numbers get booking alerts, ${recipients(cfg, 'attendants').length} attendants, admin ${recipients(cfg, 'admin').length ? 'set' : 'NOT SET'}`);

  const watcher = new TicqetWatcher({ settings: cfg.settings, env });
  await watcher.start();

  if (CHECK) {
    const ok = await runCheck(cfg, watcher);
    await watcher.stop();
    process.exit(ok ? 0 : 1);
  }

  const engine = new Engine({ cfg, source: watcher, sender });
  const run = makeRunner();
  let lastReloadError = null;

  const reloadIfChanged = () => {
    if (!configChanged(cfg)) return;
    try {
      const next = loadConfig();
      if (next.settings.channel !== cfg.settings.channel || next.settings.smsSenderName !== cfg.settings.smsSenderName) {
        sender = makeSender(next.settings, env);
        engine.sender = sender;
        log.info(`[config] channel is now: ${sender.describe()}`);
      }
      if (next.settings.court.ticqetEventId !== cfg.settings.court.ticqetEventId) {
        log.warn('[config] the court\'s Ticqet id changed - restart the agent for that to take effect.');
      }
      cfg = next;
      engine.cfg = cfg;
      lastReloadError = null;
      log.info('[config] reloaded after a change on disk');
    } catch (err) {
      if (err.message !== lastReloadError) log.error(`[config] change NOT applied, still using the previous config: ${err.message}`);
      lastReloadError = err.message;
    }
  };

  await run('tick', () => engine.tick()); // starts the live listeners straight away
  const probeMs = (cfg.settings.watch.probeMinutes || 5) * 60000;
  const timers = [
    setInterval(() => run('tick', () => engine.tick()), 15000),
    setInterval(() => run('minute', async () => {
      reloadIfChanged();
      await engine.minuteTick();
    }), 60000),
    setInterval(() => run('probe', () => engine.probe()), probeMs),
    setInterval(() => run('status', async () => log.info(`[status] ${engine.status()}`)), 3600000),
  ];
  setTimeout(() => run('status', async () => log.info(`[status] ${engine.status()}`)), 120000).unref();

  const shutdown = async (signal) => {
    log.info(`[stop] ${signal} received - shutting down`);
    for (const t of timers) clearInterval(t);
    await run('stop', () => watcher.stop());
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => log.error(`[unhandled] ${err?.stack || err}`));

  log.info(`[start] running: watching ${cfg.settings.watch.windowDays} days ahead, live.`);
}

// Run only when started directly (not when imported by a test).
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    log.error(`[fatal] ${err.message}`);
    process.exit(1);
  });
}
