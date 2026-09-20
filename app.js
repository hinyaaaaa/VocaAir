
/* ============================================================
   DATA LAYER
   ============================================================ */
const LS = {
  get: k => { try{ return JSON.parse(localStorage.getItem(k)||'null'); }catch(e){ return null; } },
  set: (k,v) => localStorage.setItem(k, JSON.stringify(v)),
};
const loadDecks = () => LS.get('vq_decks') || [];
const saveDecks = d => LS.set('vq_decks', d);
const loadWords = () => LS.get('vq_words') || [];
const saveWords = w => LS.set('vq_words', w);
const loadSettings = () => LS.get('vq_settings') || { dim: 0.45 };
const saveSettings = s => LS.set('vq_settings', s);
const normalizeKey = s => String(s || '').trim().normalize('NFKC').toLowerCase();

/* ============================================================
   BACKUP — JSON export / import（進捗の完全復旧用）
   ============================================================ */
let _backupFileHandle = null; // 一度「保存」した先のファイルハンドル。次回から上書き保存に使う

async function exportBackup() {
  const payload = {
    app: 'VocaAir',
    version: 1,
    exportedAt: new Date().toISOString(),
    decks: loadDecks(),
    words: loadWords(),
    settings: loadSettings(),
  };
  const json = JSON.stringify(payload, null, 2);
  const filename = 'VocaAir_save_data.json';

  // 対応ブラウザ(Chrome/Edge等)では File System Access API で「保存」ダイアログを出し、
  // 2回目以降は同じファイルへ上書き保存できるようにする。
  if (window.showSaveFilePicker) {
    try {
      const handle = _backupFileHandle || await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(json);
      await writable.close();
      _backupFileHandle = handle;
      toast('JSONファイルを保存しました（上書き保存）');
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return; // ユーザーがキャンセル
      // 権限エラー等は下のフォールバックへ
    }
  }

  // 非対応ブラウザ(Safari・Firefox・モバイル等)向けフォールバック：通常のダウンロード
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast('JSONファイルを書き出しました');
}

function importBackup(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try { data = JSON.parse(reader.result); }
    catch (e) { toast('JSONファイルの読み込みに失敗しました'); input.value = ''; return; }

    if (!data || !Array.isArray(data.decks) || !Array.isArray(data.words)) {
      toast('このファイルはVocaAirのバックアップ形式ではありません');
      input.value = '';
      return;
    }
    const deckCount = data.decks.length;
    const wordCount = data.words.length;
    confirm(
      `単語帳 ${deckCount} 件・単語 ${wordCount} 件を復元します`,
      '現在この端末にあるデータはすべて上書きされます。この操作は取り消せません',
      () => {
        saveDecks(data.decks);
        saveWords(data.words);
        if (data.settings) saveSettings(data.settings);
        localStorage.removeItem('vq_session');
        toast('復元しました');
        input.value = '';
        renderAll();
        showScreen('home');
      },
      '📥'
    );
  };
  reader.readAsText(file);
}

/* ============================================================
   SRS ENGINE — Anki相当のスケジューリング
   ------------------------------------------------------------
   - 4段階評価: Again(1) / Hard(2) / Good(3) / Easy(4)
   - 新規カードは「学習ステップ」を経てから本スケジュールへ卒業する
     （セッション内で近いうちに再出題される＝Ankiの学習キューを
      「経過分数」ではなく「あと何枚後に出すか」で近似したもの）
   - 復習カードを忘れた(Again)場合は「再学習ステップ」を経てから
     間隔を半分にして復帰する（いきなり1日にリセットしない）
   - 間隔には ±5% のfuzzを掛けて同じ日に固まるのを防ぐ
   - 上限間隔・リーチ（何度も間違える単語）検知も搭載
   ============================================================ */
const SRS = {
  graduatingInterval: 1,   // 学習ステップ卒業(Good)後の初回間隔(日)
  easyInterval: 4,         // Easyで即卒業した場合の間隔(日)
  easyBonus: 1.3,          // Easy時のボーナス倍率
  hardFactor: 1.2,         // Hard時の間隔倍率
  newLapseIntervalFactor: 0.5, // 復習カードをAgainした時、新しい間隔 = 直前間隔 × これ
  minEf: 1.3,
  startEf: 2.5,
  maxIntervalDays: 1825,   // 上限5年
  leechThreshold: 8,       // この回数Againしたらリーチ扱い
  fuzzRatio: 0.05,         // ±5%
};

function ensureSrsFields(w) {
  if (!w.state) w.state = (w.reps > 0) ? 'review' : 'new';
  if (typeof w.lapses !== 'number') w.lapses = 0;
  if (typeof w.learningStep !== 'number') w.learningStep = 0;
  if (typeof w.ef !== 'number') w.ef = SRS.startEf;
  if (typeof w.interval !== 'number') w.interval = 1;
  return w;
}

function fuzzInterval(days) {
  if (days < 3) return days; // 短い間隔はfuzzさせない(Anki準拠)
  const delta = Math.max(1, Math.round(days * SRS.fuzzRatio));
  const jitter = Math.floor(Math.random() * (delta * 2 + 1)) - delta;
  return Math.max(1, days + jitter);
}

function capInterval(days) {
  return Math.min(days, SRS.maxIntervalDays);
}

/**
 * 1枚のカードを1回分採点する。
 * grade: 1=Again, 2=Hard, 3=Good, 4=Easy
 * 戻り値: { requeue: boolean, requeueOffset: number, graduated: boolean }
 *   requeue=true の場合、呼び出し側は同一セッション内でこの単語を
 *   requeueOffset 枚後あたりに再度キューへ差し込むこと。
 */
