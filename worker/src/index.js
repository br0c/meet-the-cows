// Meet the Cows — contribution intake Worker (live, validated end-to-end).
//
// Flow: the app POSTs multipart/form-data (field metadata + optional photo). We verify a
// Cloudflare Turnstile token, read the photo's EXIF GPS to pre-approve by location, strip EXIF
// from the stored image, then open a GitHub pull request that adds the contribution under
// contributions/<fieldId>/. A maintainer reviews and merges; the pack build folds it in.
// Full-size photo originals are stored in R2 (originals/), and a nightly cron snapshots the
// repo into the same bucket (repo-backups/) as an off-GitHub backup.
//
// Secrets (wrangler secret put): GITHUB_TOKEN (fine-grained: Contents RW + Pull requests RW on
// the repo), TURNSTILE_SECRET. Non-secret config lives in wrangler.toml [vars].

import exifr from 'exifr';

export default {
  async fetch(request, env) {
    const origin = resolveOrigin(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(origin) });
    if (request.method !== 'POST') return json(origin, 405, { error: 'Use POST.' });
    try {
      return await handleSubmit(request, env, origin);
    } catch (err) {
      return json(origin, 500, { error: 'Submission failed.', detail: String(err && err.message || err) });
    }
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(backupRepo(env));
  },
};

