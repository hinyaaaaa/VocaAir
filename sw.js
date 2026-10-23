/* VocaAir Service Worker — オフライン動作 */
const VERSION = 'va-shell-v1.9.0';
const KEEP = [VERSION, 'va-photos-v1', 'va-runtime-v1'];
const RUNTIME = 'va-runtime-v1';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'scenery.js', 'scenery-data.js', 'sync-core.js', 'sync-firebase.js', 'sync.js', 'vendor/xlsx.full.min.js',
  'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png'];
const RUNTIME_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    await Promise.allSettled(SHELL.map(u => c.add(new Request(u, { cache: 'reload' }))));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (!KEEP.includes(k)) await caches.delete(k);
    await self.clients.claim();
    // v1.8.0: 通知機能の廃止。残っている Push 購読があれば解除する
    try { const sub = await self.registration.pushManager.getSubscription(); if (sub) await sub.unsubscribe(); } catch (e) {}
  })());
});

async function staleWhileRevalidate(req, cacheName) {
  const c = await caches.open(cacheName);
  const hit = await c.match(req);
  const net = fetch(req).then(res => { if (res && (res.ok || res.type === 'opaque')) c.put(req, res.clone()); return res; }).catch(() => null);
  return hit || (await net) || Response.error();
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 3500);
        const res = await fetch(req, { signal: ctrl.signal }); clearTimeout(t);
        const c = await caches.open(VERSION); c.put('index.html', res.clone());
        return res;
      } catch (err) {
        return (await caches.match('index.html')) || (await caches.match('./')) || Response.error();
      }
    })());
    return;
  }
  if (url.origin === self.location.origin) {
    // 自分のファイルは「まずネットワーク(3秒で見切り)、だめなら保存済み」: 更新が次回起動まで遅れず、オフラインでも動く
    e.respondWith((async () => {
      const c = await caches.open(VERSION);
      try {
        const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 3000);
        const res = await fetch(req, { signal: ctrl.signal }); clearTimeout(t);
        if (res.ok) c.put(req, res.clone());
        return res;
      } catch (err) { return (await c.match(req)) || Response.error(); }
    })());
    return;
  }
  if (RUNTIME_HOSTS.includes(url.hostname)) { e.respondWith(staleWhileRevalidate(req, RUNTIME)); return; }
});

self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });
