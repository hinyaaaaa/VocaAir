import assert from 'node:assert/strict';
import { webcrypto, createPublicKey, createVerify } from 'node:crypto';
import fs from 'node:fs';
import worker, { vapidHeader, shouldSend, localParts, run } from './src/index.js';

// テスト用の使い捨て鍵をその場で生成（本物の鍵には依存しない）
const kp = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const priv = JSON.stringify(await webcrypto.subtle.exportKey('jwk', kp.privateKey));
const pub = Buffer.from(await webcrypto.subtle.exportKey('raw', kp.publicKey)).toString('base64url');
const env = { VAPID_PRIVATE_JWK: priv, VAPID_PUBLIC_KEY: pub, VAPID_SUBJECT: 'mailto:t@example.com' };

// 1) VAPID JWT の署名が公開鍵で検証できる (ES256 は r||s の64バイト)
const hdr = await vapidHeader('https://web.push.apple.com/abc', env, 1_700_000_000_000);
const m = hdr.match(/^vapid t=([^,]+), k=(.+)$/); assert.ok(m); assert.equal(m[2], pub);
const [h, b, s] = m[1].split('.');
const sig = Buffer.from(s, 'base64url'); assert.equal(sig.length, 64);
const raw = Buffer.from(pub, 'base64url');
const pk = await webcrypto.subtle.importKey('raw', raw, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
assert.ok(await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pk, sig, new TextEncoder().encode(h + '.' + b)));
assert.equal(JSON.parse(Buffer.from(b, 'base64url')).aud, 'https://web.push.apple.com');

// 2) 時刻判定: 日本(tzOffset=-540)で 20:00 設定
const jst = (y, mo, d, hh, mm) => Date.UTC(y, mo - 1, d, hh - 9, mm);
const sub = { time: '20:00', tz: -540, last: '' };
assert.equal(localParts(jst(2026, 10, 14, 20, 0), -540).hhmm, '20:00');
assert.ok(shouldSend(sub, jst(2026, 10, 14, 20, 0)));
assert.ok(shouldSend(sub, jst(2026, 10, 14, 20, 9)));       // 取りこぼし救済
assert.ok(!shouldSend(sub, jst(2026, 10, 14, 19, 59)));
assert.ok(!shouldSend(sub, jst(2026, 10, 14, 20, 10)));     // 10分を過ぎたら送らない
assert.ok(!shouldSend({ ...sub, last: '2026-10-14' }, jst(2026, 10, 14, 20, 1))); // 今日送信済み
assert.ok(shouldSend(sub, jst(2026, 10, 15, 20, 0)));       // 翌日はまた送る
assert.ok(shouldSend({ time: '00:05', tz: -540, last: '' }, jst(2026, 10, 14, 0, 5)));

// 3) run(): 送信 → last更新 → 同じ分の再実行では送らない / 410は購読削除
const store = {}; env.SUBS = { get: async k => (store[k] ? JSON.parse(store[k]) : null), put: async (k, v) => { store[k] = v; } };
store.subs = JSON.stringify({ 'https://e/1': { sub: { endpoint: 'https://e/1' }, time: '20:00', tz: -540, last: '' }, 'https://e/gone': { sub: { endpoint: 'https://e/gone' }, time: '20:00', tz: -540, last: '' } });
const sent = [];
const send = async s => { sent.push(s.endpoint); return { ok: s.endpoint !== 'https://e/gone', status: s.endpoint === 'https://e/gone' ? 410 : 201 }; };
await run(env, jst(2026, 10, 14, 20, 0), send);
await run(env, jst(2026, 10, 14, 20, 1), send);
assert.deepEqual(sent.sort(), ['https://e/1', 'https://e/gone']);
const after = JSON.parse(store.subs); assert.ok(after['https://e/1'] && !after['https://e/gone']); assert.equal(after['https://e/1'].last, '2026-10-14');

// 4) /subscribe /unsubscribe
env.ALLOWED_ORIGIN = 'https://hinyaaaaa.github.io';
const post = (path, body, origin = env.ALLOWED_ORIGIN) => worker.fetch(new Request('https://w.example' + path, { method: 'POST', headers: { Origin: origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }), env);
assert.equal((await post('/subscribe', { subscription: { endpoint: 'https://push/x', keys: {} }, time: '07:30', tzOffset: -540 })).status, 200);
assert.equal(JSON.parse(store.subs)['https://push/x'].time, '07:30');
assert.equal((await post('/subscribe', { subscription: { endpoint: 'http://bad' }, time: '07:30' })).status, 400);
assert.equal((await post('/subscribe', { subscription: { endpoint: 'https://push/y' }, time: '07:30' }, 'https://evil.example')).status, 403);
await post('/unsubscribe', { endpoint: 'https://push/x' });
assert.ok(!JSON.parse(store.subs)['https://push/x']);
console.log('worker tests passed');
