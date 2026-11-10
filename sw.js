const SHELL = 'shell-v1', RUNTIME = 'runtime-v1';
const FILES = ['./', 'index.html', 'app.js', 'core.js', 'manifest.json', 'icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => ![SHELL, RUNTIME].includes(k)).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Shell: cache primeiro. Mapas (OSM) e Leaflet: guarda o que já foi visto (offline parcial).
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isRuntime = url.host.endsWith('openstreetmap.org') || url.host === 'unpkg.com';
  if (url.origin === location.origin) {
    e.respondWith(caches.match(req).then((r) => r || fetch(req)));
  } else if (isRuntime) {
    e.respondWith(caches.open(RUNTIME).then(async (c) => {
      const hit = await c.match(req);
      const net = fetch(req).then((res) => { if (res.ok || res.type === 'opaque') c.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    }));
  }
});
