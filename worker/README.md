# Contribution intake Worker

A Cloudflare Worker that turns an in-app field contribution (a dated note and/or up to 5 photos —
an update to an existing field, or a proposed **new field** with its own metadata) into a
reviewable **GitHub pull request**, with a **geolocation pre-approval** step from each photo's
EXIF GPS. The app stays on GitHub Pages and just POSTs here.

> **Status: live.** Deployed via CI (`.github/workflows/deploy-worker.yml`) at
> `https://mtc-contrib-intake.br0c.workers.dev`. The in-app submission → GitHub PR flow has been
> validated end-to-end in production.

## What it does

1. Accepts `multipart/form-data` at `POST /` (Turnstile-gated).
2. If a photo is attached: checks type/size/resolution, reads **EXIF GPS**, and computes the
   distance to the field. Within `GEO_RADIUS_M` (1 km) ⇒ label `geo-verified`, else
   `needs-location-review`. EXIF is then **stripped** before the photo is stored anywhere.
   Device GPS is a fallback that only ever counts **in favour**: on-site ⇒ verified; far away ⇒
   silently ignored (never shown in the PR or the app).
3. Uploads the full-size EXIF-stripped original to the **R2 bucket** (`originals/` in `mtc-data`)
   — **no image bytes enter git**. The pack build later downloads and resizes it (2560 px) like
   any other pack photo. (While `R2_PUBLIC_BASE` is unset, it falls back to the legacy
   `RELEASE_TAG` release-asset path; old release URLs keep working either way.)
4. Opens a PR that adds `contributions/<fieldId>/<stamp>_<id>.json` (metadata + asset link) on a
   new branch, labelled for review, with the photo embedded in the PR body. **Nothing is in the
   app until a maintainer merges.**
5. Nightly (cron `47 2 * * *`): snapshots the repo (`main` + `dev` tarballs from GitHub) into
   `repo-backups/` in the same bucket as an off-GitHub backup — covers the code, merged
   contributions, and the translation cache in one artifact. Snapshots are pruned after 90 days;
   `repo-backups/last-run.json` records each run's outcome.

## Setup

```bash
cd worker
npm install
npx wrangler login
```

Edit `wrangler.toml` vars if needed (`REPO`, `ALLOWED_ORIGIN`, `GEO_RADIUS_M`, photo limits).

### R2 bucket (photo originals + repo backups)

One-time setup in the Cloudflare dashboard:

1. **R2 → Create bucket** named exactly `mtc-data` (Standard storage class; or edit
   `bucket_name` in `wrangler.toml`). The deploy fails if the bucket referenced by the
   binding does not exist. That's all — do **not** enable public access.

The bucket stays **private**. Photo originals are served by this Worker's
`GET /originals/<key>` route (that URL goes into the contribution JSON and PR body, so the
pack build and reviewers fetch it like any https URL, credential-free). Repo backups under
`repo-backups/` are not reachable from outside at all. No S3 API keys exist anywhere.

### Bug reports (`POST /bug`)

The app's Settings → "Report a bug" form posts here (Turnstile-gated like contributions);
the Worker opens a GitHub **issue** labelled `bug` + `from-app`, so pilots need no GitHub
account. This requires one extra permission on the `GITHUB_TOKEN` fine-grained PAT:
**Issues: Read and write**.

### Secrets

```bash
npx wrangler secret put GITHUB_TOKEN      # fine-grained PAT, see scopes below
npx wrangler secret put TURNSTILE_SECRET  # Cloudflare Turnstile secret (optional while prototyping)
```

**`GITHUB_TOKEN`** — a *fine-grained* personal access token (or a GitHub App installation token)
scoped to **`br0c/meet-the-cows`** with repository permissions:
- **Contents:** Read and write (create the branch + commit the files)
- **Pull requests:** Read and write (open the PR, add labels)
- **Issues:** Read and write (file in-app bug reports as issues)

Nothing else. Keep it in the Worker secret store — never in `wrangler.toml` or the repo.

## Run / deploy

```bash
npx wrangler dev      # local, at http://127.0.0.1:8787
npx wrangler deploy   # publish; note the *.workers.dev URL (or bind a custom route)
```

Put the resulting URL in the app's `CONTRIB_ENDPOINT` constant (Phase 2).

> **Deploy order: Worker first, app shell second.** When a release changes the request shape,
> an already-cached app shell keeps POSTing the old shape — which the new Worker accepts
> (legacy keys stay supported). The reverse is not safe: a new shell posting to an old Worker
> gets its unknown keys silently ignored (e.g. a Worker predating multi-photo reads only
> `photo` and would drop every `photos` entry while still reporting success). The same applies
> to rollbacks: rolling back the Worker without rolling back Pages reintroduces that window.

### Continuous deployment (GitHub Actions)

`.github/workflows/deploy-worker.yml` runs `wrangler deploy` for you, so the live
Worker stays in sync with the repo instead of a manual push from a laptop. It is
**manual for now** — run it from the repo's **Actions** tab (*Deploy contribution
Worker → Run workflow*). Once the contribution flow is validated end-to-end,
uncomment the `push:` trigger in that file to auto-deploy on merges that touch
`worker/**`.

Two **repo** secrets are required (Settings → Secrets and variables → Actions):

| secret | value |
|--------|-------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with **Account → Workers Scripts → Edit**, Account Resources scoped to your account. Nothing else. |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account id. |

The Worker's own runtime secrets (`GITHUB_TOKEN`, `TURNSTILE_SECRET`) live in the
Cloudflare secret store and are **not** needed by the Action — `wrangler deploy`
only uploads code + `[vars]`, and secrets set with `wrangler secret put` persist
across deploys. So the GitHub PAT never enters GitHub Actions.

## Request shape (what the app sends)

`multipart/form-data`:

| field | required | notes |
|-------|----------|-------|
| `type` | no | `new-field` for a proposal; anything else is an update to an existing field |
| `fieldId`, `fieldLat`, `fieldLon` | update only | from the loaded pack |
| `fieldCode`, `fieldName` | no | for the PR title / re-matching |
| `name`, `lat`, `lon`, `country` | new-field only | plus optional `kind`, `elevationM`, `difficulty`, `runway`, `lengthM`, `widthM`, `surface`, `frequency` |
| `date` | no | defaults to today |
| `description` | note **or** photo required | free text |
| `photos` (repeated) | note **or** photo required | up to 5 JPEGs, each ≤ 15 MB, long edge ≥ 2560 px (legacy single `photo` still accepted) |
| `deviceLat`, `deviceLon` | no | live GPS fallback when a photo has no EXIF |
| `submitter` | no | optional handle for attribution |
| `turnstileToken` | when Turnstile is on | from the widget |

Response: `{ ok: true, prUrl, prNumber, geo: { verified, source, distanceM } }` (`geo` aggregates
the per-photo verdicts; each photo's own verdict is in the contribution JSON and the PR body).

## Still to do

- Add unit tests for `readGps` / `stripExif` / `jpegLongEdge` (exercised in production, not yet
  covered by tests).
- Rate limiting (KV or Turnstile-only for now).

Shipped: the in-app Contribute form + `CONTRIB_ENDPOINT`, the client EXIF read for the live
"pre-verified" hint, and `merge_contributions()` in `scripts/build_pack.py` (folds merged
`contributions/` into the pack — localized notes, optimized photos).
