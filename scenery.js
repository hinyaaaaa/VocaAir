/* ============================================================
   Scenery — 世界の景色を背景にするモジュール
   ------------------------------------------------------------
   ・地点: 基準地点(SCENERY_ANCHORS) × 61区画(中心+周囲の同心円) = 15,000通り以上
   ・写真: Wikimedia Commons の「位置情報つきファイル」を geosearch で取得。
     記事サムネイル(国旗・地図が混ざる原因)は一切使わない。
     JPEG・横長・高解像度・許諾OK・タイトルに旗/地図/人物/室内等を含まない、で絞り込む。
   ・オフライン: 表示した写真は Cache Storage に保存し、一部は事前にまとめて保存(オフラインパック)。
     通信できない時は保存済みの写真からランダムに表示。何も無ければグラデーション。
   ============================================================ */
(function () {
  'use strict';

  const ANCHORS = window.SCENERY_ANCHORS || [];
  const THUMB_W = 1920;                       // Wikimediaの標準サムネイル幅
  const API = 'https://commons.wikimedia.org/w/api.php';
  const PHOTO_CACHE = 'va-photos-v1';
  const MAX_POOL = 80;                        // 端末に保存しておく写真の上限
  const KEY_PICK = 'va_scn_pick';             // 地点index → 選ばれた写真
  const KEY_POOL = 'va_scn_pool';             // オフラインで使える写真のメタ情報
  const KEY_BLOCK = 'va_scn_block';           // 「表示しない」にした写真
  const KEY_RECENT = 'va_scn_recent';         // 最近行った地点（重複回避）

  /* ---------- 地点カタログ ---------- */
  // 区画: [距離km, 方位の数] のリング。中心1 + 8 + 12 + 16 + 24 = 61
  const RINGS = [[0, 1], [4, 8], [9, 12], [16, 16], [25, 24]];
  const CELLS = [];
  RINGS.forEach(([km, n], ri) => {
    for (let i = 0; i < n; i++) {
      const bearing = (360 / n) * i + (ri % 2 ? 11 : 0);
      CELLS.push({ km, bearing, radius: km === 0 ? 9000 : 6000 });
    }
  });
  const CELLS_PER = CELLS.length;
  const PLACE_COUNT = ANCHORS.length * CELLS_PER;

  function place(idx) {
    idx = ((idx % PLACE_COUNT) + PLACE_COUNT) % PLACE_COUNT;
    const ai = Math.floor(idx / CELLS_PER), ci = idx % CELLS_PER;
    const [city, code, lat0, lon0] = ANCHORS[ai];
    const c = CELLS[ci];
    const dLat = (c.km * Math.cos(c.bearing * Math.PI / 180)) / 111.32;
    const dLon = (c.km * Math.sin(c.bearing * Math.PI / 180)) / (111.32 * Math.max(0.2, Math.cos(lat0 * Math.PI / 180)));
    return { idx, anchor: ai, cell: ci, city, code, lat: lat0 + dLat, lon: lon0 + dLon, radius: c.radius };
  }

  /* ---------- localStorage 小物 ---------- */
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
  };
  const rand = n => Math.floor(Math.random() * n);

  function randomPlaceIdx(excludeIdx) {
    const recent = new Set(ls.get(KEY_RECENT, []));
    let i, guard = 0;
    do { i = rand(PLACE_COUNT); guard++; }
    while ((i === excludeIdx || (recent.has(i) && guard < 30)) && guard < 60);
    return i;
  }
  function markVisited(idx) {
    const r = ls.get(KEY_RECENT, []);
    r.push(idx);
    ls.set(KEY_RECENT, r.slice(-60));
  }

  /* ---------- 写真の絞り込み ---------- */
  // 旗・地図・紋章・図表・人物・室内・乗り物・看板・展示物・文書などを除外
  const BAD_EN = /\b(flag|flags|map|maps|mapa|karte|carte|locator|location|plan|diagram|chart|graph|coat of arms|arms|crest|emblem|logo|seal|icon|stamp|coin|banknote|signature|screenshot|scan|scanned|document|manuscript|book|page|letter|newspaper|poster|advert|banner|billboard|sign|signs|plaque|menu|interior|inside|room|lobby|kitchen|portrait|selfie|people|crowd|man|woman|girl|boy|child|children|family|wedding|festival|parade|protest|rally|concert|match|game|bus|train|tram|metro|subway|car|cars|truck|taxi|bike|bicycle|motorcycle|aircraft|airplane|plane|airport|helicopter|ship|boat|ferry|food|dish|meal|restaurant|shop|store|market|museum|exhibit|exhibition|painting|drawing|sculpture|statue|bust|grave|tomb|cemetery|stadium|hospital|school|university|office|building site|construction|panorama of the|montage|collage|composite|timeline|pictogram|coa|bandera|drapeau|bandiera)\b/i;
  const BAD_JA = /(旗|地図|位置図|紋章|国章|ロゴ|図|表|地形図|ポスター|看板|室内|内部|肖像|人物|祭|パレード|バス|電車|自動車|飛行機|料理|博物館|絵画|彫刻|像|墓)/;
  const OK_LICENSE = /^(cc[ -]?by|cc0|public domain|pd|attribution|gfdl)/i;

  function normTitle(t) {
    return String(t || '').replace(/^File:/i, '').replace(/\.[a-z0-9]{3,4}$/i, '').replace(/[_\-.,()\d]+/g, ' ').toLowerCase();
  }
  function stripHtml(s) { return String(s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(); }

  function acceptPage(p, blocked) {
    const ii = p && p.imageinfo && p.imageinfo[0];
    if (!ii) return null;
    if (ii.mime !== 'image/jpeg') return null;
    const w = ii.width, h = ii.height;
    if (!(w >= 1800 && h >= 1000)) return null;
    const ratio = w / h;
    if (ratio < 1.25 || ratio > 2.4) return null;              // 横長の風景写真だけ
    if (blocked.has(p.title)) return null;
    const t = normTitle(p.title);
    if (BAD_EN.test(t) || BAD_JA.test(p.title)) return null;
    const em = ii.extmetadata || {};
    const lic = stripHtml(em.LicenseShortName && em.LicenseShortName.value);
    if (!OK_LICENSE.test(lic)) return null;
    const desc = stripHtml(em.ImageDescription && em.ImageDescription.value).toLowerCase();
    if (desc && (BAD_EN.test(desc.slice(0, 160)))) return null;
    return {
      id: p.title,
      url: ii.thumburl || ii.url,
      page: ii.descriptionurl || '',
      artist: stripHtml(em.Artist && em.Artist.value).slice(0, 60),
      license: lic,
    };
  }

  async function geosearch(lat, lon, radius, blocked) {
    const qs = new URLSearchParams({
      action: 'query', format: 'json', origin: '*',
      generator: 'geosearch', ggscoord: lat.toFixed(5) + '|' + lon.toFixed(5),
      ggsradius: String(Math.min(10000, radius)), ggsnamespace: '6', ggslimit: '50',
      prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: String(THUMB_W),
      iiextmetadatafilter: 'Artist|LicenseShortName|ImageDescription',
    });
    const res = await fetch(API + '?' + qs.toString());
    if (!res.ok) throw new Error('commons ' + res.status);
    const data = await res.json();
    const pages = data && data.query && data.query.pages;
    if (!pages) return [];
    return Object.values(pages).map(p => acceptPage(p, blocked)).filter(Boolean);
  }

  /* ---------- 写真の決定 ---------- */
  // 地点 → 写真。区画に写真が無ければ同じ基準地点内の別区画へ。
  async function resolvePhoto(idx) {
    const picks = ls.get(KEY_PICK, {});
    if (picks[idx]) return picks[idx];
    if (!navigator.onLine) return null;
    const blocked = new Set(ls.get(KEY_BLOCK, []));
    const p0 = place(idx);
    const tries = [idx];
    tries.push(p0.anchor * CELLS_PER);                          // 中心
    for (let k = 0; k < 2; k++) tries.push(p0.anchor * CELLS_PER + rand(CELLS_PER));
    for (const ti of tries) {
      const p = place(ti);
      let list = [];
      try { list = await geosearch(p.lat, p.lon, p.radius, blocked); } catch (e) { console.warn(e); }
      if (list.length) {
        const photo = list[rand(list.length)];
        photo.city = p0.city;
        picks[idx] = photo;
        const keys = Object.keys(picks);
        if (keys.length > 250) keys.slice(0, keys.length - 250).forEach(k => delete picks[k]);
        ls.set(KEY_PICK, picks);
        return photo;
      }
    }
    return null;
  }

  /* ---------- オフライン保存 ---------- */
  async function cacheHas(url) {
    try { const c = await caches.open(PHOTO_CACHE); return !!(await c.match(url)); } catch (e) { return false; }
  }
  async function savePhoto(photo) {
    try {
      if (!('caches' in window)) return false;
      const c = await caches.open(PHOTO_CACHE);
      if (!(await c.match(photo.url))) {
        const res = await fetch(photo.url, { mode: 'cors' });
        if (!res.ok) return false;
        await c.put(photo.url, res);
      }
      let pool = ls.get(KEY_POOL, []).filter(x => x.url !== photo.url);
      pool.push(photo);
      while (pool.length > MAX_POOL) {
        const old = pool.shift();
        try { await c.delete(old.url); } catch (e) {}
      }
      ls.set(KEY_POOL, pool);
      return true;
    } catch (e) { return false; }
  }
  async function blobUrlFromCache(url) {
    try {
      const c = await caches.open(PHOTO_CACHE);
      const r = await c.match(url);
      if (!r) return null;
      return URL.createObjectURL(await r.blob());
    } catch (e) { return null; }
  }
  function loadImg(src) {
    return new Promise((ok, ng) => { const im = new Image(); im.onload = () => ok(src); im.onerror = ng; im.src = src; });
  }
  async function pickFromPool() {
    const pool = ls.get(KEY_POOL, []);
    const order = pool.map((_, i) => i).sort(() => Math.random() - 0.5);
    for (const i of order) {
      const b = await blobUrlFromCache(pool[i].url);
      if (b) { try { await loadImg(b); return { photo: pool[i], src: b }; } catch (e) {} }
    }
    return null;
  }

  // オフラインパック: 世界中から n 枚をまとめて保存
  async function prefetchPack(n, onProgress) {
    if (!navigator.onLine) return { saved: 0, error: 'offline' };
    const have = ls.get(KEY_POOL, []).length;
    const want = Math.max(0, Math.min(MAX_POOL, n) - have);
    let saved = 0, done = 0, failures = 0;
    const used = new Set();
    while (saved < want && failures < want * 3 + 6) {
      const ai = rand(ANCHORS.length);
      if (used.has(ai)) { failures++; continue; }
      used.add(ai);
      const idx = ai * CELLS_PER; // 中心区画
      let photo = null;
      try { photo = await resolvePhoto(idx); } catch (e) {}
      if (photo && await savePhoto(photo)) saved++; else failures++;
      done++;
      if (onProgress) onProgress({ saved, want });
    }
    return { saved, want };
  }
  async function clearOffline() {
    try { await caches.delete(PHOTO_CACHE); } catch (e) {}
    ls.set(KEY_POOL, []);
  }
  function offlineCount() { return ls.get(KEY_POOL, []).length; }

  /* ---------- 表示 ---------- */
  const GRADIENTS = [
    'linear-gradient(160deg,#2b3a67,#4a2545 60%,#7a4a2e)',
    'linear-gradient(160deg,#1f3d3a,#2d5f56 55%,#e8b84b)',
    'linear-gradient(160deg,#3a1f3d,#6b2d5f 55%,#e88a4b)',
    'linear-gradient(160deg,#1a2f4a,#2d5f8f 55%,#d9c27a)',
    'linear-gradient(160deg,#2f1f1a,#7a3a2e 55%,#e8c66a)',
  ];
  function gradientFor(city) {
    let h = 0; for (const ch of String(city)) h = (h * 31 + ch.charCodeAt(0)) | 0;
    return GRADIENTS[Math.abs(h) % GRADIENTS.length];
  }

  let token = 0, lastBlob = null, current = null;
  function setCredit(photo) {
    const el = document.getElementById('dest-credit');
    if (!el) return;
    if (!photo) { el.innerHTML = ''; el.classList.remove('has'); return; }
    const who = photo.artist ? photo.artist : 'Wikimedia Commons';
    const a = document.createElement('a');
    a.href = photo.page || '#'; a.target = '_blank'; a.rel = 'noopener';
    a.textContent = '📷 ' + who + ' / ' + (photo.license || 'CC');
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = 'この写真は表示しない'; b.onclick = blockCurrent;
    el.innerHTML = ''; el.appendChild(a); el.appendChild(b); el.classList.add('has');
  }

  async function show(idx) {
    const my = ++token;
    const layer = document.getElementById('dest-bg');
    if (!layer) return;
    const p = place(idx);
    current = { idx, photo: null };
    layer.style.backgroundImage = gradientFor(p.city);
    setCredit(null);
    let photo = null;
    try { photo = await resolvePhoto(idx); } catch (e) {}
    if (my !== token) return;
    let src = null;
    if (photo) {
      src = await blobUrlFromCache(photo.url);        // 保存済みなら通信不要
      if (!src && navigator.onLine) {
        try { await loadImg(photo.url); src = photo.url; savePhoto(photo); } catch (e) {}
      }
    }
    if (!src) {                                         // 通信不可・取得失敗 → 保存済みの別の景色
      const alt = await pickFromPool();
      if (my !== token) return;
      if (alt) { photo = alt.photo; src = alt.src; }
    }
    if (my !== token) return;
    if (src) {
      if (lastBlob && lastBlob !== src && lastBlob.startsWith('blob:')) { try { URL.revokeObjectURL(lastBlob); } catch (e) {} }
      lastBlob = src;
      layer.style.backgroundImage = `url("${src}")`;
      current.photo = photo;
      setCredit(photo);
    }
  }

  function blockCurrent() {
    if (!current || !current.photo) return;
    const blocked = ls.get(KEY_BLOCK, []);
    blocked.push(current.photo.id);
    ls.set(KEY_BLOCK, blocked.slice(-500));
    const picks = ls.get(KEY_PICK, {});
    delete picks[current.idx];
    ls.set(KEY_PICK, picks);
    ls.set(KEY_POOL, ls.get(KEY_POOL, []).filter(x => x.id !== current.photo.id));
    show(current.idx);
  }

  window.Scenery = {
    PLACE_COUNT, place, randomPlaceIdx, markVisited, show,
    prefetchPack, clearOffline, offlineCount, maxPool: MAX_POOL,
    _test: { acceptPage, CELLS, normTitle },
  };
})();
