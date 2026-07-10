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
    if (request.method === 'GET') return serveOriginal(request, env);
    if (request.method !== 'POST') return json(origin, 405, { error: 'Use POST.' });
    try {
      if (new URL(request.url).pathname.endsWith('/bug')) return await handleBugReport(request, env, origin);
      return await handleSubmit(request, env, origin);
    } catch (err) {
      return json(origin, 500, { error: 'Submission failed.', detail: String(err && err.message || err) });
    }
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(backupRepo(env));
  },
};

// Anonymous in-app bug report -> GitHub issue. Turnstile-gated like contributions, so pilots
// need no GitHub account; the token requires Issues: Read and write on the repo.
async function handleBugReport(request, env, origin) {
  const form = await request.formData();
  const get = k => (form.get(k) ?? '').toString().trim();

  const description = get('description').slice(0, 5000);
  if (!description) return json(origin, 400, { error: 'Describe the bug.' });
  const turnstileToken = get('turnstileToken');
  if (env.TURNSTILE_SECRET && !turnstileToken) {
    return json(origin, 403, { error: 'The anti-spam check did not load in the app. Allow challenges.cloudflare.com (disable content blockers for this site) and try again.' });
  }
  const ok = await verifyTurnstile(turnstileToken, env, request.headers.get('CF-Connecting-IP'));
  if (!ok) return json(origin, 403, { error: 'Spam check failed. Please retry.' });

  const contact = get('contact').slice(0, 200);
  const diagnostics = get('diagnostics').slice(0, 2000);
  const firstLine = description.replace(/\s+/g, ' ').trim();
  const title = `Bug report: ${firstLine.slice(0, 72)}${firstLine.length > 72 ? '…' : ''}`;
  const body = [
    description,
    contact ? `\n**Contact:** ${contact}` : '',
    diagnostics ? `\n---\n\`\`\`\n${diagnostics}\n\`\`\`` : '',
    '\n_Submitted anonymously via the in-app bug report._',
  ].filter(Boolean).join('\n');

  const issue = await gh(env, '/issues', 'POST', { title, body, labels: ['bug', 'from-app'] });
  return json(origin, 200, { ok: true, issueUrl: issue.html_url, issueNumber: issue.number });
}

const NEW_FIELD_COUNTRIES = ['FR', 'CH', 'DE', 'IT', 'AT'];

