// PayFast (South Africa): clients pay project milestones, and customers pay the monthly subscription, in rand.
// PayFast sends us a signed "instant transaction notification" (ITN) for every payment. We check it three ways:
// the signature, a confirmation call back to PayFast, and our own records, before we trust it.
const crypto = require('crypto');
const accounts = require('./accounts');

const ID = process.env.PAYFAST_MERCHANT_ID || '';
const KEY = process.env.PAYFAST_MERCHANT_KEY || '';
const PASS = process.env.PAYFAST_PASSPHRASE || '';
const SUB_AMOUNT = +process.env.PAYFAST_SUB_AMOUNT || 0;                       // monthly price in rand
const HOST = (process.env.PAYFAST_HOST || (/^(1|true|yes)$/i.test(process.env.PAYFAST_SANDBOX || '') ? 'https://sandbox.payfast.co.za' : 'https://www.payfast.co.za')).replace(/\/+$/, '');
const SEC = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' };

exports.enabled = () => !!(ID && KEY);
exports.subscriptionsEnabled = () => !!(ID && KEY && PASS && SUB_AMOUNT > 0);

// PayFast wants PHP-style url encoding: spaces as +, hex in capitals, and ! ' ( ) * ~ encoded too.
const enc = v => encodeURIComponent(String(v).trim()).replace(/[!'()*~]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()).replace(/%20/g, '+');
const md5 = s => crypto.createHash('md5').update(s).digest('hex');

// Outgoing form: blank values are left out, and the order of the fields is the order they are sent.
function signForm(pairs) {
  const s = pairs.filter(([, v]) => v !== '' && v != null).map(([k, v]) => k + '=' + enc(v)).join('&') + (PASS ? '&passphrase=' + enc(PASS) : '');
  return md5(s);
}
function build(pairs) {
  const clean = pairs.filter(([, v]) => v !== '' && v != null).map(([k, v]) => [k, String(v)]);
  clean.push(['signature', signForm(pairs)]);
  return { url: HOST + '/eng/process', method: 'POST', fields: Object.fromEntries(clean) };
}
const first = n => String(n || '').trim().split(/\s+/)[0].slice(0, 100);
const merchant = () => [['merchant_id', ID], ['merchant_key', KEY]];

exports.roomForm = (room, base, cents) => build([
  ...merchant(),
  ['return_url', base + '/r?paid=1'], ['cancel_url', base + '/r'], ['notify_url', base + '/api/webhooks/payfast'],
  ['email_address', room.partyEmail || ''],
  ['m_payment_id', ('room-' + room.id + '-' + Date.now()).slice(0, 100)],
  ['amount', (cents / 100).toFixed(2)], ['item_name', String(room.title).slice(0, 100)],
  ['custom_str1', 'room:' + room.id]
]);

exports.subscribeForm = (user, base) => {
  const amt = SUB_AMOUNT.toFixed(2);
  return build([
    ...merchant(),
    ['return_url', base + '/?billing=success'], ['cancel_url', base + '/?billing=cancelled'], ['notify_url', base + '/api/webhooks/payfast'],
    ['name_first', first(user.name)], ['email_address', user.email],
    ['m_payment_id', ('sub-' + user.id + '-' + Date.now()).slice(0, 100)],
    ['amount', amt], ['item_name', 'ScaleDesk monthly plan'],
    ['custom_str1', 'user:' + user.id],
    ['subscription_type', '1'], ['billing_date', new Date().toISOString().slice(0, 10)], ['recurring_amount', amt], ['frequency', '3'], ['cycles', '0']
  ]);
};
// Page where the customer can change the card behind their subscription.
exports.updateUrl = (token, base) => token ? HOST + '/eng/recurring/update/' + encodeURIComponent(token) + '?return=' + encodeURIComponent(base + '/') : '';

let roomPaid = () => false;
exports.onRoomPaid = f => { roomPaid = f; };

const send = (res, code, obj) => { res.writeHead(code, Object.assign({ 'Content-Type': 'application/json' }, SEC)); res.end(JSON.stringify(obj)); };
const readBody = (req, max) => new Promise((ok, no) => {
  let n = 0; const c = [];
  req.on('data', d => { n += d.length; if (n > max) { no(new Error('too big')); req.destroy(); } else c.push(d); });
  req.on('end', () => ok(Buffer.concat(c).toString('utf8'))); req.on('error', no);
});

async function itn(raw) {
  if (!exports.enabled()) return 404;
  const pairs = [...new URLSearchParams(raw).entries()];
  const got = (pairs.find(([k]) => k === 'signature') || [])[1] || '';
  const body = pairs.filter(([k]) => k !== 'signature');
  const str = body.map(([k, v]) => k + '=' + enc(v)).join('&');
  const want = md5(str + (PASS ? '&passphrase=' + enc(PASS) : ''));
  if (got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) return 401;     // 1. signature
  const d = Object.fromEntries(body);
  if (d.merchant_id !== ID) return 400;
  try {                                                                                                         // 2. ask PayFast to confirm
    const r = await fetch(HOST + '/eng/query/validate', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: str, signal: AbortSignal.timeout(15000) });
    if (!r.ok || (await r.text()).trim() !== 'VALID') return 400;
  } catch (e) { console.error('payfast validate:', e.message); return 503; }                                    // PayFast will try again later
  if (d.payment_status !== 'COMPLETE') return 200;                                                              // failed or cancelled: nothing to record
  const evt = 'pf:' + d.pf_payment_id;
  if (!d.pf_payment_id || accounts.seenEvent(evt)) return 200;                                                  // repeat message
  const tag = String(d.custom_str1 || '');
  if (tag.startsWith('room:')) { if (!(+d.amount_gross > 0) || !roomPaid(tag.slice(5), +d.amount_gross, 'pf-' + d.pf_payment_id, 'ZAR')) return 200; }
  else if (tag.startsWith('user:')) accounts.payfastPaid(tag.slice(5), d.token || '');
  accounts.markEvent(evt);
  return 200;
}

exports.handle = (req, res, u) => {
  if (u.pathname !== '/api/webhooks/payfast') return false;
  (async () => {
    if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
    const code = await itn(await readBody(req, 20000));
    res.writeHead(code, SEC); res.end(code === 200 ? 'OK' : '');
  })().catch(e => { console.error('payfast:', e.message); if (!res.headersSent) { res.writeHead(500); res.end(); } });
  return true;
};
