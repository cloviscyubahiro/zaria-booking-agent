// Turns an agent message (formatter.js: a "ZARIA COURT: <title>" line, then
// detail lines) into an email. The subject carries the key fact, so the phone
// notification alone tells the story; the body repeats the message in a
// simple layout that reads well on a phone.

import { HEAD } from './formatter.js';

// Messages that list several things: their subject is just the title.
const LIST_KINDS = new Set([
  'daily', 'weekly', 'overnight', 'bookings-digest', 'admin-overnight', 'open-regular-slots',
  'regular-slot-check', 'welcome', 'test', 'config-error', 'umuganda', 'facilities-added',
]);

const NAVY = '#093254'; // Zaria Court navy, as on the setup workbook headers
const GREY = '#5b6475';

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function toEmail(text, { kind = '', courtName = '', footer = 'Automatic message from the Zaria Court booking system.' } = {}) {
  const lines = String(text).split('\n').map((s) => s.trim()).filter(Boolean);
  const title = (lines.shift() || 'Update').replace(new RegExp(`^${HEAD}:\\s*`, 'i'), '') || 'Update';
  const key = lines.find((l) => l !== courtName);
  const subject = LIST_KINDS.has(kind) || !key ? title : `${title}: ${key.replace(/[.:]$/, '')}`;

  const textBody = [title, ...lines, '', '--', footer].join('\n');
  const para = (l) => {
    const bold = /:$/.test(l) ? 'font-weight:bold;margin-top:12px;' : '';
    return `<p style="margin:0 0 4px;${bold}">${esc(l)}</p>`;
  };
  const html = [
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#1d2433;max-width:560px">`,
    `<p style="margin:0 0 2px;font-size:12px;letter-spacing:0.06em;text-transform:uppercase;color:${GREY}">Zaria Court</p>`,
    `<p style="margin:0 0 12px;font-size:22px;line-height:1.25;font-weight:bold;color:${NAVY}">${esc(title)}</p>`,
    ...lines.map(para),
    `<p style="margin:24px 0 0;padding-top:8px;border-top:1px solid #e3e6ec;font-size:12px;color:${GREY}">${esc(footer)}</p>`,
    '</div>',
  ].join('\n');

  return { subject: subject.length > 140 ? `${subject.slice(0, 137)}...` : subject, text: textBody, html };
}
