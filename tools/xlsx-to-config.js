#!/usr/bin/env node
// Turns the Excel setup workbook into the agent's config files:
//   config/settings.json, config/regular-clients.json, config/contacts.json
//   (+ config/schedule-changes.json if the workbook has a "Schedule Changes" sheet)
//
//   npm run config                         reads config/zaria-setup.xlsx
//   npm run config -- path/to/file.xlsx    reads another file
//
// Nothing is written if the workbook has errors. The running agent notices the
// new files within a minute; no restart needed.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import readExcelFile from 'read-excel-file/node';
import { DEFAULT_SETTINGS } from '../src/config.js';
import { convertSheets, toHHMM, toISODate } from '../src/workbook.js';

export { toHHMM, toISODate };

export async function convertWorkbook(file, baseSettings = DEFAULT_SETTINGS) {
  return convertSheets(await readExcelFile(file), baseSettings);
}

async function main() {
  const file = process.argv[2] || path.join('config', 'zaria-setup.xlsx');
  if (!fs.existsSync(file)) {
    console.error(`Workbook not found: ${file}\nCopy the setup workbook to config/zaria-setup.xlsx, or give its path: npm run config -- path/to/file.xlsx`);
    process.exit(1);
  }
  const current = ['config/settings.json', 'config/settings.example.json'].find((f) => fs.existsSync(f));
  const base = current ? JSON.parse(fs.readFileSync(current, 'utf8')) : DEFAULT_SETTINGS;

  const res = await convertWorkbook(file, base);
  console.log(`\nRead ${file}`);
  if (res.settings) {
    const clients = [...new Set(res.regulars.map((r) => r.client))];
    console.log(`  Regular clients: ${res.regulars.length} rows (${clients.join(', ') || 'none'})`);
    console.log(`  Contacts: ${res.contacts.length} numbers - ${res.contacts.filter((x) => x.reminders).length} attendant(s), ${res.contacts.filter((x) => x.admin).length} admin`);
    console.log(`  Channel: ${res.settings.channel}   Watching: ${res.settings.facilities.map((f) => f.name).join(', ')}`);
  }
  if (res.warnings.length) {
    console.log('\nWarnings:');
    for (const w of res.warnings) console.log(`  - ${w}`);
  }
  if (res.errors.length) {
    console.error('\nErrors:');
    for (const e of res.errors) console.error(`  - ${e}`);
    console.error('\nNothing was written. Fix the rows above and run again.\n');
    process.exit(1);
  }
  fs.mkdirSync('config', { recursive: true });
  fs.writeFileSync('config/settings.json', `${JSON.stringify(res.settings, null, 2)}\n`);
  fs.writeFileSync('config/regular-clients.json', `${JSON.stringify(res.regulars, null, 2)}\n`);
  fs.writeFileSync('config/contacts.json', `${JSON.stringify(res.contacts, null, 2)}\n`);
  if (res.changeRows) fs.writeFileSync('config/schedule-changes.json', `${JSON.stringify(res.changeRows, null, 2)}\n`);
  console.log(`\nWrote config/settings.json, config/regular-clients.json, config/contacts.json${res.changeRows ? ', config/schedule-changes.json' : ''}`);
  console.log('A running agent picks this up within a minute.\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
