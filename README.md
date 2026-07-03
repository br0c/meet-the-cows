# Meet the Cows

Meet the Cows is an offline-friendly landing-field viewer for glider pilots.

Open it, allow location access, and it shows nearby outlanding fields and airfields with distance, bearing, required glide ratio, notes, photos, and available documents such as VAC PDFs.

## Safety

This app is for quick field briefing and triage only. It is not primary navigation and does not account for terrain, wind, sink, airspace, obstacles, NOTAMs, legality, or current field condition.

Always use official and current sources, local knowledge, and established navigation tools for flight decisions.

## Features

- Nearby fields from your current GPS position
- Distance, bearing, and straight-line required glide ratio
- Safety arrival margin setting
- Manual altitude mode for ground testing
- Filters for more difficult fields
- Field detail view with notes, photos, and documents
- Installable PWA with offline app shell
- Optional offline download for pack media and documents

## Using Offline

The app shell and core pack files are cached automatically by the service worker.

Photos and PDFs can be large, so they are not all cached automatically. To make them available offline:

1. Open Settings.
2. Tap `Download / verify media & docs`.
3. Keep the app open until the progress line finishes.

The offline button downloads media and documents from the static pack URLs one by one and reports progress.

## Data

The public app loads a static data pack from same-origin GitHub Pages paths:

```text
/meet-the-cows/packs/packs.json
/meet-the-cows/packs/fr-alps/manifest.json
/meet-the-cows/packs/fr-alps/fields.json
/meet-the-cows/packs/fr-alps/media/...
/meet-the-cows/packs/fr-alps/docs/...
```

Generated pack files are not committed to the repository.

## Credits and Data Sources

Meet the Cows stands on work published by several aviation and gliding data providers. Please respect each source's terms, licences, and attribution requirements.

- [planeur-net / Guide des Aires de Securite](https://github.com/planeur-net/outlanding): outlanding field data and source photos where included.
- [Service de l'Information Aeronautique (SIA)](https://www.sia.aviation-civile.gouv.fr): official French VAC documents where included.
- [OpenAIP](https://www.openaip.net): airfield metadata used to help discover and place glider-relevant airfields.
- [streckenflug.at Landout Database](https://landout.streckenflug.at): additional landout notes and photos where the pack build includes them.
- [OurAirports](https://ourairports.com): optional airport/runway coordinate fallback for some pack builds.

The exact sources used by a deployed pack are listed in that pack's `manifest.json`.

## Run Locally

No app build step is required.

```bash
python3 -m http.server 5173
```

Then open:

```text
http://localhost:5173
```

Browser geolocation requires HTTPS except on localhost.

## Deployment

GitHub Pages deployment is handled by `.github/workflows/deploy-pages.yml`.

The workflow builds the data pack, assembles the static app and pack files into a Pages artifact, uploads it, and deploys with `actions/deploy-pages`.

## Contributing

Field corrections and photo contributions are welcome. Include the field name or code, describe the issue clearly, and cite a useful source when possible.

Only contribute photos or documents you own or have permission to share.