function gradeCard(word, grade) {
  ensureSrsFields(word);
  const now = Date.now();
  let result = { requeue: false, requeueOffset: 0 };

  if (word.state === 'new' || word.state === 'learning') {
    if (grade === 1) { // Again
      word.state = 'learning'; word.learningStep = 0;
      result = { requeue: true, requeueOffset: 2 };
    } else if (grade === 2) { // Hard — 同じステップを繰り返す
      word.state = 'learning'; word.learningStep = Math.max(0, word.learningStep);
      result = { requeue: true, requeueOffset: 4 };
    } else if (grade === 3) { // Good
      if (word.learningStep >= 1) {
        // 2段階目もクリア → 卒業
        word.state = 'review'; word.reps = (word.reps||0) + 1;
        word.interval = SRS.graduatingInterval;
        word.nextDue = now + word.interval * 86400000;
      } else {
        word.state = 'learning'; word.learningStep = 1;
        result = { requeue: true, requeueOffset: 7 };
      }
    } else { // Easy — 即卒業＋ボーナス間隔
      word.state = 'review'; word.reps = (word.reps||0) + 1;
      word.interval = SRS.easyInterval;
      word.nextDue = now + word.interval * 86400000;
    }
    return result;
  }

  if (word.state === 'relearning') {
    if (grade === 1) {
      word.learningStep = 0;
      result = { requeue: true, requeueOffset: 3 };
    } else {
      // Hard/Good/Easyいずれでも再学習ステップから復帰
      word.state = 'review'; word.reps = (word.reps||0) + 1;
      let interval = word.pendingInterval || 1;
      if (grade === 4) interval = Math.round(interval * SRS.easyBonus);
      interval = capInterval(fuzzInterval(interval));
      word.interval = interval;
      word.nextDue = now + interval * 86400000;
      word.pendingInterval = undefined;
    }
    return result;
  }

  // state === 'review'
  let { ef = SRS.startEf, interval = 1, lapses = 0 } = word;
  if (grade === 1) { // Again → 復習忘れ(lapse)
    lapses++;
    ef = Math.max(SRS.minEf, ef - 0.2);
    const pending = Math.max(1, Math.round(interval * SRS.newLapseIntervalFactor));
    word.state = 'relearning'; word.learningStep = 0;
    word.pendingInterval = pending;
    word.ef = ef; word.lapses = lapses;
    word.leech = lapses >= SRS.leechThreshold;
    result = { requeue: true, requeueOffset: 3, leech: word.leech && lapses === SRS.leechThreshold };
    return result;
  }

  if (grade === 2) { // Hard
    interval = Math.max(interval + 1, Math.round(interval * SRS.hardFactor));
    ef = Math.max(SRS.minEf, ef - 0.15);
  } else if (grade === 3) { // Good
    interval = Math.round(interval * ef);
  } else { // Easy
    interval = Math.round(interval * ef * SRS.easyBonus);
    ef = ef + 0.15;
  }
  interval = capInterval(fuzzInterval(interval));
  word.ef = ef; word.interval = interval; word.lapses = lapses;
  word.reps = (word.reps||0) + 1;
  word.nextDue = now + interval * 86400000;
  return result;
}

const daysUntil = ts => Math.max(0, Math.ceil((ts - Date.now()) / 86400000));

/* ============================================================
   UTILS
   ============================================================ */
function esc(s) {
  const d = document.createElement('div'); d.textContent = s||''; return d.innerHTML;
}
function shuffle(a) {
  for (let i = a.length-1; i > 0; i--) {
    const j = Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2400);
}

/* ============================================================
   CONFIRM MODAL
   ============================================================ */
function confirm(msg, sub, onOk, icon='🗑️') {
  document.getElementById('confirm-icon').textContent = icon;
  document.getElementById('confirm-msg').textContent = msg;
  document.getElementById('confirm-sub').textContent = sub || '';
  document.getElementById('confirm-ok-btn').onclick = () => { closeModal('modal-confirm'); onOk(); };
  document.getElementById('modal-confirm').classList.add('open');
}

/* ============================================================
   NAVIGATION
   ============================================================ */
const NAV = { home:'nav-home', import:'nav-import', settings:'nav-settings', quiz:'nav-home', result:'nav-home', board:'nav-home' };
function showScreen(id) {
  // クイズ以外の画面に移る場合、正解後の自動送りタイマーが残っていたら破棄する
  // (残したままだと、後で戻ってきた時に無関係なカードが1枚飛ばされてしまう)
  if (id !== 'quiz' && qAdvanceTimer) { clearTimeout(qAdvanceTimer); qAdvanceTimer = null; }
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('screen-'+id).classList.add('active');
  const nid = NAV[id]; if (nid) document.getElementById(nid).classList.add('active');
  if (id === 'home') renderHome();
  if (id === 'import') { clearImport(); populateImportDeckSelect(); }
  if (id === 'settings') initSettings();
  showDestinationLayer(id === 'board' || id === 'quiz' || id === 'result');
  window.scrollTo({ top: 0, behavior: 'instant' });
}

/* ============================================================
   MODAL HELPERS
   ============================================================ */
let _newDeckCtx = null;
function openNewDeckModal(ctx) {
  _newDeckCtx = ctx || null;
  document.getElementById('new-deck-name').value = '';
  document.getElementById('modal-new-deck').classList.add('open');
  setTimeout(() => document.getElementById('new-deck-name').focus(), 60);
}
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
document.querySelectorAll('.modal-overlay').forEach(m => {
  m.addEventListener('click', e => { if (e.target === m) m.classList.remove('open'); });
});
document.getElementById('new-deck-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') createDeck();
  if (e.key === 'Escape') closeModal('modal-new-deck');
});

function createDeck() {
  const name = document.getElementById('new-deck-name').value.trim();
  if (!name) { document.getElementById('new-deck-name').focus(); return; }
  const decks = loadDecks();
  const id = Date.now();
  decks.push({ id, name, createdAt: Date.now() });
  saveDecks(decks);
  closeModal('modal-new-deck');
  toast(`「${name}」を作成しました`);
  renderAll();
  if (_newDeckCtx === 'import') {
    populateImportDeckSelect();
    document.getElementById('import-deck-select').value = id;
  }
}

/* ============================================================
   HOME — Today summary + flight-list of decks
   ============================================================ */
function renderHome() {
  const decks = loadDecks();
  const words = loadWords();
  const now = Date.now();

  const totalDue = words.filter(w => (w.nextDue||0) <= now).length;
  const heroMsg = document.getElementById('home-hero-msg');
  if (heroMsg) {
    heroMsg.textContent = !decks.length ? '最初の単語帳を作って、学習の旅をはじめましょう'
      : totalDue > 0 ? `今日は ${totalDue} 語、復習の予定があります`
      : '今日の復習はすべて終わっています';
  }

  const el = document.getElementById('home-flight-list');
  if (!decks.length) {
    el.innerHTML = `<div class="empty">
      <div class="empty-icon">🧳</div>
      <p>まだ単語帳がありません</p>
      <small>右下の「＋」から最初の単語帳を作れます</small>
    </div>`;
    return;
  }
  el.innerHTML = decks.map(d => {
    const dw = words.filter(w => w.deckId === d.id);
    const due = dw.filter(w => (w.nextDue||0) <= now).length;
    const mastered = dw.length ? Math.round(((dw.length - due) / dw.length) * 100) : 0;
    const dest = getCurrentDestination(d.id);
    return `<div class="flight-row glass" onclick="openBoarding(${d.id})">
      <div class="fr-code-col">
        <span class="fr-code">${esc(dest.code)}</span>
        <span class="fr-code-city">${esc(dest.city)}</span>
      </div>
      <div class="fr-main">
        <div class="fr-name">${esc(d.name)}</div>
        <div class="fr-meta">
          <span>${dw.length} 語</span>
          ${due>0 ? `<span class="fr-due">復習 ${due}</span>` : `<span class="fr-mastered">習得 ${mastered}%</span>`}
        </div>
      </div>
      <button class="fr-del" onclick="event.stopPropagation();confirmDeleteDeck(${d.id},'${esc(d.name)}')" aria-label="この単語帳を削除">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
      </button>
      <svg class="fr-chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
    </div>`;
  }).join('');
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
  return h;
}

