// "preview" sender: sends nothing. It writes each message the agent WOULD send
// to the console and to data/outbox-preview.log, so you can watch the agent run
// against real Ticqet bookings at zero cost before switching a channel on.

import fs from 'node:fs';
import path from 'node:path';
import { log, mask, dataDir } from '../logger.js';

export function createPreviewSender() {
  return {
    name: 'preview',
    describe: () => 'PREVIEW - nothing is sent; messages are written to data/outbox-preview.log',
    async send({ to, text, kind }) {
      log.info(`[preview] would send ${kind || 'message'} to ${mask(to)}`);
      try {
        const file = path.join(dataDir(), 'outbox-preview.log');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, `----- ${new Date().toISOString()} [${kind || 'message'}] to ${to}\n${text}\n\n`);
      } catch { /* ignore */ }
      return { ok: true, preview: true };
    },
  };
}