async function handleSubmit(request, env, origin) {
  const form = await request.formData();
  const get = k => (form.get(k) ?? '').toString().trim();

  // Blank -> NaN (Number('') is 0, which would silently pass the finite check as 0,0).
  const num = key => { const v = get(key); return v === '' ? NaN : Number(v); };
  const optNum = key => { const v = num(key); return Number.isFinite(v) ? v : null; };

  // Two submission types share the pipeline: 'update' (default; note/photos for an existing
  // field) and 'new-field' (a proposed field with its own metadata). Both end as a reviewed PR.
  const type = get('type') === 'new-field' ? 'new-field' : 'update';
  let fieldId, fieldCode, fieldName, fieldLat, fieldLon;
  let proposed = null;
  if (type === 'new-field') {
    fieldName = get('name').slice(0, 80);
    fieldLat = num('lat');
    fieldLon = num('lon');
    if (fieldName.length < 3) return json(origin, 400, { error: 'Give the field a name (3+ characters).' });
    if (!Number.isFinite(fieldLat) || Math.abs(fieldLat) > 90 || !Number.isFinite(fieldLon) || Math.abs(fieldLon) > 180) {
      return json(origin, 400, { error: 'Valid coordinates are required.' });
    }
    const country = get('country').toUpperCase();
    if (!NEW_FIELD_COUNTRIES.includes(country)) return json(origin, 400, { error: "Pick the field's country." });
    const difficulty = get('difficulty').toUpperCase();
    proposed = {
      name: fieldName,
      kind: get('kind') === 'airfield' ? 'airfield' : 'outlanding',
      country,
      latitude: fieldLat,
      longitude: fieldLon,
      elevationM: optNum('elevationM'),
      difficulty: ['A', 'B', 'C'].includes(difficulty) ? difficulty : '',
      runway: get('runway').slice(0, 20),
      lengthM: optNum('lengthM'),
      widthM: optNum('widthM'),
      surface: get('surface').slice(0, 60),
      frequency: get('frequency').slice(0, 20),
    };
    fieldCode = '';
    fieldId = `new-${fieldName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'field'}`;
  } else {
    fieldId = get('fieldId');
    fieldCode = get('fieldCode');
    fieldName = get('fieldName');
    fieldLat = num('fieldLat');
    fieldLon = num('fieldLon');
    if (!fieldId || !Number.isFinite(fieldLat) || !Number.isFinite(fieldLon)) {
      return json(origin, 400, { error: 'Missing field reference.' });
    }
  }
  const date = get('date');
  const description = get('description');
  const submitter = get('submitter');
  const deviceLat = get('deviceLat') ? Number(get('deviceLat')) : null;
  const deviceLon = get('deviceLon') ? Number(get('deviceLon')) : null;

  // Photos arrive as repeated 'photos' entries; the legacy single 'photo' key is still
  // accepted because installed app shells update lazily.
  const photoFiles = [...form.getAll('photos'), form.get('photo')]
    .filter(f => f && typeof f === 'object' && Number(f.size) > 0);
  const maxPhotos = Number(env.MAX_PHOTOS || 5);
  if (photoFiles.length > maxPhotos) {
    return json(origin, 400, { error: `At most ${maxPhotos} photos per submission.` });
  }

  // --- validation ---
  if (type === 'update' && !description && !photoFiles.length) {
    return json(origin, 400, { error: 'Add a note, a photo, or both.' });
  }
  const turnstileToken = get('turnstileToken');
  if (env.TURNSTILE_SECRET && !turnstileToken) {
    return json(origin, 403, { error: 'The anti-spam check did not load in the app. Allow challenges.cloudflare.com (disable content blockers for this site) and try again.' });
  }
  const ok = await verifyTurnstile(turnstileToken, env, request.headers.get('CF-Connecting-IP'));
  if (!ok) return json(origin, 403, { error: 'Spam check failed. Please retry.' });

  const radiusM = Number(env.GEO_RADIUS_M || 1000);
  const maxBytes = Number(env.MAX_PHOTO_BYTES || 15728640);
  const minEdge = Number(env.MIN_PHOTO_LONG_EDGE || 2560);

  // Validate every photo and compute its own geo verdict before anything is uploaded, so a
  // bad file rejects the submission without leaving orphaned originals behind.
  const staged = []; // { bytes, geo }
  for (const photo of photoFiles) {
    if (photo.type !== 'image/jpeg') return json(origin, 415, { error: 'Photos must be JPEGs.' });
    if (photo.size > maxBytes) return json(origin, 413, { error: `Photo "${photo.name}" is too large.` });
    const raw = new Uint8Array(await photo.arrayBuffer());
    const longEdge = jpegLongEdge(raw);
    if (longEdge != null && longEdge < minEdge) {
      return json(origin, 422, { error: `Photo resolution too low (min ${minEdge}px on the long edge).` });
    }
    // Read GPS BEFORE stripping metadata; then store a location-free copy.
    const gps = await readGps(raw);
    const photoGeo = geoVerdict(gps, deviceLat, deviceLon, fieldLat, fieldLon, radiusM);
    const bytes = stripLocationMetadata(raw);
    if (!bytes) return json(origin, 415, { error: 'A photo file looks corrupt — please try another JPEG.' });
    staged.push({ bytes, geo: photoGeo });
  }
  // Aggregate verdict (response + PR label): every photo pre-verified, or — with no photos —
  // the on-site device check.
  const geo = staged.length
    ? { ...(staged.find(p => !p.geo.verified) || staged[0]).geo, verified: staged.every(p => p.geo.verified) }
    : geoVerdict(null, deviceLat, deviceLon, fieldLat, fieldLon, radiusM);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
  const shortId = (crypto.randomUUID && crypto.randomUUID().slice(0, 8)) || Math.random().toString(16).slice(2, 10);
  const base = `contributions/${sanitize(fieldId)}/${stamp}_${shortId}`;

  // Full-size (EXIF-stripped) originals go to R2, not into git — the repo stays lean and the
  // pack build later downloads + resizes them like any other pack photo. Without the bucket
  // binding (e.g. local dev), fall back to the legacy release-asset path. A failed upload
  // drops that one photo (warn), never the submission.
  const photoAssets = [];
  let photoUploadFailed = false;
  for (const [index, photo] of staged.entries()) {
    const name = `${sanitize(fieldId)}_${stamp}_${shortId}_${index + 1}.jpg`;
    try {
      const asset = env.ORIGINALS
        ? await uploadOriginal(env, new URL(request.url).origin, name, photo.bytes)
        : await uploadReleaseAsset(env, name, photo.bytes);
      photoAssets.push({ ...asset, geo: photo.geo });
    } catch (error) {
      photoUploadFailed = true;
      console.warn('photo upload failed', error);
    }
  }
  if (photoUploadFailed && !description && type === 'update') {
    await deleteOriginals(env, photoAssets);
    return json(origin, 502, { error: 'Photo upload failed — please try again.' });
  }

  const meta = {
    schema: 3, type, fieldId, fieldCode, fieldLat, fieldLon, fieldName,
    proposed, // the suggested field's data (new-field submissions only)
    date: date || new Date().toISOString().slice(0, 10),
    description,
    photoAssets, // [{ storage, key|id, name, url, size, geo }] — full-size originals (R2, or legacy release)
    submitter: submitter ? { handle: submitter } : null,
    geo,
    submittedAt: new Date().toISOString(),
  };

  const files = [{ path: `${base}.json`, content: b64(new TextEncoder().encode(JSON.stringify(meta, null, 2))) }];

  let pr;
  try {
    pr = await openPr(env, { type, fieldId, fieldName, fieldCode, proposed, description, geo, files, photoAssets, photoUploadFailed });
  } catch (error) {
    // Don't leave orphaned originals behind when the PR could not be opened.
    await deleteOriginals(env, photoAssets);
    throw error;
  }
  return json(origin, 200, { ok: true, prUrl: pr.html_url, prNumber: pr.number, geo });
}

