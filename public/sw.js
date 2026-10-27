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

// Web Push → a notification. The payload is only a nudge: the app re-fetches live state when opened.
self.addEventListener('push', (e) => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch { /* not JSON: generic nudge */ }
  const url = typeof m.url === 'string' && m.url.startsWith('/app/') ? m.url : '/app/#/';
  e.waitUntil(self.registration.showNotification(m.title || 'Agent Ops', {
    body: m.body || 'Something needs you.',
    tag: m.tag || 'agent-ops', // same item → replaces its earlier notification instead of stacking
    data: { url },
    icon: '/app/icons/icon-192.png',
    badge: '/app/icons/badge-96.png',
  }));
});

// Tap → open (or focus) the app at the item. The page decides what's still true.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/app/#/', self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const app = wins.find((w) => w.url.startsWith(`${self.location.origin}/app`));
    if (app) {
      app.postMessage({ type: 'open', url });
      return app.focus();
    }
    return self.clients.openWindow(url);
  })());
});
