/* ============================================================
   sync.js — 複数端末の同期の画面とアプリ連携（v1.9.0 新設）
   ------------------------------------------------------------
   ロジックは sync-core.js、Firebase との通信は sync-firebase.js。ここは
   「設定の保存・ログイン・状態表示・他端末の内容を取り込んだら画面を更新」を繋ぐだけ。
   Firebase の構成を入れていなければ何もしない。通信に失敗してもアプリは動く。
   app.js の loadDecks / saveDecks などと toast / confirm を使う（app.js より後に読み込む）。
   ============================================================ */
(function () {
  'use strict';

  const CONFIG_KEY = 'va-firebase-config';
  const EMAIL_KEY = 'va-sync-email';
  const META_PREFIX = 'va-sync-meta-';
  // Temper が同じ端末・同じURL配下に保存している設定（あれば「同じ設定を使う」で引き継げる）
  const TEMPER_CONFIG_KEY = 'temper-firebase-config';
  const TEMPER_EMAIL_KEY = 'temper-sync-email';

  let engine = null;
  let fb = null;
  let status = 'off'; // off | signedout | connecting | synced | offline | error:*
  let user = null;

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };

  /* ---------- Firebase の構成（貼り付けたテキストの解析と検証） ---------- */

  /** コンソールに表示される `const firebaseConfig = { ... };` をそのまま貼れるようにする */
  function parseFirebaseConfig(text) {
    const t = String(text || '');
    // コンソールのコードには `import { initializeApp } from ...` なども含まれるので、
    // 最初の { ではなく、apiKey を含む { … } を探す
    const k = t.indexOf('apiKey');
    if (k < 0) return null;
    const a = t.lastIndexOf('{', k), b = t.indexOf('}', k);
    if (a < 0 || b <= a) return null;
    const body = t.slice(a, b + 1)
      .replace(/\/\/.*$/gm, '')
      .replace(/'/g, '"')
      .replace(/([{,]\s*)([A-Za-z_][\w]*)\s*:/g, '$1"$2":')
      .replace(/,\s*}/g, '}');
    try { return validateConfig(JSON.parse(body)); } catch (e) { return null; }
  }
  /** 使うキーだけを、形式を確かめて残す（想定外の値を持つ設定は受け付けない） */
  function validateConfig(c) {
    if (!c || typeof c !== 'object') return null;
    const RULES = {
      apiKey: /^[\w-]{20,100}$/,
      authDomain: /^[a-z0-9.-]{4,100}$/i,
      projectId: /^[a-z0-9-]{4,40}$/,
      storageBucket: /^[a-z0-9._-]{4,100}$/i,
      messagingSenderId: /^[0-9]{4,30}$/,
      appId: /^[\w:.-]{6,100}$/,
      measurementId: /^[\w-]{4,40}$/,
    };
    const out = {};
    for (const k of Object.keys(RULES)) {
      if (c[k] == null) continue;
      if (typeof c[k] !== 'string' || !RULES[k].test(c[k])) return null;
      out[k] = c[k];
    }
    return out.apiKey && out.projectId && out.appId ? out : null;
  }
  function readConfig(key) {
    try { return validateConfig(JSON.parse(lsGet(key) || 'null')); } catch (e) { return null; }
  }
  const loadConfig = () => readConfig(CONFIG_KEY);

  /* ---------- 状態表示 ---------- */

  function statusLabel() {
    if (status === 'off') return '未設定';
    if (status === 'signedout') return 'ログインしていません';
    if (status === 'connecting') return '接続中…';
    if (status === 'synced') return '同期中' + (user && user.email ? '（' + user.email + '）' : '');
    if (status === 'offline') return 'オフライン（戻ったら自動で同期します）';
    if (status === 'error:load') return 'Firebaseを読み込めませんでした（通信を確認してください）';
    if (status === 'error:permission-denied') return 'エラー：権限がありません（Firestoreのルールを確認）';
    if (status === 'error:storage') return 'エラー：この端末に保存できませんでした（容量を確認）';
    return 'エラー：' + status.replace(/^error:/, '');
  }
  function setStatus(s) {
    status = s;
    const el = document.getElementById('sync-status');
    if (el) el.textContent = statusLabel();
  }

  /* ---------- 他の端末の内容を取り込んだ後の保存と画面更新 ---------- */

  function activeScreen() {
    const el = document.querySelector('.screen.active');
    return el ? el.id.replace(/^screen-/, '') : '';
  }
  function onRemoteApplied(state, touched) {
    try {
      // LS を直接書く（saveDecks 等を通さない＝取り込んだ内容を送り返す動きを起こさない）
      if (touched.has('decks')) LS.set('vq_decks', state.decks);
      if (touched.has('words')) LS.set('vq_words', state.words);
      if (touched.has('settings')) LS.set('vq_settings', state.settings);
    } catch (e) {
      setStatus('error:storage');
      return;
    }
    // クイズ中・結果画面・取り込み画面は、操作を邪魔しないよう更新しない（次に画面を開いたとき最新になる）
    const s = activeScreen();
    try {
      if (s === 'home') renderHome();
      else if (s === 'words') renderWords();
      else if (s === 'settings') initSettings();
    } catch (e) { /* 再描画に失敗してもデータは保存済み */ }
  }

  /* ---------- 起動・ログイン状態に合わせたエンジンの開始と停止 ---------- */

  function stopEngine() {
    if (engine) { try { engine.stop(); } catch (e) { /* 止められなくても続ける */ } engine = null; }
  }

  async function init() {
    const cfg = loadConfig();
    if (!cfg) { setStatus('off'); return; }
    setStatus('connecting');
    try {
      fb = await window.VaSyncFirebase.loadFirebase(cfg);
      fb.onAuthChanged((u) => {
        stopEngine();
        user = u || null;
        if (activeScreen() === 'settings') renderCard();
        if (!u) { setStatus('signedout'); return; }
        setStatus('connecting');
        engine = window.VaSyncCore.createSyncEngine({
          getState: () => ({ decks: loadDecks(), words: loadWords(), settings: loadSettings() }),
          backend: fb.makeBackend(u.uid),
          metaStore: {
            get: () => { try { return JSON.parse(localStorage.getItem(META_PREFIX + u.uid) || 'null'); } catch (e) { return null; } },
            set: (m) => localStorage.setItem(META_PREFIX + u.uid, JSON.stringify(m)),
          },
          normalizeDeck: cleanDeck,
          normalizeWord: cleanWord,
          normalizeSettings: cleanSettings,
          onStatus: (s) => setStatus(navigator.onLine === false ? 'offline' : s),
          onRemoteApplied,
        });
        engine.start();
      });
      window.addEventListener('offline', () => { if (engine) setStatus('offline'); });
      window.addEventListener('online', () => { if (engine) { setStatus('synced'); engine.flush(); } });
    } catch (e) {
      console.error('[VocaAir] sync init failed', e);
      setStatus('error:load');
    }
  }

  /* ---------- 操作（設定画面のボタンから） ---------- */

  function saveConfig() {
    const cfg = parseFirebaseConfig((document.getElementById('sync-config') || {}).value);
    if (!cfg) { toast('Firebaseの構成（apiKey・projectId・appIdを含む）を貼り付けてください'); return; }
    try { localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg)); } catch (e) { toast('保存できませんでした'); return; }
    location.reload(); // 読み込み直して初期化する
  }
  function useTemperConfig() {
    const cfg = readConfig(TEMPER_CONFIG_KEY);
    if (!cfg) { toast('Temperの設定が見つかりません'); return; }
    try { localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg)); } catch (e) { toast('保存できませんでした'); return; }
    location.reload();
  }
  async function auth(kind) {
    if (!fb) { toast('まだ接続できていません。少し待ってからもう一度お試しください'); return; }
    const email = (document.getElementById('sync-email') || {}).value.trim();
    const pw = (document.getElementById('sync-pw') || {}).value || '';
    if (!email || pw.length < 6) { toast('メールアドレスと6文字以上のパスワードを入れてください'); return; }
    try {
      try { localStorage.setItem(EMAIL_KEY, email); } catch (e) { /* 覚えられなくても続ける */ }
      if (kind === 'up') await fb.signUp(email, pw); else await fb.signIn(email, pw);
    } catch (e) {
      const code = e && e.code ? e.code : '';
      toast(code.includes('invalid') || code.includes('wrong') ? 'メールアドレスかパスワードが違います'
        : code.includes('email-already') ? 'このメールアドレスは登録済みです。ログインしてください'
        : code.includes('weak') ? 'パスワードが短すぎます'
        : code.includes('operation-not-allowed') ? 'Firebaseでメール/パスワードのログインが有効になっていません'
        : 'ログインできませんでした（' + (code || '通信エラー') + '）');
    }
  }
  async function signOut() {
    if (fb) { try { await fb.signOut(); } catch (e) { /* 失敗しても画面は戻す */ } }
    renderCard();
  }
  function clearConfig() {
    confirm('同期をやめますか', 'この端末の同期設定を消します。この端末のデータと、クラウド上のデータはそのまま残ります。', () => {
      stopEngine();
      try {
        localStorage.removeItem(CONFIG_KEY);
        Object.keys(localStorage).filter((k) => k.startsWith(META_PREFIX)).forEach((k) => localStorage.removeItem(k));
      } catch (e) { /* 消せなくても再読込で判断される */ }
      location.reload();
    }, '🔌');
  }
  function syncNow() {
    if (!engine || !engine.ready) { toast('同期の準備中です。少し待ってからもう一度お試しください'); return; }
    const n = engine.flush().length;
    toast(n ? n + ' 件を送信しました' : '送るものはありません（最新です）');
  }

  /* ---------- 設定画面のカード ---------- */

  function renderCard() {
    const el = document.getElementById('sync-card');
    if (!el) return;
    const head = '<div class="settings-label">複数端末の同期</div>'
      + '<p class="set-note" id="sync-status">' + esc(statusLabel()) + '</p>';
    const cfg = loadConfig();
    if (!cfg) {
      const t = readConfig(TEMPER_CONFIG_KEY);
      el.innerHTML = head
        + '<textarea id="sync-config" class="form-input" rows="4" placeholder="Firebaseの構成（const firebaseConfig = {…}）を貼り付け" style="margin-top:10px"></textarea>'
        + '<div class="btn-row"><button class="btn sm primary" onclick="VaSync.saveConfig()">同期を設定する</button>'
        + (t ? '<button class="btn sm ghost" onclick="VaSync.useTemperConfig()">Temperと同じ設定を使う</button>' : '')
        + '</div>'
        + '<p class="form-hint">設定のしかたは SYNC_SETUP.md に書いてあります。Temperで同期を設定済みなら、同じFirebaseをそのまま使えます。</p>';
      return;
    }
    if (user) {
      el.innerHTML = head
        + '<div class="btn-row"><button class="btn sm primary" onclick="VaSync.syncNow()">いますぐ同期</button>'
        + '<button class="btn sm ghost" onclick="VaSync.signOut()">ログアウト</button>'
        + '<button class="btn sm danger" onclick="VaSync.clearConfig()">同期をやめる</button></div>';
      return;
    }
    const email = lsGet(EMAIL_KEY) || lsGet(TEMPER_EMAIL_KEY) || '';
    el.innerHTML = head
      + '<input id="sync-email" class="form-input" type="email" autocomplete="username" placeholder="メールアドレス" value="' + esc(email) + '" style="margin-top:10px">'
      + '<input id="sync-pw" class="form-input" type="password" autocomplete="current-password" placeholder="パスワード（6文字以上）" style="margin-top:10px">'
      + '<div class="btn-row"><button class="btn sm primary" onclick="VaSync.auth(\'in\')">ログイン</button>'
      + '<button class="btn sm ghost" onclick="VaSync.auth(\'up\')">新規登録</button>'
      + '<button class="btn sm danger" onclick="VaSync.clearConfig()">同期をやめる</button></div>'
      + '<p class="form-hint">Temperと同じメールアドレス・パスワードで登録できます（ログインは別々に必要です）。</p>';
  }

  window.VaSync = {
    notifyLocalChange() { if (engine) engine.notifyLocalChange(); },
    active() { return !!engine; },
    renderCard, saveConfig, useTemperConfig, auth, signOut, clearConfig, syncNow,
    parseFirebaseConfig, // テスト用
  };

  init();
})();
