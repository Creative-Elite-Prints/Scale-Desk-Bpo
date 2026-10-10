// Project rooms: private shared spaces for a client and a developer.
// A room stays open until the client approves AND the full payment is recorded, then it closes.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const accounts = require('./accounts');
const mailer = require('./mailer'), billing = require('./billing'), payfast = require('./payfast'), paypal = require('./paypal');

const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const HOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET || '';
const ROOM_DAYS = +process.env.ROOM_DAYS || 60;                       // room expires if never finished
const DOWNLOAD_DAYS = +process.env.DOWNLOAD_DAYS_AFTER_CLOSE || 7;    // then files are deleted
const MAX_FILE = 7 * 1024 * 1024;
const CURRENCIES = ['USD', 'EUR', 'GBP', 'ZAR', 'AUD', 'CAD', 'NZD', 'SGD', 'HKD', 'AED', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN'];
const EMAIL_LIMIT = +process.env.EMAIL_DAILY_LIMIT || 30;
const sentToday = new Map();
function allowEmail(uid) {
  const k = uid + ':' + new Date().toISOString().slice(0, 10), n = sentToday.get(k) || 0;
  if (n >= EMAIL_LIMIT) return false;
  sentToday.set(k, n + 1); return true;
}
const DAY = 86400000;
const SEC = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' };

fs.mkdirSync(path.join(DATA, 'files'), { recursive: true });
const DBF = path.join(DATA, 'rooms.json');
let db = { rooms: {} };
const persist = require('./persist');
db = persist.load(DBF, db);
const save = () => { persist.write(DBF, db); persist.touch('rooms.json'); };

const now = () => Date.now();
const sha = x => crypto.createHash('sha256').update(String(x)).digest('hex');
const same = (a, b) => crypto.timingSafeEqual(Buffer.from(sha(a)), Buffer.from(sha(b)));
const rid = () => crypto.randomBytes(6).toString('hex');
const secret = () => crypto.randomBytes(24).toString('base64url');
const clip = (s, n) => String(s || '').trim().slice(0, n);

const pages = {
  '/rooms': fs.readFileSync(path.join(__dirname, 'public', 'myrooms.html')),
  '/r': fs.readFileSync(path.join(__dirname, 'public', 'room.html'))
};

// ---- Guessing protection: 15 wrong keys in 10 minutes blocks an address ----
const fails = new Map();
const recent = ip => (fails.get(ip) || []).filter(t => now() - t < 600000);
const blocked = ip => recent(ip).length >= 15;
const fail = ip => fails.set(ip, recent(ip).concat(now()));

// ---- Room rules ----
const payMethods = r => [].concat(billing.enabled() ? ['stripe'] : [], payfast.enabled() && r.currency === 'ZAR' ? ['payfast'] : [], paypal.enabled() && paypal.currencies.includes(r.currency) ? ['paypal'] : []);
const paidFull = r => r.paidCents >= r.amountCents;
// Payments are split into milestones (default 30% start, 40% midpoint, 30% delivery).
// A milestone counts as paid once the total paid reaches its running total, so part and manual payments work too.
const planOf = r => r.plan || [{ label: 'Full payment', pct: 100 }];
function steps(r) {
  let cum = 0; const p = planOf(r);
  return p.map((s, i) => { const cents = i === p.length - 1 ? r.amountCents - cum : Math.round(r.amountCents * s.pct / 100); cum += cents; return { label: s.label, pct: s.pct, cents, cum }; });
}
const releasedN = r => r.plan ? Math.min(r.released || 1, r.plan.length) : 1;
function dueCents(r) { const st = steps(r); return Math.max(0, st[releasedN(r) - 1].cum - r.paidCents); }
const labelsFor = n => n === 1 ? ['Full payment'] : n === 2 ? ['Deposit', 'Delivery'] : n === 3 ? ['Start', 'Midpoint', 'Delivery'] : Array.from({ length: n }, (_, i) => 'Payment ' + (i + 1));
const windowOpen = r => r.status === 'open' || now() < r.closedAt + DOWNLOAD_DAYS * DAY;
function closeRoom(r, why) { r.status = 'closed'; r.closedAt = now(); r.reason = why; r.log.push([now(), 'closed: ' + why]); save(); }
function refresh(r) { if (r.status === 'open' && now() > r.expiresAt) closeRoom(r, 'expired'); }
const WORK = ['pending', 'progress', 'review', 'completed'];
const workOf = r => (r.kind === 'quote' ? '' : (r.work || (r.offer && !r.offer.accepted ? 'pending' : (r.approved && paidFull(r) ? 'completed' : 'progress'))));
function maybeClose(r) {
  if (r.kind !== 'quote' && r.approved && paidFull(r)) r.work = 'completed';
  if (r.status === 'open' && r.approved && paidFull(r)) closeRoom(r, 'approved and paid in full'); else save();
}
function purgeRoom(r) {
  for (const f of r.files) { try { fs.unlinkSync(path.join(DATA, 'files', r.id + '-' + f.id)); } catch (e) { /* already gone */ } }
  r.status = 'purged'; r.files = []; r.messages = []; r.tokens = {}; r.payUrl = '';
  r.log.push([now(), 'files and messages deleted']); save();
}
function pay(r, amount, ref) {
  const n = +amount;
  if (!(n > 0)) return { code: 400, body: { error: 'Amount must be more than zero' } };
  ref = clip(ref, 80) || 'manual-' + rid();
  if (r.payments.some(p => p.ref === ref)) return { code: 200, body: { ok: true, duplicate: true } };
  const cents = Math.round(n * 100);
  r.payments.push({ ref, cents, at: now() }); r.paidCents += cents;
  r.log.push([now(), 'payment ' + (cents / 100).toFixed(2) + ' (' + ref + ')']);
  maybeClose(r);
  return { code: 200, body: { ok: true, paidCents: r.paidCents, status: r.status } };
}
const NOTIFY_GAP = 30 * 60 * 1000;
function notifyAfterMessage(r, role, text, base) {
  if (!mailer.enabled()) return;
  const toOwner = role !== 'owner', key = toOwner ? 'owner' : 'party', to = toOwner ? r.ownerEmail : r.partyEmail;
  r.notified = r.notified || {};
  if (!to || now() - (r.notified[key] || 0) < NOTIFY_GAP || !allowEmail(r.ownerId || 'admin')) return;
  r.notified[key] = now(); save();
  const snippet = text.slice(0, 300), me = r.ownerLabel || 'Scale Desk';
  const subject = 'New message from ' + (toOwner ? label(r, role) : me) + ': ' + r.title;
  const body = toOwner
    ? label(r, role) + ' wrote in "' + r.title + '":\n\n' + snippet + '\n\nOpen ScaleDesk to reply:\n' + base + '/'
    : me + ' sent you a message about "' + r.title + '":\n\n' + snippet + '\n\nTo read and reply, open the private link from the first email or message you received. For your security the link is not repeated here.';
  mailer.send({ to, subject, text: body, replyTo: toOwner ? undefined : (r.ownerEmail || undefined) }).catch(e => console.error('notify:', e.message));
}
const label = (r, role) => role === 'client' ? r.clientName : role === 'developer' ? (r.kind === 'quote' ? r.clientName : 'Developer') : (r.ownerLabel || 'Scale Desk');
const sys = (r, role, body) => r.messages.push({ id: (r.nextMsg = (r.nextMsg || 0) + 1), role, name: label(r, role), body, at: now() });
const canOwn = (a, r) => a.admin || (a.uid && (r.ownerId || 'admin') === a.uid);
function view(r, role) {
  return {
    id: r.id, ownerLabel: r.ownerLabel || '', kind: r.kind || 'project', brief: r.brief || '', quotes: r.quotes || [], title: r.title, clientName: r.clientName, currency: r.currency, role,
    amountCents: r.amountCents, paidCents: r.paidCents, approved: r.approved,
    status: r.status, work: workOf(r), review: r.review || null, canReview: role === 'client' && workOf(r) === 'completed', reason: r.reason || '', expiresAt: r.expiresAt,
    downloadsUntil: r.status === 'closed' ? r.closedAt + DOWNLOAD_DAYS * DAY : 0,
    canApprove: role === 'client' && r.kind !== 'quote' && r.status === 'open' && !r.approved && (!r.offer || r.offer.accepted),
    canAccept: role === 'client' && r.status === 'open' && !!r.offer && !r.offer.accepted,
    canPay: role === 'client' && r.kind !== 'quote' && r.status === 'open' && (!r.offer || r.offer.accepted) && !paidFull(r) && dueCents(r) > 0 && payMethods(r).length > 0,
    payMethods: role === 'client' ? payMethods(r) : [],
    milestones: r.kind === 'quote' ? [] : steps(r).map((s, i) => ({ label: s.label, pct: s.pct, cents: s.cents, status: r.paidCents >= s.cum ? 'paid' : i < releasedN(r) ? 'due' : 'upcoming' })),
    dueCents: r.kind === 'quote' ? 0 : dueCents(r),
    canRelease: role === 'owner' && r.kind !== 'quote' && r.status === 'open' && releasedN(r) < planOf(r).length,
    offer: r.offer || null,
    payUrl: paidFull(r) ? '' : r.payUrl,
    files: r.files.map(f => ({ id: f.id, name: f.name, size: f.size, final: f.final, by: f.by, at: f.at,
      locked: f.final && role === 'client' && !paidFull(r) }))
  };
}

// ---- Who is calling? ----
function who(req, ip, roomId) {
  if (blocked(ip)) return { err: 429 };
  const ak = req.headers['x-admin-key'];
  if (ak) { if (ADMIN_KEY && same(ak, ADMIN_KEY)) return { role: 'owner', admin: true, uid: 'admin', label: 'Scale Desk' }; fail(ip); return { err: 401 }; }
  if (req.headers['x-session']) {
    const s = accounts.userFrom(req);
    if (s && s.active) return { role: 'owner', uid: s.user.id, email: s.user.email, label: s.user.business || s.user.name };
    fail(ip); return { err: 401 };
  }
  const m = /^Bearer (\w+)\.([\w-]+)$/.exec(req.headers.authorization || '');
  if (m) {
    const r = db.rooms[m[1]], h = sha(m[2]);
    if (r && (!roomId || roomId === r.id)) {
      for (const role of ['client', 'developer']) {
        const t = r.tokens[role];
        if (t && t.length === h.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(t))) return { role };
      }
    }
  }
  fail(ip); return { err: 401 };
}

