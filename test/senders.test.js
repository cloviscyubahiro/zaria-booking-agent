import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ZARIA_QUIET = '1';
process.env.ZARIA_DATA_DIR = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'zaria-senders-'));
const { createWhatsAppCloudSender, toTemplateParams, DEFAULT_API_VERSION } = await import('../src/senders/whatsapp-cloud.js');
const { createPindoSender, smsSegments, nonGsmChars } = await import('../src/senders/pindo.js');
const { makeSender } = await import('../src/senders/index.js');

const noSleep = async () => {};
function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts, body: JSON.parse(opts.body) });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (r instanceof Error) throw r;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  };
  fn.calls = calls;
  return fn;
}
const MSG = 'ZARIA COURT: New booking\nMulti-Purpose Court\nThu 1 Oct, 5:00-7:00 PM (2 hrs)';

test('WhatsApp: message becomes two one-line template variables', () => {
  assert.deepEqual(toTemplateParams(MSG), ['New booking', 'Multi-Purpose Court | Thu 1 Oct, 5:00-7:00 PM (2 hrs)']);
  const [title, details] = toTemplateParams('ZARIA COURT: X\nline\twith tab\nfive     spaces');
  assert.equal(title, 'X');
  assert.doesNotMatch(details, /[\n\t]| {4,}/, 'WhatsApp forbids newlines, tabs and 4+ spaces in variables');
});

test('WhatsApp: correct API call with the approved template', async () => {
  const fetchImpl = fakeFetch([{ status: 200, body: { messages: [{ id: 'wamid.1' }] } }]);
  const s = createWhatsAppCloudSender({ token: 'tok', phoneNumberId: '1234', templateName: 'zaria_court_update', templateLang: 'en', fetchImpl, sleep: noSleep });
  const r = await s.send({ to: '+250780000001', text: MSG, kind: 'new-booking' });
  assert.equal(r.ok, true);
  const call = fetchImpl.calls[0];
  assert.equal(call.url, `https://graph.facebook.com/${DEFAULT_API_VERSION}/1234/messages`);
  assert.equal(DEFAULT_API_VERSION, 'v25.0', 'v20.0 was retired by Meta on 24 Sep 2026');
  assert.equal(call.opts.headers.Authorization, 'Bearer tok');
  assert.equal(call.body.to, '250780000001');
  assert.equal(call.body.type, 'template');
  assert.equal(call.body.template.name, 'zaria_court_update');
  assert.deepEqual(call.body.template.components[0].parameters.map((p) => p.text), ['New booking', 'Multi-Purpose Court | Thu 1 Oct, 5:00-7:00 PM (2 hrs)']);
});

test('WhatsApp: an expired token is reported once with a plain-English hint (no retries)', async () => {
  const fetchImpl = fakeFetch([{ status: 401, body: { error: { code: 190, message: 'Error validating access token' } } }]);
  const s = createWhatsAppCloudSender({ token: 'old', phoneNumberId: '1', templateName: 't', fetchImpl, sleep: noSleep });
  const r = await s.send({ to: '+250780000001', text: MSG });
  assert.equal(r.ok, false);
  assert.equal(fetchImpl.calls.length, 1);
  assert.match(r.error, /Meta error 190/);
  assert.match(r.error, /permanent System User token/);
});

test('WhatsApp: a server error is retried, then succeeds', async () => {
  const fetchImpl = fakeFetch([{ status: 503, body: {} }, { status: 200, body: { messages: [{ id: 'w2' }] } }]);
  const s = createWhatsAppCloudSender({ token: 't', phoneNumberId: '1', templateName: 't', fetchImpl, sleep: noSleep });
  assert.equal((await s.send({ to: '+250780000001', text: MSG })).ok, true);
  assert.equal(fetchImpl.calls.length, 2);
});

test('WhatsApp: network failure gives up after 3 tries without throwing', async () => {
  const fetchImpl = fakeFetch([new Error('ECONNRESET')]);
  const s = createWhatsAppCloudSender({ token: 't', phoneNumberId: '1', templateName: 't', fetchImpl, sleep: noSleep });
  const r = await s.send({ to: '+250780000001', text: MSG });
  assert.equal(r.ok, false);
  assert.equal(fetchImpl.calls.length, 3);
});

test('SMS (Pindo): correct call, and a bad token is not retried', async () => {
  const ok = fakeFetch([{ status: 201, body: { sms_id: 7, total_cost: 0.011, remaining_balance: 4.9 } }]);
  const s = createPindoSender({ token: 'p', senderName: 'ZariaCourt', fetchImpl: ok, sleep: noSleep });
  assert.equal((await s.send({ to: '+250780000001', text: MSG })).ok, true);
  assert.equal(ok.calls[0].url, 'https://api.pindo.io/v1/sms/');
  assert.deepEqual(ok.calls[0].body, { to: '+250780000001', text: MSG, sender: 'ZariaCourt' });
  const bad = fakeFetch([{ status: 401, body: { message: 'Unauthorized' } }]);
  const s2 = createPindoSender({ token: 'x', senderName: 'ZariaCourt', fetchImpl: bad, sleep: noSleep });
  const r = await s2.send({ to: '+250780000001', text: MSG });
  assert.equal(r.ok, false);
  assert.equal(bad.calls.length, 1);
  assert.match(r.error, /PINDO_TOKEN/);
});

test('SMS: plain messages stay in one segment; special characters are detected', () => {
  assert.equal(smsSegments(MSG), 1);
  assert.deepEqual(nonGsmChars('5–7 PM ⚽'), ['–', '⚽']);
  assert.equal(smsSegments('x'.repeat(161)), 2);
});

test('makeSender: channel names and helpful errors', () => {
  assert.equal(makeSender({ channel: 'preview' }, {}).name, 'preview');
  assert.equal(makeSender({ channel: 'whatsapp' }, { WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: '1' }).name, 'whatsapp-cloud');
  assert.equal(makeSender({ channel: 'SMS', smsSenderName: 'ZariaCourt' }, { PINDO_TOKEN: 'p' }).name, 'pindo');
  assert.throws(() => makeSender({ channel: 'whatsapp' }, {}), /WHATSAPP_TOKEN/);
  assert.throws(() => makeSender({ channel: 'sms' }, {}), /PINDO_TOKEN/);
});
