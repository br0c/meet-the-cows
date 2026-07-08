# Contribution intake Worker

A Cloudflare Worker that turns an in-app field contribution (a dated note and/or a photo) into a
reviewable **GitHub pull request**, with a **geolocation pre-approval** step from the photo's EXIF
GPS. The app stays on GitHub Pages and just POSTs here.

> **Status: prototype.** The GitHub PR flow and the JPEG/EXIF helpers in `src/index.js` have not
> been run end-to-end yet. Stand it up with `wrangler dev` and a test repo/label first.

## What it does

1. Accepts `multipart/form-data` at `POST /` (Turnstile-gated).
2. If a photo is attached: checks type/size/resolution, reads **EXIF GPS**, and computes the
   distance to the field. Within `GEO_RADIUS_M` (1 km) ⇒ label `geo-verified`, else
   `needs-location-review`. EXIF is then **stripped** so no GPS is stored in the repo.
3. Opens a PR that adds `contributions/<fieldId>/<stamp>_<id>.json` (+ `.jpg`) on a new branch,
   labelled for review. **Nothing is public until a maintainer merges.**

## Setup

```bash
cd worker
npm install
npx wrangler login
```

Edit `wrangler.toml` vars if needed (`REPO`, `ALLOWED_ORIGIN`, `GEO_RADIUS_M`, photo limits).

### Secrets

```bash
npx wrangler secret put GITHUB_TOKEN      # fine-grained PAT, see scopes below
npx wrangler secret put TURNSTILE_SECRET  # Cloudflare Turnstile secret (optional while prototyping)
```

**`GITHUB_TOKEN`** — a *fine-grained* personal access token (or a GitHub App installation token)
scoped to **`br0c/meet-the-cows`** with repository permissions:
- **Contents:** Read and write (create the branch + commit the files)
- **Pull requests:** Read and write (open the PR, add labels)

Nothing else. Keep it in the Worker secret store — never in `wrangler.toml` or the repo.

## Run / deploy

```bash
npx wrangler dev      # local, at http://127.0.0.1:8787
npx wrangler deploy   # publish; note the *.workers.dev URL (or bind a custom route)
```

Put the resulting URL in the app's `CONTRIB_ENDPOINT` constant (Phase 2).

## Request shape (what the app sends)

`multipart/form-data`:

| field | required | notes |
|-------|----------|-------|
| `fieldId`, `fieldLat`, `fieldLon` | yes | from the loaded pack |
| `fieldCode`, `fieldName` | no | for the PR title / re-matching |
| `date` | no | defaults to today |
| `description` | note **or** photo required | free text |
| `photo` | note **or** photo required | JPEG, ≤ 15 MB, long edge ≥ 2560 px |
| `deviceLat`, `deviceLon` | no | live GPS fallback when the photo has no EXIF |
| `submitter` | no | optional handle for attribution |
| `turnstileToken` | when Turnstile is on | from the widget |

Response: `{ ok: true, prUrl, prNumber, geo: { verified, source, distanceM } }`.

## Still to do (tracked for Phase 2/3)

- App side: the Contribute button + form, client EXIF read for the live "pre-verified" hint,
  JPEG normalization (HEIC→JPEG), and `CONTRIB_ENDPOINT`.
- Build side: `merge_contributions()` in `scripts/build_pack.py` to fold merged
  `contributions/` into the pack (localize notes, optimize photos).
- Validate `readGps` / `stripExif` / `jpegLongEdge` against real phone photos; add unit tests.
- Rate limiting (KV or Turnstile-only for now).
