const core = require('/home/claude/VocaAir/sync-core.js');
const { makeCloud, makeDevice, wait } = require('./harness.js');
const d = JSON.parse(require('fs').readFileSync('/home/claude/VocaAir/VocaAir_save_data.json', 'utf8'));
const used = new Set(d.words.map(w => String(w.id))), seen = new Set();
for (const w of d.words) { const k = String(w.id); if (!seen.has(k)) { seen.add(k); continue; } let c, j = 1; do { c = Number(w.id) + 0.0005 * j; j++; } while (used.has(String(c))); used.add(String(c)); w.id = c; }
let pass = 0, fail = 0;
const ok = (c, name, extra = '') => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); };
(async () => {
  // 1) 1バッチ失敗 → 自動で再送されて全語が届く
  {
    const cloud = makeCloud(); let failedOnce = false;
    const A = makeDevice(core, cloud, d, { failBatch: (bi) => { if (bi === 2 && !failedOnce) { failedOnce = true; return true; } return false; } });
    A.eng.start(); await wait(60); await A.eng.idle();
    ok(cloud.docs.words.size === 1529, '失敗直後はクラウド 1529語', 'got ' + cloud.docs.words.size);
    ok(A.eng.pendingFailed === 400, '失敗件数を把握している', 'pending ' + A.eng.pendingFailed);
    A.eng.flush(); await A.eng.idle();     // バックオフ後の再送（次の保存・起動・オンライン復帰でも同じ）
    ok(cloud.docs.words.size === 1929, '再送で全1929語が届く', 'got ' + cloud.docs.words.size);
    ok(A.eng.pendingFailed === 0, '失敗件数が0に戻る');
  }
  // 2) 送信が全部例外で落ちても、記録を取り消して後で送れる
  {
    const cloud = makeCloud(); let down = true;
    const A = makeDevice(core, cloud, d, { failBatch: () => down });
    A.eng.start(); await wait(60); await A.eng.idle();
    ok(cloud.docs.words.size === 0, '全滅中はクラウド0語');
    down = false; A.eng.flush(); await A.eng.idle();
    ok(cloud.docs.words.size === 1929, '復旧後に全語が届く', 'got ' + cloud.docs.words.size);
  }
  // 3) 旧版の症状が残っている端末（meta は「送信済み」なのにクラウドに無い）→ 全件照合で補う
  {
    const cloud = makeCloud(); let failedOnce = false;
    const A = makeDevice(core, cloud, d, { failBatch: (bi) => { if (bi === 2 && !failedOnce) { failedOnce = true; return true; } return false; } });
    A.eng.start(); await wait(60); await A.eng.idle();
    // 「旧版で失敗した端末」を模す: 失敗した語の meta を“送信済み”に戻す
    const lost = d.words.filter(w => !cloud.docs.words.has(String(w.id)));
    lost.forEach(w => { A.eng.meta.words[String(w.id)] = { h: core.hashOf(w), u: 1 }; });
    A.eng.flush(); await A.eng.idle();
    ok(cloud.docs.words.size === 1529, '旧版の症状を再現（記録上は送信済み・実際は欠け）', 'cloud ' + cloud.docs.words.size);
    const r = await A.eng.reconcile();
    ok(cloud.docs.words.size === 1929 && r.resent === 400, '全件照合で欠けた400語を補う', JSON.stringify(r));
    const r2 = await A.eng.reconcile();
    ok(r2.resent === 0 && r2.pulled === 0 && r2.cloud.words === 1929, '2回目は何も起きない（一致）', JSON.stringify(r2));
  }
  // 4) クラウドにあって端末に無い語は取り込む（新しい端末・消えた端末）
  {
    const cloud = makeCloud();
    const A = makeDevice(core, cloud, d); A.eng.start(); await wait(60); await A.eng.idle();
    const B = makeDevice(core, cloud, { decks: [], words: [] }); B.eng.start(); await wait(80); await B.eng.idle();
    ok(B.store.words.length === 1929 && B.store.decks.length === 3, '空の新端末に全1929語・3冊が届く', B.store.words.length + '語');
    // B から一部が消えた状態（取り込み失敗を模す）
    B.store.words = B.store.words.slice(0, 1500);
    const r = await B.eng.reconcile();
    ok(B.store.words.length === 1929 && r.pulled === 429, '全件照合でBの欠け429語を取り込む', JSON.stringify(r));
  }
  // 5) 既存の挙動が壊れていない: 1語の採点が1件だけ送られる／削除が伝わる／不正IDは無視
  {
    const cloud = makeCloud();
    const A = makeDevice(core, cloud, d); A.eng.start(); await wait(60); await A.eng.idle();
    A.store.words[10].reps = 99; const it = A.eng.flush(); await A.eng.idle();
    ok(it.length === 1, '1語の変更は1件だけ送る', 'items ' + it.length);
    const gone = A.store.words.pop(); const it2 = A.eng.flush(); await A.eng.idle();
    ok(it2.length === 1 && cloud.docs.words.get(String(gone.id)).deletedAt, '削除は墓標で伝わる');
  }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
