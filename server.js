// ScaleDesk live job server. Needs Node 18 or newer. No packages to install.
// It collects open jobs from several sources, keeps the newest, and pushes new ones to the page.
const http = require('http');
const fs = require('fs'), path = require('path');
const accounts = require('./accounts');
const billing = require('./billing');
const rooms = require('./rooms');
const ai = require('./ai');
const profile = require('./profile');
const payfast = require('./payfast');
const paypal = require('./paypal');
billing.onRoomPaid(rooms.recordPayment);
accounts.setBilling(billing.subscriptionsEnabled);
accounts.setProviders(billing.providers);

const PORT = process.env.PORT || 3000;
const ACCESS_KEY = process.env.ACCESS_KEY || '';          // optional password for the feed
const ORIGIN = process.env.ALLOWED_ORIGIN || '*';         // set to your site address once hosted
const FL_TOKEN = process.env.FREELANCER_TOKEN || '';      // optional Freelancer.com API token
const SOURCES = (process.env.SOURCES || 'freelancer,remoteok').split(',').map(s => s.trim()).filter(Boolean);
const KEYWORDS = (process.env.FREELANCER_KEYWORDS || 'website,wordpress,game,mobile app,web app,chatbot')
  .split(',').map(s => s.trim()).filter(Boolean);
const FL_EVERY = (+process.env.FREELANCER_EVERY_SECONDS || 60) * 1000;
const MAX_JOBS = 500;
const BUSINESS = process.env.BUSINESS_NAME || 'Scale Desk', SUPPORT = process.env.SUPPORT_EMAIL || 'the support email shown on our website', COUNTRY = process.env.LEGAL_COUNTRY || 'South Africa';
const legal = n => { try { return fs.readFileSync(path.join(__dirname, 'public', n + '.html'), 'utf8').split('{{BUSINESS}}').join(BUSINESS).split('{{EMAIL}}').join(SUPPORT).split('{{COUNTRY}}').join(COUNTRY).split('{{DATE}}').join(new Date().toISOString().slice(0, 10)); } catch (e) { return null; } };
const STATIC = {};
for (const [url, file, type, cache] of [['/manifest.webmanifest', 'manifest.webmanifest', 'application/manifest+json', 'no-cache'], ['/sw.js', 'sw.js', 'application/javascript', 'no-cache'],
  ['/icon-192.png', 'icon-192.png', 'image/png', 'public, max-age=86400'], ['/icon-512.png', 'icon-512.png', 'image/png', 'public, max-age=86400'], ['/icon-maskable.png', 'icon-maskable.png', 'image/png', 'public, max-age=86400']]) {
  try { STATIC[url] = { body: fs.readFileSync(path.join(__dirname, 'public', file)), type, cache }; } catch (e) { /* optional */ }
}
const LEGAL = { '/terms': legal('terms'), '/privacy': legal('privacy') };
let APP_PAGE = null, LANDING = null;
try { LANDING = fs.readFileSync(path.join(__dirname, 'public', 'landing.html')); } catch (e) { /* optional */ }
try { APP_PAGE = fs.readFileSync(path.join(__dirname, 'public', 'app.html')); } catch (e) { /* app page not installed */ }

