// 🚀 AL KAYAN GROUP - 24/7 Live Auto-Updating Service Worker with Background Push & Audio Alerts
const CACHE_NAME = 'alkayan-pwa-cache-v9';
const FIREBASE_BASE_URL = 'https://alkayan-group-default-rtdb.europe-west1.firebasedatabase.app';

const ASSETS_TO_CACHE = [
  './mobile.html',
  './mobile_app.compiled.js',
  './portal_data.js',
  './portal_data.json',
  './manifest.json',
  './app_icon.png',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './app_icon.ico',
  './alkayan_bg.jpg',
  './notification.wav',
  './vendor/react.production.min.js',
  './vendor/react-dom.production.min.js',
  './vendor/tailwindcss.js'
];

let activeClientProfile = null;
let seenNotificationIds = new Set();
let backgroundPollInterval = null;

// 1. Install: Pre-cache core assets & skip waiting for instant automated activation
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Pre-caching offline assets for 24/7 operation...');
      return cache.addAll(ASSETS_TO_CACHE).catch((err) => {
        console.warn('[SW] Non-critical cache item skipped:', err);
      });
    })
  );
});

// Helper: Check if a notification matches the active client
function doesNotificationMatch(notif, clientProfile) {
  if (!notif) return false;
  const nCid = notif.targetClientId || notif.clientId;
  if (!nCid || nCid === 'admin_only' || nCid === 'internal') return false;
  if (nCid === 'all') return true;

  if (!clientProfile) return false;
  if (clientProfile.id && (notif.clientId === clientProfile.id || notif.targetClientId === clientProfile.id)) return true;

  const cPhone = (clientProfile.phone || '').replace(/\D/g, '');
  const nPhone = (notif.clientPhone || notif.phone || '').replace(/\D/g, '');
  if (cPhone && nPhone && (cPhone === nPhone || (cPhone.length >= 9 && nPhone.endsWith(cPhone)) || (nPhone.length >= 9 && cPhone.endsWith(nPhone)))) return true;

  if (clientProfile.username && (notif.clientUsername || notif.username) && (notif.clientUsername || notif.username).trim().toLowerCase() === clientProfile.username.trim().toLowerCase()) return true;

  return false;
}

// Helper: Show Native OS Notification with Sound & Vibration
async function triggerNativeNotification(notif) {
  if (!notif || !notif.id) return;
  if (seenNotificationIds.has(notif.id)) return;
  seenNotificationIds.add(notif.id);

  const title = notif.title || '🔔 إشعار جديد من مجموعة الكيان';
  const body = notif.message || notif.text || 'وصلك إشعار وتنبيه جديد من إدارة مجموعة الكيان';

  const options = {
    body: body,
    icon: './app_icon.png',
    badge: './app_icon.png',
    tag: notif.id,
    renotify: true,
    requireInteraction: true,
    silent: false,
    vibrate: [500, 200, 500, 200, 500],
    data: {
      url: './mobile.html?tab=notifications',
      notifId: notif.id
    },
    actions: [
      { action: 'open', title: 'عرض الإشعار 🔔' },
      { action: 'close', title: 'إغلاق ✕' }
    ]
  };

  try {
    await self.registration.showNotification(title, options);
    console.log('[SW] Native notification successfully displayed:', notif.id);
  } catch (err) {
    console.warn('[SW] showNotification error:', err);
  }
}

// Background Worker: Poll Firebase periodically to deliver notifications when user is outside the app
async function checkBackgroundNotifications() {
  try {
    const res = await fetch(`${FIREBASE_BASE_URL}/alkayan_db/latest_notification.json?t=${Date.now()}`, { cache: 'no-store' });
    if (res.ok) {
      const latest = await res.json();
      if (latest && latest.id && !seenNotificationIds.has(latest.id)) {
        if (doesNotificationMatch(latest, activeClientProfile)) {
          const windowClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
          const hasVisibleWindow = windowClients.some(c => c.visibilityState === 'visible');
          if (!hasVisibleWindow) {
            await triggerNativeNotification(latest);
          }
        }
      }
    }
  } catch (err) {}
}

function startBackgroundPolling() {
  if (backgroundPollInterval) return;
  backgroundPollInterval = setInterval(checkBackgroundNotifications, 3000);
}

// 2. Message: Listen for client commands (REGISTER_CLIENT, SHOW_NATIVE_NOTIFICATION, SKIP_WAITING)
self.addEventListener('message', (event) => {
  if (!event.data) return;

  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  if (event.data.type === 'REGISTER_CLIENT') {
    activeClientProfile = event.data.client;
    console.log('[SW] Registered active client for background push:', activeClientProfile?.name);
    startBackgroundPolling();
  }

  if (event.data.type === 'SHOW_NATIVE_NOTIFICATION') {
    const notif = event.data.notification;
    if (notif) {
      triggerNativeNotification(notif);
    }
  }
});

// 3. Activate: Clean old caches, claim clients immediately, and start polling
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('[SW] Clearing old cache:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => {
      return self.clients.claim().then(() => {
        startBackgroundPolling();
        return self.clients.matchAll({ type: 'window' }).then((clients) => {
          clients.forEach((client) => {
            client.postMessage({ type: 'APP_VERSION_UPDATED' });
          });
        });
      });
    })
  );
});

// 4. Notification Click: Bring app window to focus or open mobile.html on notifications tab
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'close') return;

  const targetUrl = (event.notification.data && event.notification.data.url) || './mobile.html?tab=notifications';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes('mobile.html') && 'focus' in client) {
          client.postMessage({ type: 'NAVIGATE_TAB', tab: 'notifications' });
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});

// 5. Fetch: Strategy for 24/7 Offline + Instant Auto-Updates
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (url.pathname.includes('index.html') || url.pathname.includes('app.compiled.js') || url.pathname.includes('app.jsx') || url.pathname === '/') {
    return;
  }

  if (url.hostname.includes('firebaseio.com') || url.hostname.includes('firebasedatabase.app') || url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request).catch(() => {
        return new Response(JSON.stringify({
          success: false,
          offline: true,
          message: '📱 تم تسجيل الإجراء في وضع التشغيل الذاتي 24/7.'
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      })
    );
    return;
  }

  if (
    url.pathname.endsWith('version.json') ||
    url.pathname.endsWith('mobile.html') ||
    url.pathname.endsWith('mobile_app.compiled.js') ||
    url.pathname.endsWith('portal_data.js') ||
    url.pathname.endsWith('portal_data.json') ||
    url.pathname.endsWith('manifest.json') ||
    url.pathname.endsWith('notification.wav') ||
    url.pathname.endsWith('sw.js')
  ) {
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const resClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone));
          }
          return networkResponse;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const fetchPromise = fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const resClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone));
        }
        return networkResponse;
      }).catch(() => {});

      return cachedResponse || fetchPromise || caches.match('./mobile.html');
    })
  );
});
