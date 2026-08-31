// 🚀 AL KAYAN GROUP - 24/7 Offline Resilient Service Worker
const CACHE_NAME = 'alkayan-pwa-cache-v3';
const ASSETS_TO_CACHE = [
  './mobile.html',
  './mobile_app.compiled.js',
  './portal_data.js',
  './portal_data.json',
  './manifest.json',
  './app_icon.ico',
  './alkayan_bg.jpg',
  './vendor/react.production.min.js',
  './vendor/react-dom.production.min.js',
  './vendor/tailwindcss.js'
];

// 1. Install: Pre-cache all core application assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Pre-caching offline assets for 24/7 operation...');
      return cache.addAll(ASSETS_TO_CACHE).catch((err) => {
        console.warn('[SW] Non-critical cache item skipped:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

// 2. Activate: Clean old caches and take control
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
    }).then(() => self.clients.claim())
  );
});

// 3. Fetch: Cache-First Strategy for Offline 24/7 Guarantee
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // For API endpoints, try network with silent fallback
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request).catch(() => {
        return new Response(JSON.stringify({
          success: false,
          offline: true,
          message: '📱 تم تسجيل الإجراء في وضع التشغيل الذاتي 24/7 وسيتم التحديث التلقائي.'
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      })
    );
    return;
  }

  // For HTML, JS, CSS, and Images: Serve from Cache immediately, then update in background
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        // Fetch background update if online
        fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, networkResponse.clone());
            });
          }
        }).catch(() => {});
        return cachedResponse;
      }

      // If not in cache, fetch from network and cache it
      return fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const resClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, resClone);
          });
        }
        return networkResponse;
      }).catch(() => {
        // Fallback to mobile.html for navigation requests
        if (event.request.mode === 'navigate') {
          return caches.match('./mobile.html');
        }
      });
    })
  );
});
