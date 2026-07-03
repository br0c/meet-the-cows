# Data pack release flow

Generated offline packs are not committed to Git. They are uploaded to the rolling GitHub Release `data-latest`.

Stable URLs:

```text
https://github.com/br0c/meet-the-cows/releases/download/data-latest/packs.json
https://github.com/br0c/meet-the-cows/releases/download/data-latest/fr-alps.zip
https://github.com/br0c/meet-the-cows/releases/download/data-latest/fr-alps.zip.sha256
```

Local upload:

```bash
python scripts/build_pack.py \
  --cupx https://raw.githubusercontent.com/planeur-net/outlanding/main/guide_aires_securite.cupx \
  --pack-id fr-alps \
  --pack-name "France / Alps" \
  --countries FR CH IT \
  --airfield-source openaip \
  --include-streckenflug \
  --streckenflug-countries FR CH IT \
  --streckenflug-workers 8 \
  --vac-root auto \
  --vac-date auto \
  --include-vac-airfields

scripts/release_data_pack_local.sh
```

GitHub Actions:

- Add `OPENAIP_API_KEY` in GitHub repository secrets.
- Push `.github/workflows/build-data-pack.yml`.
- Run the workflow manually from GitHub Actions, or let the daily schedule run it.
