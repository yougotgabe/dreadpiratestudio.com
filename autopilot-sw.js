// DPS Autopilot — Service Worker
const CACHE_NAME = 'autopilot-v1';
const STATIC_ASSETS = [
  '/autopilot/dashboard/dashboard.html',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Network first for API calls, cache fallback for static assets
  if (e.request.url.includes('/rest/v1/') || e.request.url.includes('workers.dev')) {
    return; // Let API calls go through normally
  }
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});

// Push notification handler
self.addEventListener('push', e => {
  const data = e.data?.json() || {};
  const title = data.title || 'DPS Autopilot';
  const options = {
    body: data.body || 'A post is ready for your review.',
    icon: '/icon-192.png',
    badge: '/icon-72.png',
    tag: data.tag || 'autopilot-review',
    renotify: true,
    data: { url: data.url || '/dashboard.html' },
    actions: [
      { action: 'review', title: 'Review Now' },
      { action: 'dismiss', title: 'Later' },
    ],
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

// Notification click handler
self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'dismiss') return;
  const url = e.notification.data?.url || '/dashboard.html';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes('dashboard') && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
