# Meet the Cows

Offline-first outlanding field and VAC viewer for glider pilots.

The goal is deliberately narrow: **open the app, get GPS position, see nearby landable options, tap one, see photos/docs/VAC**. It is not a replacement for SeeYou Navigator, XCSoar, LX, Oudie, FLARM, official briefing, or judgement.

## Current state

This is an initial static PWA prototype:

- nearest entries list from current GPS position
- outlanding fields and official/VAC-only airfields in the same list
- distance and bearing
- straight-line required glide ratio
- safety arrival margin, default 250 m
- manual altitude override
- hide C and/or D fields
- field detail panel with notes, images and PDFs
- service-worker offline cache
- Python build pipeline for CUPX + SIA VAC import
- optional creation of VAC-only airfield entries using an airport coordinate source

The bundled `fr-alps` pack is **sample data only** so the UI works immediately. It is not for flight. Generate the real pack with the importer.

## Data sources

### Outlanding fields

The intended initial source is the planeur-net Guide des Aires de Sécurité CUPX:

```bash
python scripts/build_pack.py \
  --cupx https://raw.githubusercontent.com/planeur-net/outlanding/main/guide_aires_securite.cupx \
  --pack-id fr-alps \
  --pack-name "France / Alps"
```

CUPX files are handled by the importer as concatenated ZIP files: a pictures ZIP and a points ZIP containing `POINTS.CUP`.

The Guide CUP does include some official aerodromes/altiports/velisurfaces, but the VAC import must not depend on that. SIA VAC airfields are handled as a separate layer.

### VAC PDFs and VAC-only airfields

VAC import is supported from day one. The SIA eAIP/VAC URL is cycle-specific. Find the current eAIP PDF root on the SIA site, then pass the `VAC/AD` directory as `--vac-root`.

To attach VACs to existing CUP entries **and also create official airfield entries when the airfield is not in the CUP**, use `--include-vac-airfields`:

```bash
python scripts/build_pack.py \
  --cupx https://raw.githubusercontent.com/planeur-net/outlanding/main/guide_aires_securite.cupx \
  --pack-id fr-alps \
  --pack-name "France / Alps" \
  --vac-root "https://www.sia.aviation-civile.gouv.fr/media/dvd/eAIP_11_JUN_2026/Atlas-VAC/PDF_AIPparSSection/VAC/AD" \
  --vac-date "2026-06-11 / AIRAC 06-26" \
  --include-vac-airfields
```

The importer tries URLs in this form:

```text
{vac-root}/AD-2.LFMR.pdf
{vac-root}/AD-2.LFLG.pdf
...
```

Behaviour:

1. If the LFxx code already exists in the CUP-derived fields, the VAC PDF is attached to that entry.
2. If the LFxx code is not present and `--include-vac-airfields` is enabled, the importer creates a separate `kind: "airfield"` entry using the airport coordinate source, then attaches the VAC PDF.
3. If a PDF exists but no coordinates are available, the PDF is downloaded but no list entry is created because it cannot be sorted by proximity.

By default the VAC-only airfield layer uses OurAirports `airports.csv` and `runways.csv` for coordinates/dimensions. That data is useful for placing the entry on the nearest-options list, but is not authoritative navigation data. The SIA VAC remains the official source.

Optional flags:

```bash
--airports-csv path_or_url   # defaults to OurAirports airports.csv
--runways-csv path_or_url    # defaults to OurAirports runways.csv
--vac-codes LFMR,LFLG,LFNA   # optional limit/extension list, or path/URL to a text file
--max-vac 20                 # debug limit
```

## SIA attribution / licence note

For any hosted SIA VAC PDFs, show attribution similar to:

```text
Service de l’Information Aéronautique — original data downloaded from https://www.sia.aviation-civile.gouv.fr, update date: YYYY-MM-DD / AIRAC xx-xx.
```

Do not imply SIA endorsement. Keep update dates visible. VAC data is safety-critical and cycle-specific.

## Guide des Aires photo permission note

The upstream project says its pictures are used with permission. That is not automatically the same thing as a general open licence for rehosting/remixing elsewhere. Before making a public hosted app with copied photos, get explicit permission from the upstream maintainer / rights holder or keep this as a personal/private derived pack.

## Run locally

No build step is required for the prototype.

```bash
python3 -m http.server 5173
```

Open:

```text
http://localhost:5173
```

For iPhone testing, serve over HTTPS or deploy to GitHub Pages. Browser geolocation requires a secure context except on localhost.

## Deploy to GitHub Pages

1. Create a GitHub repo named `meet-the-cows`.
2. Upload this folder.
3. In the repo settings, enable GitHub Pages from the `main` branch root.
4. Open `https://<your-user>.github.io/meet-the-cows/`.

The prototype uses relative paths, so it should work both at a custom domain root and under a GitHub Pages project path such as `/meet-the-cows/`.

## GitHub Action

`.github/workflows/build-pack.yml` is included. It runs the pack builder manually via `workflow_dispatch`. Set repository variables if you want to include VAC:

- `SIA_VAC_ROOT`: current SIA VAC AD root URL
- `SIA_VAC_DATE`: attribution/update date shown in the manifest

The action includes `--include-vac-airfields`, so VAC-only official aerodromes can be created when they are not present in the Guide CUP.

## Cockpit list

The main page is deliberately narrow for portrait use. It shows only:

- `Name`
- `Dist`: straight-line distance
- `Glide`: rounded required glide ratio using iPhone GPS altitude, field elevation and safety margin
- `Diff`: A/B/C/D/UNKNOWN

Bearing, arrival height, field dimensions, notes, photos, PDFs and VAC are shown after tapping an entry. Pack selection, offline download/verify, safety margin and hide C/D filters live in Settings behind the gear icon.

## Safety disclaimer

Meet the Cows is only a field briefing/triage tool. It does **not** account for terrain, wind, sink, airspace, circuit direction, obstacles, legality, NOTAMs or current field condition. Use official sources and established gliding tools for navigation and flight safety.
