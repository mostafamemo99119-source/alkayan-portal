// 🚀 AL KAYAN GROUP - 24/7 Live Auto-Updating Service Worker
const CACHE_NAME = 'alkayan-pwa-cache-v5';
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
  './vendor/react.production.min.js',
  './vendor/react-dom.production.min.js',
  './vendor/tailwindcss.js'
];

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

// 2. Message: Listen for SKIP_WAITING from active clients
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// 3. Activate: Clean old caches, claim clients immediately, and broadcast update
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
        return self.clients.matchAll({ type: 'window' }).then((clients) => {
          clients.forEach((client) => {
            client.postMessage({ type: 'APP_VERSION_UPDATED' });
          });
        });
      });
    })
  );
});

// 4. Fetch: Strategy for 24/7 Offline + Instant Auto-Updates
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Desktop app bypass - never cache or intercept desktop dashboard requests
  if (url.pathname.includes('index.html') || url.pathname.includes('app.compiled.js') || url.pathname.includes('app.jsx') || url.pathname === '/') {
    return;
  }

  // Firebase Realtime Database & API endpoints: Direct Network fetch
  if (url.hostname.includes('firebaseio.com') || url.hostname.includes('firebasedatabase.app') || url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request).catch(() => {
        return new Response(JSON.stringify({
          success: false,
          offline: true,
          message: '📱 تم تسجيل الإجراء في وضع التشغيل الذاتي 24/7 وسيتم المزامنة التلقائية.'
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      })
    );
    return;
  }

  // Network-First for mobile.html, version, compiled scripts, and portal data so ANY updates reflect instantly
  if (
    url.pathname.endsWith('version.json') ||
    url.pathname.endsWith('mobile.html') ||
    url.pathname.endsWith('mobile_app.compiled.js') ||
    url.pathname.endsWith('portal_data.js') ||
    url.pathname.endsWith('portal_data.json') ||
    url.pathname.endsWith('manifest.json') ||
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

  // Stale-While-Revalidate for other static assets (images, fonts, vendor styles)
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
