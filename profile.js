// Public profile pages: what a person does, and examples of their work. Owner and customers each get one.
const accounts = require('./accounts');
const SEC = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' };
const BIZ = process.env.BUSINESS_NAME || 'Scale Desk';
const clip = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const IMG = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/;
const MAX_IMG = 400000, MAX_WORK = 6, MAX_SERV = 10;
const send = (res, code, o) => { res.writeHead(code, Object.assign({ 'Content-Type': 'application/json' }, SEC)); res.end(JSON.stringify(o)); };
const body = (req, max) => new Promise((ok, no) => { let n = 0; const c = []; req.on('data', d => { n += d.length; if (n > max) { no(new Error('big')); req.destroy(); } else c.push(d); }); req.on('end', () => ok(Buffer.concat(c).toString('utf8'))); req.on('error', no); });
const slugify = s => clip(s, 40).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'member';

function clean(d, u, old) {
  d = d || {};
  const work = (Array.isArray(d.work) ? d.work : []).slice(0, MAX_WORK).map((w, i) => {
    w = w || {};
    let img = typeof w.img === 'string' && IMG.test(w.img) && w.img.length <= MAX_IMG ? w.img : '';
    if (!img && w.keep && old && old.work && old.work[i]) img = old.work[i].img || '';
    const link = /^https:\/\//i.test(String(w.link || '').trim()) ? clip(w.link, 300) : '';
    return { title: clip(w.title, 100), desc: clip(w.desc, 800), link, img };
  }).filter(w => w.title || w.desc || w.img);
  const email = clip(d.email, 120);
  return {
    public: !!d.public, name: clip(d.name, 80) || u.business || u.name, headline: clip(d.headline, 140), about: clip(d.about, 2500),
    services: (Array.isArray(d.services) ? d.services : []).map(x => clip(x, 120)).filter(Boolean).slice(0, MAX_SERV),
    location: clip(d.location, 80), rate: clip(d.rate, 80), email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : '',
    work
  };
}
function slugFor(u, name) {
  let base = slugify(name || u.business || u.name), s = base, n = 1;
  const taken = x => accounts.allUsers().some(o => o.id !== u.id && o.profile && o.profile.slug === x);
  while (taken(s)) s = base + '-' + (++n);
  return s;
}
const outView = (u, p) => p ? Object.assign({}, p, { work: p.work.map(w => ({ title: w.title, desc: w.desc, link: w.link, hasImg: !!w.img })) }) : null;

