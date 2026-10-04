// SMS through Pindo (https://pindo.io), a Rwandan SMS provider.
// Needs PINDO_TOKEN in .env. The sender name (e.g. "ZariaCourt") must be
// approved in your Pindo account; until it is, use "PindoTest".

import { log, mask } from '../logger.js';
import { postJson } from './http.js';

const URL = 'https://api.pindo.io/v1/sms/';

// Characters outside the basic GSM-7 set push an SMS into 70-character
// segments, which costs more. The formatter avoids them; this is a safety net.
const GSM7 = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
export function nonGsmChars(text) {
  return [...new Set([...String(text)].filter((ch) => !GSM7.includes(ch)))];
}

// Rough count of SMS parts a text will be billed as.
export function smsSegments(text) {
  const n = [...String(text)].length;
  if (nonGsmChars(text).length) return n <= 70 ? 1 : Math.ceil(n / 67);
  return n <= 160 ? 1 : Math.ceil(n / 153);
}

export function createPindoSender({ token, senderName, fetchImpl, sleep }) {
  if (!token) throw new Error('SMS channel: set PINDO_TOKEN in .env (see README, SMS setup).');
  const sender = senderName || 'PindoTest';

  return {
    name: 'pindo',
    describe: () => `SMS via Pindo as "${sender}"`,
    async send({ to, text, kind }) {
      const odd = nonGsmChars(text);
      if (odd.length) log.warn(`[sms] message has special characters ${JSON.stringify(odd)} - it may cost extra`);
      const r = await postJson({ url: URL, headers: { Authorization: `Bearer ${token}` }, body: { to, text, sender }, fetchImpl, sleep });
      if (r.ok) {
        log.info(`[sms] sent ${kind || 'message'} to ${mask(to)} (${smsSegments(text)} part(s), cost ${r.data.total_cost ?? '?'}, balance ${r.data.remaining_balance ?? '?'})`);
        return { ok: true, id: r.data.sms_id };
      }
      const detail = r.data?.message || r.data?.error?.message || JSON.stringify(r.data);
      const hint = r.status === 401 || r.status === 403 ? ' -> check PINDO_TOKEN' : ' -> check the number, the sender name and your Pindo balance';
      const error = `HTTP ${r.status} ${detail}${hint}`;
      log.error(`[sms] ${kind || 'message'} to ${mask(to)} failed: ${error}`);
      return { ok: false, error };
    },
  };
}
