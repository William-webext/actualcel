// Service worker minimale per la PWA. Le pagine (navigazioni HTML) sono
// sempre di rete quando possibile, con la cache solo come fallback offline:
// così ogni aggiornamento dell'app si vede al primo reload, invece di
// restare bloccati sulla versione precedente finché la cache non si aggiorna
// da sola in background. Icone/manifest, che cambiano raramente, restano
// cache-first per un avvio più veloce. Le chiamate /api/* non vengono mai
// messe in cache: passano sempre alla rete, altrimenti login/dati/salvataggi
// diventerebbero stantii.
const CACHE = 'actualcel-shell-v3';
const SHELL = ['/', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.pathname.startsWith('/api/')) return;

  var isDocument = req.mode === 'navigate' || req.destination === 'document';

  if (isDocument) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) caches.open(CACHE).then((cache) => cache.put(req, res.clone()));
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached || caches.match('/'))),
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res.ok) caches.open(CACHE).then((cache) => cache.put(req, res.clone()));
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
