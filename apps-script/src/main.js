// Google Apps Script version of the Zaria Court booking agent - free to run.
//
// Every 5 minutes, on Google's servers: read Ticqet, let the same engine as the
// Node agent decide what is new, due or wrong, and send email through the
// Google account that owns the script. Settings, contacts and the booking log
// live in the Google Sheet the script belongs to.
//
// Entry points (called by the global functions at the end of the built Code.gs):
//   setup()          once: creates the tabs and the 5-minute timer
//   runAgent()       every 5 minutes, and from the menu "Check Ticqet now"
//   sendTestEmail()  from the menu
//   onOpen()         adds the "Zaria Agent" menu to the sheet

import { Engine } from '../../src/engine.js';
import { convertSheets } from '../../src/workbook.js';
import { DEFAULT_SETTINGS, withDefaults, cleanRegulars, cleanContacts, recipients, channelName } from '../../src/config.js';
import { dateWindow, nowInZone, isoDate } from '../../src/time.js';
import * as fmt from '../../src/formatter.js';
import * as store from './store.js';
import { Props } from './props.js';
import { TicqetRest } from './source.js';
import { createEmailSender, createPreviewSender } from './sender.js';
import * as sheets from './sheets.js';
import { log, recent } from './logger.js';

/* global __ZARIA_DEFAULTS__ */
// Filled in at build time from the local config: regular clients, and contact
// names, roles and ticks (never phone numbers). Used only to pre-fill new tabs.
const PREFILL = typeof __ZARIA_DEFAULTS__ !== 'undefined' ? __ZARIA_DEFAULTS__ : { regulars: [], contacts: [] };

// Here the agent runs every 5 minutes instead of continuously, so it alerts on
// the first sighting of a change (no settle wait), lets reminders go out up to
// 10 minutes late, and stays under a free Google account's 100 emails a day.
export const BASE_SETTINGS = withDefaults({
  ...DEFAULT_SETTINGS,
  watch: { ...DEFAULT_SETTINGS.watch, settleSeconds: 0 },
  reminderToleranceMinutes: 10,
  maxMessagesPerDay: 90,
});

const FOOTER = 'Automatic message from the Zaria Court booking system, which checks Ticqet every 5 minutes.';

const ready = (c) => ({ settings: withDefaults(c.settings), regulars: cleanRegulars(c.regulars), contacts: cleanContacts(c.contacts) });

// The config from the sheet - or, if the sheet has mistakes, the last good one,
// so a typo never stops the alerts.
function loadConfig(ss, props) {
  const res = convertSheets(sheets.readConfigSheets(ss), BASE_SETTINGS);
  if (!res.errors.length) {
    props.set('lastGoodConfig', { settings: res.settings, regulars: res.regulars, contacts: res.contacts });
    return { cfg: ready(res), errors: [], warnings: res.warnings };
  }
  const last = props.get('lastGoodConfig', null);
  if (!last) throw new Error(`The sheet has mistakes and there are no earlier good settings to use: ${res.errors.join(' ')}`);
  return { cfg: ready(last), errors: res.errors, warnings: res.warnings };
}

function makeSender(cfg, previewItems) {
  const admin = cfg.contacts.find((c) => c.admin && c.email);
  const footer = admin ? `${FOOTER} Reply to this email to reach ${admin.name || 'the admin'}.` : FOOTER;
  if (cfg.settings.channel === 'email') {
    return createEmailSender({ mail: MailApp, settings: cfg.settings, footer, replyTo: admin ? admin.email : null });
  }
  if (cfg.settings.channel === 'preview') {
    return createPreviewSender({ settings: cfg.settings, footer, record: (m) => previewItems.push(m) });
  }
  throw new Error(`Channel "${channelName(cfg.settings.channel)}" only works in the server version. Use Preview or Email.`);
}

// Tell the admin once about new mistakes in the sheet.
async function reportConfigErrors(cfg, sender, errors, runtime) {
  if (!errors.length) {
    runtime.configErrorsSent = null;
    return;
  }
  for (const e of errors) log.warn(`[config] ${e}`);
  const key = errors.join('|');
  if (runtime.configErrorsSent === key) return;
  runtime.configErrorsSent = key;
  for (const to of recipients(cfg, 'admin')) await sender.send({ to, text: fmt.configProblem(errors), kind: 'config-error' });
}

function statusRows({ cfg, runtime, props, configErrors, warnings, failure }) {
  const day = cfg ? isoDate(nowInZone(cfg.settings.timezone)) : '';
  const messages = props.get('jobs', {})[`sent|${day}`] || 0;
  let left = '?';
  try {
    left = MailApp.getRemainingDailyQuota();
  } catch { /* not authorised yet */ }
  const ticqet = runtime.errorSince
    ? `NOT READABLE since ${sheets.kigaliStamp(runtime.errorSince)}: ${runtime.lastError || 'unknown error'}`
    : runtime.lastContactAt ? `OK - last read ${sheets.kigaliStamp(runtime.lastContactAt)}` : 'Not read yet';
  const errorsThisRun = recent.filter((r) => r.level === 'ERROR').map((r) => r.text);
  return [
    ['Last check', sheets.kigaliStamp(new Date())],
    ['Ticqet', ticqet],
    ['Channel', !cfg ? '?' : cfg.settings.channel === 'email' ? 'Email - sending for real' : 'Preview - nothing is sent (see the Preview tab)'],
    ['Watching', cfg ? `${cfg.settings.court.name}, the next ${cfg.settings.watch.windowDays} days` : '?'],
    ['Messages today', String(messages)],
    ['Emails this Google account can still send today', String(left)],
    ['Mistakes in the sheet', configErrors.length ? configErrors.join('\n') : 'None'],
    ['Things to check', warnings.length ? warnings.join('\n') : 'None'],
    ['Errors in the last check', failure ? failure.message : errorsThisRun.length ? errorsThisRun.join('\n') : 'None'],
  ];
}

