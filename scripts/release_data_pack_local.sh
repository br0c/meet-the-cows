#!/usr/bin/env bash
set -euo pipefail

PACK_ID="${PACK_ID:-fr-alps}"
PACK_NAME="${PACK_NAME:-France / Alps}"
RELEASE_TAG="${RELEASE_TAG:-data-latest}"
RELEASE_TITLE="${RELEASE_TITLE:-Latest data pack}"
REPO="${REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"

if [ ! -d "data/packs/${PACK_ID}" ]; then
  echo "Missing data/packs/${PACK_ID}. Run scripts/build_pack.py first." >&2
  exit 1
fi

mkdir -p dist/packs
rm -f "dist/packs/${PACK_ID}.zip" "dist/packs/${PACK_ID}.zip.sha256" "dist/packs/packs.json"

(cd data/packs && zip -r "../../dist/packs/${PACK_ID}.zip" "${PACK_ID}")
shasum -a 256 "dist/packs/${PACK_ID}.zip" > "dist/packs/${PACK_ID}.zip.sha256"

python scripts/make_pack_index.py \
  --repo "${REPO}" \
  --release-tag "${RELEASE_TAG}" \
  --pack-id "${PACK_ID}" \
  --pack-name "${PACK_NAME}" \
  --zip "dist/packs/${PACK_ID}.zip" \
  --output "dist/packs/packs.json"

if ! gh release view "${RELEASE_TAG}" >/dev/null 2>&1; then
  gh release create "${RELEASE_TAG}" \
    --title "${RELEASE_TITLE}" \
    --notes "Rolling release for offline data packs."
fi

gh release upload "${RELEASE_TAG}" \
  "dist/packs/${PACK_ID}.zip" \
  "dist/packs/${PACK_ID}.zip.sha256" \
  "dist/packs/packs.json" \
  --clobber

echo
echo "Uploaded:"
gh release view "${RELEASE_TAG}" --json tagName,url,assets
