#!/usr/bin/env node
// Sends one short test message through the configured channel, to check that
// the token works and a phone can be reached. Ignores quiet hours.
//
//   npm run send-test -- 0788123456    one number
//   npm run send-test -- admin         the admin number(s)
//   npm run send-test -- all           everyone on the Contacts sheet

import { loadEnv, loadConfig, recipients, normalizePhone, channelName } from '../src/config.js';
import { makeSender } from '../src/senders/index.js';
import { testMessage } from '../src/formatter.js';

const target = process.argv[2];
if (!target) {
  console.error('Usage: npm run send-test -- <0788123456 | admin | all>');
  process.exit(1);
}

const env = loadEnv();
const cfg = loadConfig();
const sender = makeSender(cfg.settings, env);
let numbers;
if (target === 'all') numbers = recipients(cfg, 'everyone');
else if (target === 'admin') numbers = recipients(cfg, 'admin');
else numbers = [normalizePhone(target)];
if (!numbers.length) {
  console.error(`No numbers found for "${target}". Check the Contacts sheet and run "npm run config".`);
  process.exit(1);
}

console.log(`Sending a test via ${sender.describe()} to ${numbers.length} number(s)...`);
let failed = 0;
for (const to of numbers) {
  const r = await sender.send({ to, text: testMessage(channelName(cfg.settings.channel)), kind: 'test' });
  console.log(`  ${to}: ${r.ok ? 'OK' : `FAILED - ${r.error}`}`);
  if (!r.ok) failed += 1;
}
process.exit(failed ? 1 : 0);
