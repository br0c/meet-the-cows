// Deployment configuration for Meet the Cows.
//
// Loaded twice, on purpose, so the app and the service worker always agree:
//   - index.html loads it as a plain script before src/app.js  -> window.MTC_CONFIG
//   - service-worker.js importScripts() it at install time     -> self.MTC_CONFIG
// It must therefore stay a classic script (no import/export) and set a global.
//
// Every field is optional. With the defaults below the app behaves like a plain single-origin
// site, which is what a local checkout needs.
self.MTC_CONFIG = {
  // Absolute base that pack paths resolve against. Pack URLs are always of the form
  // "packs/<id>/manifest.json", so this is the ROOT above them — a bucket whose layout mirrors
  // the site's. Empty means "same place as the app" (the historical behaviour); set it to serve
  // pack data from R2 instead, e.g.
  //   'https://data.meetthecows.org/'      -> https://data.meetthecows.org/packs/fr/manifest.json
  // The service worker caches this origin for offline use, so it must send permissive CORS
  // headers (Access-Control-Allow-Origin) for the app origins that read it.
  packsBase: '',

  // Absolute base for the Worker that serves aerodrome charts, e.g.
  //   'https://api.meetthecows.org/'  -> https://api.meetthecows.org/charts/vac/LFNE.pdf
  // Charts live in a PRIVATE bucket because most of them may not be redistributed (Germany's
  // DFS and Italy's ENAV grant no such right), so unlike pack media they are not fetched from
  // packsBase but requested from this Worker with a short-lived token. Empty means "no chart
  // Worker configured": the app then falls back to each chart's published URL, which is what
  // every deployment did before the charts moved.
  chartsBase: '',

  // Label for non-production deployments, shown in Settings and beside the version so a
  // tester can never confuse an experimental build with the real one. '' = production.
  channel: '',
};