export async function runAgent() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    log.warn('[run] the previous check is still running - skipped this one');
    return;
  }
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const props = new Props(PropertiesService.getScriptProperties());
  const runtime = props.get('runtime', {}); // Ticqet health + engine state between runs
  const previewItems = [];
  let cfg = null;
  let source = null;
  let configErrors = [];
  let warnings = [];
  let failure = null;
  recent.length = 0;
  store.begin(props);
  try {
    runtime.firstRunAt = runtime.firstRunAt || Date.now();
    ({ cfg, errors: configErrors, warnings } = loadConfig(ss, props));
    // Older sheets: split "Attendant reminders" into Reminder 1 and Reminder 2
    // (same ticks in both, so this run's config is unchanged).
    if (sheets.upgradeContacts(ss, cfg.settings)) log.info('[setup] Contacts: reminders now have one column each');
    const sender = makeSender(cfg, previewItems);
    await reportConfigErrors(cfg, sender, configErrors, runtime);

    const labels = dateWindow(nowInZone(cfg.settings.timezone), cfg.settings.watch.windowDays).map((d) => d.label);
    source = new TicqetRest({ settings: cfg.settings, http: UrlFetchApp, state: runtime });
    source.load(labels);

    const engine = new Engine({ cfg, source, sender });
    engine.startedAt = runtime.firstRunAt;
    engine.pending = new Map(runtime.pending || []);
    engine.silence = runtime.silence || { alerted: false, since: null };
    await engine.tick();
    await engine.minuteTick();
    runtime.pending = [...engine.pending];
    runtime.silence = engine.silence;
  } catch (err) {
    failure = err;
    log.error(`[run] ${err.stack || err.message}`);
  } finally {
    const safely = (what, fn) => {
      try {
        fn();
      } catch (e) {
        log.error(`[run] could not ${what}: ${e.message}`);
      }
    };
    safely('write the Bookings Log', () => sheets.appendBookingLog(ss, store.takeBookingLog(), source ? source.createTimes : new Map(), cfg));
    safely('write the Preview tab', () => sheets.appendPreview(ss, previewItems));
    props.set('runtime', runtime);
    safely('save the agent\'s memory', () => props.flush());
    safely('update the Status tab', () => sheets.writeStatus(ss, statusRows({ cfg, runtime, props, configErrors, warnings, failure })));
    lock.releaseLock();
  }
}

export async function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone('Africa/Kigali');
  try {
    ss.setSpreadsheetLocale('en_GB'); // dates day-first, as in Rwanda
  } catch { /* keep the current locale */ }
  const created = sheets.setupTabs(ss, { ...PREFILL, settings: BASE_SETTINGS });
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === 'runAgent') ScriptApp.deleteTrigger(t);
  }
  ScriptApp.newTrigger('runAgent').timeBased().everyMinutes(5).create();
  await runAgent(); // first read: existing bookings are recorded, not announced
  const made = created.length ? `Created the tabs: ${created.join(', ')}. ` : '';
  log.info(`[setup] ${made}Checking Ticqet every 5 minutes.`);
  ss.toast(`${made}The agent now checks Ticqet every 5 minutes. Next: add everyone's email on the Contacts tab.`, 'Zaria Agent', 20);
}

export async function sendTestEmail() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const props = new Props(PropertiesService.getScriptProperties());
  const { cfg } = loadConfig(ss, props);
  props.flush();
  let me = '';
  try {
    me = Session.getActiveUser().getEmail();
  } catch { /* not available */ }
  const admins = recipients({ ...cfg, settings: { ...cfg.settings, channel: 'email' } }, 'admin');
  const to = [...new Set([...admins, me].filter(Boolean))];
  const sender = createEmailSender({ mail: MailApp, settings: cfg.settings, footer: FOOTER });
  const results = [];
  for (const addr of to) {
    const r = await sender.send({ to: addr, text: fmt.testMessage('email'), kind: 'test' });
    results.push(`${addr}: ${r.ok ? 'sent' : `FAILED - ${r.error}`}`);
  }
  const msg = results.length ? results.join('\n') : 'No address found: add your email on the Contacts tab and tick Admin alerts.';
  log.info(`[test] ${msg}`);
  ss.toast(msg, 'Zaria Agent - test email', 20);
}

export function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Zaria Agent')
    .addItem('Check Ticqet now', 'runAgent')
    .addItem('Send me a test email', 'sendTestEmail')
    .addSeparator()
    .addItem('Set up / repair', 'setup')
    .addToUi();
}
