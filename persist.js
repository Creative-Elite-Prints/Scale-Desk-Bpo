// Keeps a safe copy of your accounts and rooms OUTSIDE the server, so a restart or a wiped disk can never erase them.
// Needs a free Upstash Redis database (UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN). Without it, nothing changes.
// It also tells you when your storage is only temporary (the usual reason accounts disappear on Render).
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const URL_ = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, ''), TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const NS = process.env.PERSIST_NAMESPACE || 'scaledesk';
const FILES = ['accounts.json', 'rooms.json'], CHUNK = 250000;
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const log = (...a) => console.log('[storage]', ...a);

// Safe load and save. A damaged file is kept aside (never overwritten with an empty one) and the previous copy (.bak) is used.
exports.load = (file, fallback) => {
  for (const q of [file, file + '.bak']) {
    if (!fs.existsSync(q)) continue;
    try {
      const v = JSON.parse(fs.readFileSync(q, 'utf8'));
      if (q !== file) console.error('[storage] ' + path.basename(file) + ' was damaged. Recovered from its backup copy.');
      return v;
    } catch (e) {
      if (q === file) { try { fs.renameSync(file, file + '.damaged-' + Date.now()); } catch (x) { /* keep going */ } console.error('[storage] ' + path.basename(file) + ' could not be read. A copy was kept as .damaged-*. Trying the backup copy.'); }
    }
  }
  return fallback;
};
exports.write = (file, obj) => {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  try { if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak'); } catch (e) { /* the backup copy is a bonus */ }
  fs.renameSync(tmp, file);
};

exports.enabled = () => !!(URL_ && TOKEN);

// Is the data folder on storage that survives a restart? Pure function so it can be tested.
exports.detect = (dir, env, stat) => {
  if (!env.RENDER) return 'local';                       // your own computer or another host: nothing to warn about
  try { return stat(dir).dev !== stat('/').dev ? 'disk' : 'temporary'; } catch (e) { return 'temporary'; }
};
exports.status = () => {
  let disk = 'local';
  try { fs.mkdirSync(DATA, { recursive: true }); disk = exports.detect(DATA, process.env, p => fs.statSync(p)); } catch (e) { disk = 'temporary'; }
  const mode = exports.enabled() ? 'remote' : disk;
  return { mode, persistent: mode !== 'temporary', disk };
};

async function cmd(args) {
  const r = await fetch(URL_, { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(args), signal: AbortSignal.timeout(15000) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error(d.error || 'HTTP ' + r.status);
  return d.result;
}
const metaKey = f => NS + ':' + f + ':meta', chunkKey = (f, h, i) => NS + ':' + f + ':' + h.slice(0, 12) + ':' + i;
const last = {};           // file -> meta we last pushed or restored

async function pull(f) {
  const raw = await cmd(['GET', metaKey(f)]);
  if (!raw) return null;                                   // nothing backed up yet
  const m = JSON.parse(raw); let text = '';
  for (let i = 0; i < m.n; i++) {
    const c = await cmd(['GET', chunkKey(f, m.sha, i)]);
    if (typeof c !== 'string') throw new Error('backup of ' + f + ' is incomplete');
    text += c;
  }
  if (sha(text) !== m.sha) throw new Error('backup of ' + f + ' failed its check');
  last[f] = m; return text;
}
async function push(f) {
  let text; try { text = fs.readFileSync(path.join(DATA, f), 'utf8'); } catch (e) { return; }
  const h = sha(text); if (last[f] && last[f].sha === h) return;
  const n = Math.max(1, Math.ceil(text.length / CHUNK));
  for (let i = 0; i < n; i++) await cmd(['SET', chunkKey(f, h, i), text.slice(i * CHUNK, (i + 1) * CHUNK)]);
  const m = { n, sha: h, len: text.length, at: Date.now() };
  await cmd(['SET', metaKey(f), JSON.stringify(m)]);       // the meta moves last, so a half-finished push never replaces a good copy
  const old = last[f]; last[f] = m;
  if (old) try { await cmd(['DEL'].concat(Array.from({ length: old.n }, (_, i) => chunkKey(f, old.sha, i)))); } catch (e) { /* leftovers are harmless */ }
}

// Called once before the server starts. Brings back the files if this server has none (fresh or wiped disk).
exports.restore = async () => {
  if (!exports.enabled()) return;
  fs.mkdirSync(DATA, { recursive: true });
  for (const f of FILES) {
    const p = path.join(DATA, f);
    if (fs.existsSync(p)) { log(f + ' found on this server, keeping it'); continue; }
    let text = null, err;
    for (let a = 0; a < 5; a++) { try { text = await pull(f); err = null; break; } catch (e) { err = e; await new Promise(r => setTimeout(r, 3000)); } }
    if (err) { console.error('[storage] STOPPING: could not read your saved ' + f + ' from Upstash (' + err.message + '). Not starting with an empty database.'); process.exit(1); }
    if (text) { fs.writeFileSync(p + '.tmp', text); fs.renameSync(p + '.tmp', p); log('restored ' + f + ' from Upstash'); }
    else log('no saved copy of ' + f + ' yet (first run)');
  }
};

let dirty = new Set(), timer = null, running = null, retry = null;
async function flushNow() {
  const files = [...dirty]; dirty = new Set();
  for (const f of files) { try { await push(f); } catch (e) { console.error('[storage] backup of ' + f + ' failed:', e.message); dirty.add(f); } }
  if (dirty.size && !retry) retry = setTimeout(() => { retry = null; exports.flush(); }, 20000);
}
exports.flush = () => { running = (running || Promise.resolve()).then(flushNow).then(() => { running = null; }); return running; };
exports.touch = f => {
  if (!exports.enabled()) return;
  dirty.add(f); clearTimeout(timer); timer = setTimeout(() => exports.flush(), 1500);
};
// Render stops the server with SIGTERM when it restarts or sleeps: finish saving first.
if (exports.enabled()) for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => {
  clearTimeout(timer);
  Promise.race([exports.flush(), new Promise(r => setTimeout(r, 8000))]).then(() => process.exit(0));
});