// per-deck選択中の出題モード: 'due'(復習のみ) または 'random'(ランダムN問)
const deckModes = {};
function getMode(deckId) { return deckModes[deckId] || 'due'; }

// per-deck選択中のランダム出題数。0 = 単語帳の全部
const deckRandomCounts = {};
function getRandomCount(deckId) {
  return (typeof deckRandomCounts[deckId] === 'number') ? deckRandomCounts[deckId] : 20;
}

// per-deck選択中の出題方向: 'm2w' = 単語を見て意味を答える／'w2m' = 意味を見て単語を答える
const deckDirections = {};
function setDirection(deckId, direction, btn) {
  deckDirections[deckId] = direction;
  document.querySelectorAll(`#dir-${deckId} .mode-tab`).forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}
function getDirection(deckId) { return deckDirections[deckId] || 'm2w'; }

// per-deck選択中の回答形式: 'choice' = 4択／'input' = 入力式
const deckFormats = {};
function setFormat(deckId, format, btn) {
  deckFormats[deckId] = format;
  document.querySelectorAll(`#fmt-${deckId} .mode-tab`).forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}
function getFormat(deckId) { return deckFormats[deckId] || 'choice'; }

/* ============================================================
   搭乗手続き画面（学習モードの設定）
   ============================================================ */
let _boardingDeckId = null;

function openBoarding(deckId) {
  _boardingDeckId = deckId;
  renderBoardScreen(deckId);
  applyDestinationBackground(deckId);
  showScreen('board');
}

function setBoardMode(deckId, mode) {
  deckModes[deckId] = mode;
  renderBoardScreen(deckId);
}

function setBoardCount(deckId, count) {
  deckRandomCounts[deckId] = count;
  renderBoardScreen(deckId);
}

function renderBoardScreen(deckId) {
  const deck = loadDecks().find(d => d.id === deckId);
  const pass = document.getElementById('board-pass');
  if (!deck) { pass.innerHTML = ''; return; }

  const words = loadWords().filter(w => w.deckId === deckId);
  const now = Date.now();
  const due = words.filter(w => (w.nextDue||0) <= now).length;
  const total = words.length;

  const mode = getMode(deckId);
  const direction = getDirection(deckId);
  const format = getFormat(deckId);
  const count = getRandomCount(deckId);

  const counts = [10, 20, 30, 50];
  const countPills = counts.map(c =>
    `<button class="count-pill ${count===c?'active':''}" onclick="setBoardCount(${deckId},${c})">${c}問</button>`
  ).join('') + `<button class="count-pill ${count===0?'active':''}" onclick="setBoardCount(${deckId},0)">全部（${total}問）</button>`;

  const dest = getCurrentDestination(deckId);
  const next = getNextDestination(deckId);

  pass.innerHTML = `
    <div class="airmail-stripe"></div>
    <div class="board-body">
      <div class="dc-eyebrow-row">
        <span class="dest-badge"><span class="db-dot"></span>現在地 <span class="db-city">${esc(dest.city)}</span></span>
        <span class="dc-route">${dest.code} <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg> ${next.code}</span>
      </div>
      <div class="board-deck-name">${esc(deck.name)}</div>
      <div class="board-stats">
        <div class="board-stat"><span class="bs-num">${total}</span><span class="bs-lbl">単語数</span></div>
        <div class="board-stat"><span class="bs-num">${due}</span><span class="bs-lbl">復習待ち</span></div>
      </div>

      <div class="board-section">
        <div class="board-section-label">出題範囲</div>
        <div class="mode-tabs">
          <button class="mode-tab ${mode==='due'?'active':''}" onclick="setBoardMode(${deckId},'due')">復習のみ<span class="mt-sub">${due}語</span></button>
          <button class="mode-tab ${mode==='random'?'active':''}" onclick="setBoardMode(${deckId},'random')">問題数を指定<span class="mt-sub">ランダム出題</span></button>
        </div>
        ${mode === 'random' ? `<div class="count-row">${countPills}</div>` : ''}
      </div>

      <div class="board-section">
        <div class="board-section-label">出題の向き</div>
        <div class="mode-tabs" id="dir-${deckId}">
          <button class="mode-tab ${direction==='m2w'?'active':''}" onclick="setDirection(${deckId},'m2w',this)">単語 → 意味</button>
          <button class="mode-tab ${direction==='w2m'?'active':''}" onclick="setDirection(${deckId},'w2m',this)">意味 → 単語</button>
        </div>
      </div>

      <div class="board-section" style="margin-bottom:26px">
        <div class="board-section-label">答え方</div>
        <div class="mode-tabs" id="fmt-${deckId}">
          <button class="mode-tab ${format==='choice'?'active':''}" onclick="setFormat(${deckId},'choice',this)">4択</button>
          <button class="mode-tab ${format==='input'?'active':''}" onclick="setFormat(${deckId},'input',this)">入力式</button>
        </div>
      </div>

      <button class="btn primary board-start-btn" onclick="startQuizDeck(${deckId})">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
        学習をはじめる
      </button>
      ${(mode === 'due' && due === 0) ? '<p class="board-warn">今日の復習はありません。「問題数を指定」でも学習できます</p>' : ''}
    </div>
  `;
}

function confirmDeleteDeck(id, name) {
  confirm(`「${name}」を削除しますか？`, 'この単語帳の全ての単語も削除されます', () => deleteDeck(id));
}
function deleteDeck(id) {
  saveDecks(loadDecks().filter(d => d.id !== id));
  saveWords(loadWords().filter(w => w.deckId !== id));
  const session = LS.get('vq_session');
  if (session && session.deckId === id) localStorage.removeItem('vq_session');
  toast('削除しました');
  renderAll();
}

/* ============================================================
   QUIZ
   ============================================================ */
let qWords=[], qIdx=0, qOk=0, qNg=0, qInput=null, qDeckId=null;
let qDirection='m2w', qFormat='choice', qCorrectAnswer='', qAnswered=false, qCardFormat='choice';
let qCardShownAt = 0; // このカードが表示された時刻(ms) — 回答時間から難易度を自動判定するために使う
let qAdvanceTimer = null; // 正解後の自動送りタイマーのID。二重発火・カード飛ばし防止のため常に管理する
const SESSION_KEY = 'vq_session';

// キーボードショートカット: 出題中は 1〜4 キーで4択を選択できる。
// (以前あったEnterでの次送りは、自動送りと競合しやすかったため廃止)
document.addEventListener('keydown', (e) => {
  const quizScreen = document.getElementById('screen-quiz');
  if (!quizScreen || !quizScreen.classList.contains('active')) return;

  if (!qAnswered && qCardFormat === 'choice' && ['1','2','3','4'].includes(e.key)) {
    const btn = document.querySelector(`#q-answer-area .choice-btn[data-key="${e.key}"]`);
    if (btn && !btn.disabled) {
      e.preventDefault();
      btn.click();
    }
  }
});

