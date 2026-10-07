// Senders for the Apps Script version. The engine only calls
// send({ to, text, kind }) -> { ok }, once per recipient.
//
//   email    sends through the Google account that runs the script (MailApp)
//   preview  sends nothing; each email is recorded for the "Preview" sheet

import { toEmail } from '../../src/email.js';
import { log, mask } from './logger.js';

export function createEmailSender({ mail, settings, footer, replyTo = null }) {
  return {
    name: 'email',
    describe: () => 'Email (Gmail)',
    async send({ to, text, kind }) {
      try {
        if (mail.getRemainingDailyQuota() < 1) {
          return { ok: false, error: 'the Google account\'s daily email limit is used up - email resumes tomorrow' };
        }
        const e = toEmail(text, { kind, courtName: settings.court && settings.court.name, footer });
        const message = { to, subject: e.subject, body: e.text, htmlBody: e.html, name: settings.emailSenderName || 'Zaria Court Bookings' };
        if (replyTo && replyTo !== to) message.replyTo = replyTo;
        mail.sendEmail(message);
        log.info(`[email] sent ${kind || 'message'} to ${mask(to)}`);
        return { ok: true };
      } catch (err) {
        log.error(`[email] ${kind || 'message'} to ${mask(to)} failed: ${err.message}`);
        return { ok: false, error: err.message };
      }
    },
  };
}

export function createPreviewSender({ settings, footer, record }) {
  return {
    name: 'preview',
    describe: () => 'PREVIEW - nothing is sent; emails are written to the Preview sheet',
    async send({ to, text, kind }) {
      const e = toEmail(text, { kind, courtName: settings.court && settings.court.name, footer });
      record({ to, kind: kind || 'message', subject: e.subject, text: e.text });
      return { ok: true, preview: true };
    },
  };
}
