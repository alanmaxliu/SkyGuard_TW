const CACHE_NAME = 'skyguard-tw-v1.2.0';
const STATIC_ASSETS = [
  './',
  './index.html',
  './css/style.css?v=1.2.0',
  './js/app.js?v=1.2.0',
  './js/version.js',
  './js/data/fortresses.js',
  './js/data/regulations.js',
  './js/utils/sun.js',
  './js/utils/geo.js',
  './js/services/caaApi.js',
  './assets/icon.svg',
  './manifest.webmanifest'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.map((key) => {
            if (key !== CACHE_NAME) {
              return caches.delete(key);
            }
          })
        )
      )
      .then(() => self.clients.claim())
  );
});

// 全面採用 Network-First（網路優先），確保一旦發布新版，手機重整立即拿到最新畫面；只有沒網路時才用快取
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
