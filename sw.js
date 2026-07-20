// 掌厨 — Service Worker
// 缓存策略：安装时预缓存核心文件，运行时网络优先、缓存兜底
// ⚠️ 每次部署时更新 CACHE_VERSION，强制所有客户端刷新缓存

var CACHE_VERSION = 'v3';
var CACHE_NAME = 'zhangchu-' + CACHE_VERSION;
var PRE_CACHE = [
  '.',
  'index.html',
  'recipes.js',
  'manifest.json'
];

// 安装：预缓存核心文件
self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return Promise.allSettled(
        PRE_CACHE.map(function(url) {
          return cache.add(url).catch(function() {
            // 某个文件加载失败不影响整体
          });
        })
      );
    })
  );
  // 立即激活，不等待旧 SW
  self.skipWaiting();
});

// 激活：清理旧版本缓存
self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE_NAME; })
            .map(function(k) { return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

// 请求拦截：网络优先，超时/失败则用缓存兜底
self.addEventListener('fetch', function(e) {
  // 只处理 GET 请求
  if (e.request.method !== 'GET') return;

  // CDN 资源（QR库等）：缓存优先
  if (e.request.url.indexOf('cdn.jsdelivr.net') !== -1 ||
      e.request.url.indexOf('unpkg.com') !== -1) {
    e.respondWith(
      caches.match(e.request).then(function(cached) {
        return cached || fetch(e.request).then(function(resp) {
          var clone = resp.clone();
          caches.open(CACHE_NAME).then(function(c) { c.put(e.request, clone); });
          return resp;
        });
      })
    );
    return;
  }

  // 本地文件：网络优先，3秒超时回退缓存
  e.respondWith(
    new Promise(function(resolve) {
      var timeoutId = setTimeout(function() {
        timeoutId = null;
        caches.match(e.request).then(function(cached) {
          if (cached) resolve(cached);
        });
      }, 3000);

      fetch(e.request).then(function(resp) {
        if (timeoutId) {
          clearTimeout(timeoutId);
          // 更新缓存
          var clone = resp.clone();
          caches.open(CACHE_NAME).then(function(c) { c.put(e.request, clone); });
          resolve(resp);
        }
      }).catch(function() {
        if (timeoutId) {
          clearTimeout(timeoutId);
          caches.match(e.request).then(function(cached) {
            resolve(cached || new Response('离线时不可用', { status: 503 }));
          });
        }
      });
    })
  );
});
