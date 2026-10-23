/* ============================================================
   sync-core.js — 複数端末の同期エンジン（v1.9.0 新設）
   ------------------------------------------------------------
   Temper の sync-core.js と同じ方式を、VocaAir のデータ（単語帳・単語・設定）向けに移植したもの。
   Firebase には依存しない純粋なロジックで、通信は「バックエンド」（sync-firebase.js）に任せる。

   方式:
   ・1件ごと（単語帳1冊・単語1語・設定1つ）を1つの文書として扱う
   ・前回送った内容のハッシュ(meta)と比べて、変わった分だけ送る
   ・同じ文書を複数端末で触ったら、updatedAt が新しい方が残る（後勝ち）
   ・削除は「墓標」（deletedAt）を送って伝える
   ・自分が送った内容が戻ってきても、ハッシュが同じなので何も起きない
   ・手元の「まだ送っていない変更」は、届いた内容より優先する
   ・Temper との違い: 初回の取り込み（単語帳・単語・設定の3つ）が終わるまで送信しない
     （先に手元の初期値を送って、クラウドの内容を上書きしてしまうのを防ぐ）

   このファイルは <script> で読み込む通常のスクリプト。Node のテストからは require もできる。
   ============================================================ */
(function (root) {
  'use strict';

  const ID_RE = /^[0-9]{1,20}(\.[0-9]{1,20})?$/; // 単語帳ID・単語IDは数値（例 1786886321192.3613）
  const MAX_JSON = 20000;                          // 1文書のJSONの上限（超えるものは取り込まない）
  const COLLS = ['decks', 'words'];
  const KIND = { decks: 'deck', words: 'word' };
  // 「手元が空なのに、同期済みの文書がこれだけある」場合は、読み込み失敗・復元失敗の可能性が高いので、
  // 「全部削除された」とは送らない（クラウドを守る）。単語帳は1冊でも守る。
  const WIPE_MIN = { decks: 1, words: 3 };

  /** キー順を固定したJSON（ハッシュを端末間で一致させるため） */
  function stableStringify(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
    return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  }
  function hashOf(v) {
    const s = typeof v === 'string' ? v : stableStringify(v);
    let h1 = 5381, h2 = 52711;
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = (h1 * 33) ^ c; h2 = (h2 * 33) ^ c; }
    return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36) + s.length.toString(36);
  }

  function emptyMeta() { return { decks: {}, words: {}, settings: null }; }
  function replaceObj(target, src) { Object.keys(target).forEach((k) => { delete target[k]; }); Object.assign(target, src); }

  /**
   * @param {object} o
   * @param {()=>{decks:Array,words:Array,settings:object}} o.getState 現在の内容（毎回、保存済みの最新を返す）
   * @param {object} o.backend { start(handlers), stop(), push(items) }
   * @param {{get:()=>object|null, set:(m:object)=>void}} o.metaStore 前回送った内容の記録
   * @param {(x:object)=>object|null} o.normalizeDeck 届いた単語帳を整える（不正なら null）
   * @param {(x:object)=>object|null} o.normalizeWord 届いた単語を整える（不正なら null）
   * @param {(x:object)=>object|null} o.normalizeSettings 届いた設定を整える
   * @param {(state:object, touched:Set<string>)=>void} o.onRemoteApplied 他端末の内容を取り込んだ後に呼ぶ（保存・再描画）
   * @param {()=>number} [o.now]
   * @param {(status:string)=>void} [o.onStatus]
   */
  function createSyncEngine(o) {
    const now = o.now || (() => Date.now());
    let meta = o.metaStore.get() || emptyMeta();
    if (!meta.decks || !meta.words) meta = emptyMeta();
    let timer = null;
    let started = false;
    let ready = false; // 初回の取り込みが終わるまで送信しない

    const save = () => { try { o.metaStore.set(meta); } catch (e) { /* 保存できなくても動く */ } };

    function flushColl(coll, list, items, t) {
      const mm = meta[coll];
      const seen = new Set();
      list.forEach((x) => {
        if (!x || !ID_RE.test(String(x.id))) return; // 不正なIDは同期しない
        const id = String(x.id);
        if (seen.has(id)) return; // 同じIDが重複していても、毎回送り直す動きにならないようにする（重複は app.js 側で修復する）
        seen.add(id);
        const h = hashOf(x);
        const m = mm[id];
        if (!m || m.h !== h || m.d) {
          mm[id] = { h, u: t };
          items.push({ kind: KIND[coll], id, json: stableStringify(x), updatedAt: t, deletedAt: null });
        }
      });
      const live = Object.keys(mm).filter((id) => !mm[id].d).length;
      if (list.length === 0 && live >= WIPE_MIN[coll]) return; // 安全弁（上の説明）
      Object.keys(mm).forEach((id) => {
        const m = mm[id];
        if (!seen.has(id) && !m.d) {
          mm[id] = { h: '', u: t, d: 1 };
          items.push({ kind: KIND[coll], id, json: null, updatedAt: t, deletedAt: t });
        }
      });
    }

    /** 手元の変更を検出して送る */
    function flush() {
      if (!started || !ready) return [];
      const state = o.getState();
      const t = now();
      const items = [];
      flushColl('decks', state.decks, items, t);
      flushColl('words', state.words, items, t);
      const sh = hashOf(state.settings);
      if (!meta.settings || meta.settings.h !== sh) {
        meta.settings = { h: sh, u: t };
        items.push({ kind: 'settings', id: 'settings', json: stableStringify(state.settings), updatedAt: t });
      }
      if (items.length) { save(); o.backend.push(items); }
      return items;
    }

    const remoteWins = (m, doc, remoteHash) => !m || doc.updatedAt > m.u || (doc.updatedAt === m.u && remoteHash > m.h);

    /** まとめて取り込むための作業台（IDで引ける索引と、追加・削除の予定） */
    function newBatch(state) {
      const b = { state, idx: {}, removed: {}, added: {}, touched: new Set() };
      COLLS.forEach((c) => {
        b.idx[c] = new Map(state[c].map((x) => [String(x.id), x]));
        b.removed[c] = new Set();
        b.added[c] = [];
      });
      return b;
    }
    function commit(b) {
      COLLS.forEach((c) => {
        if (b.removed[c].size) b.state[c] = b.state[c].filter((x) => !b.removed[c].has(String(x.id)));
        if (b.added[c].length) b.state[c] = b.state[c].concat(b.added[c]);
      });
    }

    function applyColl(coll, doc, b) {
      if (!ID_RE.test(doc.id)) return false;
      const mm = meta[coll];
      const m = mm[doc.id];
      const local = b.idx[coll].get(doc.id);
      if (local && m && !m.d && hashOf(local) !== m.h) return false; // 未送信の手元の変更を優先
      if (doc.deletedAt) {
        if (m && m.u >= doc.updatedAt) return false;
        mm[doc.id] = { h: '', u: doc.updatedAt, d: 1 };
        if (local) { b.removed[coll].add(doc.id); b.idx[coll].delete(doc.id); b.touched.add(coll); }
        return !!local;
      }
      if (typeof doc.json !== 'string' || doc.json.length > MAX_JSON) return false;
      const obj = (coll === 'decks' ? o.normalizeDeck : o.normalizeWord)(JSON.parse(doc.json));
      if (!obj) return false;
      obj.id = Number(doc.id);
      const rh = hashOf(obj);
      if (!remoteWins(m, doc, rh)) return false;
      mm[doc.id] = { h: rh, u: doc.updatedAt };
      if (local) {
        if (hashOf(local) === rh) return false;
        replaceObj(local, obj);
        b.touched.add(coll);
        return true;
      }
      b.added[coll].push(obj);
      b.idx[coll].set(doc.id, obj);
      b.touched.add(coll);
      return true;
    }

    function applyDoc(doc, b) {
      if (!doc || typeof doc.id !== 'string') return false;
      try {
        if (doc.kind === 'deck') return applyColl('decks', doc, b);
        if (doc.kind === 'word') return applyColl('words', doc, b);
        if (doc.kind === 'settings') {
          const state = b.state;
          const m = meta.settings;
          if (m && hashOf(state.settings) !== m.h) return false; // 未送信の手元の変更を優先
          if (typeof doc.json !== 'string' || doc.json.length > MAX_JSON) return false;
          const s = o.normalizeSettings(JSON.parse(doc.json));
          if (!s) return false;
          const rh = hashOf(s);
          if (m && !(doc.updatedAt > m.u || (doc.updatedAt === m.u && rh > m.h))) return false;
          meta.settings = { h: rh, u: doc.updatedAt };
          if (hashOf(state.settings) === rh) return false;
          state.settings = s;
          b.touched.add('settings');
          return true;
        }
      } catch (e) {
        return false; // 壊れた文書は無視する（主機能を止めない）
      }
      return false;
    }

    /** 他端末（または自分の別の書き込み）から届いた1件を取り込む（テスト用）。変更があれば true */
    function applyRemote(doc) {
      const state = o.getState();
      const b = newBatch(state);
      const changed = applyDoc(doc, b);
      commit(b);
      if (changed) o.onRemoteApplied(state, b.touched);
      return changed;
    }

    const handlers = {
      onDocs(docs) {
        const state = o.getState();
        const b = newBatch(state);
        let changed = false;
        docs.forEach((d) => { if (applyDoc(d, b)) changed = true; });
        commit(b);
        save();
        if (changed) o.onRemoteApplied(state, b.touched);
        schedule(0); // 取り込み後の差分（初回は手元にだけある分）を送る。ready になるまでは flush が何もしない
      },
      onStatus(s) {
        if (s === 'synced' && !ready) { ready = true; schedule(0); }
        if (o.onStatus) o.onStatus(s);
      },
    };

    function schedule(ms = 1200) {
      if (!started) return;
      clearTimeout(timer);
      timer = setTimeout(flush, ms);
    }

    return {
      start() { started = true; o.backend.start(handlers); },
      stop() { started = false; ready = false; clearTimeout(timer); if (o.backend.stop) o.backend.stop(); },
      /** 保存のたびに呼ぶ（送信はまとめて少し遅らせる） */
      notifyLocalChange() { schedule(); },
      flush,
      applyRemote,
      get ready() { return ready; },
      get meta() { return meta; },
    };
  }

  const api = { createSyncEngine, stableStringify, hashOf, ID_RE, MAX_JSON };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.VaSyncCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
