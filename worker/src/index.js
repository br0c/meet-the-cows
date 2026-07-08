// Meet the Cows — contribution intake Worker (PROTOTYPE, untested end-to-end).
//
// Flow: the app POSTs multipart/form-data (field metadata + optional photo). We verify a
// Cloudflare Turnstile token, read the photo's EXIF GPS to pre-approve by location, strip EXIF
// from the stored image, then open a GitHub pull request that adds the contribution under
// contributions/<fieldId>/. A maintainer reviews and merges; the pack build folds it in.
//
// Secrets (wrangler secret put): GITHUB_TOKEN (fine-grained: Contents RW + Pull requests RW on
// the repo), TURNSTILE_SECRET. Non-secret config lives in wrangler.toml [vars].

import exifr from 'exifr';

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(env) });
    if (request.method !== 'POST') return json(env, 405, { error: 'Use POST.' });
    try {
      return await handleSubmit(request, env);
    } catch (err) {
      return json(env, 500, { error: 'Submission failed.', detail: String(err && err.message || err) });
    }
  },
};

async function handleSubmit(request, env) {
  const form = await request.formData();
  const get = k => (form.get(k) ?? '').toString().trim();

  const fieldId = get('fieldId');
  const fieldCode = get('fieldCode');
  const fieldLat = Number(get('fieldLat'));
  const fieldLon = Number(get('fieldLon'));
  const fieldName = get('fieldName');
  const date = get('date');
  const description = get('description');
  const submitter = get('submitter');
  const deviceLat = get('deviceLat') ? Number(get('deviceLat')) : null;
  const deviceLon = get('deviceLon') ? Number(get('deviceLon')) : null;
  const photo = form.get('photo'); // File | null

  // --- validation ---
  if (!fieldId || !Number.isFinite(fieldLat) || !Number.isFinite(fieldLon)) {
    return json(env, 400, { error: 'Missing field reference.' });
  }
  if (!description && !(photo && photo.size)) {
    return json(env, 400, { error: 'Add a note, a photo, or both.' });
  }
  const ok = await verifyTurnstile(get('turnstileToken'), env, request.headers.get('CF-Connecting-IP'));
  if (!ok) return json(env, 403, { error: 'Spam check failed. Please retry.' });

  let photoBytes = null;
  let geo = { verified: false, source: 'none', distanceM: null };

  if (photo && photo.size) {
    if (photo.type !== 'image/jpeg') return json(env, 415, { error: 'Photo must be a JPEG.' });
    const maxBytes = Number(env.MAX_PHOTO_BYTES || 15728640);
    if (photo.size > maxBytes) return json(env, 413, { error: 'Photo is too large.' });

    const raw = new Uint8Array(await photo.arrayBuffer());
    const longEdge = jpegLongEdge(raw);
    const minEdge = Number(env.MIN_PHOTO_LONG_EDGE || 2560);
    if (longEdge != null && longEdge < minEdge) {
      return json(env, 422, { error: `Photo resolution too low (min ${minEdge}px on the long edge).` });
    }

    // Read GPS BEFORE stripping EXIF; then store an EXIF-free copy so no location lands in git.
    const gps = await readGps(raw);
    geo = geoVerdict(gps, deviceLat, deviceLon, fieldLat, fieldLon, Number(env.GEO_RADIUS_M || 1000));
    photoBytes = stripExif(raw);
  } else {
    geo = geoVerdict(null, deviceLat, deviceLon, fieldLat, fieldLon, Number(env.GEO_RADIUS_M || 1000));
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
  const shortId = (crypto.randomUUID && crypto.randomUUID().slice(0, 8)) || Math.random().toString(16).slice(2, 10);
  const base = `contributions/${sanitize(fieldId)}/${stamp}_${shortId}`;

  const meta = {
    schema: 1, fieldId, fieldCode, fieldLat, fieldLon, fieldName,
    date: date || new Date().toISOString().slice(0, 10),
    description,
    photo: photoBytes ? `${base.split('/').pop()}.jpg` : null,
    submitter: submitter ? { handle: submitter } : null,
    geo,
    submittedAt: new Date().toISOString(),
  };

  const files = [{ path: `${base}.json`, content: b64(new TextEncoder().encode(JSON.stringify(meta, null, 2))) }];
  if (photoBytes) files.push({ path: `${base}.jpg`, content: b64(photoBytes) });

  const pr = await openPr(env, { fieldId, fieldName, fieldCode, description, geo, files });
  return json(env, 200, { ok: true, prUrl: pr.html_url, prNumber: pr.number, geo });
}

// ---------- geolocation ----------

function geoVerdict(gps, deviceLat, deviceLon, fieldLat, fieldLon, radiusM) {
  if (gps && Number.isFinite(gps.latitude) && Number.isFinite(gps.longitude)) {
    const d = haversine(gps.latitude, gps.longitude, fieldLat, fieldLon);
    if (d <= radiusM) return { verified: true, source: 'exif', distanceM: Math.round(d) };
    return { verified: false, source: 'exif', distanceM: Math.round(d) };
  }
  if (Number.isFinite(deviceLat) && Number.isFinite(deviceLon)) {
    const d = haversine(deviceLat, deviceLon, fieldLat, fieldLon);
    if (d <= radiusM) return { verified: true, source: 'device', distanceM: Math.round(d) };
    return { verified: false, source: 'device', distanceM: Math.round(d) };
  }
  return { verified: false, source: 'none', distanceM: null };
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, toRad = d => d * Math.PI / 180;
  const p1 = toRad(lat1), p2 = toRad(lat2), dp = toRad(lat2 - lat1), dl = toRad(lon2 - lon1);
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function readGps(bytes) {
  try {
    const g = await exifr.gps(bytes);           // { latitude, longitude } | undefined
    return g && Number.isFinite(g.latitude) ? g : null;
  } catch {
    return null; // no/unreadable EXIF ⇒ falls through to device GPS or manual review
  }
}

// ---------- JPEG helpers (prototype — validate against real photos) ----------

// Largest of width/height from the JPEG SOF marker, or null if not found.
function jpegLongEdge(b) {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let i = 2;
  while (i < b.length - 8) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m === 0xda || m === 0xd9) break;                 // SOS / EOI
    const len = dv.getUint16(i + 2);
    const isSof = (m >= 0xc0 && m <= 0xcf) && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
    if (isSof) { const h = dv.getUint16(i + 5), w = dv.getUint16(i + 7); return Math.max(w, h); }
    i += 2 + len;
  }
  return null;
}