async function deleteOriginals(env, photoAssets) {
  for (const asset of photoAssets) {
    try {
      if (asset.storage === 'r2') await env.ORIGINALS.delete(asset.key);
      else await gh(env, `/releases/assets/${asset.id}`, 'DELETE');
    } catch { /* best effort */ }
  }
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

// Store the full-size (location-stripped) original in R2 under originals/. The URL written to
// the contribution JSON and the PR body points back at THIS Worker (serveOriginal), so
// reviewers and the pack build fetch it like any plain https URL — the bucket itself stays
// private and no S3 credentials exist anywhere.
async function uploadOriginal(env, selfOrigin, name, bytes) {
  const key = `originals/${name}`;
  await env.ORIGINALS.put(key, bytes, { httpMetadata: { contentType: 'image/jpeg' } });
  return { storage: 'r2', key, name, url: `${selfOrigin}/${key}`, size: bytes.length };
}

// GET /originals/<key>: stream a photo original from the private bucket. Only the originals/
// prefix is reachable — repo backups never leave the bucket. Keys carry a random id, and each
// upload uses a fresh key, so responses can be cached as immutable.
async function serveOriginal(request, env) {
  const path = decodeURIComponent(new URL(request.url).pathname);
  if (!env.ORIGINALS || !path.startsWith('/originals/') || path.includes('..')) {
    return new Response('Not found', { status: 404 });
  }
  const object = await env.ORIGINALS.get(path.slice(1));
  if (!object) return new Response('Not found', { status: 404 });
  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
      'Content-Length': String(object.size),
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Access-Control-Allow-Origin': '*',
    },
  });
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
export { uploadOriginal, serveOriginal, backupRepo, handleBugReport };