const saveSession = () => {
  if (qDeckId == null) return;
  LS.set(SESSION_KEY, { deckId: qDeckId, mode: getMode(qDeckId), direction: qDirection, format: qFormat, wordIds: qWords.map(w => w.id), idx: qIdx, ok: qOk, ng: qNg });
};
const clearSession = () => localStorage.removeItem(SESSION_KEY);
const loadSession = () => LS.get(SESSION_KEY);

// 同じ単語帳内の他の単語から、正解と重複しないダミー選択肢を最大count件集める
function getDistractors(deckId, excludeId, field, correctVal, count) {
  const pool = loadWords().filter(w => w.deckId === deckId && String(w.id) !== String(excludeId));
  const seen = new Set([normalizeKey(correctVal)]);
  const candidates = [];
  shuffle([...pool]).forEach(w => {
    const val = String((w[field]||'')).trim();
    const key = normalizeKey(val);
    if (val && !seen.has(key)) { seen.add(key); candidates.push(val); }
  });
  return candidates.slice(0, count);
}

function startQuizDeck(deckId, forceNew) {
  if (qAdvanceTimer) { clearTimeout(qAdvanceTimer); qAdvanceTimer = null; }
  qDeckId = deckId;
  const mode = getMode(deckId);
  let direction = getDirection(deckId);
  let format = getFormat(deckId);
  const now = Date.now();

  // 4択には「正解＋異なる選択肢3つ」が必要。単語帳内のユニークな値が4つ未満なら入力式に自動切替
  if (format === 'choice') {
    const deckWords = loadWords().filter(w => w.deckId === deckId);
    const field = direction === 'w2m' ? 'trans' : 'word';
    const uniqueVals = new Set(deckWords.map(w => normalizeKey(w[field])).filter(Boolean));
    if (uniqueVals.size < 4) {
      format = 'input';
      toast('4択を作るには単語が4つ以上必要です。入力式で出題します');
    }
  }

  if (!forceNew) {
    const session = loadSession();
    if (session && session.deckId === deckId && session.mode === mode && session.direction === direction && session.format === format
        && Array.isArray(session.wordIds) && session.idx < session.wordIds.length) {
      const byId = new Map(loadWords().map(w => [String(w.id), w]));
      const resumed = session.wordIds.map(id => byId.get(String(id))).filter(Boolean).map(ensureSrsFields);
      if (resumed.length) {
        qWords = resumed;
        qDirection = direction; qFormat = format;
        qIdx = Math.min(session.idx, qWords.length);
        qOk = session.ok || 0;
        qNg = session.ng || 0;
        document.getElementById('q-ok').textContent = qOk;
        document.getElementById('q-ng').textContent = qNg;
        // 再開の場合は目的地を進めない — 前回このセッションを開始した時点の目的地のまま
        // (直前の搭乗手続き画面ですでにその背景が表示されている)
        showScreen('quiz');
        toast('前回の続きから再開します');
        loadCard();
        return;
      }
    }
  }

  let words = loadWords().filter(w => w.deckId === deckId).map(ensureSrsFields);
  if (mode === 'due') {
    words = words.filter(w => (w.nextDue||0) <= now);
  } else if (mode === 'random') {
    words = shuffle([...words]);
    const count = getRandomCount(deckId);
    if (count > 0) words = words.slice(0, count);
  }
  if (!words.length) {
    if (mode === 'due') toast('復習が必要な単語はありません。「ランダム出題」もお試しください');
    else toast('この単語帳に単語がありません');
    return;
  }
  qWords = shuffle([...words]);
  qDirection = direction; qFormat = format;
  qIdx = 0; qOk = 0; qNg = 0;
  document.getElementById('q-ok').textContent = 0;
  document.getElementById('q-ng').textContent = 0;
  // 学習をはじめるたびに、次の目的地へ一つ進む
  advanceDeckLap(deckId);
  applyDestinationBackground(deckId);
  showScreen('quiz');
  saveSession();
  loadCard();
}

function loadCard() {
  // 新しいカードを表示する前に、前のカードの自動送りタイマーが
  // 万一残っていたら必ず破棄する（多重発火＝カード飛ばしの主因だったため）
  if (qAdvanceTimer) { clearTimeout(qAdvanceTimer); qAdvanceTimer = null; }
  if (qIdx >= qWords.length) { showResult(); return; }
  const w = qWords[qIdx];
  const promptField = qDirection === 'w2m' ? 'word' : 'trans';
  const answerField = qDirection === 'w2m' ? 'trans' : 'word';
  document.getElementById('q-prompt-label').textContent = qDirection === 'w2m' ? '単　語' : '意　味';
  document.getElementById('q-prompt').textContent = w[promptField] || '';
  qCorrectAnswer = String(w[answerField] || '').trim();
  qAnswered = false;
  resetStamp();

  const memoEl = document.getElementById('q-memo');
  if (w.memo) { memoEl.textContent = w.memo; memoEl.style.display = ''; }
  else { memoEl.textContent = ''; memoEl.style.display = 'none'; }
  document.getElementById('q-feedback').className = 'feedback';
  document.getElementById('q-feedback').innerHTML = '';
  document.getElementById('q-next-btn').style.display = 'none';

  const area = document.getElementById('q-answer-area');
  area.innerHTML = '';
  qInput = null;

  let cardFormat = qFormat;
  let distractors = [];
  if (cardFormat === 'choice') {
    distractors = getDistractors(w.deckId, w.id, answerField, qCorrectAnswer, 3);
    if (distractors.length < 3) cardFormat = 'input'; // この語だけ選択肢が足りない場合の保険
  }
  qCardFormat = cardFormat;
  document.getElementById('q-kbd-choice').style.display = cardFormat === 'choice' ? '' : 'none';

  if (cardFormat === 'choice') {
    document.getElementById('q-check-btn').style.display = 'none';
    const options = shuffle([qCorrectAnswer, ...distractors]);
    const grid = document.createElement('div');
    grid.className = 'choice-grid';
    options.forEach((opt, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'choice-btn choice-in';
      btn.style.animationDelay = (i * 0.05) + 's';
      btn.dataset.key = String(i + 1);
      btn.dataset.value = opt;
      btn.innerHTML = `<span class="choice-key">${i + 1}</span><span class="choice-label">${esc(opt)}</span>`;
      btn.onclick = () => selectChoice(btn, opt);
      grid.appendChild(btn);
    });
    area.appendChild(grid);
  } else {
    document.getElementById('q-check-btn').style.display = '';
    const wrap = document.createElement('div');
    wrap.className = 'input-answer-wrap';
    qInput = document.createElement('input');
    qInput.type = 'text';
    qInput.className = 'blank-input';
    qInput.placeholder = qDirection === 'w2m' ? '意味を入力' : '単語を入力';
    qInput.autocomplete = 'off';
    qInput.spellcheck = false;
    qInput.addEventListener('keydown', e => { if (e.key === 'Enter') checkAnswer(); });
    wrap.appendChild(qInput);
    area.appendChild(wrap);
  }

  updateProgress();
  qCardShownAt = Date.now();
  setTimeout(() => qInput && qInput.focus(), 60);
}