function page(u, p) {
  const name = esc(p.name), work = p.work.map((w, i) => '<div class="w">' + (w.img ? '<img src="/p/' + esc(p.slug) + '/img/' + i + '" alt="' + esc(w.title || 'Example of work') + '">' : '') +
    '<h3>' + esc(w.title || 'Project') + '</h3>' + (w.desc ? '<p>' + esc(w.desc).replace(/\n/g, '<br>') + '</p>' : '') + (w.link ? '<p><a href="' + esc(w.link) + '" rel="noopener nofollow ugc" target="_blank">View this project</a></p>' : '') + '</div>').join('');
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + name + (p.headline ? ' | ' + esc(p.headline) : '') + '</title>' +
    '<meta name="description" content="' + esc(p.headline || p.about.slice(0, 150)) + '"><style>' +
    ':root{--bg:#f7f6f2;--fg:#1c1b19;--mut:#6b6860;--card:#fff;--ac:#1d6b57;--bd:#e3e0d8}@media(prefers-color-scheme:dark){:root{--bg:#161614;--fg:#efede6;--mut:#a09d94;--card:#201f1c;--ac:#5fc4a8;--bd:#34322d}}' +
    '*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,Segoe UI,sans-serif}main{max-width:760px;margin:0 auto;padding:32px 16px 56px}' +
    'h1{font-size:34px;line-height:1.15;margin:0 0 6px}h2{font-size:14px;letter-spacing:.08em;text-transform:uppercase;color:var(--mut);margin:34px 0 10px}.hl{font-size:19px;color:var(--mut);margin:0}.meta{color:var(--mut);font-size:14px;margin-top:10px}' +
    '.cta{display:inline-block;margin-top:16px;background:var(--ac);color:var(--bg);padding:11px 20px;border-radius:10px;text-decoration:none;font-weight:600}.chips{display:flex;flex-wrap:wrap;gap:8px;padding:0;margin:0;list-style:none}.chips li{background:var(--card);border:1px solid var(--bd);border-radius:999px;padding:6px 14px;font-size:15px}' +
    '.grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}.w{background:var(--card);border:1px solid var(--bd);border-radius:14px;padding:14px;overflow:hidden}.w img{width:100%;height:170px;object-fit:cover;border-radius:8px;display:block;margin-bottom:10px}.w h3{margin:0 0 4px;font-size:18px}.w p{margin:6px 0;font-size:15px}a{color:var(--ac)}footer{margin-top:44px;color:var(--mut);font-size:13px}' +
    '</style></head><body><main><h1>' + name + '</h1>' + (p.headline ? '<p class="hl">' + esc(p.headline) + '</p>' : '') +
    '<div class="meta">' + [p.location && esc(p.location), p.rate && esc(p.rate)].filter(Boolean).join(' · ') + '</div>' +
    (p.email ? '<a class="cta" href="mailto:' + esc(p.email) + '">Get in touch</a>' : '') +
    (p.about ? '<h2>About</h2><p>' + esc(p.about).replace(/\n/g, '<br>') + '</p>' : '') +
    (p.services.length ? '<h2>What I do</h2><ul class="chips">' + p.services.map(s => '<li>' + esc(s) + '</li>').join('') + '</ul>' : '') +
    (work ? '<h2>Examples of my work</h2><div class="grid">' + work + '</div>' : '') +
    '<footer>Profile on ' + esc(BIZ) + '</footer></main></body></html>';
}
function notFound(res) { res.writeHead(404, Object.assign({ 'Content-Type': 'text/html; charset=utf-8' }, SEC)); res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font:16px system-ui;padding:40px"><h1>Profile not found</h1><p>This profile does not exist or is not public.</p>'); }
const find = slug => accounts.allUsers().find(u => u.profile && u.profile.public && u.profile.slug === slug && accounts.activeUser(u));

exports.handle = (req, res, u) => {
  const p = u.pathname;
  let m;
  if ((m = /^\/p\/([a-z0-9-]{1,50})(?:\/img\/(\d))?$/.exec(p)) && req.method === 'GET') {
    const us = find(m[1]);
    if (!us) { notFound(res); return true; }
    if (m[2] !== undefined) {
      const w = us.profile.work[+m[2]], g = w && w.img && IMG.exec(w.img);
      if (!g) { notFound(res); return true; }
      res.writeHead(200, { 'Content-Type': 'image/' + g[1], 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' }); res.end(Buffer.from(g[2], 'base64')); return true;
    }
    res.writeHead(200, Object.assign({ 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'" }, SEC));
    res.end(page(us, us.profile)); return true;
  }
  if (p !== '/api/me/profile') return false;
  (async () => {
    const s = accounts.userFrom(req);
    if (!s) return send(res, 401, { error: 'Please sign in' });
    const us = s.user;
    if (req.method === 'GET') return send(res, 200, { profile: outView(us, us.profile) });
    if (req.method !== 'PUT') return send(res, 405, { error: 'Method not allowed' });
    if (!s.active) return send(res, 402, { error: 'Your plan is not active' });
    let d; try { d = JSON.parse(await body(req, 3200000)); } catch (e) { return send(res, 400, { error: 'Could not read that. Try smaller pictures.' }); }
    const prof = clean(d, us, us.profile);
    if (prof.public && !prof.about && !prof.services.length && !prof.work.length) return send(res, 400, { error: 'Add something about you before making the page public.' });
    prof.slug = us.profile && us.profile.slug || slugFor(us, prof.name);
    accounts.saveProfile(us.id, prof);
    return send(res, 200, { profile: outView(us, prof), url: '/p/' + prof.slug });
  })().catch(e => { console.error('profile:', e.message); if (!res.headersSent) send(res, 500, { error: 'Server error' }); });
  return true;
};
