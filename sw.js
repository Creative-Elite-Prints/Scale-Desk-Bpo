// Lets ScaleDesk be installed on a phone. It never stores private data: only the app shell and icons.
const CACHE = 'scaledesk-shell-v3';
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(['/icon-192.png'])).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== CACHE).map(x => caches.delete(x)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  if (u.pathname === '/app') {
    e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(CACHE).then(x => x.put('/app', c)); return r; }).catch(() => caches.match('/app')));
  } else if (u.pathname.startsWith('/icon-')) {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
  }
});