function selectChoice(btn, value) {
  if (qAnswered) return;
  qAnswered = true;
  const w = qWords[qIdx];
  const correct = normalizeKey(value) === normalizeKey(qCorrectAnswer);
  document.querySelectorAll('#q-answer-area .choice-btn').forEach(b => {
    b.disabled = true;
    if (normalizeKey(b.dataset.value) === normalizeKey(qCorrectAnswer)) b.classList.add('correct');
    else if (b === btn) b.classList.add('wrong');
  });
  handleAnswered(correct, w);
}

function checkAnswer() {
  if (!qInput || qInput.disabled || qAnswered) return;
  qAnswered = true;
  const w = qWords[qIdx];
  const ans = qInput.value.trim();
  const correct = ans === qCorrectAnswer;
  qInput.className = 'blank-input ' + (correct ? 'correct' : 'wrong');
  qInput.disabled = true;
  document.getElementById('q-check-btn').style.display = 'none';
  handleAnswered(correct, w);
}

function resetStamp() {
  const stamp = document.getElementById('stampEl');
  stamp.className = 'stamp';
  stamp.style.animation = 'none';
  document.getElementById('stampSvgInner').innerHTML = '';
  const card = document.getElementById('q-card');
  card.classList.remove('card-enter', 'screen-shake');
  void card.offsetWidth; // force reflow so the animation replays every card
  card.classList.add('card-enter');
}

function triggerStamp(correct) {
  const stamp = document.getElementById('stampEl');
  const inner = document.getElementById('stampSvgInner');
  const color = correct ? '#324a68' : '#a8402d';
  stamp.className = 'stamp ' + (correct ? 'correct' : 'wrong');
  inner.innerHTML = correct
    ? `<circle class="stamp-ring" cx="75" cy="75" r="54" stroke="${color}"/>
       <circle cx="75" cy="75" r="44" fill="none" stroke="${color}" stroke-width="2" opacity="0.55"/>
       <path d="M50,78 L68,96 L104,54" fill="none" stroke="${color}" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>
       <text x="75" y="129" text-anchor="middle" font-family="'Space Mono',monospace" font-weight="700" font-size="12" fill="${color}" letter-spacing="2">APPROVED</text>`
    : `<circle class="stamp-ring" cx="75" cy="75" r="54" stroke="${color}"/>
       <line x1="52" y1="52" x2="98" y2="98" stroke="${color}" stroke-width="8" stroke-linecap="round"/>
       <line x1="98" y1="52" x2="52" y2="98" stroke="${color}" stroke-width="8" stroke-linecap="round"/>
       <text x="75" y="129" text-anchor="middle" font-family="'Space Mono',monospace" font-weight="700" font-size="12" fill="${color}" letter-spacing="2">DENIED</text>`;
  void stamp.offsetWidth;
  stamp.style.animation = 'stamp-slam .6s var(--land) both';
  if (!correct) {
    setTimeout(() => {
      const card = document.getElementById('q-card');
      card.classList.remove('screen-shake');
      void card.offsetWidth;
      card.classList.add('screen-shake');
    }, 260);
  }
}

function handleAnswered(correct, w) {
  const fb = document.getElementById('q-feedback');
  const elapsed = Date.now() - (qCardShownAt || Date.now());
  triggerStamp(correct);

  // 自動送りタイマーを予約するヘルパー。途中で手動送り・画面遷移された場合は
  // 必ず破棄されるので(nextCard/loadCard/showScreen側で管理)、二重発火やカード
  // 飛ばしは起きない。
  const scheduleAdvance = (delay) => {
    if (qAdvanceTimer) clearTimeout(qAdvanceTimer);
    qAdvanceTimer = setTimeout(nextCard, delay);
  };

  if (!correct) {
    fb.className = 'feedback ng';
    fb.innerHTML = `✕　不正解。正解：<strong>${esc(qCorrectAnswer)}</strong>`;
    qNg++;
    document.getElementById('q-ng').textContent = qNg;
    applyGrade(w, 1); // Again
    document.getElementById('q-next-btn').style.display = '';
    saveSession();
    updateProgress();
    scheduleAdvance(1700); // 正解を確認できるよう少し長めに待ってから自動で次へ
    return;
  }

  const grade = autoGrade(elapsed, qCardFormat, qCorrectAnswer.length);
  const gradeMeta = { 2: ['難しい', 'ag-hard'], 3: ['普通', 'ag-good'], 4: ['簡単', 'ag-easy'] }[grade];
  fb.className = 'feedback ok';
  fb.innerHTML = `✓　正解！　<span class="auto-grade-tag ${gradeMeta[1]}">${gradeMeta[0]}</span>`;
  qOk++;
  document.getElementById('q-ok').textContent = qOk;
  applyGrade(w, grade);
  saveSession();
  updateProgress();
  scheduleAdvance(550); // 正解はテンポよく次へ
}

/**
 * 回答にかかった時間から、Anki風の Hard/Good/Easy を自動推定する。
 * - 4択は「見て即座に選べたか」、入力式は「正解の長さに対して
 *   どれだけ早く打てたか」で判定基準を変える。
 * - 迷わず即答 → Easy／普通のペース → Good／時間がかかった → Hard
 */
function autoGrade(elapsedMs, format, answerLen) {
  let easyT, hardT;
  if (format === 'choice') {
    easyT = 2200;   // 2.2秒以内の即答 → Easy
    hardT = 6500;   // 6.5秒を超えたら → Hard
  } else {
    const base = 1200 + 260 * Math.max(1, answerLen); // 文字数ぶんのタイピング時間を考慮
    easyT = base * 0.55;
    hardT = base * 1.6;
  }
  if (elapsedMs <= easyT) return 4; // Easy
  if (elapsedMs <= hardT) return 3; // Good
  return 2; // Hard
}

// SRSエンジンに1回分の採点を反映し、必要ならセッション内に再出題を仕込む
function applyGrade(w, grade) {
  const res = gradeCard(w, grade);
  const words = loadWords();
  const i = words.findIndex(x => String(x.id) === String(w.id));
  if (i >= 0) Object.assign(words[i], w);
  saveWords(words);
  if (res && res.leech) {
    toast(`「${w.word}」は${SRS.leechThreshold}回以上間違えています。意味や例文を見直してみましょう 🐛`);
  }
  if (res && res.requeue) {
    const pos = Math.min(qWords.length, qIdx + 1 + res.requeueOffset);
    qWords.splice(pos, 0, w);
  }
}

function nextCard() {
  if (qAdvanceTimer) { clearTimeout(qAdvanceTimer); qAdvanceTimer = null; }
  qIdx++; saveSession(); loadCard();
}

