/* VocaAir Service Worker — オフライン動作 + 通知(Web Push) */
const VERSION = 'va-shell-v1';
const META_CACHE = 'va-meta';
const KEEP = [VERSION, META_CACHE, 'va-photos-v1', 'va-runtime-v1'];
const RUNTIME = 'va-runtime-v1';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'scenery.js', 'scenery-data.js', 'notify.js', 'config.js',
  'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png'];
const CDN_PRECACHE = ['https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'];
const RUNTIME_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.jsdelivr.net'];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    await Promise.allSettled(SHELL.map(u => c.add(new Request(u, { cache: 'reload' }))));
    const r = await caches.open(RUNTIME);
    await Promise.allSettled(CDN_PRECACHE.map(u => r.add(new Request(u, { mode: 'no-cors' }))));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (!KEEP.includes(k)) await caches.delete(k);
    await self.clients.claim();
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

/* ---- 通知 ---- */
async function dueCount() {
  try {
    const c = await caches.open(META_CACHE);
    const r = await c.match(self.registration.scope + '__due');
    if (!r) return null;
    const j = await r.json();
    const now = Date.now();
    return (j.times || []).filter(t => (t || 0) <= now).length;
  } catch (e) { return null; }
}
async function showDue() {
  const n = await dueCount();
  const body = n == null ? '復習の時間です。今日の景色へ出発しましょう。'
    : n > 0 ? `復習する単語が${n}語あります。今日の景色へ出発しましょう。` : '復習の時間です。新しい景色に会いに行きましょう。';
  await self.registration.showNotification('VocaAir', { body, tag: 'va-daily', icon: 'icons/icon-192.png', badge: 'icons/icon-192.png' });
}
self.addEventListener('push', e => { e.waitUntil(showDue()); });
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if ('focus' in c) { await c.focus(); return; } }
    await self.clients.openWindow('./');
  })());
});
self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });
