# Meet the Cows

Meet the Cows is an offline-friendly landing-field viewer for glider pilots, designed to run as a phone web app in the cockpit.

**Live app: <https://br0c.github.io/meet-the-cows/>** — open it on your phone and add it to your home screen.

Install it on your phone, open it before or during a flight, allow location access, and it shows nearby outlanding fields and airfields with distance, bearing, required glide ratio, notes, photos, and available documents such as VAC PDFs.

## Safety

This app is intended as a cockpit aid for quick field briefing and triage only. It is provided as-is, without warranty, guarantee, operational approval, or assumption of responsibility by its author or contributors.

Meet the Cows is not primary navigation. It does not account for terrain, wind, sink, airspace, obstacles, NOTAMs, legality, surface condition, livestock, crops, wires, slope, current weather, or the pilot's actual aircraft performance.

The pilot in command is solely responsible for all flight planning, navigation, field selection, landing decisions, and consequences of using or not using any information shown by the app. Always use official and current sources, local knowledge, active lookout, and established navigation tools for flight decisions.

Difficulty `C` and `D` fields are highly contraindicated. Treat them as hazardous, last-resort emergency options only, not as normal landing choices.

## Features

- Nearby fields from your current GPS position
- Three best safe options (difficulty `A`, required glide ratio 20 or better, airfields first) pinned above the list
- Distance, bearing, and straight-line required glide ratio
- Safety arrival margin setting
- Manual altitude mode for ground testing
- Filters for more difficult fields
- Field detail view with notes, photos, and documents
- Installable PWA with offline app shell that updates itself on next launch
- Offline download of pack media and documents
- In-app prompt when new field data is published, downloading only what changed

## Install on a Phone

1. Open <https://br0c.github.io/meet-the-cows/> in your phone browser.
2. On iPhone, use Safari's share button, then choose `Add to Home Screen`.
3. On Android, use the browser menu, then choose `Install app` or `Add to Home screen`.
4. Launch Meet the Cows from the home-screen icon.
5. Allow location access when prompted.

For cockpit use, open the app before launch while you still have a good connection, let it load the pack, and download media/docs if you want them available offline.

## Using Offline

The app shell and core pack files (field list and manifest) are cached automatically by the service worker and refreshed from the network whenever you open the app online.

Photos and PDFs can be large, so they are not all cached automatically. To make them available offline the first time:

1. Open Settings.
2. Tap `Download / verify media & docs`.
3. Keep the app open until the progress line finishes.

This downloads every photo and document for the pack and records what you have so later updates only fetch the difference.

## Updates

Updates are only ever offered, never applied in flight. You choose when to reload or sync, on the ground with a good connection.

### App updates

The app updates itself: the next time you open it online, it loads the latest version automatically. An app update no longer clears your downloaded photos and documents — the app shell and the offline pack live in separate caches.

### Data updates

When a newer data pack is published, a `New field data available` banner appears at the top of the list. Tap `Update` to sync; the app opens Settings so you can watch the progress. It refreshes the field text, then downloads only the media and documents that actually changed, removes any that were dropped, and skips everything you already hold — so a routine update is a small download, not the whole pack.

## Using in Flight

1. Launch the home-screen app.
2. Wait for the GPS status to become available.
3. Use the nearest list to compare distance, bearing, required glide ratio, and difficulty. The three best safe options (difficulty `A`, required glide ratio 20 or better, airfields preferred) are pinned above the thicker divider.
4. Tap a field to review notes, photos, documents, and VAC material.
5. Adjust the safety arrival margin in Settings if you want a more conservative glide estimate.

The app uses phone GPS altitude when available. If your browser does not provide altitude, required glide ratio may be unavailable unless you use manual altitude for testing.

## Ground Testing

Manual altitude is useful for testing the app before flight.

1. Open Settings.
2. Enable `Use manual altitude for testing`.
3. Enter a realistic altitude in meters.
4. Open the app somewhere with location permission available so the nearest list can use your real phone position.
5. Check that glide ratio, filters, field detail view, and offline media/docs behave as expected.

Turn manual altitude off before relying on live GPS altitude in flight.

## Data

The public app loads a static data pack from same-origin GitHub Pages paths:

```text
/meet-the-cows/packs/packs.json
/meet-the-cows/packs/fr-alps/manifest.json
/meet-the-cows/packs/fr-alps/fields.json
/meet-the-cows/packs/fr-alps/media-manifest.json
/meet-the-cows/packs/fr-alps/state.json
/meet-the-cows/packs/fr-alps/media/...
/meet-the-cows/packs/fr-alps/docs/...
```

`media-manifest.json` lists a content hash for every media/doc file; the app diffs it to
download only changed files on an update. `state.json` is the source fingerprint the build
uses to decide whether a rebuild is needed. Generated pack files are not committed to the repository.

## Credits and Data Sources

Meet the Cows stands on work published by several aviation and gliding data providers. Please respect each source's terms, licences, and attribution requirements.

- [planeur-net / Guide des Aires de Securite](https://github.com/planeur-net/outlanding): outlanding field data and source photos where included.
- [Service de l'Information Aeronautique (SIA)](https://www.sia.aviation-civile.gouv.fr): official French VAC documents where included.
- [OpenAIP](https://www.openaip.net): airfield metadata used to help discover and place glider-relevant airfields.
- [streckenflug.at Landout Database](https://landout.streckenflug.at): additional landout notes and photos where the pack build includes them.
- [OurAirports](https://ourairports.com): optional airport/runway coordinate fallback for some pack builds.

The exact sources used by a deployed pack are listed in that pack's `manifest.json`.

## Deployment

GitHub Pages deployment is split so app-only changes do not rebuild the data pack:

- `.github/workflows/deploy-app.yml` deploys app-shell changes using the latest already-built pack.
- `.github/workflows/build-data-pack.yml` rebuilds the data pack, assembles the full static site, and deploys it. It runs manually, on schedule, and when the data-build scripts change.

The data-pack build is incremental: it fingerprints the upstream sources (Guide CUPX, SIA VAC cycle, streckenflug list) and skips the rebuild and deploy entirely when nothing has changed, so the daily run is a no-op on quiet days. It does a full refresh on pushes, on manual runs, and once a week. German streckenflug notes are translated to English via DeepL, cached across runs so only new or changed text is re-translated.

## Contributing

Field corrections and photo contributions are welcome. Include the field name or code, describe the issue clearly, and cite a useful source when possible.

Only contribute photos or documents you own or have permission to share.
