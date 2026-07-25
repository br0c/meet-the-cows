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

  // The app's own address and the landing site are NOT here: they are constants in src/app.js
  // (CANONICAL_APP_URL, SITE_URL). They belong in the shell rather than in deploy-time config
  // because the copy that needs them most is the retired one on the old origin, which stops
  // being deployed to and would therefore never receive them.

  // Label for non-production deployments, shown in Settings and beside the version so a
  // tester can never confuse an experimental build with the real one. '' = production.
  channel: '',
};
