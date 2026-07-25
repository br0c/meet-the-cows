// Deployment configuration for Meet the Cows.
//
// Loaded twice, on purpose, so the app and the service worker always agree:
//   - index.html loads it as a plain script before src/app.js  -> window.MTC_CONFIG
//   - service-worker.js importScripts() it at install time     -> self.MTC_CONFIG
// It must therefore stay a classic script (no import/export) and set a global.
//
// Every field is optional. With the defaults below the app behaves exactly like the
// original single-origin GitHub Pages deployment, so an unconfigured build is never broken.
self.MTC_CONFIG = {
  // Absolute base that pack paths resolve against. Pack URLs are always of the form
  // "packs/<id>/manifest.json", so this is the ROOT above them — a bucket whose layout mirrors
  // the site's. Empty means "same place as the app" (the historical behaviour); set it to serve
  // pack data from R2 instead, e.g.
  //   'https://data.meetthecows.org/'      -> https://data.meetthecows.org/packs/fr/manifest.json
  // The service worker caches this origin for offline use, so it must send permissive CORS
  // headers (Access-Control-Allow-Origin) for the app origins that read it.
  packsBase: '',

  // Canonical home of the production app, e.g. 'https://app.meetthecows.org/'. When this is
  // set and the app is being served from a DIFFERENT origin, that copy understands itself to
  // be a retired deployment and shows the migration notice. One value, correct on both sides:
  // on the canonical origin it matches and nothing is shown; anywhere else it does not and
  // the notice appears. Empty disables the notice entirely.
  canonicalAppUrl: '',

  // Marketing / landing site, linked from the migration notice ("Why the move?").
  siteUrl: '',

  // Label for non-production deployments, shown in Settings and beside the version so a
  // tester can never confuse an experimental build with the real one. '' = production.
  channel: '',
};