// Return a JPEG with all APP1/Exif segments removed (drops embedded GPS from the stored file).
function stripExif(b) {
  if (b[0] !== 0xff || b[1] !== 0xd8) return b;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out = [b.subarray(0, 2)]; // SOI
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) { out.push(b.subarray(i)); break; }
    const m = b[i + 1];
    if (m === 0xda) { out.push(b.subarray(i)); break; }  // SOS + entropy data: copy the rest
    const len = dv.getUint16(i + 2);
    const seg = b.subarray(i, i + 2 + len);
    const isExif = m === 0xe1 && b[i + 4] === 0x45 && b[i + 5] === 0x78 && b[i + 6] === 0x69 && b[i + 7] === 0x66; // "Exif"
    if (!isExif) out.push(seg);
    i += 2 + len;
  }
  let total = 0; for (const c of out) total += c.length;
  const result = new Uint8Array(total);
  let o = 0; for (const c of out) { result.set(c, o); o += c.length; }
  return result;
}

// ---------- GitHub ----------

async function openPr(env, { fieldId, fieldName, fieldCode, description, geo, files }) {
  const repo = env.REPO, baseBranch = env.BASE_BRANCH || 'main';
  const branch = `contrib/${sanitize(fieldId)}-${Date.now().toString(36)}`;

  const baseRef = await gh(env, `/git/ref/heads/${baseBranch}`);
  await gh(env, '/git/refs', 'POST', { ref: `refs/heads/${branch}`, sha: baseRef.object.sha });

  for (const f of files) {
    await gh(env, `/contents/${f.path}`, 'PUT', {
      message: `Contribution: ${fieldName || fieldCode || fieldId}`,
      content: f.content, branch,
    });
  }

  const label = geo.verified ? 'geo-verified' : 'needs-location-review';
  const body = [
    `**Field:** ${fieldName || '—'} (${fieldCode || fieldId})`,
    description ? `\n**Update:**\n${description}` : '',
    `\n**Geo-check:** ${geo.verified ? '✅ verified' : '⚠️ needs review'} · source \`${geo.source}\`` +
      (geo.distanceM != null ? ` · ${geo.distanceM} m from field` : ''),
    `\n_Submitted via the in-app contribution form. A maintainer must review and merge before this goes live._`,
  ].join('\n');

  const pr = await gh(env, '/pulls', 'POST', {
    title: `Contribution: ${fieldName || fieldCode || fieldId}`,
    head: branch, base: baseBranch, body, maintainer_can_modify: true,
  });

  try { await gh(env, `/issues/${pr.number}/labels`, 'POST', { labels: ['contribution', label] }); } catch { /* labels are cosmetic */ }
  return pr;
}

async function gh(env, path, method = 'GET', body) {
  const res = await fetch(`https://api.github.com/repos/${env.REPO}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'mtc-contrib-intake',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`GitHub ${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

// ---------- misc ----------

async function verifyTurnstile(token, env, ip) {
  if (!env.TURNSTILE_SECRET) return true; // not configured yet ⇒ don't block during prototyping
  if (!token) return false;
  const form = new FormData();
  form.set('secret', env.TURNSTILE_SECRET);
  form.set('response', token);
  if (ip) form.set('remoteip', ip);
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  return !!data.success;
}

function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function sanitize(s) { return String(s).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80); }

function cors(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function json(env, status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(env) },
  });
}
