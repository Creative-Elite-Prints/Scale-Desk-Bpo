// Accounts for people you sell ScaleDesk to: sign up, sign in, free trial, monthly subscription.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const mailer = require('./mailer');

const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const HOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET || '';
const TRIAL_DAYS = process.env.TRIAL_DAYS === undefined ? 7 : Math.max(0, +process.env.TRIAL_DAYS || 0);  // 0 = you unlock each account by hand
const OWNERS = (process.env.OWNER_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
const PRICE_TEXT = process.env.PLAN_PRICE_TEXT || '';
const SUBSCRIBE_URL = /^https:\/\//i.test(process.env.SUBSCRIBE_URL || '') ? process.env.SUBSCRIBE_URL : '';
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || '';
const DAY = 86400000, SESSION_DAYS = 180, MAX_DATA = 900000;
const SEC = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' };

fs.mkdirSync(DATA, { recursive: true });
const DBF = path.join(DATA, 'accounts.json');
let db = { users: {}, sessions: {}, invites: {} };
const persist = require('./persist');
db = Object.assign(db, persist.load(DBF, {}));
const save = () => { persist.write(DBF, db); persist.touch('accounts.json'); };

const now = () => Date.now();
const sha = x => crypto.createHash('sha256').update(String(x)).digest('hex');
const same = (a, b) => crypto.timingSafeEqual(Buffer.from(sha(a)), Buffer.from(sha(b)));
const clip = (s, n) => String(s || '').trim().slice(0, n);
const normEmail = s => String(s || '').normalize('NFKC').replace(/[\u200b-\u200d\ufeff]/g, '').trim().toLowerCase().slice(0, 120);
const scrypt = (pw, salt) => new Promise((ok, no) => crypto.scrypt(pw, salt, 64, (e, k) => e ? no(e) : ok(k.toString('hex'))));

// ---- Plan rules ----
function access(u) {
  if (OWNERS.includes(u.email)) return 'owner';
  if (u.blocked) return 'blocked';
  if ((u.paidUntil || 0) > now()) return 'active';
  if ((u.trialUntil || 0) > now()) return 'trial';
  return 'expired';
}
const isActive = a => a === 'owner' || a === 'active' || a === 'trial';
const baseOf = req => (process.env.PUBLIC_URL || '').replace(/\/+$/, '') || ((req.headers['x-forwarded-proto'] || 'http').split(',')[0] + '://' + req.headers.host);
// The /admin page is only served to a browser holding this cookie, and only owners are given it.
const cookieFor = (req, token, on) => 'sd_admin=' + (on ? token : '') + '; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=' + (on ? 365 * 86400 : 0) +
  (((req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https') ? '; Secure' : '');
const giveCookie = (req, res, u, token) => { if (u && OWNERS.includes(u.email)) res.setHeader('Set-Cookie', cookieFor(req, token, true)); };
const BIZ = process.env.BUSINESS_NAME || 'Scale Desk';
// Talent counters live on the account itself (not in the browser data), so they are backed up to Upstash with everything else.
const talentStats = u => { const t = u.talent || {}; return { outreach: Object.keys(t.out || {}).length, outreachTotal: t.outTotal || 0, saved: Object.keys(t.saved || {}).length, savedTotal: t.savedTotal || 0 }; };
const pub = u => ({ id: u.id, email: u.email, name: u.name, business: u.business, access: access(u), verified: !!u.verified || OWNERS.includes(u.email),
  trialUntil: u.trialUntil || 0, paidUntil: u.paidUntil || 0, createdAt: u.createdAt, talent: talentStats(u) });

// ---- Sessions ----
function newSession(uid) {
  const t = crypto.randomBytes(32).toString('base64url');
  const u = db.users[uid], days = u && OWNERS.includes(u.email) ? 365 : SESSION_DAYS;
  db.sessions[sha(t)] = { uid, exp: now() + days * DAY };
  save(); return t;
}
function userFrom(req) {
  const t = req.headers['x-session'];
  if (!t) return null;
  const s = db.sessions[sha(t)];
  if (!s || s.exp < now()) return null;
  const u = db.users[s.uid];
  if (!u) return null;
  const a = access(u);
  return { user: u, access: a, active: isActive(a) };
}
const tickets = new Map();
function consumeTicket(t) {
  const e = tickets.get(t); tickets.delete(t);
  return !!e && e.exp > now();
}
setInterval(() => { for (const [k, v] of tickets) if (v.exp < now()) tickets.delete(k); for (const [k, s] of Object.entries(db.sessions)) if (s.exp < now()) delete db.sessions[k]; }, 600000);

// ---- Abuse limits ----
const marks = new Map();
const count = (k, ms) => (marks.get(k) || []).filter(t => now() - t < ms).length;
const mark = k => marks.set(k, (marks.get(k) || []).filter(t => now() - t < 3600000).concat(now()));
setInterval(() => marks.clear(), 3600000);

// ---- HTTP helpers ----
const send = (res, code, obj) => { res.writeHead(code, Object.assign({ 'Content-Type': 'application/json' }, SEC)); res.end(JSON.stringify(obj)); };
function readBody(req, max) {
  return new Promise((ok, no) => {
    let n = 0; const c = [];
    req.on('data', d => { n += d.length; if (n > max) { no(new Error('too big')); req.destroy(); } else c.push(d); });
    req.on('end', () => ok(Buffer.concat(c).toString('utf8')));
    req.on('error', no);
  });
}
const json = async (req, max = 20000) => { try { return JSON.parse((await readBody(req, max)) || '{}'); } catch (e) { return null; } };

async function run(req, res, u) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'x';
  const p = u.pathname, m = req.method;

  if (p === '/api/plan' && m === 'GET') {
    return send(res, 200, { price: PRICE_TEXT, trialDays: TRIAL_DAYS, subscribeUrl: SUBSCRIBE_URL, support: SUPPORT_EMAIL, billing: billingOn(), providers: providersOn(), email: mailer.enabled(), ai: !!process.env.ANTHROPIC_API_KEY });
  }

  if (p === '/api/auth/signup' && m === 'POST') {
    if (count('su' + ip, 3600000) >= 10) return send(res, 429, { error: 'Too many sign-ups from this address. Try later.' });
    const d = await json(req);
    const email = normEmail(d && d.email), pw = String((d && d.password) || '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return send(res, 400, { error: 'Enter a valid email address' });
    if (pw.length < 8 || pw.length > 200) return send(res, 400, { error: 'Password must be at least 8 characters' });
    if (!clip(d.name, 80)) return send(res, 400, { error: 'Enter your name' });
    if (d.terms !== true) return send(res, 400, { error: 'Please accept the Terms and the Privacy Policy' });
    if (Object.values(db.users).some(x => normEmail(x.email) === email)) return send(res, 409, { error: 'An account with this email already exists. Sign in instead.' });
    mark('su' + ip);
    let days = TRIAL_DAYS;
    const code = clip(d.code, 20).toUpperCase();
    if (code) {
      const inv = db.invites[code];
      if (!inv || inv.uses < 1) return send(res, 400, { error: 'That invite code is not valid' });
      inv.uses -= 1; days = inv.days;
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const id = crypto.randomBytes(6).toString('hex');
    db.users[id] = { id, email, name: clip(d.name, 80), business: clip(d.business, 80), salt, hash: await scrypt(pw, salt),
      createdAt: now(), trialUntil: days > 0 ? now() + days * DAY : 0, paidUntil: 0, refs: [], data: {} };
    save();
    sendVerify(db.users[id], baseOf(req));
    const tk0 = newSession(id); giveCookie(req, res, db.users[id], tk0);
    return send(res, 201, { token: tk0, user: pub(db.users[id]) });
  }

  if (p === '/api/auth/login' && m === 'POST') {
    const d = await json(req), email = normEmail(d && d.email), key = 'lf' + ip + email;
    if (count(key, 600000) >= 8 || count('lf' + ip, 600000) >= 20) return send(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
    const us = Object.values(db.users).find(x => normEmail(x.email) === email);
    const good = us && crypto.timingSafeEqual(Buffer.from(await scrypt(String((d && d.password) || ''), us.salt), 'hex'), Buffer.from(us.hash, 'hex'));
    if (!good) { mark(key); mark('lf' + ip); return send(res, 401, { error: 'Wrong email or password' }); }
    const tk1 = newSession(us.id); giveCookie(req, res, us, tk1);
    return send(res, 200, { token: tk1, user: pub(us) });
  }

  // Email confirmation: soft (people can start straight away), but the link proves the address is theirs.
  if (p === '/api/auth/verify' && m === 'GET') {
    const m2 = /^(\w+)\.([\w-]+)$/.exec(u.searchParams.get('token') || ''), us = m2 && db.users[m2[1]];
    const ok = !!us && !!us.vhash && us.vhash.length === sha(m2[2]).length && crypto.timingSafeEqual(Buffer.from(us.vhash), Buffer.from(sha(m2[2])));
    if (ok) { us.verified = true; us.vhash = ''; save(); }
    res.writeHead(200, Object.assign({ 'Content-Type': 'text/html; charset=utf-8' }, SEC));
    return res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Email confirmation</title><body style="font:18px system-ui;max-width:520px;margin:60px auto;padding:0 20px"><h1>' +
      (ok ? 'Email confirmed' : 'This link is not valid') + '</h1><p>' + (ok ? 'Thank you. You can close this page and go back to ' + BIZ + '.' : 'It may have been used already. Sign in and press "Send confirmation again".') + '</p><p><a href="/">Open ' + BIZ + '</a></p>');
  }
  if (p === '/api/auth/resend' && m === 'POST') {
    const s = userFrom(req); if (!s) return send(res, 401, { error: 'Please sign in' });
    if (s.user.verified) return send(res, 200, { ok: true, already: true });
    if (count('rs' + s.user.id, 3600000) >= 3) return send(res, 429, { error: 'Please wait before asking again' });
    mark('rs' + s.user.id);
    if (!mailer.enabled()) return send(res, 503, { error: 'Email sending is not set up on this server' });
    sendVerify(s.user, baseOf(req)); return send(res, 200, { ok: true });
  }

  // Forgot password: always answers the same way, so nobody can use it to find out who has an account.
  if (p === '/api/auth/forgot' && m === 'POST') {
    const d = await json(req), email = normEmail(d && d.email);
    if (count('fp' + ip, 3600000) >= 5 || count('fp' + email, 3600000) >= 3) return send(res, 429, { error: 'Too many requests. Try again later.' });
    mark('fp' + ip); mark('fp' + email);
    const us = Object.values(db.users).find(x => normEmail(x.email) === email);
    if (us && mailer.enabled()) {
      const sec = crypto.randomBytes(24).toString('base64url');
      us.reset = { h: sha(sec), exp: now() + 3600000 }; save();
      mailer.send({ to: us.email, subject: 'Reset your ' + BIZ + ' password', text: 'Someone asked to reset the password for your ' + BIZ + ' account.\n\nOpen this link within one hour to choose a new password:\n' +
        baseOf(req) + '/?reset=' + us.id + '.' + sec + '\n\nIf this was not you, ignore this email. Your password stays the same.' }).catch(e => console.error('reset mail:', e.message));
    }
    return send(res, 200, { ok: true });
  }
  if (p === '/api/auth/reset' && m === 'POST') {
    const d = await json(req), m2 = /^(\w+)\.([\w-]+)$/.exec(clip(d && d.token, 120)), pw = String((d && d.password) || '');
    if (count('rt' + ip, 600000) >= 10) return send(res, 429, { error: 'Too many attempts. Try again later.' });
    mark('rt' + ip);
    if (pw.length < 8 || pw.length > 200) return send(res, 400, { error: 'Password must be at least 8 characters' });
    const us = m2 && db.users[m2[1]], h = m2 && sha(m2[2]);
    if (!us || !us.reset || us.reset.exp < now() || us.reset.h.length !== h.length || !crypto.timingSafeEqual(Buffer.from(us.reset.h), Buffer.from(h)))
      return send(res, 400, { error: 'This reset link is not valid or has expired. Ask for a new one.' });
    us.salt = crypto.randomBytes(16).toString('hex'); us.hash = await scrypt(pw, us.salt); us.reset = null; us.verified = true;
    for (const [k, s2] of Object.entries(db.sessions)) if (s2.uid === us.id) delete db.sessions[k];
    save(); const tk2 = newSession(us.id); giveCookie(req, res, us, tk2);
    return send(res, 200, { token: tk2, user: pub(us) });
  }

  if (p === '/api/auth/logout' && m === 'POST') {
    const t = req.headers['x-session']; if (t) { delete db.sessions[sha(t)]; save(); }
    res.setHeader('Set-Cookie', cookieFor(req, '', false));
    return send(res, 200, { ok: true });
  }

  if (p === '/api/me' && m === 'GET') {
    const s = userFrom(req);
    if (!s) return send(res, 401, { error: 'Please sign in' });
    const ss = db.sessions[sha(req.headers['x-session'])], keep = (OWNERS.includes(s.user.email) ? 365 : SESSION_DAYS) * DAY;
    if (ss && ss.exp - now() < keep - DAY) { ss.exp = now() + keep; save(); }
    giveCookie(req, res, s.user, req.headers['x-session']);   // stay signed in while you keep using it
    return send(res, 200, { user: pub(s.user), data: s.active ? s.user.data : null, stats: s.user.stats || { outreach: 0, saved: Math.max(0, ((s.user.data && s.user.data.team) || []).length) },
      plan: { price: PRICE_TEXT, subscribeUrl: SUBSCRIBE_URL, support: SUPPORT_EMAIL, billing: billingOn(), providers: providersOn(), email: mailer.enabled(), ai: !!process.env.ANTHROPIC_API_KEY, storage: s.access === 'owner' ? persist.status().mode : undefined } });
  }
  if (p === '/api/me/data' && m === 'PUT') {
    const s = userFrom(req);
    if (!s) return send(res, 401, { error: 'Please sign in' });
    if (!s.active) return send(res, 402, { error: 'Your plan is not active' });
    const raw = await readBody(req, MAX_DATA + 1000).catch(() => null);
    if (raw === null || raw.length > MAX_DATA) return send(res, 413, { error: 'Too much data' });
    let d; try { d = JSON.parse(raw); } catch (e) { return send(res, 400, { error: 'Bad JSON' }); }
    s.user.data = d; save(); return send(res, 200, { ok: true });
  }
  // Talent counters (active outreach, saved talent). Kept on the account, so they are backed up to Upstash with everything else.
  if (p === '/api/me/talent' && m === 'POST') {
    const s = userFrom(req);
    if (!s) return send(res, 401, { error: 'Please sign in' });
    if (!s.active) return send(res, 402, { error: 'Your plan is not active' });
    const d = await json(req), id = clip(d && d.id, 40), type = d && d.type;
    if (!id || !['message', 'save', 'unsave'].includes(type)) return send(res, 400, { error: 'Bad request' });
    const t = s.user.talent = s.user.talent || { out: {}, saved: {}, outTotal: 0, savedTotal: 0 };
    if (type === 'message') { t.outTotal = (t.outTotal || 0) + 1; if (Object.keys(t.out).length < 2000) t.out[id] = now(); }
    else if (type === 'save') { if (!t.saved[id]) { t.savedTotal = (t.savedTotal || 0) + 1; if (Object.keys(t.saved).length < 2000) t.saved[id] = now(); } }
    else delete t.saved[id];
    save();
    return send(res, 200, talentStats(s.user));
  }
  if (p === '/api/stream-ticket' && m === 'GET') {
    const s = userFrom(req);
    if (!s || !s.active) return send(res, s ? 402 : 401, { error: s ? 'Your plan is not active' : 'Please sign in' });
    const t = crypto.randomBytes(18).toString('base64url');
    tickets.set(t, { exp: now() + 30000 });
    return send(res, 200, { ticket: t });
  }

  // Subscription payments confirmed by your payment tool, signed with PAYMENT_WEBHOOK_SECRET.
  if (p === '/api/webhooks/subscription' && m === 'POST') {
    if (!HOOK_SECRET) return send(res, 404, { error: 'Not enabled' });
    const raw = await readBody(req, 20000);
    const want = crypto.createHmac('sha256', HOOK_SECRET).update(raw).digest('hex'), got = String(req.headers['x-signature'] || '');
    if (got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) return send(res, 401, { error: 'Bad signature' });
    let d; try { d = JSON.parse(raw); } catch (e) { return send(res, 400, { error: 'Bad JSON' }); }
    const us = Object.values(db.users).find(x => normEmail(x.email) === normEmail(d.email));
    if (!us) return send(res, 404, { error: 'No account with that email' });
    const ref = clip(d.reference, 80);
    if (!ref) return send(res, 400, { error: 'Reference is required' });
    if (us.refs.includes(ref)) return send(res, 200, { ok: true, duplicate: true });
    const months = Math.min(12, Math.max(1, Math.round(+d.months || 1)));
    us.paidUntil = Math.max(now(), us.paidUntil || 0) + months * 30 * DAY; us.refs.push(ref); save();
    return send(res, 200, { ok: true, paidUntil: us.paidUntil });
  }

  // ---- Owner tools (ADMIN_KEY) ----
  if (p.startsWith('/api/admin/')) {
    const ak = req.headers['x-admin-key'], os = ak ? null : userFrom(req);
    if (count('af' + ip, 600000) >= 15) return send(res, 429, { error: 'Too many attempts' });
    const isOwnerSession = !!(os && os.access === 'owner');
    if (!isOwnerSession && (!ak || !ADMIN_KEY || !same(ak, ADMIN_KEY))) { mark('af' + ip); return send(res, 401, { error: 'Not authorised' }); }
    if (p === '/api/admin/users' && m === 'GET') return send(res, 200, Object.values(db.users).map(pub));
    if (p === '/api/admin/stats' && m === 'GET') {
      const us = Object.values(db.users), price = +process.env.MRR_PRICE || 19, cnt = a => us.filter(x => access(x) === a).length;
      const paid = cnt('active');
      return send(res, 200, { mrr: Math.round(paid * price * 100) / 100, price, currency: (process.env.MRR_CURRENCY || 'USD').toUpperCase().slice(0, 3), paid, trial: cnt('trial'), expired: cnt('expired'), total: us.length });
    }
    if (p === '/api/admin/invites' && m === 'GET') return send(res, 200, db.invites);
    if (p === '/api/admin/invites' && m === 'POST') {
      const d = (await json(req)) || {}, code = crypto.randomBytes(4).toString('hex').toUpperCase();
      db.invites[code] = { days: Math.min(365, Math.max(1, +d.days || 14)), uses: Math.min(1000, Math.max(1, +d.uses || 1)) };
      save(); return send(res, 201, { code, invite: db.invites[code] });
    }
    const mm = /^\/api\/admin\/users\/(\w+)\/(\w+)$/.exec(p);
    if (mm && m === 'POST') {
      const us = db.users[mm[1]]; if (!us) return send(res, 404, { error: 'No such account' });
      const d = (await json(req)) || {};
      if (mm[2] === 'grant') us.trialUntil = Math.max(now(), us.trialUntil || 0) + Math.min(365, Math.max(1, +d.days || 7)) * DAY;
      else if (mm[2] === 'settrial') { const n = Math.min(365, Math.max(0, Math.round(+d.days || 0))); us.trialUntil = n ? now() + n * DAY : 0; }
      else if (mm[2] === 'paid') us.paidUntil = Math.max(now(), us.paidUntil || 0) + Math.min(12, Math.max(1, Math.round(+d.months || 1))) * 30 * DAY;
      else if (mm[2] === 'cancel') { us.paidUntil = 0; us.trialUntil = 0; }
      else if (mm[2] === 'block') us.blocked = !!d.blocked;
      else if (mm[2] === 'password') {
        const pw = String(d.password || ''); if (pw.length < 8) return send(res, 400, { error: 'Password must be at least 8 characters' });
        us.salt = crypto.randomBytes(16).toString('hex'); us.hash = await scrypt(pw, us.salt);
        for (const [k, s] of Object.entries(db.sessions)) if (s.uid === us.id) delete db.sessions[k];
      } else if (mm[2] === 'delete') {
        delete db.users[us.id]; for (const [k, s] of Object.entries(db.sessions)) if (s.uid === us.id) delete db.sessions[k];
      } else return send(res, 404, { error: 'Not found' });
      save(); return send(res, 200, { ok: true, user: db.users[us.id] ? pub(us) : null });
    }
  }
  return send(res, 404, { error: 'Not found' });
}

function sendVerify(us, base) {
  if (!mailer.enabled()) return;
  const sec = crypto.randomBytes(24).toString('base64url');
  us.vhash = sha(sec); save();
  mailer.send({ to: us.email, subject: 'Confirm your email for ' + BIZ, text: 'Welcome to ' + BIZ + '.\n\nPlease confirm this is your email address:\n' + base + '/api/auth/verify?token=' + us.id + '.' + sec + '\n\nYou can already use the app while you wait.' })
    .catch(e => console.error('verify mail:', e.message));
}
let billingOn = () => false;
let providersOn = () => [];
exports.setProviders = f => { providersOn = f; };
exports.setBilling = f => { billingOn = f; };
exports.seenEvent = id => (db.events || []).includes(id);
exports.markEvent = id => { db.events = (db.events || []).concat(id).slice(-500); save(); };
exports.stripeLink = (uid, customer, sub) => {
  const u = db.users[uid]; if (!u) return false;
  u.stripeCustomer = customer; u.stripeSub = sub; save(); return true;
};
exports.payfastPaid = (uid, token) => {
  const u = db.users[uid]; if (!u) return false;
  if (token) u.payfastToken = token;
  const n = now();
  u.paidUntil = (u.paidUntil || 0) > n ? u.paidUntil + 30 * DAY : n + 32 * DAY;   // a month, with 2 days of grace when starting or restarting
  save(); return true;
};
exports.getUser = uid => db.users[uid] || null;
exports.allUsers = () => Object.values(db.users);
exports.activeUser = u => isActive(access(u));
exports.saveProfile = (uid, prof) => { if (db.users[uid]) { db.users[uid].profile = prof; save(); } };
exports.stripePaid = (customer, email, endMs) => {
  const u = Object.values(db.users).find(x => (customer && x.stripeCustomer === customer) || (email && normEmail(x.email) === normEmail(email)));
  if (!u) return false;
  if (customer && !u.stripeCustomer) u.stripeCustomer = customer;
  u.paidUntil = Math.max(u.paidUntil || 0, (endMs || now() + 30 * DAY) + 2 * DAY); save(); return true;   // 2 days of grace
};
exports.userFrom = userFrom;
// True only for a signed-in OWNER (OWNER_EMAILS). Used to gate the /admin page itself.
exports.isOwnerCookie = req => {
  const m = /(?:^|;\s*)sd_admin=([\w-]{20,80})/.exec(req.headers.cookie || '');
  const s = m && userFrom({ headers: { 'x-session': m[1] } });
  return !!(s && s.access === 'owner');
};
exports.consumeTicket = consumeTicket;
exports.handle = (req, res, u) => {
  const p = u.pathname;
  if (!(p === '/api/plan' || p.startsWith('/api/auth/') || p === '/api/me' || p === '/api/me/data' || p === '/api/me/talent' || p === '/api/stream-ticket' ||
        p === '/api/webhooks/subscription' || p.startsWith('/api/admin/'))) return false;
  run(req, res, u).catch(e => { console.error('accounts:', e.message); if (!res.headersSent) send(res, 500, { error: 'Server error' }); });
  return true;
};
