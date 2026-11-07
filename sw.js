const CACHE_NAME = 'skyguard-tw-v1.3.0';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // 1. 刪除所有舊版快取
      const keys = await caches.keys();
      await Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );

      // 2. 立即接管所有開啟中的頁面，並強制重新載入最新 HTML（解決手機卡在 v1.0 舊畫面問題）
      await self.clients.claim();
      const windowClients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true
      });
      for (const client of windowClients) {
        try {
          await client.navigate(client.url);
        } catch (_) {}
      }
    })()
  );
});

// 網路優先 (Network-First)：有網路一律抓最新檔案，離線才用快取
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
