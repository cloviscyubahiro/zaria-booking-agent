#!/usr/bin/env node
// Builds the Google Apps Script version into ONE file to paste into the
// script editor:  npm run build:apps-script  ->  apps-script/dist/Code.gs
//
// It bundles the shared agent code (src/) with the Apps Script parts
// (apps-script/src/), swapping the Node-only modules (files, logging) for their
// Apps Script versions. New tabs are pre-filled from the local config:
// regular clients, contact names, roles, emails and ticks - never phone
// numbers - and schedule changes. Because of those names and emails, dist/ is
// not committed to git.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHARED = path.join(root, 'src').toLowerCase() + path.sep;
const GAS = path.join(root, 'apps-script', 'src');
export const OUTFILE = path.join(root, 'apps-script', 'dist', 'Code.gs');

const BANNER = `/**
 * Zaria Court booking alerts - Google Apps Script version.
 * Built from the zaria-booking-agent repository (npm run build:apps-script).
 * Do not edit here: change the source, rebuild, and paste the new file.
 * @OnlyCurrentDoc
 */`;

// The functions Apps Script can see: the Run menu, the timer and the sheet menu.
const FOOTER = `
/** Run this once after pasting: creates the tabs and the 5-minute timer. */
function setup() { return ZariaAgent.setup(); }

/** Runs every 5 minutes (set up by setup): reads Ticqet and sends what is due. */
function runAgent() { return ZariaAgent.runAgent(); }

/** Sends a test email to you and to the admin on the Contacts tab. */
function sendTestEmail() { return ZariaAgent.sendTestEmail(); }

/** Adds the "Zaria Agent" menu when the sheet is opened. */
function onOpen(e) { return ZariaAgent.onOpen(e); }
`;

// Regular clients, contacts (names, roles, emails, ticks) and schedule changes
// from the local config.
export function localDefaults(dir = path.join(root, 'config')) {
  const read = (f) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch {
      return null;
    }
  };
  const regulars = read('regular-clients.json') || read('regular-clients.example.json') || [];
  const contacts = (read('contacts.json') || []).map((c) => ({
    name: c.name || '', role: c.role || '', email: c.email || '',
    alerts: !!c.alerts, summaries: !!c.summaries, reminders: !!c.reminders, admin: !!c.admin,
    ...(c.reminder1 !== undefined ? { reminder1: !!c.reminder1, reminder2: !!c.reminder2 } : {}),
  }));
  const settings = read('settings.json') || {};
  if (!contacts.some((c) => c.admin)) {
    const name = settings.adminName && settings.adminName !== 'the admin' ? settings.adminName : '';
    contacts.push({ name, role: 'Admin', alerts: false, summaries: false, reminders: false, admin: true });
  }
  const changes = (read('schedule-changes.json') || []).map((c) => ({
    date: c.date || '', facility: c.facility || '', client: c.client || '',
    newTime: c.newTime || '', reason: c.reason || '', email: !!c.email,
  }));
  return { regulars, contacts, changes };
}

const swapNodeModules = {
  name: 'apps-script-swaps',
  setup(build) {
    // src/store.js and src/logger.js use files: use the Apps Script versions.
    build.onResolve({ filter: /^\.\/(store|logger)\.js$/ }, (args) => (
      path.resolve(args.importer).toLowerCase().startsWith(SHARED) ? { path: path.join(GAS, path.basename(args.path)) } : undefined
    ));
    // node:fs / node:path are imported by shared modules but never used here.
    build.onResolve({ filter: /^node:/ }, (args) => ({ path: args.path, namespace: 'node-stub' }));
    build.onLoad({ filter: /.*/, namespace: 'node-stub' }, () => ({ contents: 'export default {};', loader: 'js' }));
  },
};

export async function buildAppsScript({ defaults = localDefaults(), outfile = OUTFILE, write = true } = {}) {
  const result = await esbuild.build({
    entryPoints: [path.join(GAS, 'main.js')],
    bundle: true,
    format: 'iife',
    globalName: 'ZariaAgent',
    platform: 'neutral',
    target: 'es2019',
    charset: 'utf8',
    legalComments: 'none',
    define: { __ZARIA_DEFAULTS__: JSON.stringify(defaults) },
    banner: { js: BANNER },
    footer: { js: FOOTER },
    plugins: [swapNodeModules],
    write: false,
    logLevel: 'silent',
  });
  const code = result.outputFiles[0].text;
  if (write) {
    fs.mkdirSync(path.dirname(outfile), { recursive: true });
    fs.writeFileSync(outfile, code);
  }
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const defaults = localDefaults();
  const code = await buildAppsScript({ defaults });
  console.log(`Built ${path.relative(root, OUTFILE)} (${Math.round(code.length / 1024)} KB)`);
  const withEmail = defaults.contacts.filter((c) => c.email).length;
  const places = [...new Set(defaults.regulars.map((r) => r.facility))].join(', ');
  console.log(`  pre-fill: ${defaults.regulars.length} regular client rows (${places}), ${defaults.contacts.length} contacts (${withEmail} with email; never phone numbers), ${defaults.changes.length} schedule change(s)`);
  console.log('Paste it into the Apps Script editor (README > "Email alerts, free").');
}