function updateProgress() {
  const pct = qWords.length ? Math.round(qIdx / qWords.length * 100) : 0;
  document.getElementById('q-prog').style.width = pct + '%';
  document.getElementById('q-prog-label').textContent = qIdx + ' / ' + qWords.length + '問';
  const plane = document.getElementById('q-prog-plane');
  if (plane) plane.style.left = pct + '%';
}

function leaveQuiz() {
  showScreen('home');
}

function restartQuiz() {
  if (qDeckId !== null) { clearSession(); startQuizDeck(qDeckId, true); }
  else showScreen('home');
}

function showResult() {
  clearSession();
  showScreen('result');
  const pct = qWords.length ? Math.round(qOk / qWords.length * 100) : 0;
  document.getElementById('res-pct').textContent = pct + '%';
  document.getElementById('res-msg').textContent = pct >= 80 ? 'よくできました！' : 'もう一度復習しましょう';
  document.getElementById('res-ok').textContent = qOk;
  document.getElementById('res-ng').textContent = qNg;
  const avg = qWords.length ? Math.round(qWords.reduce((s,w) => s+(w.interval||1), 0) / qWords.length) : 1;
  document.getElementById('res-interval').textContent = avg;

  // 目的地への到着を伝え、次に学習をはじめた時に向かう先をプレビューする
  // (実際にその目的地へ進むのは、次回「学習をはじめる」を押した瞬間)
  if (qDeckId != null) {
    const arrived = getCurrentDestination(qDeckId);
    const next = getNextDestination(qDeckId);
    document.getElementById('res-arrived-city').textContent = arrived.city;
    document.getElementById('res-next-city').textContent = next.city;
  }
}

/* ============================================================
   IMPORT
   ============================================================ */
let importWorkbook = null;
let importSheetIndex = 0;
let importData = [];
const dropZone = document.getElementById('drop-zone');
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault(); dropZone.classList.remove('drag-over');
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});

function handleFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    importWorkbook = XLSX.read(e.target.result, { type: 'array' });
    importSheetIndex = 0;
    populateImportSheetSelect();
    renderImportSheet(importSheetIndex);
    document.getElementById('import-preview').style.display = 'block';
    dropZone.style.display = 'none';
  };
  reader.readAsArrayBuffer(file);
}

