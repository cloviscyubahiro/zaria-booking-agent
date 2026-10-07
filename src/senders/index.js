// Picks the sender for settings.channel. The rest of the agent only ever calls
// sender.send({ to, text, kind }), so switching between WhatsApp, SMS and
// preview is a one-word change in the Settings sheet.

import { createPreviewSender } from './preview.js';
import { createPindoSender } from './pindo.js';
import { createWhatsAppCloudSender } from './whatsapp-cloud.js';
import { normalizeChannel } from '../config.js';

export function makeSender(settings, env = process.env) {
  const channel = normalizeChannel(settings.channel);
  if (channel === 'whatsapp-cloud') {
    return createWhatsAppCloudSender({
      token: env.WHATSAPP_TOKEN,
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
      templateName: env.WHATSAPP_TEMPLATE_NAME || 'zaria_court_update',
      templateLang: env.WHATSAPP_TEMPLATE_LANG || 'en',
      apiVersion: env.WHATSAPP_API_VERSION,
    });
  }
  if (channel === 'pindo') {
    return createPindoSender({ token: env.PINDO_TOKEN, senderName: settings.smsSenderName });
  }
  if (channel === 'email') {
    throw new Error('Email alerts are sent by the Google Apps Script version of the agent (README > "Email alerts, free"). Set Channel to preview, WhatsApp or SMS to run it here.');
  }
  return createPreviewSender();
}
