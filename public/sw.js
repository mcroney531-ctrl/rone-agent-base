// Minimal service worker: it exists so Android installs Agent Ops as a real app (WebAPK), not a
// Chrome shortcut. Network only: the inbox is live data, so nothing is cached.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(() => new Response(
    '<!doctype html><meta name="viewport" content="width=device-width"><p style="font:16px system-ui;padding:24px">Offline. Agent Ops needs a connection.</p>',
    { headers: { 'content-type': 'text/html; charset=utf-8' } },
  )));
});
