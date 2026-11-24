// Your Venture Church app: offline support. Pages always try the network first, so site updates show right away.
const V = 'venture-v2';
const CORE = ['/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== V).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const keep = (req, res) => {
  if (res && (res.ok || res.type === 'opaque')) { const copy = res.clone(); caches.open(V).then(c => c.put(req, copy)); }
  return res;
};
// show the saved copy now, refresh it in the background
const fresh = (e, req) => e.respondWith(caches.match(req).then(hit => {
  const net = fetch(req).then(res => keep(req, res)).catch(() => hit);
  if (hit) { e.waitUntil(net); return hit; }
  return net;
}));

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (req.mode === 'navigate') {
    e.respondWith(fetch(req)
      .then(res => { if (res.ok) { const copy = res.clone(); caches.open(V).then(c => c.put('/', copy)); } return res; })
      .catch(() => caches.match('/')));
    return;
  }
  if (url.origin === location.origin) {
    if (url.pathname.startsWith('/media/') || req.headers.has('range')) return; // videos stream from the network
    if (url.pathname.startsWith('/data/')) { // events and groups: newest when online, last copy when offline
      e.respondWith(fetch(req).then(res => keep(req, res)).catch(() => caches.match(req)));
      return;
    }
    fresh(e, req);
    return;
  }
  if (/^(fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net)$/.test(url.hostname)) fresh(e, req);
});
