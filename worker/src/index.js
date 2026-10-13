/* VocaAir 通知サーバー (Cloudflare Workers)
   - POST /subscribe   { subscription, time:"HH:MM", tzOffset }  購読と通知時刻を登録/更新
   - POST /unsubscribe { endpoint }                              解除
   - cron(毎分)で、各購読者の「現地時刻」が設定時刻になったら空のWeb Pushを送る。
     本文はService Worker側が端末内の復習数から作る（暗号化ペイロード不要）。 */

const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const enc = s => new TextEncoder().encode(s);

export async function vapidHeader(endpoint, env, nowMs = Date.now()) {
  const aud = new URL(endpoint).origin;
  const head = b64u(enc(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(enc(JSON.stringify({ aud, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT || 'mailto:admin@example.com' })));
  const key = await crypto.subtle.importKey('jwk', JSON.parse(env.VAPID_PRIVATE_JWK), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc(head + '.' + body));
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${env.VAPID_PUBLIC_KEY}`;
}

export async function sendPush(sub, env) {
  return fetch(sub.endpoint, {
    method: 'POST',
    headers: { Authorization: await vapidHeader(sub.endpoint, env), TTL: '3600', Urgency: 'normal' },
  });
}

export function localParts(nowMs, tzOffsetMin) {
  const d = new Date(nowMs - tzOffsetMin * 60000); // getTimezoneOffset は「UTC − 現地」(分)
  const hh = String(d.getUTCHours()).padStart(2, '0'), mm = String(d.getUTCMinutes()).padStart(2, '0');
  return { hhmm: `${hh}:${mm}`, date: `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`, minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}
const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

// 今この購読者に送るべきか。設定時刻ちょうど、または取りこぼし救済(設定時刻から10分以内で、まだ今日送っていない)
export function shouldSend(s, nowMs) {
  const p = localParts(nowMs, s.tz || 0);
  if (s.last === p.date) return false;
  const diff = p.minutes - toMin(s.time);
  return diff >= 0 && diff < 10;
}

async function loadSubs(env) { return (await env.SUBS.get('subs', 'json')) || {}; }
const saveSubs = (env, subs) => env.SUBS.put('subs', JSON.stringify(subs));

export async function run(env, nowMs = Date.now(), send = sendPush) {
  const subs = await loadSubs(env);
  let dirty = false;
  for (const [ep, s] of Object.entries(subs)) {
    if (!shouldSend(s, nowMs)) continue;
    const res = await send(s.sub, env).catch(() => null);
    if (res && (res.status === 404 || res.status === 410)) { delete subs[ep]; dirty = true; continue; }
    if (res && res.ok) { s.last = localParts(nowMs, s.tz || 0).date; dirty = true; }
  }
  if (dirty) await saveSubs(env, subs);
}

function cors(env, req) {
  const origin = req.headers.get('Origin') || '';
  const allow = (env.ALLOWED_ORIGIN || '*');
  const ok = allow === '*' || origin === allow;
  return { 'Access-Control-Allow-Origin': ok ? (allow === '*' ? '*' : origin) : 'null', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type', Vary: 'Origin' };
}

export default {
  async fetch(req, env) {
    const h = cors(env, req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/health') return new Response('ok', { headers: h });
    if (req.method !== 'POST') return new Response('not found', { status: 404, headers: h });
    if (env.ALLOWED_ORIGIN && env.ALLOWED_ORIGIN !== '*' && req.headers.get('Origin') !== env.ALLOWED_ORIGIN) return new Response('forbidden', { status: 403, headers: h });
    let body; try { body = await req.json(); } catch (e) { return new Response('bad json', { status: 400, headers: h }); }
    const subs = await loadSubs(env);
    if (url.pathname === '/subscribe') {
      const sub = body.subscription;
      if (!sub || typeof sub.endpoint !== 'string' || !sub.endpoint.startsWith('https://') || !/^\d{2}:\d{2}$/.test(body.time || '')) return new Response('bad request', { status: 400, headers: h });
      const prev = subs[sub.endpoint];
      subs[sub.endpoint] = { sub, time: body.time, tz: Number(body.tzOffset) || 0, last: prev && prev.time === body.time ? prev.last : '' };
      await saveSubs(env, subs);
      return new Response('ok', { headers: h });
    }
    if (url.pathname === '/unsubscribe') {
      if (body.endpoint) { delete subs[body.endpoint]; await saveSubs(env, subs); }
      return new Response('ok', { headers: h });
    }
    return new Response('not found', { status: 404, headers: h });
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(run(env)); },
};
