/* ============================================================
   Notify — 復習リマインダー（iPhoneのホーム画面アプリ / PWA 向け）
   ・通知時刻は設定画面で変更できる
   ・アプリを閉じていても届く通知は Web Push が必要 → worker/ の通知サーバーが毎分チェックして送る
     （config.js の pushApi が空のときは「アプリを開いている間」だけ通知する）
   ・iPhoneは iOS 16.4 以降で、Safariの「ホーム画面に追加」したアプリから許可する必要がある
   ============================================================ */
(function () {
  'use strict';
  const CFG = window.VA_CONFIG || {};
  const KEY = 'va_notify';
  const META_CACHE = 'va-meta';
  const st = (() => { try { return Object.assign({ enabled: false, time: '20:00', lastLocal: '' }, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) { return { enabled: false, time: '20:00', lastLocal: '' }; } })();
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) {} };

  const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = () => window.navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
  const serverConfigured = () => !!(CFG.vapidPublicKey && CFG.pushApi);
  function support() {
    return { notif: 'Notification' in window, sw: 'serviceWorker' in navigator, push: 'PushManager' in window };
  }
  const u8 = b64 => { const p = '='.repeat((4 - b64.length % 4) % 4); const s = atob((b64 + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(s, c => c.charCodeAt(0)); };
  const hhmm = d => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  const ymd = d => d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  const api = p => String(CFG.pushApi).replace(/\/$/, '') + p;

  let registration = null;
  async function register() {
    if (!support().sw || location.protocol === 'file:') return null;
    try { registration = await navigator.serviceWorker.register('sw.js'); await navigator.serviceWorker.ready; } catch (e) { console.warn('SW', e); }
    return registration;
  }
  async function reg() { return registration || (support().sw ? navigator.serviceWorker.ready.catch(() => null) : null); }

  /* ---- 復習が必要な単語数をService Workerと共有（通知本文に使う） ---- */
  async function syncDue() {
    try {
      if (!('caches' in window) || typeof loadWords !== 'function') return;
      const times = loadWords().map(w => w.nextDue || 0);
      const c = await caches.open(META_CACHE);
      const scope = (registration && registration.scope) || (location.href.replace(/[^/]*$/, ''));
      await c.put(scope + '__due', new Response(JSON.stringify({ times, at: Date.now() }), { headers: { 'content-type': 'application/json' } }));
    } catch (e) {}
  }
  function dueNow() {
    try { const n = Date.now(); return loadWords().filter(w => (w.nextDue || 0) <= n).length; } catch (e) { return 0; }
  }

  /* ---- サーバー(Web Push) ---- */
  let serverActive = false;
  async function subscribeServer() {
    if (!serverConfigured() || !support().push) return false;
    const r = await reg(); if (!r) return false;
    let sub = await r.pushManager.getSubscription();
    if (!sub) sub = await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: u8(CFG.vapidPublicKey) });
    const res = await fetch(api('/subscribe'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON(), time: st.time, tzOffset: new Date().getTimezoneOffset() }),
    });
    serverActive = res.ok;
    return res.ok;
  }
  async function unsubscribeServer() {
    try {
      const r = await reg(); const sub = r && await r.pushManager.getSubscription();
      if (sub) {
        if (serverConfigured()) { try { await fetch(api('/unsubscribe'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) }); } catch (e) {} }
        await sub.unsubscribe();
      }
    } catch (e) {}
    serverActive = false;
  }

  /* ---- 設定画面から呼ばれる ---- */
  async function onToggle(on) {
    if (!on) { st.enabled = false; save(); await unsubscribeServer(); render(); return; }
    const s = support();
    if (!s.notif || !s.sw) { st.enabled = false; save(); render(); return; }
    if (isIOS() && !isStandalone()) { st.enabled = false; save(); render(); return; }
    let perm = Notification.permission;
    if (perm === 'default') perm = await Notification.requestPermission(); // ユーザーのタップ操作の中で呼ぶ必要がある
    if (perm !== 'granted') { st.enabled = false; save(); render(); return; }
    st.enabled = true; save();
    await register(); await syncDue();
    try { await subscribeServer(); } catch (e) { console.warn('push subscribe', e); }
    render();
    if (typeof toast === 'function') toast('通知をオンにしました');
  }
  async function onTime(v) {
    if (!/^\d{2}:\d{2}$/.test(v)) return;
    st.time = v; st.lastLocal = ''; save();
    if (st.enabled) { try { await subscribeServer(); } catch (e) {} }
    render();
  }
  async function test() {
    const r = await reg();
    if (!r || Notification.permission !== 'granted') { if (typeof toast === 'function') toast('先に通知をオンにしてください'); return; }
    const n = dueNow();
    await r.showNotification('VocaAir', { body: n ? `復習する単語が${n}語あります。` : 'テスト通知です。', tag: 'va-test', icon: 'icons/icon-192.png' });
  }

  function statusText() {
    const s = support();
    if (location.protocol === 'file:') return 'ファイルを直接開いている間は通知を使えません（公開URLで開いてください）';
    if (isIOS() && !isStandalone()) return 'iPhoneでは、Safariの共有ボタン →「ホーム画面に追加」で追加したアプリから開くと設定できます（iOS 16.4以降）';
    if (!s.notif || !s.sw) return 'このブラウザは通知に対応していません';
    if (Notification.permission === 'denied') return '通知が許可されていません。iPhoneの「設定 > 通知 > VocaAir」で許可してください';
    if (!st.enabled) return 'オフ';
    if (serverActive || (serverConfigured() && s.push)) return `毎日 ${st.time} にお知らせします（アプリを閉じていても届きます）`;
    return `毎日 ${st.time} にお知らせします（通知サーバー未接続のため、アプリを開いている間のみ）`;
  }
  function render() {
    const t = document.getElementById('nt-time'), c = document.getElementById('nt-enable'), s = document.getElementById('nt-status');
    if (t) t.value = st.time;
    if (c) c.checked = !!st.enabled && (typeof Notification === 'undefined' || Notification.permission === 'granted');
    if (s) s.textContent = statusText();
  }

  /* ---- アプリを開いている間のフォールバック通知 ---- */
  async function localTick() {
    if (!st.enabled || serverActive || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const now = new Date();
    if (ymd(now) === st.lastLocal || hhmm(now) < st.time) return;
    const n = dueNow(); if (!n) return;
    const r = await reg(); if (!r) return;
    st.lastLocal = ymd(now); save();
    r.showNotification('VocaAir', { body: `復習する単語が${n}語あります。`, tag: 'va-daily', icon: 'icons/icon-192.png' });
  }

  async function init() {
    await register();
    await syncDue();
    if (st.enabled && Notification.permission === 'granted') { try { await subscribeServer(); } catch (e) {} } // タイムゾーン変更にも追従
    render();
    setInterval(localTick, 60000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { syncDue(); localTick(); } });
  }

  window.Notify = { init, onToggle, onTime, test, render, syncDue };
})();
