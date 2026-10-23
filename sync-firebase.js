/* ============================================================
   sync-firebase.js — Firebase（Auth + Firestore）のバックエンド（v1.9.0 新設）
   ------------------------------------------------------------
   Firebase SDK は設定されたときだけ、gstatic の ES モジュールとして動的に読み込む
   （同期を使わない人・オフラインの人には一切影響しない）。
   sync-core.js の「バックエンド」インターフェースを実装する薄い層で、同期のロジックはここに置かない。

   Firestore の構成（すべて users/{uid} の下。ルールは firestore.rules。Temper と同じルールで足りる）:
     va_decks/{deckId}   { id, json, updatedAt, deletedAt }
     va_words/{wordId}   { id, json, updatedAt, deletedAt }
     va_meta/settings    { id, json, updatedAt }
   Temper と同じ Firebase プロジェクトを共有しても、コレクション名の接頭辞 va_ で分かれるので混ざらない。
   Firebase アプリも別名（'vocaair'）で初期化するので、ログイン状態・オフライン用キャッシュも Temper とは独立
   （ログイン・ログアウトが Temper に影響しない。メールアドレスとパスワードは同じものを使える）。

   SDK のバージョンは Temper と同じ 11.0.2 に揃えること（同じ端末のキャッシュ形式が食い違わないように）。
   ============================================================ */
(function (root) {
  'use strict';
  const FB = 'https://www.gstatic.com/firebasejs/11.0.2';
  const APP_NAME = 'vocaair';
  const BATCH = 400; // Firestore の1回の書き込みは500件まで

  let appSingleton = null;
  let dbSingleton = null;

  const safeId = (id) => String(id).replace(/[^0-9.]/g, '_');

  async function loadFirebase(config) {
    const [appMod, authMod, fsMod] = await Promise.all([
      import(`${FB}/firebase-app.js`),
      import(`${FB}/firebase-auth.js`),
      import(`${FB}/firebase-firestore.js`),
    ]);
    if (!appSingleton) appSingleton = appMod.initializeApp(config, APP_NAME);
    const auth = authMod.getAuth(appSingleton);
    if (!dbSingleton) {
      try {
        dbSingleton = fsMod.initializeFirestore(appSingleton, {
          localCache: fsMod.persistentLocalCache({ tabManager: fsMod.persistentMultipleTabManager() }),
        });
      } catch (e) {
        dbSingleton = fsMod.getFirestore(appSingleton); // 永続キャッシュが使えない環境
      }
    }
    const db = dbSingleton;

    return {
      onAuthChanged: (cb) => authMod.onAuthStateChanged(auth, cb),
      signIn: (email, pw) => authMod.signInWithEmailAndPassword(auth, email, pw),
      signUp: (email, pw) => authMod.createUserWithEmailAndPassword(auth, email, pw),
      signOut: () => authMod.signOut(auth),

      /** sync-core のバックエンド（uid ごと） */
      makeBackend(uid) {
        const base = `users/${uid}`;
        let unsubs = [];
        let pushStatus = () => {};
        return {
          start(handlers) {
            pushStatus = handlers.onStatus;
            const pending = { decks: false, words: false, settings: false };
            const first = (k, docs) => {
              handlers.onDocs(docs);
              if (!pending[k]) {
                pending[k] = true;
                if (pending.decks && pending.words && pending.settings) handlers.onStatus('synced'); // 3つとも取り込み終わってから
              }
            };
            const fail = (e) => handlers.onStatus('error:' + (e && e.code ? e.code : 'unknown'));
            const toDocs = (snap, kind) => snap.docChanges()
              .filter((c) => c.type !== 'removed' && !c.doc.metadata.hasPendingWrites) // 自分の未確定の書き込みは取り込まない
              .map((c) => {
                const d = c.doc.data();
                return { kind, id: String(d.id == null ? c.doc.id : d.id), json: d.json == null ? null : d.json, updatedAt: Number(d.updatedAt) || 0, deletedAt: d.deletedAt || null };
              });
            unsubs.push(fsMod.onSnapshot(fsMod.collection(db, `${base}/va_decks`), (s) => first('decks', toDocs(s, 'deck')), fail));
            unsubs.push(fsMod.onSnapshot(fsMod.collection(db, `${base}/va_words`), (s) => first('words', toDocs(s, 'word')), fail));
            unsubs.push(fsMod.onSnapshot(fsMod.doc(db, `${base}/va_meta/settings`), (s) => {
              const d = s.exists() && !s.metadata.hasPendingWrites ? s.data() : null;
              first('settings', d ? [{ kind: 'settings', id: 'settings', json: d.json, updatedAt: Number(d.updatedAt) || 0 }] : []);
            }, fail));
          },
          stop() { unsubs.forEach((u) => { try { u(); } catch (e) { /* 解除に失敗しても続ける */ } }); unsubs = []; },
          push(items) {
            for (let i = 0; i < items.length; i += BATCH) {
              const batch = fsMod.writeBatch(db);
              items.slice(i, i + BATCH).forEach((it) => {
                if (it.kind === 'settings') {
                  batch.set(fsMod.doc(db, `${base}/va_meta/settings`), { id: 'settings', json: it.json, updatedAt: it.updatedAt });
                } else {
                  const coll = it.kind === 'deck' ? 'va_decks' : 'va_words';
                  batch.set(fsMod.doc(db, `${base}/${coll}/${safeId(it.id)}`), { id: it.id, json: it.json, updatedAt: it.updatedAt, deletedAt: it.deletedAt });
                }
              });
              batch.commit().catch((e) => pushStatus('error:' + (e && e.code ? e.code : 'unknown')));
            }
          },
        };
      },
    };
  }

  root.VaSyncFirebase = { loadFirebase };
})(typeof window !== 'undefined' ? window : globalThis);
