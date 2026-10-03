// PayPal checkout for project payments in other currencies. The client pays on PayPal's own page
// (PayPal balance or card), so no card details reach this server. We create the order, send the client to
// PayPal, and when they come back we ask PayPal directly what happened before recording anything.
const accounts = require('./accounts');
const ID = process.env.PAYPAL_CLIENT_ID || '';
const SECRET = process.env.PAYPAL_CLIENT_SECRET || '';
const BASE = (process.env.PAYPAL_API_BASE || (/^(1|true|yes)$/i.test(process.env.PAYPAL_SANDBOX || '') ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com')).replace(/\/+$/, '');
// Currencies PayPal can charge that ScaleDesk offers. PayPal does not take rand or dirham.
const CUR = ['USD', 'EUR', 'GBP', 'AUD', 'CAD', 'NZD', 'SGD', 'HKD', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN'];
exports.enabled = () => !!(ID && SECRET);
exports.currencies = CUR;

let tok = { v: '', exp: 0 };
async function token() {
  if (tok.v && tok.exp > Date.now() + 30000) return tok.v;
  const r = await fetch(BASE + '/v1/oauth2/token', { method: 'POST', signal: AbortSignal.timeout(20000),
    headers: { Authorization: 'Basic ' + Buffer.from(ID + ':' + SECRET).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error('PayPal sign-in failed (' + r.status + ')');
  tok = { v: d.access_token, exp: Date.now() + (d.expires_in || 300) * 1000 };
  return tok.v;
}
async function pp(path, method, body) {
  const r = await fetch(BASE + path, { method, signal: AbortSignal.timeout(20000),
    headers: { Authorization: 'Bearer ' + await token(), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('PayPal ' + path.split('/').slice(0, 4).join('/') + ' returned ' + r.status + (d.message ? ': ' + d.message : ''));
  return d;
}

exports.roomCheckout = async (room, base, cents) => {
  const o = await pp('/v2/checkout/orders', 'POST', {
    intent: 'CAPTURE',
    purchase_units: [{ reference_id: room.id, custom_id: 'room:' + room.id, description: String(room.title).slice(0, 120),
      amount: { currency_code: room.currency, value: (cents / 100).toFixed(2) } }],
    payment_source: { paypal: { experience_context: { brand_name: String(room.ownerLabel || 'ScaleDesk').slice(0, 120), user_action: 'PAY_NOW',
      shipping_preference: 'NO_SHIPPING', return_url: base + '/api/paypal/return?room=' + room.id, cancel_url: base + '/r' } } }
  });
  const link = (o.links || []).find(l => l.rel === 'payer-action' || l.rel === 'approve');
  if (!link) throw new Error('PayPal gave no payment link');
  return link.href;
};

let roomPaid = () => false;
exports.onRoomPaid = f => { roomPaid = f; };
const hits = new Map();
setInterval(() => hits.clear(), 3600000);

async function back(req, res, u) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'x';
  const n = (hits.get(ip) || 0) + 1; hits.set(ip, n);
  const base = (process.env.PUBLIC_URL || '').replace(/\/+$/, '') || ((req.headers['x-forwarded-proto'] || 'http').split(',')[0] + '://' + req.headers.host);
  const go = q => { res.writeHead(302, { Location: base + '/r' + q, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); res.end(); };
  const room = /^\w{1,40}$/.test(u.searchParams.get('room') || '') ? u.searchParams.get('room') : '', order = /^[\w-]{5,40}$/.test(u.searchParams.get('token') || '') ? u.searchParams.get('token') : '';
  if (!room || !order || n > 40 || !exports.enabled()) return go('');
  try {
    let o = await pp('/v2/checkout/orders/' + order, 'GET');
    const unit = (o.purchase_units || [])[0] || {};
    if (unit.custom_id !== 'room:' + room) return go('');                       // this order is not for this room
    if (o.status === 'APPROVED') o = await pp('/v2/checkout/orders/' + order + '/capture', 'POST', {});
    const caps = (((o.purchase_units || [])[0] || {}).payments || {}).captures || [];
    let done = false;
    for (const c of caps) if (c.status === 'COMPLETED' && c.amount && +c.amount.value > 0) done = roomPaid(room, +c.amount.value, 'pp-' + c.id, c.amount.currency_code) || done;
    return go(done || o.status === 'COMPLETED' ? '?paid=1' : '');
  } catch (e) { console.error('paypal return:', e.message); return go(''); }
}
exports.handle = (req, res, u) => {
  if (u.pathname !== '/api/paypal/return' || req.method !== 'GET') return false;
  back(req, res, u).catch(e => { console.error('paypal:', e.message); if (!res.headersSent) { res.writeHead(500); res.end(); } });
  return true;
};