function populateImportSheetSelect() {
  const sel = document.getElementById('import-sheet-select');
  if (!sel) return;
  if (!importWorkbook || !Array.isArray(importWorkbook.SheetNames) || !importWorkbook.SheetNames.length) {
    sel.innerHTML = '<option value="">（シートがありません）</option>';
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  sel.innerHTML = importWorkbook.SheetNames.map((name, index) => `<option value="${index}">${esc((name || '').trim() || `Sheet ${index + 1}`)}</option>`).join('');
  sel.value = String(importSheetIndex || 0);
}

function changeImportSheet(value) {
  importSheetIndex = parseInt(value, 10) || 0;
  renderImportSheet(importSheetIndex);
}

function renderImportSheet(index) {
  if (!importWorkbook || !Array.isArray(importWorkbook.SheetNames) || !importWorkbook.SheetNames.length) {
    importData = [];
    document.getElementById('preview-body').innerHTML = '';
    document.getElementById('preview-count').textContent = '';
    return;
  }
  const sheetName = importWorkbook.SheetNames[Math.max(0, Math.min(index, importWorkbook.SheetNames.length - 1))];
  const ws = importWorkbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header:1, defval:'' });
  importData = [];
  const tbody = document.getElementById('preview-body');
  tbody.innerHTML = '';
  let valid = 0, invalid = 0;
  // A列=No（無視）／B列=単語／C列=意味／D列=メモ（任意）
  rows.forEach((row, rowIndex) => {
    const noCell = String(row[0]||'').trim();
    const word = String(row[1]||'').trim();
    const trans = String(row[2]||'').trim();
    const memo = String(row[3]||'').trim();
    if (!noCell && !word && !trans) return;
    // ヘッダー行（No / 単語 / 意味）はスキップ
    if (rowIndex === 0 && (noCell === 'No' || noCell === 'no') && word === '単語' && trans === '意味') return;
    const ok = !!(word && trans);
    ok ? valid++ : invalid++;
    importData.push({ word, trans, memo, ok });
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${esc(word)}</td><td>${esc(trans)}</td><td style="color:var(--ink-faint)">${esc(memo)}</td>
      <td style="text-align:center">${ok
        ? '<span style="color:var(--moss)">✓</span>'
        : '<span style="color:var(--vermilion)" title="単語・意味が必要">✕</span>'}</td>`;
    tbody.appendChild(tr);
  });
  document.getElementById('preview-count').textContent = `${sheetName} / ${valid} 件有効 ／ ${invalid} 件スキップ`;
}

function populateImportDeckSelect() {
  const sel = document.getElementById('import-deck-select');
  const decks = loadDecks();
  sel.innerHTML = decks.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
  if (!decks.length) sel.innerHTML = '<option value="">（先に単語帳を作成してください）</option>';
}

function importWords() {
  const deckId = parseInt(document.getElementById('import-deck-select').value);
  if (!deckId) { toast('単語帳を選択してください'); return; }
  const valid = importData.filter(r => r.ok);
  if (!valid.length) { toast('インポートできる単語がありません'); return; }
  const words = loadWords();
  valid.forEach(r => {
    words.push({ id: Date.now()+Math.random(), deckId, word:r.word, trans:r.trans, memo:r.memo||'', ef:SRS.startEf, interval:1, reps:0, nextDue:0, state:'new', lapses:0, learningStep:0 });
  });
  saveWords(words);
  toast(`${valid.length} 語をインポートしました`);
  clearImport();
  renderAll();
}

function clearImport() {
  importData = [];
  importWorkbook = null;
  importSheetIndex = 0;
  document.getElementById('import-preview').style.display = 'none';
  document.getElementById('drop-zone').style.display = 'block';
  document.getElementById('file-input').value = '';
  document.getElementById('preview-body').innerHTML = '';
  const sheetSel = document.getElementById('import-sheet-select');
  if (sheetSel) {
    sheetSel.innerHTML = '';
    sheetSel.disabled = true;
  }
}

/* ============================================================
   DESTINATIONS — a real-world "flight path" VocaAir travels along.
   100 stops, mixing famous landmarks with lesser-known places, so
   studying doubles as a small window onto the world. Every time
   studying is *started* (not finished), the deck flies to a new,
   randomly chosen stop. Photography is fetched live from Wikipedia
   (ja→en fallback) and cached in localStorage. If no photo can be
   found, a deterministic gradient stands in — the app never looks
   broken, it just looks a little more abstract.
   ============================================================ */
const DESTINATIONS = [
  // ── アジア ──
  { city: '東京',           code: 'NRT', title: '東京タワー' },
  { city: '京都',           code: 'KIX', title: '伏見稲荷大社' },
  { city: '大阪',           code: 'ITM', title: '大阪城' },
  { city: '那覇',           code: 'OKA', title: '首里城' },
  { city: 'ソウル',          code: 'ICN', title: '景福宮' },
  { city: '台北',           code: 'TPE', title: '台北101' },
  { city: '香港',           code: 'HKG', title: '香港' },
  { city: '北京',           code: 'PEK', title: '故宮博物院' },
  { city: '上海',           code: 'PVG', title: '上海' },
  { city: 'バンコク',        code: 'BKK', title: 'ワット・アルン' },
  { city: 'シンガポール',     code: 'SIN', title: 'マリーナベイ・サンズ' },
  { city: 'バリ島',          code: 'DPS', title: 'タナロット寺院' },
  { city: 'デリー',          code: 'DEL', title: 'タージ・マハル' },
  { city: 'カトマンズ',       code: 'KTM', title: 'エベレスト' },
  { city: 'ブータン',        code: 'PBH', title: 'ブータン' },
  { city: 'スリランカ',      code: 'CMB', title: 'シーギリヤ' },
  { city: 'ミャンマー',      code: 'RGN', title: 'バガン' },
  { city: 'ラオス',         code: 'LPQ', title: 'ルアンパバーン' },
  { city: 'モンゴル',        code: 'UBN', title: 'モンゴル' },
  { city: 'ウズベキスタン',   code: 'TAS', title: 'サマルカンド' },
  { city: 'カザフスタン',    code: 'ALA', title: 'カザフスタン' },
  { city: 'キルギス',        code: 'FRU', title: 'キルギス' },
  { city: 'バングラデシュ',   code: 'DAC', title: 'バングラデシュ' },
  { city: 'ブルネイ',        code: 'BWN', title: 'ブルネイ' },
  { city: 'モルディブ',      code: 'MLE', title: 'モルディブ' },
  // ── 中東 ──
  { city: 'ドバイ',          code: 'DXB', title: 'ブルジュ・ハリファ' },
  { city: 'イスタンブール',    code: 'IST', title: 'アヤソフィア' },
  { city: 'ヨルダン',        code: 'AMM', title: 'ペトラ' },
  { city: 'オマーン',        code: 'MCT', title: 'オマーン' },
  { city: 'ドーハ',          code: 'DOH', title: 'ドーハ' },
  { city: 'レバノン',        code: 'BEY', title: 'レバノン' },
  { city: 'エルサレム',      code: 'TLV', title: 'エルサレム旧市街' },
  { city: 'サウジアラビア',   code: 'RUH', title: 'サウジアラビア' },
  // ── アフリカ ──
  { city: 'カイロ',          code: 'CAI', title: 'ギザの大ピラミッド' },
  { city: 'マラケシュ',       code: 'RAK', title: 'ジャマ・エル・フナ広場' },
  { city: 'ケープタウン',      code: 'CPT', title: 'テーブルマウンテン' },
  { city: 'エチオピア',      code: 'ADD', title: 'エチオピア' },
  { city: 'タンザニア',      code: 'JRO', title: 'キリマンジャロ' },
  { city: 'ザンジバル',      code: 'ZNZ', title: 'ザンジバル' },
  { city: 'ナイロビ',        code: 'NBO', title: 'マサイマラ国立保護区' },
  { city: 'マダガスカル',    code: 'TNR', title: 'マダガスカル' },
  { city: 'セーシェル',      code: 'SEZ', title: 'セーシェル' },
  { city: 'モーリシャス',    code: 'MRU', title: 'モーリシャス' },
  { city: 'ボツワナ',        code: 'GBE', title: 'オカバンゴ・デルタ' },
  { city: 'ナミビア',        code: 'WDH', title: 'ナミブ砂漠' },
  { city: 'ザンビア',        code: 'LVI', title: 'ヴィクトリアの滝' },
  { city: 'ガーナ',          code: 'ACC', title: 'ガーナ' },
  { city: 'チュニジア',      code: 'TUN', title: 'チュニジア' },
  // ── ヨーロッパ ──
  { city: 'パリ',           code: 'CDG', title: 'エッフェル塔' },
  { city: 'ロンドン',        code: 'LHR', title: 'ビッグ・ベン' },
  { city: 'ローマ',          code: 'FCO', title: 'コロッセオ' },
  { city: 'ベネチア',        code: 'VCE', title: 'サン・マルコ広場' },
  { city: 'バルセロナ',       code: 'BCN', title: 'サグラダ・ファミリア' },
  { city: 'アムステルダム',    code: 'AMS', title: 'アムステルダム' },
  { city: 'プラハ',          code: 'PRG', title: 'プラハ城' },
  { city: 'サントリーニ',     code: 'JTR', title: 'サントリーニ島' },
  { city: 'アテネ',          code: 'ATH', title: 'パルテノン神殿' },
  { city: 'アイスランド',     code: 'KEF', title: 'アイスランド' },
  { city: 'モスクワ',        code: 'SVO', title: '聖ワシリイ大聖堂' },
  { city: 'ウィーン',        code: 'VIE', title: 'シェーンブルン宮殿' },
  { city: 'ブダペスト',      code: 'BUD', title: 'ブダペスト' },
  { city: 'ダブリン',        code: 'DUB', title: 'ダブリン' },
  { city: 'リスボン',        code: 'LIS', title: 'リスボン' },
  { city: 'チューリッヒ',    code: 'ZRH', title: 'マッターホルン' },
  { city: 'ブリュッセル',    code: 'BRU', title: 'ブリュッセル' },
  { city: 'コペンハーゲン',   code: 'CPH', title: 'コペンハーゲン' },
  { city: 'ストックホルム',   code: 'ARN', title: 'ストックホルム' },
  { city: 'ヘルシンキ',      code: 'HEL', title: 'ヘルシンキ' },
  { city: 'タリン',          code: 'TLL', title: 'タリン旧市街' },
  { city: 'トビリシ',        code: 'TBS', title: 'ジョージア（国）' },
  { city: 'アルメニア',      code: 'EVN', title: 'アルメニア' },
  { city: 'コトル',          code: 'TGD', title: 'モンテネグロ' },
  { city: 'ドゥブロヴニク',   code: 'DBV', title: 'ドゥブロヴニク' },
  // ── アメリカ大陸 ──
  { city: 'ニューヨーク',     code: 'JFK', title: '自由の女神像' },
  { city: 'サンフランシスコ',  code: 'SFO', title: 'ゴールデンゲートブリッジ' },
  { city: 'メキシコシティ',    code: 'MEX', title: 'テオティワカン' },
  { city: 'リオデジャネイロ',  code: 'GIG', title: 'コルコバードのキリスト像' },
  { city: 'マチュ・ピチュ',    code: 'CUZ', title: 'マチュ・ピチュ' },
  { city: 'ブエノスアイレス',  code: 'EZE', title: 'ブエノスアイレス' },
  { city: 'ウユニ塩湖',      code: 'UYU', title: 'ウユニ塩原' },
  { city: 'パタゴニア',      code: 'FTE', title: 'パタゴニア' },
  { city: 'ハバナ',          code: 'HAV', title: 'ハバナ' },
  { city: 'ジャマイカ',      code: 'KIN', title: 'ジャマイカ' },
  { city: 'コスタリカ',      code: 'SJO', title: 'コスタリカ' },
  { city: 'ガラパゴス諸島',   code: 'GPS', title: 'ガラパゴス諸島' },
  { city: 'バンクーバー',    code: 'YVR', title: 'バンクーバー' },
  { city: 'ナイアガラの滝',   code: 'YYZ', title: 'ナイアガラの滝' },
  { city: 'パナマ',          code: 'PTY', title: 'パナマ運河' },
  { city: 'カルタヘナ',      code: 'CTG', title: 'カルタヘナ・デ・インディアス' },
  { city: 'グアテマラ',      code: 'GUA', title: 'ティカル' },
  // ── オセアニア ──
  { city: 'シドニー',        code: 'SYD', title: 'シドニー・オペラハウス' },
  { city: 'クイーンズタウン',  code: 'ZQN', title: 'ミルフォード・サウンド' },
  { city: 'ホノルル',        code: 'HNL', title: 'ダイヤモンドヘッド' },
  { city: 'フィジー',        code: 'NAN', title: 'フィジー' },
  { city: 'タヒチ',          code: 'PPT', title: 'ボラボラ島' },
  { city: 'パラオ',          code: 'ROR', title: 'パラオ' },
  { city: 'サモア',          code: 'APW', title: 'サモア' },
  { city: 'バヌアツ',        code: 'VLI', title: 'バヌアツ' },
  { city: 'ケアンズ',        code: 'CNS', title: 'グレートバリアリーフ' },
  { city: 'イースター島',    code: 'IPC', title: 'イースター島' },
];
const DEST_PROGRESS_KEY = 'vq_dest_progress';
const DEST_IMG_CACHE_KEY = 'vq_dest_img_cache';

function randDestIndex(excludeIdx) {
  if (DESTINATIONS.length <= 1) return 0;
  let i;
  do { i = Math.floor(Math.random() * DESTINATIONS.length); } while (i === excludeIdx);
  return i;
}

function getDeckProgress() { return LS.get(DEST_PROGRESS_KEY) || {}; }
// 各単語帳につき {current, next} のインデックスを保持する。current が「今いる場所」、
// next は「次に学習をはじめた時にランダムで向かう場所」を、あらかじめ1つだけ確定させて
// おいたもの（プレビュー表示のため）。
function getDeckDest(deckId) {
  const p = getDeckProgress();
  let entry = p[deckId];
  if (!entry || typeof entry.current !== 'number') {
    const current = randDestIndex();
    const next = randDestIndex(current);
    entry = { current, next };
    p[deckId] = entry;
    LS.set(DEST_PROGRESS_KEY, p);
  }
  return entry;
}
function getCurrentDestination(deckId) { return DESTINATIONS[getDeckDest(deckId).current]; }
function getNextDestination(deckId) { return DESTINATIONS[getDeckDest(deckId).next]; }
// 「学習をはじめる」が押されるたびに呼ぶ。あらかじめ決めておいた next へ実際に移動し、
// さらに次のプレビュー用に、新しい next をランダムに決め直す。
function advanceDeckLap(deckId) {
  const p = getDeckProgress();
  const entry = getDeckDest(deckId); // 未初期化なら先に確定させる
  const newCurrent = entry.next;
  const newNext = randDestIndex(newCurrent);
  p[deckId] = { current: newCurrent, next: newNext };
  LS.set(DEST_PROGRESS_KEY, p);
}

function getDestImgCache() { return LS.get(DEST_IMG_CACHE_KEY) || {}; }
async function fetchWikiThumb(lang, title) {
  const url = `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&origin=*&prop=pageimages&piprop=thumbnail&pithumbsize=1600&redirects=1&titles=${encodeURIComponent(title)}`;
  const res = await fetch(url);
  const data = await res.json();
  const pages = data && data.query && data.query.pages;
  const page = pages && Object.values(pages)[0];
  return (page && page.thumbnail && page.thumbnail.source) || null;
}
// Wikipedia の pageimages API から目的地の写真を取得する。日本語版で見つからなければ
// 英語版も試す。一度取得した画像は localStorage にキャッシュし、次回以降はオフラインでも
// 表示できるようにする。それでも見つからない場合は呼び出し側がグラデーションで代替する。
async function fetchDestinationImage(title) {
  const cache = getDestImgCache();
  if (cache[title]) return cache[title];
  let src = null;
  try { src = await fetchWikiThumb('ja', title); } catch (e) { console.error(e); }
  if (!src) { try { src = await fetchWikiThumb('en', title); } catch (e) { console.error(e); } }
  if (src) { cache[title] = src; LS.set(DEST_IMG_CACHE_KEY, cache); }
  return src;
}

// 写真が見つからなかった時の代替背景。都市名から決定的に選ぶので、同じ目的地なら
// 常に同じ色合いになる（リロードのたびに変わって落ち着かない、を避けるため）。
const FALLBACK_GRADIENTS = [
  'linear-gradient(160deg,#2b3a67,#4a2545 60%,#7a4a2e)',
  'linear-gradient(160deg,#1f3d3a,#2d5f56 55%,#e8b84b)',
  'linear-gradient(160deg,#3a1f3d,#6b2d5f 55%,#e88a4b)',
  'linear-gradient(160deg,#1a2f4a,#2d5f8f 55%,#d9c27a)',
  'linear-gradient(160deg,#2f1f1a,#7a3a2e 55%,#e8c66a)',
];
function fallbackGradientFor(city) {
  return FALLBACK_GRADIENTS[Math.abs(hashStr(city)) % FALLBACK_GRADIENTS.length];
}

let _destBgToken = 0;
async function applyDestinationBackground(deckId) {
  const dest = getCurrentDestination(deckId);
  const token = ++_destBgToken;
  const layer = document.getElementById('dest-bg');
  layer.style.backgroundImage = fallbackGradientFor(dest.city); // 取得完了までの一時的な下地
  const src = await fetchDestinationImage(dest.title);
  if (token !== _destBgToken) return; // 別の目的地への切り替えが先に発生していれば無視
  if (src) {
    const img = new Image();
    img.onload = () => { if (token === _destBgToken) layer.style.backgroundImage = `url("${src}")`; };
    img.onerror = () => {}; // 取得失敗時はグラデーションのまま
    img.src = src;
  }
}
function showDestinationLayer(show) {
  document.getElementById('dest-bg').classList.toggle('show', show);
  document.getElementById('dest-scrim').classList.toggle('show', show);
}

function initSettings() {}

/* ============================================================
   RENDER ALL + INIT
   ============================================================ */
function renderAll() { renderHome(); }

renderAll();
