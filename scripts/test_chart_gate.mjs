// The chart gate: token minting, verification, and what the /charts/ route will and will not
// hand out. Runs the Worker's real module against a stub R2 binding — no Cloudflare account,
// no deploy — so the logic that stands between a private bucket and the open web is checked
// here rather than in production.
//
//   node scripts/test_chart_gate.mjs

import worker from '../worker/src/index.js';

const SECRET = 'test-secret-not-the-real-one';
const CHART = new TextEncoder().encode('%PDF-1.4 fake chart bytes');

const env = {
  ALLOWED_ORIGIN: 'https://app.meetthecows.org',
  CHARTS_TOKEN_SECRET: SECRET,
  CHARTS: {
    async get(key) {
      if (key !== 'vac/LFNE.pdf') return null;
      return { body: CHART, size: CHART.length, httpMetadata: { contentType: 'application/pdf' } };
    },
  },
};

let failures = 0;
function check(label, condition) {
  console.log(`${condition ? '  ok  ' : 'FAIL  '}${label}`);
  if (!condition) failures += 1;
}

const get = (url, headers = {}) => worker.fetch(new Request(url, { method: 'GET', headers }), env);

// --- minting ---------------------------------------------------------------------------------
const minted = await get('https://w.example/charts/token', { Origin: 'https://app.meetthecows.org' });
const body = await minted.clone().json();
check('token endpoint returns 200', minted.status === 200);
check('token is <expiry>.<signature>', /^\d+\.[A-Za-z0-9_-]+$/.test(body.token));
check('token response is never stored by a cache', minted.headers.get('Cache-Control') === 'no-store');
check('token endpoint echoes the app origin', minted.headers.get('Access-Control-Allow-Origin') === 'https://app.meetthecows.org');

// --- the happy path --------------------------------------------------------------------------
const ok = await get(`https://w.example/charts/vac/LFNE.pdf?t=${encodeURIComponent(body.token)}`);
check('a valid token serves the chart', ok.status === 200);
check('served as a PDF', ok.headers.get('Content-Type') === 'application/pdf');
check('bytes are the object body', new Uint8Array(await ok.arrayBuffer()).length === CHART.length);
// A shared cache keyed on a tokened URL would hand one pilot's token to the next requester.
check('chart response is private, not shared-cacheable',
  /(^|,\s*)private/.test(ok.headers.get('Cache-Control') || ''));

// --- what must NOT get through -----------------------------------------------------------------
check('no token -> 403', (await get('https://w.example/charts/vac/LFNE.pdf')).status === 403);
check('empty token -> 403', (await get('https://w.example/charts/vac/LFNE.pdf?t=')).status === 403);
check('garbage token -> 403', (await get('https://w.example/charts/vac/LFNE.pdf?t=nonsense')).status === 403);

// Forging: keep a real expiry, swap the signature.
const [expiry] = body.token.split('.');
check('valid expiry with a forged signature -> 403',
  (await get(`https://w.example/charts/vac/LFNE.pdf?t=${expiry}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`)).status === 403);

// Extending your own expiry must not verify — this is the whole point of signing it.
check('expiry rewritten to the far future -> 403',
  (await get(`https://w.example/charts/vac/LFNE.pdf?t=${Number(expiry) + 86400}.${body.token.split('.')[1]}`)).status === 403);

// An expired-but-genuine token, signed with the real secret.
const stale = Math.floor(Date.now() / 1000) - 10;
const staleSig = await (async () => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(stale)));
  return btoa(String.fromCharCode(...new Uint8Array(mac))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
})();
check('correctly signed but expired -> 403',
  (await get(`https://w.example/charts/vac/LFNE.pdf?t=${stale}.${staleSig}`)).status === 403);

// A token signed with a different secret: this is what rotating CHARTS_TOKEN_SECRET does to
// every token in circulation.
const otherSig = await (async () => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('some-other-secret'),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(expiry));
  return btoa(String.fromCharCode(...new Uint8Array(mac))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
})();
check('signed with a rotated-away secret -> 403',
  (await get(`https://w.example/charts/vac/LFNE.pdf?t=${expiry}.${otherSig}`)).status === 403);

// Path traversal must not reach the sibling bucket contents, token or no token.
check('path traversal -> 404 even with a valid token',
  (await get(`https://w.example/charts/../originals/secret.jpg?t=${body.token}`)).status === 404);
check('unknown chart -> 404', (await get(`https://w.example/charts/vac/NOPE.pdf?t=${body.token}`)).status === 404);

// Without the secret configured the route must fail closed rather than serve the bucket.
const unconfigured = { ...env, CHARTS_TOKEN_SECRET: '' };
check('no secret configured -> chart route 403',
  (await worker.fetch(new Request('https://w.example/charts/vac/LFNE.pdf?t=x'), unconfigured)).status === 403);
check('no secret configured -> token route 503',
  (await worker.fetch(new Request('https://w.example/charts/token'), unconfigured)).status === 503);

// The pre-existing originals route must still work — this router change sits in front of it.
const originals = { ...env, ORIGINALS: { async get(key) {
  return key === 'originals/photo.jpg' ? { body: CHART, size: CHART.length, httpMetadata: {} } : null; } } };
check('originals route still serves',
  (await worker.fetch(new Request('https://w.example/originals/photo.jpg'), originals)).status === 200);

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll chart-gate checks passed');
process.exit(failures ? 1 : 0);
