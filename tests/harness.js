// Firestore相当の共有クラウドと、2端末のテスト用ハーネス
const fs = require('fs');
function makeCloud() {
  const docs = { decks: new Map(), words: new Map(), settings: null };
  const listeners = new Set();
  return {
    docs, listeners,
    emit(kind, list) { listeners.forEach(l => l(kind, list)); },
  };
}
// 端末のバックエンド。failBatch(n) が true を返すと、そのバッチは書き込み失敗になる
function makeBackend(cloud, opts = {}) {
  let h = null; let me = null;
  const BATCH = opts.batch || 400;
  const be = {
    pushLog: [],
    start(handlers) {
      h = handlers;
      const pend = { decks: false, words: false, settings: false };
      const first = (k, docs) => { h.onDocs(docs); if (!pend[k]) { pend[k] = true; if (pend.decks && pend.words && pend.settings) h.onStatus('synced'); } };
      const toList = (coll, kind) => [...cloud.docs[coll].values()].map(d => ({ kind, id: d.id, json: d.json, updatedAt: d.updatedAt, deletedAt: d.deletedAt || null }));
      setTimeout(() => {
        first('decks', toList('decks', 'deck'));
        first('words', toList('words', 'word'));
        first('settings', cloud.docs.settings ? [{ kind: 'settings', id: 'settings', json: cloud.docs.settings.json, updatedAt: cloud.docs.settings.updatedAt }] : []);
      }, 5);
      me = (kind, list, from) => { if (from === be) return; h.onDocs(list); };
      cloud.listeners.add(me);
    },
    stop() { if (me) cloud.listeners.delete(me); },
    push(items) {
      const failed = [];
      let n = 0;
      for (let i = 0; i < items.length; i += BATCH) {
        const part = items.slice(i, i + BATCH);
        const bi = n++;
        if (opts.failBatch && opts.failBatch(bi, be)) { failed.push(...part); continue; }
        part.forEach(it => {
          if (it.kind === 'settings') cloud.docs.settings = { json: it.json, updatedAt: it.updatedAt };
          else cloud.docs[it.kind === 'deck' ? 'decks' : 'words'].set(it.id, { id: it.id, json: it.json, updatedAt: it.updatedAt, deletedAt: it.deletedAt });
        });
        cloud.listeners.forEach(l => l(null, part.map(it => ({ kind: it.kind, id: it.id, json: it.json, updatedAt: it.updatedAt, deletedAt: it.deletedAt })), be));
      }
      be.pushLog.push({ total: items.length, failed: failed.length });
      return Promise.resolve(failed); // v1.9.1: 失敗した分を返す
    },
    async fetchAll() { // 全件照合用（サーバーから直接）
      const f = (coll, kind) => [...cloud.docs[coll].values()].map(d => ({ kind, id: d.id, json: d.json, updatedAt: d.updatedAt, deletedAt: d.deletedAt || null }));
      return { decks: f('decks', 'deck'), words: f('words', 'word') };
    },
  };
  return be;
}
function makeDevice(core, cloud, initial, opts = {}) {
  const store = { decks: JSON.parse(JSON.stringify(initial.decks)), words: JSON.parse(JSON.stringify(initial.words)), settings: initial.settings || { dim: 0.45 } };
  let metaRaw = opts.meta || null;
  const backend = makeBackend(cloud, opts);
  const clean = x => (x && typeof x === 'object' ? JSON.parse(JSON.stringify(x)) : null);
  const eng = core.createSyncEngine({
    getState: () => ({ decks: store.decks, words: store.words, settings: store.settings }),
    backend,
    metaStore: { get: () => metaRaw && JSON.parse(metaRaw), set: m => { metaRaw = JSON.stringify(m); } },
    normalizeDeck: clean, normalizeWord: clean, normalizeSettings: clean,
    onRemoteApplied: (state) => { store.decks = state.decks; store.words = state.words; store.settings = state.settings; },
    now: opts.now,
  });
  return { store, eng, backend, get metaRaw() { return metaRaw; } };
}
const wait = ms => new Promise(r => setTimeout(r, ms));
module.exports = { makeCloud, makeDevice, wait };
