// WhatsApp through Meta's OFFICIAL WhatsApp Cloud API.
//
// A business can only start a WhatsApp conversation with an APPROVED message
// template. This agent uses one "Utility" template with two variables:
//
//   Zaria Court update: *{{1}}*
//   Details: {{2}}
//   This is an automatic message from the Zaria Court booking system.
//
// {{1}} gets the message title ("New booking"), {{2}} the details on one line.
// WhatsApp does not allow line breaks inside a variable, so the lines of each
// message are joined with " | ". See README > "WhatsApp setup".
//
// Needs in .env: WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID,
// WHATSAPP_TEMPLATE_NAME, WHATSAPP_TEMPLATE_LANG (and optionally WHATSAPP_API_VERSION).

import { log, mask } from '../logger.js';
import { postJson } from './http.js';

// Graph API v25.0 is supported by Meta until July 2028.
export const DEFAULT_API_VERSION = 'v25.0';

// Plain-English help for the errors you are most likely to meet while setting up.
const HINTS = {
  190: 'The access token is invalid or expired. Temporary tokens last 24 hours: create a permanent System User token (README, WhatsApp setup).',
  131030: 'This number is not on the test number\'s allowed list. Add it in Meta > WhatsApp > API Setup, or switch to your real business number.',
  131026: 'Could not be delivered. Is this number on WhatsApp?',
  131042: 'Payment problem on the WhatsApp Business Account. Add or fix the payment method in Meta Business settings.',
  131056: 'Too many messages to this number in a short time. Meta will accept more shortly.',
  132000: 'The template must have exactly two variables, {{1}} and {{2}}. Check it in WhatsApp Manager.',
  132001: 'Template not found or not approved for this language. Check WHATSAPP_TEMPLATE_NAME / WHATSAPP_TEMPLATE_LANG in .env and the template status in WhatsApp Manager.',
  132018: 'WhatsApp refused the template values (line breaks or long spaces). Please report this as a bug.',
  133010: 'The business phone number is not registered with the Cloud API yet.',
};

// Turn a multi-line agent message into the template's two variables.
export function toTemplateParams(text) {
  const lines = String(text).split('\n').map((s) => s.trim()).filter(Boolean);
  const clean = (s) => s.replace(/[\t\r\n]+/g, ' ').replace(/ {4,}/g, ' ').trim();
  const title = clean((lines.shift() || 'Update').replace(/^ZARIA COURT:\s*/i, '')).slice(0, 60) || 'Update';
  let details = clean(lines.join(' | ')) || '-';
  if (details.length > 900) details = `${details.slice(0, 897)}...`;
  return [title, details];
}

export function createWhatsAppCloudSender({ token, phoneNumberId, templateName, templateLang, apiVersion, fetchImpl, sleep }) {
  if (!token || !phoneNumberId) {
    throw new Error('WhatsApp channel: set WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID in .env (see README, WhatsApp setup).');
  }
  if (!templateName) throw new Error('WhatsApp channel: set WHATSAPP_TEMPLATE_NAME in .env.');
  const version = apiVersion || DEFAULT_API_VERSION;
  const url = `https://graph.facebook.com/${version}/${phoneNumberId}/messages`;

  return {
    name: 'whatsapp-cloud',
    describe: () => `WhatsApp Cloud API (template "${templateName}", ${version})`,
    async send({ to, text, kind }) {
      const [title, details] = toTemplateParams(text);
      const body = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: String(to).replace(/^\+/, ''),
        type: 'template',
        template: {
          name: templateName,
          language: { code: templateLang || 'en' },
          components: [{ type: 'body', parameters: [{ type: 'text', text: title }, { type: 'text', text: details }] }],
        },
      };
      const r = await postJson({ url, headers: { Authorization: `Bearer ${token}` }, body, fetchImpl, sleep });
      if (r.ok) {
        log.info(`[whatsapp] sent ${kind || 'message'} to ${mask(to)} (id ${r.data.messages?.[0]?.id ?? '?'})`);
        return { ok: true, id: r.data.messages?.[0]?.id };
      }
      const e = r.data?.error || {};
      const code = e.code ?? r.status;
      const hint = HINTS[code] || HINTS[e.error_subcode] || '';
      const error = `Meta error ${code}: ${e.error_user_msg || e.message || 'unknown'}${hint ? ` -> ${hint}` : ''}`;
      log.error(`[whatsapp] ${kind || 'message'} to ${mask(to)} failed. ${error}`);
      return { ok: false, error };
    },
  };
}