// ---- Small HTTP helpers ----
function send(res, code, obj) { res.writeHead(code, Object.assign({ 'Content-Type': 'application/json' }, SEC)); res.end(JSON.stringify(obj)); }
function readBody(req, max) {
  return new Promise((ok, no) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > max) { no(new Error('too big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', no);
  });
}
const json = async (req, max = 20000) => { try { return JSON.parse((await readBody(req, max)) || '{}'); } catch (e) { return null; } };

async function run(req, res, u) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'x';
  const p = u.pathname, m = req.method;
  if (blocked(ip)) return send(res, 429, { error: 'Too many attempts. Try again later.' });

  // Payment confirmation from your payment provider (or an automation tool), signed with a shared secret.
  if (p === '/api/webhooks/payment' && m === 'POST') {
    if (!HOOK_SECRET) return send(res, 404, { error: 'Not enabled' });
    const raw = await readBody(req, 20000);
    const want = crypto.createHmac('sha256', HOOK_SECRET).update(raw).digest('hex');
    const got = String(req.headers['x-signature'] || '');
    if (got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) { fail(ip); return send(res, 401, { error: 'Bad signature' }); }
    let d; try { d = JSON.parse(raw); } catch (e) { return send(res, 400, { error: 'Bad JSON' }); }
    const r = db.rooms[d.roomId];
    if (!r || r.status === 'purged' || r.kind === 'quote') return send(res, 404, { error: 'Room not found' });
    const out = pay(r, d.amount, d.reference);
    return send(res, out.code, out.body);
  }

  if (p === '/api/rooms') {
    const a = who(req, ip, null);
    if (a.err) return send(res, a.err, { error: 'Not authorised' });
    if (a.role !== 'owner') return send(res, 403, { error: 'Not allowed' });
    if (m === 'GET') {
      return send(res, 200, Object.values(db.rooms).filter(r => r.status !== 'purged' && canOwn(a, r)).map(r => ({
        id: r.id, kind: r.kind || 'project', quotes: (r.quotes || []).length, offer: r.offer ? (r.offer.accepted ? 'accepted' : 'waiting') : '', title: r.title, clientName: r.clientName, status: r.status, reason: r.reason || '', approved: r.approved,
        freelancerId: r.freelancerId || '', parentId: r.parentId || '', delegated: (r.tasks || []).length, work: workOf(r), review: r.review || null, amountCents: r.amountCents, paidCents: r.paidCents, currency: r.currency, expiresAt: r.expiresAt, closedAt: r.closedAt || 0,
        createdAt: r.createdAt, msgCount: r.messages.length, lastMsg: r.messages.length ? r.messages[r.messages.length - 1].body.slice(0, 90) : '',
        lastAt: r.messages.length ? r.messages[r.messages.length - 1].at : r.createdAt,
        lastRole: r.messages.length ? r.messages[r.messages.length - 1].role : '',
        unread: r.messages.filter(x => x.id > (r.ownerSeen || 0) && x.role !== 'owner').length })));
    }
    if (m === 'POST') {
      const d = await json(req), quote = !!d && d.kind === 'quote', amount = quote ? 0 : (d && +d.amount);
      if (!d || !clip(d.title, 120) || !clip(d.clientName, 80) || (!quote && !(amount > 0))) return send(res, 400, { error: quote ? 'Title and freelancer name are required' : 'Title, client name and amount are required' });
      const payUrl = /^https:\/\//i.test(d.payUrl || '') ? clip(d.payUrl, 500) : '';
      const days = Math.min(365, Math.max(1, +d.days || ROOM_DAYS));
      const cur = (clip(d.currency, 3) || 'USD').toUpperCase();
      if (!CURRENCIES.includes(cur)) return send(res, 400, { error: 'Currency not supported. Use one of: ' + CURRENCIES.join(', ') });
      let split = [30, 40, 30];
      if (d.split !== undefined) {
        split = Array.isArray(d.split) ? d.split.map(Number) : [];
        if (split.length < 1 || split.length > 5 || split.some(x => !Number.isInteger(x) || x < 1) || split.reduce((a, b) => a + b, 0) !== 100)
          return send(res, 400, { error: 'Payment split must be whole percentages that add up to 100' });
      }
      const lab = labelsFor(split.length);
      const id = rid(), tk = { client: secret(), developer: secret() };
      db.rooms[id] = {
        id, kind: quote ? 'quote' : 'project', brief: clip(d.brief, 4000), quotes: [], ownerId: a.uid, ownerLabel: a.label,
        title: clip(d.title, 120), clientName: clip(d.clientName, 80), freelancerId: clip(d.freelancerId, 40),
        currency: cur, offer: !quote && d.offer ? { text: clip(d.offerText, 6000), accepted: false } : null, amountCents: Math.round(amount * 100), paidCents: 0, payments: [],
        plan: quote ? undefined : split.map((pct, i) => ({ label: lab[i], pct })), released: 1,
        payUrl, approved: false, status: 'open', createdAt: now(), expiresAt: now() + days * DAY,
        ownerEmail: a.email || '', partyEmail: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clip(d.email, 120)) ? clip(d.email, 120).toLowerCase() : '', ownerSeen: 0, notified: {},
        tokens: { client: sha(tk.client), developer: sha(tk.developer) }, messages: [], files: [], log: [[now(), 'created']]
      };
      save();
      let emailed = false, emailError = '';
      const to = clip(d.email, 120).toLowerCase();
      if (to) {
        const link = billing.baseUrl(req) + '/r#t=' + id + '.' + (quote ? tk.developer : tk.client);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) emailError = 'That email address does not look right';
        else if (!mailer.enabled()) emailError = 'Email sending is not set up on this server';
        else if (!allowEmail(a.uid)) emailError = 'Daily email limit reached';
        else {
          const msg = clip(d.message, 6000) || (quote ? 'You are invited to send a quotation.' : 'I have prepared a proposal for you.');
          const text = (msg.includes('{link}') ? msg.split('{link}').join(link) : msg + '\n\nYour private link:\n' + link) +
            '\n\n--\nSent by ' + a.label + ' using ScaleDesk.' + (a.email ? ' Reply to this email to reach them.' : '');
          try { await mailer.send({ to, subject: clip(d.subject, 150) || (quote ? 'Quotation request: ' : 'Proposal: ') + clip(d.title, 100), text, replyTo: a.email }); emailed = true; }
          catch (e) { emailError = 'The email could not be sent'; console.error('email:', e.message); }
        }
      }
      return send(res, 201, { id, emailed, emailError, tokens: { client: id + '.' + tk.client, developer: id + '.' + tk.developer } });
    }
    return send(res, 405, { error: 'Method not allowed' });
  }

  const mm = /^\/api\/rooms\/(\w+)(?:\/(\w+))?(?:\/(\w+))?$/.exec(p);
  if (!mm) return send(res, 404, { error: 'Not found' });
  const [, id, act, sub] = mm;
  const a = who(req, ip, id);
  if (a.err) return send(res, a.err, { error: 'Not authorised' });
  const r = db.rooms[id];
  if (!r) return send(res, 404, { error: 'Not found' });
  refresh(r);
  if (r.status === 'purged') return send(res, 410, { error: 'This room has been deleted' });
  const role = a.role, owner = role === 'owner', open = r.status === 'open';
  if (owner && !canOwn(a, r)) return send(res, 404, { error: 'Not found' });

  if (!act && m === 'GET') return send(res, 200, view(r, role));

  if (act === 'messages') {
    if (m === 'GET') {
      const since = +u.searchParams.get('since') || 0;
      if (owner && (r.ownerSeen || 0) < (r.nextMsg || 0)) { r.ownerSeen = r.nextMsg; save(); }
      return send(res, 200, r.messages.filter(x => x.id > since));
    }
    if (m === 'POST') {
      if (!open) return send(res, 403, { error: 'This room is closed' });
      const d = await json(req), text = d && clip(d.body, 4000);
      if (!text) return send(res, 400, { error: 'Message is empty' });
      const msg = { id: (r.nextMsg = (r.nextMsg || 0) + 1), role, name: label(r, role), body: text, at: now() };
      r.messages.push(msg); if (r.messages.length > 2000) r.messages.shift();
      if (owner) r.ownerSeen = r.nextMsg;
      save(); notifyAfterMessage(r, role, text, billing.baseUrl(req)); return send(res, 201, msg);
    }
  }

  if (act === 'files' && !sub && m === 'POST') {
    if (!open) return send(res, 403, { error: 'This room is closed' });
    if (r.offer && !r.offer.accepted) return send(res, 403, { error: 'Files can be shared after the client accepts the offer' });
    if (r.files.length >= 100) return send(res, 400, { error: 'File limit reached' });
    const d = await json(req, Math.ceil(MAX_FILE * 1.4) + 2000);
    if (!d || typeof d.data !== 'string') return send(res, 400, { error: 'No file received' });
    const buf = Buffer.from(d.data, 'base64');
    if (!buf.length || buf.length > MAX_FILE) return send(res, 413, { error: 'File must be under 7 MB' });
    if (d.final && role !== 'client' && d.checklistDone !== true) return send(res, 400, { error: 'Tick every item in the Final delivery checklist first' });
    const f = { id: rid(), name: String(d.name || 'file').replace(/[^\w.\- ]/g, '_').slice(0, 100), size: buf.length, final: !!d.final && role !== 'client', by: role, at: now() };
    fs.writeFileSync(path.join(DATA, 'files', id + '-' + f.id), buf);
    r.files.push(f); if (f.final) r.log.push([now(), 'final delivery checklist completed by ' + role + ': ' + f.name]); save();
    return send(res, 201, view(r, role));
  }
  if (act === 'files' && sub && m === 'GET') {
    const f = r.files.find(x => x.id === sub);
    if (!f) return send(res, 404, { error: 'File not found' });
    if (!owner && !windowOpen(r)) return send(res, 403, { error: 'The download period has ended' });
    if (f.final && role === 'client' && !paidFull(r)) return send(res, 402, { error: 'Final files unlock after full payment' });
    const buf = fs.readFileSync(path.join(DATA, 'files', id + '-' + f.id));
    res.writeHead(200, Object.assign({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="' + f.name + '"', 'Content-Length': buf.length }, SEC));
    return res.end(buf);
  }

  if (act === 'invoice' && m === 'GET') {
    if (role === 'developer' || r.kind === 'quote') return send(res, 403, { error: 'Not allowed' });
    const money = c => (c / 100).toFixed(2) + ' ' + r.currency, items = [];
    const T = (x, y, text, o) => items.push(Object.assign({ x, y, text }, o || {}));
    T(50, 70, r.ownerLabel || 'Scale Desk', { size: 20, bold: true });
    T(545, 70, 'INVOICE', { size: 20, bold: true, align: 'right' });
    T(545, 92, 'No. ' + r.id.toUpperCase(), { align: 'right' }); T(545, 108, 'Date: ' + new Date().toISOString().slice(0, 10), { align: 'right' });
    T(50, 130, 'Billed to', { bold: true }); T(50, 146, r.clientName);
    T(50, 180, 'Project', { bold: true }); T(50, 196, r.title.slice(0, 80));
    items.push({ line: true, x: 50, y: 225, w: 495 });
    T(50, 245, 'Payment', { bold: true }); T(380, 245, 'Amount', { bold: true, align: 'right' }); T(545, 245, 'Status', { bold: true, align: 'right' });
    let y = 268;
    steps(r).forEach((s2, i) => {
      T(50, y, s2.label + ' (' + s2.pct + '%)'); T(380, y, money(s2.cents), { align: 'right' });
      T(545, y, r.paidCents >= s2.cum ? 'Paid' : i < releasedN(r) ? 'Due' : 'Not yet requested', { align: 'right' }); y += 20;
    });
    items.push({ line: true, x: 50, y: y + 4, w: 495 }); y += 28;
    T(380, y, 'Total', { bold: true, align: 'right' }); T(545, y, money(r.amountCents), { bold: true, align: 'right' }); y += 20;
    T(380, y, 'Paid so far', { align: 'right' }); T(545, y, money(Math.min(r.paidCents, r.amountCents)), { align: 'right' }); y += 20;
    T(380, y, 'Balance', { bold: true, align: 'right' }); T(545, y, money(Math.max(0, r.amountCents - r.paidCents)), { bold: true, align: 'right' });
    T(50, 790, 'Final files are released once the full amount is paid. Thank you for your business.', { size: 9 });
    const buf = require('./pdf').page(items);
    res.writeHead(200, Object.assign({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="invoice-' + r.id + '.pdf"', 'Content-Length': buf.length }, SEC));
    return res.end(buf);
  }

  if (act === 'quote' && m === 'POST') {
    if (r.kind !== 'quote' || role !== 'developer') return send(res, 403, { error: 'Not allowed' });
    if (!open) return send(res, 403, { error: 'This request is closed' });
    const d = await json(req), amt = d && +d.amount, days = d && Math.round(+d.days);
    if (!(amt > 0) || !(days > 0)) return send(res, 400, { error: 'Enter your price and the number of days' });
    if ((r.quotes || []).length >= 5) return send(res, 400, { error: 'You have sent the maximum number of quotations' });
    const q = { id: rid(), cents: Math.round(amt * 100), days, note: clip(d.note, 1000), at: now(), status: 'sent' };
    (r.quotes = r.quotes || []).push(q);
    r.messages.push({ id: (r.nextMsg = (r.nextMsg || 0) + 1), role, name: label(r, role),
      body: 'Sent a quotation: ' + (q.cents / 100).toFixed(2) + ' ' + r.currency + ' in ' + days + ' days.' + (q.note ? '\n' + q.note : ''), at: now() });
    save(); return send(res, 201, view(r, role));
  }

  if (act === 'offer' && m === 'POST') {
    if (role !== 'client' || !r.offer || r.offer.accepted || !open) return send(res, 403, { error: 'Not allowed' });
    const d = await json(req);
    if (d && d.decision === 'accept') { r.offer.accepted = true; if (r.work === 'pending') r.work = 'progress'; sys(r, 'client', 'Offer accepted.'); save(); return send(res, 200, view(r, role)); }
    if (d && d.decision === 'decline') { sys(r, 'client', 'Offer declined.'); closeRoom(r, 'offer declined'); return send(res, 200, view(r, role)); }
    return send(res, 400, { error: 'Choose accept or decline' });
  }
  if (act === 'checkout' && m === 'POST') {
    if (role !== 'client' || r.kind === 'quote' || !open) return send(res, 403, { error: 'Not allowed' });
    if (r.offer && !r.offer.accepted) return send(res, 403, { error: 'Accept the offer first' });
    if (paidFull(r)) return send(res, 400, { error: 'This is already paid' });
    if (dueCents(r) <= 0) return send(res, 400, { error: 'No payment is due right now' });
    const ms = payMethods(r), body0 = (await json(req)) || {}, prov = ms.includes(body0.provider) ? body0.provider : ms[0];
    if (!prov) return send(res, 503, { error: payfast.enabled() && r.currency !== 'ZAR' ? 'This room is priced in ' + r.currency + ', which no payment option on this server takes. PayFast takes rand only.' : 'Card payments are not set up' });
    if (prov === 'payfast') return send(res, 200, payfast.roomForm(r, billing.baseUrl(req), dueCents(r)));
    if (prov === 'paypal') {
      try { return send(res, 200, { url: await paypal.roomCheckout(r, billing.baseUrl(req), dueCents(r)) }); }
      catch (e) { console.error('paypal checkout:', e.message); return send(res, 502, { error: 'Could not start the PayPal payment' }); }
    }
    try { return send(res, 200, { url: await billing.projectCheckout(r, billing.baseUrl(req), dueCents(r)) }); }
    catch (e) { console.error('checkout:', e.message); return send(res, 502, { error: 'Could not start the payment' }); }
  }

  if (act === 'approve' && m === 'POST') {
    if (role !== 'client') return send(res, 403, { error: 'Only the client can approve' });
    if (r.kind === 'quote') return send(res, 400, { error: 'Not used for quote requests' });
    if (r.offer && !r.offer.accepted) return send(res, 400, { error: 'The offer has not been accepted yet' });
    if (!open) return send(res, 403, { error: 'This room is closed' });
    r.approved = true; if (!paidFull(r) && r.work !== 'completed') r.work = 'review'; r.log.push([now(), 'client approved']); maybeClose(r);
    return send(res, 200, view(r, role));
  }

  if (act === 'review' && m === 'POST') {
    if (role !== 'client') return send(res, 403, { error: 'Only the client can leave a review' });
    if (workOf(r) !== 'completed') return send(res, 400, { error: 'You can review a project once it is marked Completed' });
    const d = (await json(req)) || {}, n = Math.round(+d.rating);
    if (!(n >= 1 && n <= 5)) return send(res, 400, { error: 'Choose a rating from 1 to 5 stars' });
    r.review = { rating: n, comment: clip(d.comment, 1000), at: now() }; r.log.push([now(), 'client review ' + n + ' stars']); save();
    return send(res, 200, view(r, role));
  }
  if (!owner) return send(res, 403, { error: 'Not allowed' });   // everything below is for you only
  if (m !== 'POST') return send(res, 405, { error: 'Method not allowed' });
  const d = (await json(req)) || {};
  if (act === 'delegate') {
    // White-label hand-off: the freelancer gets their own private room that holds only the task text you write. No client name, email or messages are copied.
    if (r.kind === 'quote') return send(res, 400, { error: 'Delegate from a project room' });
    const fname = clip(d.freelancerName, 80), brief = clip(d.brief, 4000);
    if (!fname || !brief) return send(res, 400, { error: 'Enter the freelancer name and the task description' });
    const nid = rid(), tk = secret();
    db.rooms[nid] = { id: nid, kind: 'quote', brief, quotes: [], ownerId: r.ownerId || 'admin', ownerLabel: r.ownerLabel, title: 'Task: ' + clip(d.title || r.title, 110), clientName: fname, freelancerId: clip(d.freelancerId, 40), currency: r.currency,
      offer: null, amountCents: 0, paidCents: 0, payments: [], released: 1, payUrl: '', approved: false, status: 'open', createdAt: now(), expiresAt: now() + ROOM_DAYS * DAY,
      ownerEmail: r.ownerEmail || '', partyEmail: '', ownerSeen: 0, notified: {}, parentId: r.id, tokens: { client: sha(secret()), developer: sha(tk) }, messages: [], files: [], log: [[now(), 'delegated from ' + r.id]] };
    (r.tasks = r.tasks || []).push({ id: nid, freelancer: fname, at: now() }); r.log.push([now(), 'task delegated to ' + fname]); save();
    return send(res, 201, { id: nid, token: nid + '.' + tk });
  }
  if (act === 'status') {
    if (r.kind === 'quote') return send(res, 400, { error: 'Not used for quote requests' });
    if (!WORK.includes(d.status)) return send(res, 400, { error: 'Unknown status' });
    r.work = d.status; r.log.push([now(), 'status: ' + d.status]); save(); return send(res, 200, { work: workOf(r) });
  }
  if (act === 'decide') {
    const q = (r.quotes || []).find(x => x.id === d.quoteId);
    if (!q || !['accepted', 'declined'].includes(d.decision)) return send(res, 400, { error: 'Choose a quotation and a decision' });
    q.status = d.decision;
    r.messages.push({ id: (r.nextMsg = (r.nextMsg || 0) + 1), role: 'owner', name: label(r, 'owner'),
      body: 'Quotation ' + d.decision + ' (' + (q.cents / 100).toFixed(2) + ' ' + r.currency + ').', at: now() });
    save(); return send(res, 200, view(r, role));
  }
  if (act === 'release') {
    if (r.kind === 'quote' || !r.plan) return send(res, 400, { error: 'Not used here' });
    if (!open) return send(res, 403, { error: 'This room is closed' });
    if (releasedN(r) >= r.plan.length) return send(res, 400, { error: 'Every payment has already been requested' });
    r.released = releasedN(r) + 1;
    const st = steps(r)[r.released - 1];
    sys(r, 'owner', 'Next payment requested: ' + st.label + ' (' + (st.cents / 100).toFixed(2) + ' ' + r.currency + ').');
    r.log.push([now(), 'requested payment: ' + st.label]); save();
    if (mailer.enabled() && r.partyEmail && allowEmail(r.ownerId || 'admin'))
      mailer.send({ to: r.partyEmail, subject: 'Payment requested: ' + r.title, text: (r.ownerLabel || 'Scale Desk') + ' has requested the next payment (' + st.label + ', ' + (st.cents / 100).toFixed(2) + ' ' + r.currency + ') for "' + r.title + '".\n\nOpen your private link to pay by card.', replyTo: r.ownerEmail || undefined }).catch(e => console.error('release mail:', e.message));
    return send(res, 200, view(r, role));
  }
  if (act === 'payment') {
    if (r.kind === 'quote') return send(res, 400, { error: 'Not used for quote requests' });
    const out = pay(r, d.amount, d.reference); return send(res, out.code, out.body);
  }
  if (act === 'close') { if (open) closeRoom(r, 'closed by owner'); return send(res, 200, { status: r.status }); }
  if (act === 'extend') {
    const days = Math.min(365, Math.max(1, +d.days || 14));
    if (open) r.expiresAt += days * DAY;
    else if (r.reason !== 'approved and paid in full') { r.status = 'open'; r.closedAt = 0; r.reason = ''; r.expiresAt = now() + days * DAY; r.log.push([now(), 'reopened']); }
    else return send(res, 400, { error: 'This room finished normally and cannot be reopened' });
    save(); return send(res, 200, { status: r.status, expiresAt: r.expiresAt });
  }
  if (act === 'relink') {
    const role2 = d.role === 'developer' ? 'developer' : 'client', s = secret();
    r.tokens[role2] = sha(s); r.log.push([now(), 'new ' + role2 + ' link']); save();
    return send(res, 200, { token: id + '.' + s });
  }
  if (act === 'payurl') { r.payUrl = /^https:\/\//i.test(d.payUrl || '') ? clip(d.payUrl, 500) : ''; save(); return send(res, 200, { payUrl: r.payUrl }); }
  if (act === 'purge') { purgeRoom(r); return send(res, 200, { status: r.status }); }
  return send(res, 404, { error: 'Not found' });
}

exports.recordPayment = (roomId, amount, ref, currency) => {
  const r = db.rooms[roomId];
  if (!r || r.status === 'purged' || r.kind === 'quote') return false;
  if (currency && currency !== r.currency) return false;     // never count rand as dollars, or the reverse
  pay(r, amount, ref); return true;
};
exports.handle = (req, res, u) => {
  const p = u.pathname.replace(/\/+$/, '') || '/';
  { const rm0 = /^\/rooms\/(\w+)$/.exec(p); if (rm0 && req.method === 'GET') { res.writeHead(302, { Location: '/r?id=' + rm0[1], 'Cache-Control': 'no-store' }); res.end(); return true; } }
  if (pages[p] && req.method === 'GET') {
    res.writeHead(200, Object.assign({ 'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' blob: data:; frame-ancestors 'none'" }, SEC));
    res.end(pages[p]); return true;
  }
  if (!u.pathname.startsWith('/api/rooms') && u.pathname !== '/api/webhooks/payment') return false;
  run(req, res, u).catch(e => { console.error('rooms:', e.message); if (!res.headersSent) send(res, 500, { error: 'Server error' }); });
  return true;
};

// Hourly: close expired rooms and delete files once the download period is over.
const sweep = () => { for (const r of Object.values(db.rooms)) { if (r.status === 'purged') continue; refresh(r); if (r.status === 'closed' && !windowOpen(r)) purgeRoom(r); } };
setInterval(sweep, 3600000); sweep();