const CATS = [
  ['Games', /game|unity|unreal|godot|roblox/i],
  ['Mobile apps', /mobile|android|\bios\b|flutter|react native|swift|kotlin/i],
  ['AI and automation', /\bai\b|machine learning|chatbot|openai|automation|\bllm\b|gpt/i],
  ['Websites', /website|wordpress|shopify|landing|webflow|wix|squarespace|\bseo\b|html|css/i],
  ['Web apps', /web app|react|node|laravel|django|\bapi\b|saas|dashboard|php|javascript|typescript|backend|full.?stack/i]
];
const classify = text => { for (const [c, r] of CATS) if (r.test(text)) return c; return 'Web apps'; };
const strip = s => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
const clean = s => String(s || '')
  .replace(/<\s*br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6]|ul|ol)>/gi, '\n').replace(/<li[^>]*>/gi, '• ')
  .replace(/<[^>]*>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0*39;/g, "'").replace(/&amp;/g, '&')
  .replace(/&[a-z#0-9]+;/gi, ' ')
  .replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const safeUrl = u => (/^https:\/\//i.test(u || '') ? u : '');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJson(url, headers) {
  const r = await fetch(url, {
    headers: Object.assign({ 'User-Agent': 'ScaleDesk/1.0', Accept: 'application/json' }, headers || {}),
    signal: AbortSignal.timeout(15000)
  });
  if (!r.ok) throw new Error(url.split('?')[0] + ' returned ' + r.status);
  return r.json();
}

// ---- Sources. Each returns a list of jobs in the same shape. ----

// Freelancer.com public project search. Bids and messages must still go through Freelancer itself.
async function freelancer() {
  const out = [];
  for (const q of KEYWORDS) {
    try {
      const url = 'https://www.freelancer.com/api/projects/0.1/projects/active/?query=' +
        encodeURIComponent(q) + '&limit=20&job_details=true&full_description=true';
      const d = await getJson(url, FL_TOKEN ? { 'freelancer-oauth-v1': FL_TOKEN } : {});
      for (const p of (d.result && d.result.projects) || []) {
        const min = (p.budget && p.budget.minimum) || 0;
        const max = (p.budget && p.budget.maximum) || min;
        const rate = (p.currency && p.currency.exchange_rate) || 1;   // converts to US dollars
        const skills = (p.jobs || []).map(j => j.name).join(' ');
        const desc = strip(p.preview_description).slice(0, 220);
        out.push({
          key: 'freelancer:' + p.id,
          t: p.title,
          d: (p.type === 'hourly' ? 'Hourly rate. ' : '') + desc,
          full: clean(p.description || p.preview_description).slice(0, 3000),
          skills: (p.jobs || []).map(j => j.name).slice(0, 12),
          b: Math.round(((min + max) / 2) * rate / 10) * 10,
          s: 'Freelancer',
          loc: '',
          t0: (p.time_submitted ? p.time_submitted * 1000 : Date.now()),
          url: safeUrl('https://www.freelancer.com/projects/' + (p.seo_url || p.id)),
          c: classify(p.title + ' ' + desc + ' ' + skills)
        });
      }
    } catch (e) { console.error('freelancer', q, e.message); }
    await sleep(1000);
  }
  return out;
}

// RemoteOK. Terms ask you to link back and credit RemoteOK, which the page does.
async function remoteok() {
  const a = await getJson('https://remoteok.com/api');
  return a.slice(1).filter(j => j && j.id).map(j => ({
    key: 'remoteok:' + j.id,
    t: (j.position || 'Remote job') + (j.company ? ' at ' + j.company : ''),
    d: strip(j.description).slice(0, 220),
    full: clean(j.description).slice(0, 3000),
    skills: (j.tags || []).slice(0, 12),
    b: 0,
    s: 'RemoteOK',
    loc: j.location || 'Remote',
    t0: (j.epoch ? j.epoch * 1000 : Date.parse(j.date)) || Date.now(),
    url: safeUrl(j.url),
    c: classify((j.position || '') + ' ' + (j.tags || []).join(' '))
  }));
}

// Remotive. Off by default: they allow at most 4 fetches a day, delay listings by 24 hours,
// and require a link back and credit. Add "remotive" to SOURCES only if you accept those terms.
async function remotive() {
  const d = await getJson('https://remotive.com/api/remote-jobs?category=software-dev&limit=50');
  return (d.jobs || []).map(j => ({
    key: 'remotive:' + j.id,
    t: j.title + (j.company_name ? ' at ' + j.company_name : ''),
    d: strip(j.description).slice(0, 220),
    full: clean(j.description).slice(0, 3000),
    skills: (j.tags || []).slice(0, 12),
    b: 0,
    s: 'Remotive',
    loc: j.candidate_required_location || 'Remote',
    t0: Date.parse(j.publication_date) || Date.now(),
    url: safeUrl(j.url),
    c: classify(j.title + ' ' + (j.tags || []).join(' '))
  }));
}

const SRC = {
  freelancer: { fn: freelancer, every: FL_EVERY },
  remoteok: { fn: remoteok, every: 15 * 60 * 1000 },
  remotive: { fn: remotive, every: 6 * 60 * 60 * 1000 }
};

// ---- Storage and push ----
const jobs = new Map();
const clients = new Set();
const lastRun = {};

function broadcast(list) {
  const msg = 'data: ' + JSON.stringify(list) + '\n\n';
  for (const res of clients) res.write(msg);
}

function ingest(list) {
  const fresh = [];
  for (const j of list) {
    if (!j.url || jobs.has(j.key)) continue;
    jobs.set(j.key, j);
    fresh.push(j);
  }
  if (jobs.size > MAX_JOBS) {
    const keep = [...jobs.values()].sort((a, b) => b.t0 - a.t0).slice(0, MAX_JOBS);
    jobs.clear();
    keep.forEach(j => jobs.set(j.key, j));
  }
  if (fresh.length) broadcast(fresh);
}

for (const name of SOURCES) {
  const s = SRC[name];
  if (!s) { console.error('Unknown source:', name); continue; }
  const run = async () => {
    try { ingest(await s.fn()); lastRun[name] = new Date().toISOString(); }
    catch (e) { console.error(name, e.message); }
  };
  run();
  setInterval(run, s.every);
}

setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000);

// ---- Web server ----
const send = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  res.setHeader('Access-Control-Allow-Origin', ORIGIN);
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Headers': '*' }); return res.end(); }
  if (u.pathname === '/api/health') return send(res, 200, { ok: true, jobs: jobs.size, sources: SOURCES, lastRun });
  if (STATIC[u.pathname]) { const f = STATIC[u.pathname]; res.writeHead(200, { 'Content-Type': f.type, 'Cache-Control': f.cache, 'X-Content-Type-Options': 'nosniff' }); return res.end(f.body); }
  if (LEGAL[u.pathname]) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" }); return res.end(LEGAL[u.pathname]); }
  if (u.pathname === '/' && LANDING) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'" });
    return res.end(LANDING);
  }
  if ((u.pathname === '/' || u.pathname === '/app') && APP_PAGE) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; frame-ancestors 'none'" });
    return res.end(APP_PAGE);
  }
  if (accounts.handle(req, res, u)) return;              // sign up, sign in, plans
  if (profile.handle(req, res, u)) return;               // public profile pages and editor
  if (ai.handle(req, res, u)) return;                    // AI writing helper
  if (paypal.handle(req, res, u)) return;                // PayPal returns
  if (payfast.handle(req, res, u)) return;               // PayFast payment notifications
  if (billing.handle(req, res, u)) return;               // card payments
  if (rooms.handle(req, res, u)) return;                 // project rooms have their own logins
  const sess = accounts.userFrom(req);
  const allowed = (ACCESS_KEY && u.searchParams.get('key') === ACCESS_KEY) || (sess && sess.active) ||
    (u.pathname === '/api/stream' && accounts.consumeTicket(u.searchParams.get('ticket')));
  if (!allowed) return send(res, 401, { error: 'Please sign in' });
  if (u.pathname === '/api/jobs') {
    return send(res, 200, [...jobs.values()].sort((a, b) => b.t0 - a.t0).slice(0, 200));
  }
  if (u.pathname === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  send(res, 404, { error: 'Not found' });
}).listen(PORT, () => console.log('ScaleDesk server running on port ' + PORT + ' with sources: ' + SOURCES.join(', ')));