// ---------- GitHub ----------

// Geo line for the PR body. Device GPS is only ever mentioned when it verified the
// submission (on-site); a far-away or absent device signal reads as "no location data".
function geoSummary(geo) {
  if (geo.source === 'exif' && geo.verified) return `✅ pre-verified — photo GPS, ${geo.distanceM} m from the field`;
  if (geo.source === 'exif') return `⚠️ photo GPS is ${geo.distanceM} m from the field — needs review`;
  if (geo.source === 'device') return `✅ pre-verified — submitted on-site (device GPS, ${geo.distanceM} m from the field; photo has no location data)`;
  return '⚠️ no location data — needs review';
}

async function openPr(env, { type, fieldId, fieldName, fieldCode, proposed, description, geo, files, photoAssets, photoUploadFailed }) {
  const baseBranch = env.BASE_BRANCH || 'main';
  // Random suffix: Date.now() alone collides when two pilots submit for the same field in the
  // same millisecond (the JSON/asset names already carry a random id; the branch must too).
  const branch = `contrib/${sanitize(fieldId)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  const baseRef = await gh(env, `/git/ref/heads/${baseBranch}`);
  await gh(env, '/git/refs', 'POST', { ref: `refs/heads/${branch}`, sha: baseRef.object.sha });

  const title = type === 'new-field'
    ? `New field: ${fieldName}`
    : `Contribution: ${fieldName || fieldCode || fieldId}`;
  try {
    for (const f of files) {
      await gh(env, `/contents/${f.path}`, 'PUT', { message: title, content: f.content, branch });
    }

    const label = geo.verified ? 'geo-verified' : 'needs-location-review';
    const photoLines = photoAssets.map((a, i) =>
      `\n**Photo ${i + 1}** (full-size original, location metadata stripped) — ${geoSummary(a.geo)}:\n\n![contribution photo ${i + 1}](${a.url})`);
    const proposalLines = proposed ? [
      `**Proposed new field** (build creates it once this PR merges):`,
      `- Kind: ${proposed.kind} · Country: ${proposed.country}`,
      `- Coordinates: ${proposed.latitude}, ${proposed.longitude}${proposed.elevationM != null ? ` · Elevation: ${proposed.elevationM} m` : ''}`,
      `- Difficulty: ${proposed.difficulty || 'unknown'}${proposed.runway ? ` · Runway: ${proposed.runway}` : ''}${proposed.lengthM ? ` · ${proposed.lengthM}${proposed.widthM ? `×${proposed.widthM}` : ''} m` : ''}`,
      `${proposed.surface ? `- Surface: ${proposed.surface}` : ''}${proposed.frequency ? ` · Frequency: ${proposed.frequency}` : ''}`,
    ].filter(Boolean).join('\n') : '';
    const body = [
      proposalLines || `**Field:** ${fieldName || '—'} (${fieldCode || fieldId})`,
      description ? `\n**${proposed ? 'Notes' : 'Update'}:**\n${description}` : '',
      `\n**Geo-check:** ${geoSummary(geo)}`,
      ...photoLines,
      photoUploadFailed ? '\n**Photo:** at least one upload failed — fewer photos than submitted.' : '',
      `\n_Submitted via the in-app ${proposed ? 'new-field' : 'contribution'} form. A maintainer must review and merge before this goes live._`,
    ].join('\n');

    const pr = await gh(env, '/pulls', 'POST', {
      title, head: branch, base: baseBranch, body, maintainer_can_modify: true,
    });

    const labels = ['contribution', label, ...(type === 'new-field' ? ['new-field'] : [])];
    try { await gh(env, `/issues/${pr.number}/labels`, 'POST', { labels }); } catch { /* labels are cosmetic */ }
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
