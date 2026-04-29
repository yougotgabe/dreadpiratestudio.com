/**
 * DPS Autopilot — Service Worker
 * Handles push notifications and offline caching
 */

const CACHE_NAME = 'autopilot-v1';

// ── Install ───────────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  self.skipWaiting();
});

// ── Activate ──────────────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(clients.claim());
});

// ── Push ──────────────────────────────────────────────────────────────────────
self.addEventListener('push', event => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = {
      title: 'DPS Autopilot',
      body: event.data.text(),
      url: '/autopilot/dashboard/dashboard.html',
    };
  }

  const options = {
    body:    payload.body || 'You have a new notification.',
    icon:    '/icon-192.png',
    badge:   '/icon-72.png',
    tag:     payload.tag || 'autopilot-notification',
    renotify: true,
    data: {
      url: payload.url || '/autopilot/dashboard/dashboard.html',
    },
    actions: [
      { action: 'open',    title: 'Review Post' },
      { action: 'dismiss', title: 'Dismiss' },
    ],
  };

  event.waitUntil(
    self.registration.showNotification(payload.title || 'DPS Autopilot ✦', options)
  );
});

// ── Notification click ────────────────────────────────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();

  if (event.action === 'dismiss') return;

  const url = event.notification.data?.url || '/autopilot/dashboard/dashboard.html';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      // Focus existing tab if open
      for (const client of windowClients) {
        if (client.url.includes('/autopilot/') && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open new tab
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});

// ── Push subscription change ──────────────────────────────────────────────────
self.addEventListener('pushsubscriptionchange', event => {
  // Subscription expired — notify the page to re-subscribe
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(windowClients => {
      windowClients.forEach(client => {
        client.postMessage({ type: 'PUSH_SUBSCRIPTION_EXPIRED' });
      });
    })
  );
});