async function handleSubmit(request, env, origin) {
  const form = await request.formData();
  const get = k => (form.get(k) ?? '').toString().trim();

  // Blank -> NaN (Number('') is 0, which would silently pass the finite check as 0,0).
  const num = key => { const v = get(key); return v === '' ? NaN : Number(v); };
  const fieldId = get('fieldId');
  const fieldCode = get('fieldCode');
  const fieldLat = num('fieldLat');
  const fieldLon = num('fieldLon');
  const fieldName = get('fieldName');
  const date = get('date');
  const description = get('description');
  const submitter = get('submitter');
  const deviceLat = get('deviceLat') ? Number(get('deviceLat')) : null;
  const deviceLon = get('deviceLon') ? Number(get('deviceLon')) : null;
  const photo = form.get('photo'); // File | null

  // --- validation ---
  if (!fieldId || !Number.isFinite(fieldLat) || !Number.isFinite(fieldLon)) {
    return json(origin, 400, { error: 'Missing field reference.' });
  }
  if (!description && !(photo && photo.size)) {
    return json(origin, 400, { error: 'Add a note, a photo, or both.' });
  }
  const turnstileToken = get('turnstileToken');
  if (env.TURNSTILE_SECRET && !turnstileToken) {
    return json(origin, 403, { error: 'The anti-spam check did not load in the app. Allow challenges.cloudflare.com (disable content blockers for this site) and try again.' });
  }
  const ok = await verifyTurnstile(turnstileToken, env, request.headers.get('CF-Connecting-IP'));
  if (!ok) return json(origin, 403, { error: 'Spam check failed. Please retry.' });

  let photoBytes = null;
  let geo = { verified: false, source: 'none', distanceM: null };

  if (photo && photo.size) {
    if (photo.type !== 'image/jpeg') return json(origin, 415, { error: 'Photo must be a JPEG.' });
    const maxBytes = Number(env.MAX_PHOTO_BYTES || 15728640);
    if (photo.size > maxBytes) return json(origin, 413, { error: 'Photo is too large.' });

    const raw = new Uint8Array(await photo.arrayBuffer());
    const longEdge = jpegLongEdge(raw);
    const minEdge = Number(env.MIN_PHOTO_LONG_EDGE || 2560);
    if (longEdge != null && longEdge < minEdge) {
      return json(origin, 422, { error: `Photo resolution too low (min ${minEdge}px on the long edge).` });
    }

    // Read GPS BEFORE stripping metadata; then store a location-free copy.
    const gps = await readGps(raw);
    geo = geoVerdict(gps, deviceLat, deviceLon, fieldLat, fieldLon, Number(env.GEO_RADIUS_M || 1000));
    photoBytes = stripLocationMetadata(raw);
    if (!photoBytes) return json(origin, 415, { error: 'This photo file looks corrupt — please try another JPEG.' });
  } else {
    geo = geoVerdict(null, deviceLat, deviceLon, fieldLat, fieldLon, Number(env.GEO_RADIUS_M || 1000));
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
  const shortId = (crypto.randomUUID && crypto.randomUUID().slice(0, 8)) || Math.random().toString(16).slice(2, 10);
  const base = `contributions/${sanitize(fieldId)}/${stamp}_${shortId}`;

  // The full-size (EXIF-stripped) original goes to R2, not into git — the repo stays lean and
  // the pack build later downloads + resizes it like any other pack photo. Until the bucket's
  // public URL is configured (R2_PUBLIC_BASE), fall back to the legacy release-asset path.
  let photoAsset = null;
  let photoUploadFailed = false;
  if (photoBytes) {
    const name = `${sanitize(fieldId)}_${stamp}_${shortId}.jpg`;
    try {
      photoAsset = (env.ORIGINALS && env.R2_PUBLIC_BASE)
        ? await uploadOriginal(env, name, photoBytes)
        : await uploadReleaseAsset(env, name, photoBytes);
    } catch (error) {
      // Keep the note: a failed photo upload must not discard a valid submission (mirrors the
      // pack build, which keeps the note when the photo download fails).
      photoUploadFailed = true;
      console.warn('photo upload failed', error);
    }
  }
  if (photoUploadFailed && !description) {
    return json(origin, 502, { error: 'Photo upload failed — please try again.' });
  }

  const meta = {
    schema: 2, fieldId, fieldCode, fieldLat, fieldLon, fieldName,
    date: date || new Date().toISOString().slice(0, 10),
    description,
    photoAsset, // { storage, key|id, name, url, size } | null — full-size original (R2, or legacy release)
    submitter: submitter ? { handle: submitter } : null,
    geo,
    submittedAt: new Date().toISOString(),
  };

  const files = [{ path: `${base}.json`, content: b64(new TextEncoder().encode(JSON.stringify(meta, null, 2))) }];

  let pr;
  try {
    pr = await openPr(env, { fieldId, fieldName, fieldCode, description, geo, files, photoAsset, photoUploadFailed });
  } catch (error) {
    // Don't leave an orphaned original behind when the PR could not be opened.
    if (photoAsset) {
      try {
        if (photoAsset.storage === 'r2') await env.ORIGINALS.delete(photoAsset.key);
        else await gh(env, `/releases/assets/${photoAsset.id}`, 'DELETE');
      } catch { /* best effort */ }
    }
    throw error;
  }
  return json(origin, 200, { ok: true, prUrl: pr.html_url, prNumber: pr.number, geo });
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
    // Device GPS only ever counts IN FAVOUR: on-site ⇒ verified. A far-away device says
    // nothing about the photo (submitted later from home), so it is silently ignored —
    // no mention in the verdict, the PR, or the UI.
    if (d <= radiusM) return { verified: true, source: 'device', distanceM: Math.round(d) };
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

// Largest of width/height from the JPEG SOF marker; null when absent or the file is
// malformed/truncated (every read is bounds-checked so crafted input cannot throw).
function jpegLongEdge(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;                      // desynced: give up cleanly
    while (i + 2 < b.length && b[i + 1] === 0xff) i++;   // 0xFF fill bytes before a marker
    const m = b[i + 1];
    if (m === 0xda || m === 0xd9) return null;           // SOS / EOI: no SOF found
    const len = dv.getUint16(i + 2);
    if (len < 2 || i + 2 + len > b.length) return null;  // segment overruns the buffer
    const isSof = (m >= 0xc0 && m <= 0xcf) && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
    if (isSof) {
      if (i + 9 > b.length) return null;
      return Math.max(dv.getUint16(i + 5), dv.getUint16(i + 7));
    }
    i += 2 + len;
  }
  return null;
}

// Return a JPEG with every metadata segment that can carry a location removed: ALL APP1
// segments (Exif AND XMP — Android/edited photos duplicate GPS in XMP) plus APP13 (IPTC).
// APP0/APP2(ICC)/APP14 stay — needed for correct rendering, never carry GPS. Returns null
// for malformed/truncated input so the caller rejects it instead of storing a corrupt file
// (or silently keeping location data). Returns the original buffer when nothing was dropped.
function stripLocationMetadata(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out = [b.subarray(0, 2)]; // SOI
  let dropped = false;
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) return null;                      // desynced: reject rather than corrupt
    while (i + 2 < b.length && b[i + 1] === 0xff) i++;   // 0xFF fill bytes before a marker
    if (i + 2 > b.length) break;
    const m = b[i + 1];
    if (m === 0xda || m === 0xd9) { out.push(b.subarray(i)); break; } // SOS/EOI: copy the rest
    if (i + 4 > b.length) return null;                   // truncated segment header
    const len = dv.getUint16(i + 2);
    if (len < 2 || i + 2 + len > b.length) return null;  // segment overruns the buffer
    const isLocationCapable = m === 0xe1 || m === 0xed;  // APP1 (Exif/XMP) or APP13 (IPTC)
    if (isLocationCapable) dropped = true;
    else out.push(b.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  if (!dropped) return b;                                // nothing removed: skip the copy
  let total = 0; for (const c of out) total += c.length;
  const result = new Uint8Array(total);
  let o = 0; for (const c of out) { result.set(c, o); o += c.length; }
  return result;
}

// ---------- R2: photo originals + nightly repo backups ----------

// Store the full-size (location-stripped) original in R2 under originals/. The bucket's public
// URL goes into the contribution JSON and the PR body, so reviewers and the pack build fetch it
// like any plain https URL — no credentials, no build changes.
async function uploadOriginal(env, name, bytes) {
  const key = `originals/${name}`;
  await env.ORIGINALS.put(key, bytes, { httpMetadata: { contentType: 'image/jpeg' } });
  const base = String(env.R2_PUBLIC_BASE).replace(/\/+$/, '');
  return { storage: 'r2', key, name, url: `${base}/${key}`, size: bytes.length };
}

const BACKUP_PREFIX = 'repo-backups/';
const BACKUP_RETAIN_DAYS = 90;
const BACKUP_MAX_BYTES = 100 * 1024 * 1024; // sanity cap; the repo tarball is a few MB

// Nightly cron: snapshot the repo into R2 as an off-GitHub backup. GitHub serves a full tarball
// of any ref over plain https (public repo — no token needed), so this is just fetch -> put.
// Old snapshots are pruned after BACKUP_RETAIN_DAYS; repo-backups/last-run.json records the
// outcome so a quick look at the bucket shows whether backups are healthy.
async function backupRepo(env) {
  if (!env.ORIGINALS) return;
  const branches = String(env.BACKUP_BRANCHES || 'main').split(',').map(s => s.trim()).filter(Boolean);
  const day = new Date().toISOString().slice(0, 10);
  const results = [];

  for (const branch of branches) {
    try {
      const url = `https://codeload.github.com/${env.REPO}/tar.gz/refs/heads/${encodeURIComponent(branch)}`;
      const res = await fetch(url, { headers: { 'User-Agent': 'mtc-contrib-intake' } });
      if (!res.ok) throw new Error(`tarball fetch → ${res.status}`);
      const bytes = await res.arrayBuffer();
      if (bytes.byteLength > BACKUP_MAX_BYTES) throw new Error(`tarball too large (${bytes.byteLength} bytes)`);
      const key = `${BACKUP_PREFIX}${sanitize(branch)}-${day}.tar.gz`;
      await env.ORIGINALS.put(key, bytes, { httpMetadata: { contentType: 'application/gzip' } });
      results.push({ branch, key, size: bytes.byteLength, ok: true });
    } catch (error) {
      // A deleted branch (404) or a transient failure must not block the other branches.
      results.push({ branch, ok: false, error: String(error && error.message || error) });
    }
  }

  try {
    const cutoff = Date.now() - BACKUP_RETAIN_DAYS * 86400000;
    const listing = await env.ORIGINALS.list({ prefix: BACKUP_PREFIX });
    for (const obj of listing.objects) {
      if (obj.key.endsWith('.tar.gz') && obj.uploaded.getTime() < cutoff) await env.ORIGINALS.delete(obj.key);
    }
  } catch (error) {
    results.push({ prune: false, error: String(error && error.message || error) });
  }

  await env.ORIGINALS.put(`${BACKUP_PREFIX}last-run.json`,
    JSON.stringify({ at: new Date().toISOString(), results }, null, 2),
    { httpMetadata: { contentType: 'application/json' } });
  if (results.some(r => r.ok === false)) console.error('repo backup issues:', JSON.stringify(results));
}

// Exported for tests only; Workers ignores extra named exports.
export { uploadOriginal, backupRepo };

// ---------- GitHub ----------

// Geo line for the PR body. Device GPS is only ever mentioned when it verified the
// submission (on-site); a far-away or absent device signal reads as "no location data".
function geoSummary(geo) {
  if (geo.source === 'exif' && geo.verified) return `✅ pre-verified — photo GPS, ${geo.distanceM} m from the field`;
  if (geo.source === 'exif') return `⚠️ photo GPS is ${geo.distanceM} m from the field — needs review`;
  if (geo.source === 'device') return `✅ pre-verified — submitted on-site (device GPS, ${geo.distanceM} m from the field; photo has no location data)`;
  return '⚠️ no location data — needs review';
}

async function openPr(env, { fieldId, fieldName, fieldCode, description, geo, files, photoAsset, photoUploadFailed }) {
  const baseBranch = env.BASE_BRANCH || 'main';
  // Random suffix: Date.now() alone collides when two pilots submit for the same field in the
  // same millisecond (the JSON/asset names already carry a random id; the branch must too).
  const branch = `contrib/${sanitize(fieldId)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  const baseRef = await gh(env, `/git/ref/heads/${baseBranch}`);
  await gh(env, '/git/refs', 'POST', { ref: `refs/heads/${branch}`, sha: baseRef.object.sha });

  try {
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
      `\n**Geo-check:** ${geoSummary(geo)}`,
      photoAsset ? `\n**Photo** (full-size original, location metadata stripped):\n\n![contribution photo](${photoAsset.url})` : '',
      photoUploadFailed ? '\n**Photo:** upload failed — this is a note-only submission.' : '',
      `\n_Submitted via the in-app contribution form. A maintainer must review and merge before this goes live._`,
    ].join('\n');

    const pr = await gh(env, '/pulls', 'POST', {
      title: `Contribution: ${fieldName || fieldCode || fieldId}`,
      head: branch, base: baseBranch, body, maintainer_can_modify: true,
    });

    try { await gh(env, `/issues/${pr.number}/labels`, 'POST', { labels: ['contribution', label] }); } catch { /* labels are cosmetic */ }
    return pr;
  } catch (error) {
    // Don't leave a dangling contrib/* branch when the commit or PR step fails.
    try { await gh(env, `/git/refs/heads/${branch}`, 'DELETE'); } catch { /* best effort */ }
    throw error;
  }
}

// Rolling release that stores full-size contribution photos as assets (git stays lean).
// Created on first use; memoized per isolate so routine submissions skip the lookup. Only a
// 404 means "create it" — auth/rate-limit/5xx errors surface as themselves instead of being
// masked by a doomed create attempt (422 already_exists).
let cachedRelease = null;
async function ensureRelease(env) {
  if (cachedRelease) return cachedRelease;
  const tag = env.RELEASE_TAG || 'contrib-originals';
  try {
    cachedRelease = await gh(env, `/releases/tags/${tag}`);
  } catch (error) {
    if (!String(error && error.message || '').includes('→ 404')) throw error;
    cachedRelease = await gh(env, '/releases', 'POST', {
      tag_name: tag,
      name: 'Contribution photo originals',
      body: 'Full-size (location-stripped) originals of community-contributed field photos. The pack build resizes these for the app.',
      draft: false,
      prerelease: false,
    });
  }
  return cachedRelease;
}

async function uploadReleaseAsset(env, name, bytes) {
  const release = await ensureRelease(env);
  const url = `https://uploads.github.com/repos/${env.REPO}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'mtc-contrib-intake',
      'Content-Type': 'image/jpeg',
      'Content-Length': String(bytes.length),
    },
    body: bytes,
  });
  if (!res.ok) throw new Error(`GitHub asset upload → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const asset = await res.json();
  return { id: asset.id, name: asset.name, url: asset.browser_download_url, size: asset.size };
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
  if (res.status === 204) return null; // e.g. DELETE ref/asset: success with no body
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

// Echo the request Origin when it is the configured app origin or a localhost dev server;
// anything else gets the configured origin (and the browser blocks it). Lets the deployed app
// AND a locally served dev app talk to the same Worker.
function resolveOrigin(request, env) {
  const allow = env.ALLOWED_ORIGIN || '*';
  if (allow === '*') return '*';
  const origin = request.headers.get('Origin') || '';
  if (origin === allow) return origin;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin; // local dev
  return allow;
}

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(origin, status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(origin) },
  });
}
