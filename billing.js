// Card payments through Stripe Checkout: your monthly subscription, and clients paying for projects.
// Card details are typed on Stripe's own page and never reach this server.
const crypto = require('crypto');
const accounts = require('./accounts');
const payfast = require('./payfast');
const paypal = require('./paypal');

const KEY = process.env.STRIPE_SECRET_KEY || '';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const PRICE = process.env.STRIPE_PRICE_ID || '';
const API = process.env.STRIPE_API_BASE || 'https://api.stripe.com';
const SEC = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' };

exports.enabled = () => !!KEY;
exports.stripeSubscriptions = () => !!(KEY && PRICE);
exports.subscriptionsEnabled = () => !!(KEY && PRICE) || payfast.subscriptionsEnabled();
exports.providers = () => [].concat(exports.stripeSubscriptions() ? ['stripe'] : [], payfast.subscriptionsEnabled() ? ['payfast'] : []);
exports.baseUrl = req => (process.env.PUBLIC_URL || '').replace(/\/+$/, '') ||
  ((req.headers['x-forwarded-proto'] || 'http').split(',')[0] + '://' + req.headers.host);

let roomPaid = () => false;
exports.onRoomPaid = f => { roomPaid = f; payfast.onRoomPaid(f); paypal.onRoomPaid(f); };

async function stripe(path, params) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) body.append(k, String(v));
  const r = await fetch(API + path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
    body, signal: AbortSignal.timeout(20000)
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d.error && d.error.message) || 'Stripe returned ' + r.status);
  return d;
}

exports.subscribeUrl = async (user, base) => {
  const p = { mode: 'subscription', 'line_items[0][price]': PRICE, 'line_items[0][quantity]': 1,
    client_reference_id: user.id, success_url: base + '/?billing=success', cancel_url: base + '/?billing=cancelled' };
  if (user.stripeCustomer) p.customer = user.stripeCustomer; else p.customer_email = user.email;
  return (await stripe('/v1/checkout/sessions', p)).url;
};
exports.portalUrl = async (user, base) => {
  if (!user.stripeCustomer) throw new Error('No billing account yet');
  return (await stripe('/v1/billing_portal/sessions', { customer: user.stripeCustomer, return_url: base + '/' })).url;
};
exports.projectCheckout = async (room, base, due) => {
  const cents = due || room.amountCents - room.paidCents;
  return (await stripe('/v1/checkout/sessions', {
    mode: 'payment', 'line_items[0][price_data][currency]': room.currency.toLowerCase(),
    'line_items[0][price_data][unit_amount]': cents,
    'line_items[0][price_data][product_data][name]': room.title.slice(0, 120),
    'line_items[0][quantity]': 1, 'metadata[roomId]': room.id,
    success_url: base + '/r?paid=1', cancel_url: base + '/r'
  })).url;
};

// Stripe signs every message it sends. Reject anything old or not signed with your secret.
function verify(raw, header) {
  const items = String(header || '').split(',').map(x => x.split('='));
  const t = (items.find(i => i[0] === 't') || [])[1];
  const sigs = items.filter(i => i[0] === 'v1').map(i => i[1] || '');
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - (+t)) > 300) return false;
  const want = crypto.createHmac('sha256', WEBHOOK_SECRET).update(t + '.' + raw).digest('hex');
  return sigs.some(s => s.length === want.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(want)));
}

async function webhook(raw, sig) {
  if (!WEBHOOK_SECRET) return 404;
  if (!verify(raw, sig)) return 401;
  let ev; try { ev = JSON.parse(raw); } catch (e) { return 400; }
  if (accounts.seenEvent(ev.id)) return 200;
  const o = (ev.data && ev.data.object) || {};
  if (ev.type === 'checkout.session.completed') {
    if (o.mode === 'subscription') accounts.stripeLink(o.client_reference_id, o.customer, o.subscription);
    else if (o.mode === 'payment' && o.payment_status === 'paid' && o.metadata && o.metadata.roomId) roomPaid(o.metadata.roomId, o.amount_total / 100, o.id);
  } else if (ev.type === 'invoice.paid') {
    const line = o.lines && o.lines.data && o.lines.data[0];
    accounts.stripePaid(o.customer, o.customer_email, line && line.period && line.period.end ? line.period.end * 1000 : 0);
  }
  accounts.markEvent(ev.id);
  return 200;
}

const send = (res, code, obj) => { res.writeHead(code, Object.assign({ 'Content-Type': 'application/json' }, SEC)); res.end(JSON.stringify(obj)); };
const readBody = (req, max) => new Promise((ok, no) => {
  let n = 0; const c = [];
  req.on('data', d => { n += d.length; if (n > max) { no(new Error('too big')); req.destroy(); } else c.push(d); });
  req.on('end', () => ok(Buffer.concat(c).toString('utf8'))); req.on('error', no);
});

exports.handle = (req, res, u) => {
  const p = u.pathname;
  if (p !== '/api/billing/subscribe' && p !== '/api/billing/portal' && p !== '/api/webhooks/stripe') return false;
  (async () => {
    if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
    if (p === '/api/webhooks/stripe') {
      const code = await webhook(await readBody(req, 100000), req.headers['stripe-signature']);
      return send(res, code, { ok: code === 200 });
    }
    const s = accounts.userFrom(req);
    if (!s) return send(res, 401, { error: 'Please sign in' });
    if (!exports.subscriptionsEnabled()) return send(res, 503, { error: 'Card payments are not set up yet' });
    let body = {}; try { body = JSON.parse((await readBody(req, 2000)) || '{}'); } catch (e) { /* no body */ }
    const provs = exports.providers(), prov = provs.includes(body.provider) ? body.provider : provs[0];
    try {
      if (p === '/api/billing/subscribe') {
        if (prov === 'payfast') return send(res, 200, payfast.subscribeForm(s.user, exports.baseUrl(req)));
        return send(res, 200, { url: await exports.subscribeUrl(s.user, exports.baseUrl(req)) });
      }
      if (!s.user.stripeCustomer && s.user.payfastToken) return send(res, 200, { url: payfast.updateUrl(s.user.payfastToken, exports.baseUrl(req)) });
      const url = await exports.portalUrl(s.user, exports.baseUrl(req));
      return send(res, 200, { url });
    } catch (e) { console.error('billing:', e.message); return send(res, 502, { error: p.endsWith('portal') ? e.message : 'Could not start checkout' }); }
  })().catch(e => { console.error('billing:', e.message); if (!res.headersSent) send(res, 500, { error: 'Server error' }); });
  return true;
};
