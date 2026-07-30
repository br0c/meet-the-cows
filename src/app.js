import { TerrainStore, terrainSupported, terrainPaths, tileKeyFor, tileKeysForBounds, NODATA as TERRAIN_NODATA } from './terrain.js';

const APP_VERSION = '0.8.12-beta';
// Stable data cache (media/docs/pack JSON); matches service-worker.js so app updates don't
// wipe a downloaded pack. (Old versioned caches are dropped by the service worker on activate.)
const DATA_CACHE = 'mtc-data';
const BASE_URL = new URL('..', import.meta.url);
// Deployment config (config.js, loaded as a classic script before this module and shared
// verbatim with the service worker). Absent or empty fields keep the original behaviour.
const CONFIG = (typeof self !== 'undefined' && self.MTC_CONFIG) || {};
const withTrailingSlash = value => {
  const text = String(value || '').trim();
  return text && !text.endsWith('/') ? `${text}/` : text;
};
// Pack paths ("packs/…") resolve against the app by default, or against a separate data
// origin (R2) when configured — the app shell and the ~300 MB of pack data are deployed
// independently, so an experimental build can read the production packs without copying them.
// Mutable: if the configured data origin cannot be reached (misconfiguration, an outage, or
// simply not populated yet) loadPackIndex falls back to the app's own origin and everything
// downstream follows. A pilot must never lose their field list because a data host is down.
let dataBase = CONFIG.packsBase ? new URL(withTrailingSlash(CONFIG.packsBase)) : BASE_URL;
const packIndexUrl = () => new URL('packs/packs.json', dataBase).toString();

// --- Aerodrome charts ------------------------------------------------------------------------
//
// Charts are the one part of a pack that does not come from the public data origin. Most of
// them may not be redistributed (Germany's DFS and Italy's ENAV grant no such right), so they
// live in a private bucket and are served by a Worker that wants a short-lived token.
//
// Two URLs per chart, deliberately:
//   chartUrl()      — token-free, and the ONLY thing ever used as a cache key. A token in the
//                     key would mean every chart re-downloads the moment the token rotates.
//   tokenedChartUrl() — what actually goes on the wire, or into an <iframe> src.
// The service worker matches chart requests ignoring the query string, so a request carrying
// this hour's token still finds the copy stored under the token-free URL — including with no
// radio at all, which is when a pilot is most likely to want the chart.
const chartsBase = CONFIG.chartsBase ? new URL(withTrailingSlash(CONFIG.chartsBase)) : null;
const CHART_TOKEN_ENDPOINT = () => new URL('charts/token', chartsBase).toString();
// Refresh this far before expiry: a pack download can run for minutes, and a token that dies
// halfway through it would fail the rest of the charts one by one.
const CHART_TOKEN_EARLY_REFRESH_S = 300;
let chartToken = { value: '', expiresAt: 0 };
let chartTokenPending = null; // in-flight mint, so concurrent callers share one request

/** The canonical, token-free URL of a chart, or '' when this item is not a gated chart. */
function chartUrl(item) {
  const key = typeof item?.chartKey === 'string' ? item.chartKey.trim() : '';
  if (!key || !chartsBase) return '';
  return new URL(`charts/${key}`, chartsBase).toString();
}

function tokenedChartUrl(url) {
  if (!url || !chartToken.value) return url;
  return `${url}?t=${encodeURIComponent(chartToken.value)}`;
}

/** A usable token, minting one when there is none or it is about to expire. Never throws:
 *  without a token the chart request 403s, which is one missing chart, not a broken app. */
async function ensureChartToken() {
  if (!chartsBase) return '';
  const now = Date.now() / 1000;
  if (chartToken.value && chartToken.expiresAt - CHART_TOKEN_EARLY_REFRESH_S > now) return chartToken.value;
  chartTokenPending = chartTokenPending || (async () => {
    try {
      const response = await fetch(CHART_TOKEN_ENDPOINT(), { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!data?.token) throw new Error('no token in response');
      chartToken = { value: String(data.token), expiresAt: Date.now() / 1000 + Number(data.expiresIn || 3600) };
    } catch (error) {
      console.warn('Could not get a chart token', error);
    } finally {
      chartTokenPending = null;
    }
  })();
  await chartTokenPending;
  return chartToken.value;
}
// The app's permanent addresses. Hardcoded rather than configured, because moving house is a
// one-way trip and not a setting — and because the copy that most needs to know it has been
// retired is the frozen one on the old origin, which by definition stops receiving deploy-time
// configuration. Baking it into the shell means a single deploy to that origin is enough,
// forever, with no variable left switched on somewhere waiting to be forgotten.
const CANONICAL_APP_URL = 'https://app.meetthecows.org/';
const SITE_URL = 'https://meetthecows.org/';

// A copy served from anywhere other than CANONICAL_APP_URL understands itself to be a retired
// deployment and offers a guided move. null = say nothing.
const MIGRATION = (() => {
  try {
    const url = new URL(CANONICAL_APP_URL);
    if (url.origin === self.location.origin) return null;
    // A labelled channel (next, a branch preview) is a deliberate alternate deployment, not a
    // retired one: testers are there on purpose and must not be told the app has moved.
    if (String(CONFIG.channel || '').trim()) return null;
    // Nor is somebody's own machine. Without this every local checkout would nag its developer
    // to go and use production instead.
    if (isLocalOrigin(self.location)) return null;
    return { url: url.toString(), host: url.host, site: SITE_URL };
  } catch {
    return null;  // a malformed constant must never break the app
  }
})();

function isLocalOrigin(location) {
  const host = location.hostname;
  return location.protocol === 'file:'
    || host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
    || host.endsWith('.local') || host.endsWith('.localhost');
}
const MIGRATION_SNOOZE_KEY = 'mtc-migration-snoozed-until';
// Deliberately short: the user base is small, so a daily reminder moves everyone across in
// days rather than months. Long enough that it never nags twice in one flying day.
const MIGRATION_SNOOZE_MS = 24 * 60 * 60 * 1000;
const SETTINGS_KEY = 'mtc-settings-v2';
const syncedVersionKey = packId => `mtc-synced-version-${packId}`;
const syncedManifestKey = packId => `mtc-synced-manifest-${packId}`;

/** @typedef {{ id:string, kind?:'outlanding'|'airfield', name:string, code?:string, country?:string, latitude:number, longitude:number, elevationM:number|null, difficulty:string, rawDifficulty?:string, lengthM:number|null, widthM:number|null, runwayDirectionDeg:number|null, frequency?:string, frequencies?:Array<{type?:string,mhz?:number,description?:string,source?:string}>, notes:string, source?:object, media:Array<{type:string,url:string,thumbnailUrl?:string,caption?:string,source?:string,updatedAt?:string}> }} Field */

const DEFAULT_SETTINGS = {
  packIds: ['alps-west', 'alps-east'],
  language: 'auto',
  safetyMarginM: 250,
  showC: false,
  showD: false,
  // Simulated position for testing on the ground. Deliberately not persisted as "manual
  // altitude" any more: with terrain routing, a plausible altitude at the wrong place tells you
  // nothing, and every interesting case is somewhere you are not standing.
  testMode: false,
  testLatitude: null,
  testLongitude: null,
  testAltitudeM: 2500,
  testLabel: '',
  // How the test altitude is given: above sea level, or above the ground at the chosen place.
  testAltitudeMode: 'amsl',
  testAglM: 500,
  // Off until the pilot turns it on and accepts what it is. Terrain routing changes which fields
  // the app calls reachable, from data that is coarse and a solver that is new — that is not a
  // thing to switch on for someone while they are not looking.
  // On by default: the routed glide is the conservative option (max-pooled terrain, the
  // clearance ramp, refusal of anything unproven), so straight-line-by-default was defending
  // the wrong thing. Stored settings win over this default, so it reaches fresh installs and
  // resets only — nobody who chose "off" is flipped back on.
  terrainRouting: true,
  terrainClearanceM: 200,
};

// How far above the ground a routed glide is required to stay. 200 m is the default because it
// is roughly what it takes to turn away from rising ground and still have a decision left; the
// floor is 100 m because below that the DEM's own error and the grid's 280 m cells are the
// bigger number, and a clearance the data cannot support is a false promise.
const TERRAIN_CLEARANCE_MIN_M = 100;
const TERRAIN_CLEARANCE_MAX_M = 500;
const TERRAIN_CLEARANCE_STEP_M = 50;
// Fields to route per solve. Beyond the nearest ~80 the answer is academic — nobody is choosing
// their 81st-nearest option — and every extra target costs a path reconstruction.
const TERRAIN_MAX_TARGETS = 80;
// Re-solve when the glider has moved this far or climbed/descended this much. A wavefront per
// GPS tick would be pointless: neither the terrain nor the answer changes over 300 m.
const TERRAIN_RESOLVE_DISTANCE_M = 400;
const TERRAIN_RESOLVE_ALTITUDE_M = 75;
// How often the settings page re-asks whether terrain data has come back, while it is showing the
// greyed-out controls that say it has not. Comfortably above the store's own retry floor.
const TERRAIN_STATUS_RETRY_MS = 6000;
// Below this fraction of the working area covered by tiles, routed answers are treated as
// advisory: a field with no route is reported as un-checked rather than as unreachable, because
// the missing route may only mean missing ground data.
const TERRAIN_TRUST_COVERAGE = 0.98;

// Languages the app UI and pack notes are translated into. 'auto' follows the device.
const SUPPORTED_LANGS = ['en', 'fr', 'de'];

// iOS-style share glyph (arrow rising out of a tray).
const SHARE_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3"/><path d="m7 8 5-5 5 5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>';

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Actual combined download for the current selection: each pack's fields.json plus the media it
// references, with shared media (referenced by several packs) counted once. Updates as packs are
// toggled, so pilots see the real size rather than a sum that double-counts shared fields.
function selectionDownloadBytes() {
  let total = 0;
  for (const p of state.activePacks || []) total += Number(p.manifest?.fieldsBytes) || 0;
  const seen = new Set();
  for (const field of state.fields) {
    const base = field._base || state.currentManifestUrl || BASE_URL;
    for (const item of field.media || []) {
      if (!item?.url) continue;
      const url = new URL(item.url, base).toString();
      if (!seen.has(url)) { seen.add(url); total += Number(item.bytes) || 0; }
    }
  }
  return total;
}

// Share the app itself: native share sheet on phones (the iOS icon the button mimics), else copy
// the link to the clipboard, else a prompt with the URL to copy by hand.
async function shareApp() {
  const url = BASE_URL.href;
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Meet the Cows', text: t('shareText'), url });
      return;
    }
  } catch (error) {
    if (error?.name === 'AbortError') return;
    console.warn('Share failed, falling back to copy', error);
  }
  try {
    await navigator.clipboard.writeText(url);
    alert(t('shareCopied'));
  } catch {
    window.prompt(t('shareCopyPrompt'), url);
  }
}

// Diagnostics attached to every bug report — and shown to the pilot before sending.
function bugDiagnostics() {
  const packs = (state.activePacks || [])
    .map(({ pack, manifest }) => `${pack.id}@${manifest?.version || '?'}`)
    .join(', ') || 'none';
  return [
    `App: ${APP_VERSION}`,
    `Packs: ${packs}`,
    `Language: ${state.settings.language} (${resolveLang()})`,
    `Offline: ${state.cacheStatus}${state.cacheProgress ? ` — ${state.cacheProgress}` : ''}`,
    `Device: ${navigator.userAgent}`,
  ].join('\n');
}

// Fallback for pilots who do use GitHub: a pre-filled new-issue URL.
function githubIssueUrl() {
  const body = `**${t('bugWhat')}**\n\n\n\n**${t('bugSteps')}**\n1. \n\n---\n\`\`\`\n${bugDiagnostics()}\n\`\`\`\n`;
  return `${BUG_REPORT_URL}?labels=bug&body=${encodeURIComponent(body)}`;
}

// Community contributions: the intake Worker + the Turnstile widget site key (public).
const CONTRIB_ENDPOINT = 'https://mtc-contrib-intake.br0c.workers.dev';
const BUG_ENDPOINT = `${CONTRIB_ENDPOINT}/bug`;
const TURNSTILE_SITEKEY = '0x4AAAAAADyIBMLj-XXHBK-v';
const CONTRIB_MAX_BYTES = 15 * 1024 * 1024;   // keep in step with the Worker's MAX_PHOTO_BYTES
const CONTRIB_MIN_LONG_EDGE = 2560;           // keep in step with MIN_PHOTO_LONG_EDGE
const CONTRIB_GEO_RADIUS_M = 1000;            // keep in step with GEO_RADIUS_M
const CONTRIB_MAX_PHOTOS = 5;                 // keep in step with MAX_PHOTOS

// Transient state for the open contribution form (kept out of app state so typing in the form
// never triggers a full re-render that would wipe the inputs).
let contribForm = null;
let newFieldForm = null;
let bugForm = null;

// Release notes: shipped with the app shell; shown from Settings and once as a banner after an
// app update (last seen version remembered per device).
const RELEASE_NOTES_URL = new URL('release-notes.json', BASE_URL).toString();
const LAST_SEEN_VERSION_KEY = 'mtc-last-seen-version';
const DATA_LICENCE_URL = 'https://github.com/br0c/meet-the-cows/blob/main/DATA-LICENCE.md';
const BUG_REPORT_URL = 'https://github.com/br0c/meet-the-cows/issues/new';

// UI string table. Plain strings, or functions for values that interpolate. Every user-facing
// label in the app resolves through t(); pack field notes are localized in the pack itself.
const STRINGS = {
  en: {
    settings: 'Settings', refreshPack: 'Refresh pack', done: 'Done',
    share: 'Share app', shareText: 'Meet the Cows — glider outlanding cockpit aid',
    reportBug: 'Report a bug', bugNote: 'Sent to the maintainer for review — no account needed.',
    bugWhat: 'What happened?', bugSteps: 'Steps to reproduce',
    bugPlaceholder: 'Describe the bug: what you did, what you expected, what happened instead…',
    bugContact: 'Contact for follow-up (optional)', bugIncluded: 'Sent along automatically:',
    bugSubmit: 'Send report', bugSending: 'Sending…', bugThanks: 'Thank you!',
    bugThanksBody: n => `Your report was filed for review (#${n}).`,
    bugErr: 'Could not send the report', bugNeedDesc: 'Please describe the bug first.',
    bugGithubAlt: 'Prefer GitHub? Open an issue there', bugViewIssue: 'View the report',
    shareCopied: 'Link copied to clipboard.', shareCopyPrompt: 'Copy this link:',
    selectedPacks: 'Selected packs', fieldsWord: 'fields', downloadSize: 'Download size',
    app: 'App', version: 'Version', status: 'Status',
    betaStatus: 'Beta — not for primary navigation',
    language: 'Language', langAuto: 'Automatic (device)',
    pack: 'Pack', selectedPack: 'Selected pack', name: 'Name', updated: 'Updated',
    fieldsCount: 'Fields', offline: 'Offline', noPackLoaded: 'No pack loaded',
    noPackSelected: 'No pack selected', noPackSelectedHint: 'No pack selected — choose one in Settings (⚙).',
    downloadMedia: 'Download', reloadPack: 'Reload',
    exportCup: n => `Export CUP (${n} fields)`,
    cupNote: 'Waypoints file for your preferred navigation app. Brief a field here and route to it with your preferred navigation app.',
    nearestList: 'Nearest list',
    safetyMargin: 'Safety arrival margin, m',
    showC: 'Show C fields', showD: 'Show D fields',
    cdNote: 'C and D fields are hidden by default. They are difficult and possibly dangerous — recommended only as last-resort emergency options.',
    terrain: 'Terrain',
    terrainRouting: 'Fly the glide around terrain',
    terrainNote: 'With terrain on, the required glide follows a path that stays clear of the ground instead of a straight line. A field down a valley can become reachable; one behind a ridge can stop being.',
    terrainClearance: 'Terrain clearance',
    terrainClearanceNote: c => `Routed glides stay at least ${c} m above the ground. Raise it for more room to turn away from rising ground; lower it to reach further.`,
    terrainAttribution: 'Elevation: Copernicus DEM (ESA). Col and pass names: © OpenStreetMap contributors.',
    terrainUnsupported: 'This browser cannot read terrain data. Glide stays straight-line.',
    terrainMissing: 'No terrain data is published for this deployment. Glide stays straight-line.',
    terrainPartial: 'Terrain data is incomplete here, so fields without a route keep their straight-line glide.',
    terrainSize: size => `Terrain: ${size}`,
    terrainCachedCount: (done, total) => `${done} of ${total} ${total === 1 ? 'tile' : 'tiles'} offline`,
    terrainSolving: 'working out routes…',
    route: 'Route',
    routeLength: 'Route',
    routeViaChip: name => `via ${name}`,
    routeViaPlain: 'around terrain',
    routeLimitedByCol: (name, elev, dist) => `Tightest over ${name}, ${elev}, ${dist} away.`,
    cancel: 'Cancel',
    routeCrossing: (above, clears) => `${above} below you now; the glide clears it by ${clears}.`,
    routeAbove: above => `${above} below you now.`,
    routeProfileKey: c => `Ground along the route, the ${c} m clearance line above it, and the glide at the ratio shown — the two meet at the marked point.`,
    routeProfileAlt: (dist, ratio) => `Route profile over ${dist}, glide drawn at ${ratio} to 1`,
    routeStraight: 'Straight line — nothing in the way.',
    routeAround: (dist, legs) => `Around terrain: ${dist} in ${legs} leg${legs === 1 ? '' : 's'}.`,
    routeVersusDirect: d => `Direct line is ${d}.`,
    routeLimitedBy: (elev, dist, bearing) => `Tightest over ground at ${elev}, ${dist} away on ${bearing}.`,
    routeLimitedArrival: 'Tightest on arrival at the field.',
    routeUnchecked: 'Not terrain-checked — straight-line glide shown.',
    routeBlocked: 'No route clear of terrain from this altitude.',
    colName: 'Name', colDist: 'Dist', colGlide: 'Glide', colDiff: 'Diff',
    fieldsLoaded: 'Fields', noFields: 'No fields loaded.',
    waitingGps: 'Waiting for GPS. Enable location permission.',
    airfield: 'Airfield', field: 'Field', outlanding: 'Outlanding',
    footerNote: 'Not for primary navigation. Straight-line distance/glide only: no wind, sink, terrain clearance or airspace.',
    footerNoteTerrain: 'Not for primary navigation. Glide is routed over terrain with a clearance margin; distance is straight-line. No wind, sink or airspace.',
    updateBanner: '🔄 New field data available.', update: 'Update',
    sampleWarning: 'Sample data only — do not use this pack in flight. Run the importer to build the real Guide des Aires pack.',
    gpsError: e => `GPS error: ${e}.`,
    altMissingWarning: 'GPS altitude is missing, so required glide ratio cannot be computed. Settings has a testing mode for checking figures on the ground.',
    close: 'Close', bearing: 'Bearing', distance: 'Distance', reqGlide: 'Req glide',
    compass: ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'],
    arrivalHeight: 'Arrival', deltaSafe: 'Δsafe', elevation: 'Elevation', runway: 'Runway', frequency: 'Frequency',
    glideNotShown: r => `Glide not shown: ${r}.`,
    notes: 'Notes', noNotes: 'No notes.', mediaHeading: 'Photos / docs / VAC',
    noMedia: 'No media attached.', openPdf: 'Open PDF',
    source: 'Source', imported: 'imported', unknown: 'unknown',
    gpsSimulated: 'Simulated position — GPS is off',
    groundTesting: 'Ground testing',
    testNote: 'Puts the app at a chosen place and altitude so glide figures can be checked on the ground. Needs a connection, stores nothing, and overrides GPS until you stop it.',
    testPlace: 'Place',
    testPlacePlaceholder: 'Search a town, airfield, peak…',
    testSearching: 'Searching…',
    testAltitude: 'Altitude',
    testStop: 'Stop testing',
    testNoResults: 'Nothing found for that.',
    testSearchFailed: 'Search failed — this needs a connection.',
    testSearchFlaky: 'Search failed after three tries — flaky connection, or the search service.',
    testSearchRetryBtn: 'Try again',
    testUnnamed: 'Chosen position',
    testAttribution: 'Place search by Photon, using OpenStreetMap data.',
    testAmslLine: (ground, agl) => `Ground here ${ground} → ${agl} AGL`,
    testAglLine: (ground, amsl) => `Ground here ${ground} → flying at ${amsl}`,
    aglNeedsPlace: 'Pick a place first to use AGL.',
    aglNeedsTerrain: 'AGL needs downloaded terrain covering this place.',
    testBanner: (where, altitude) => `⚠︎ Simulated position: ${where}, ${altitude}. Not your real position.`,
    altSimulated: 'simulated',
    altMissing: 'missing',
    gpsOk: acc => `OK ±${acc}m`, gpsErr: 'Error',
    gpsIdle: 'idle', gpsRequesting: 'requesting', gpsUnavailable: 'unavailable',
    reasonGpsAlt: 'GPS altitude missing', reasonFieldElev: 'Field elevation missing',
    reasonBelowSafe: m => `Below safe arrival by ${m} m`,
    reasonTerrainBlocked: 'No route clear of terrain',
    revealConfirm: (label, severity) => `Difficulty ${label} fields are ${severity} and possibly dangerous — last-resort emergency options only, not recommended. Show them in the nearest list anyway?`,
    sevDifficult: 'difficult', sevVeryDifficult: 'very difficult',
    noPackYet: 'No pack loaded yet.', noCacheApi: 'Cache Storage is not available in this browser.',
    cacheReady: 'ready', cacheDownloading: 'downloading', cacheRefreshing: 'refreshing',
    dlSaving: 'Saving offline', dlFailed: 'failed', dlChecking: 'Checking files',
    cacheIncomplete: 'incomplete', cacheNotDownloaded: 'not downloaded', cacheErrorStatus: 'error',
    cacheUnknown: 'unknown',
    cpNoMedia: 'Nothing to cache', cpNoPack: 'No pack loaded',
    cpCached: (c, total) => `${c}/${total} cached`,
    cpCachedFailed: (ok, total, failed) => `${ok}/${total} cached · ${failed} failed`,
    cpInit: total => `0/${total}`,
    cpClearing: 'Clearing cached pack', cpCleared: n => `Cleared ${n} cached pack entries`,
    cpFetchIndex: 'Fetching fresh pack index', cpFetchPack: 'Fetching fresh pack',
    cpFresh: extra => `Fresh pack loaded · ${extra}`, cpNotChecked: 'not checked',
    cpRefreshing: 'Refreshing field data…',
    cpUpdating: (ok, total, failed) => `Updating ${ok}/${total} file(s)${failed ? ` · ${failed} failed` : ''}`,
    cpUpdated: (ok, evicted, failed) => `Updated ${ok} file(s)${evicted ? `, removed ${evicted}` : ''}${failed ? `, ${failed} failed` : ''}`,
    searchPlaceholder: 'Search a field by name or code', clearSearch: 'Clear search',
    searchResults: 'Search results', noMatches: q => `No fields match “${q}”.`,
    whatsNew: 'What’s new', updatedTo: v => `🆕 Updated to ${v}`,
    updateReady: '🆕 A new version is ready.', reloadNow: 'Reload',
    migBanner: 'Meet the Cows has a new home. Same app, new address — move when you’re on Wi-Fi.',
    migDetails: 'Details', migTitle: 'The app is moving',
    migIntro: 'Meet the Cows now lives on its own address. This one keeps working for now, but updates and new features land on the new one.',
    migStep1: 'Open the new address', migStep1Note: 'tap the button below, or type it in.',
    migStep2: 'Install it', migStep2Note: '“Add to Home Screen”, exactly as you did before.',
    migStep3: 'Download your packs again', migStep3Note: 'your offline maps and charts can’t follow the move, so pick your regions and download once.',
    migStep4: 'Delete the old icon', migStep4Note: 'once the new one works offline.',
    migWarnLead: 'Do this at home, on Wi-Fi.', migWarnBody: 'Re-downloading your packs uses a few hundred MB. Don’t start it at the airfield or before a flight.',
    migOpen: h => `Open ${h}`, migSnooze: 'Remind me tomorrow', migWhy: 'Why the move?',
    migSettingsAction: 'How to move',
    licenceLabel: 'Licence', licenceValue: 'Personal use · data reuse on request',
    noNotesFile: 'Release notes are unavailable offline.',
    contribute: 'Contribute an update', contribTitle: 'Contribute an update',
    cDate: 'Date observed', cDesc: 'What changed?',
    cDescPlaceholder: 'New windsock, surface change, obstacle, hazard…',
    cAddPhoto: 'Add photos (JPEG)', cRemovePhoto: 'Remove',
    cSubmitter: 'Your name or handle (optional)',
    cLicense: 'I made these photos/notes and agree to publish them under the project’s terms.',
    cSubmit: 'Submit for review', cSubmitting: 'Submitting…',
    cGeoAllOk: n => n === 1 ? '📍 Photo location pre-verified.' : `📍 All ${n} photos pre-verified by location.`,
    cGeoSomeReview: n => `📍 ${n} photo(s) without an on-site location — they will be reviewed manually.`,
    cGeoNone: 'No location on the photo — it will be reviewed manually.',
    cMaxPhotos: n => `Maximum ${n} photos per submission.`,
    cThanks: 'Sent for review',
    cThanksBody: n => `Opened as pull request #${n}. It appears once a maintainer approves it.`,
    cViewPr: 'View on GitHub →', cErr: 'Could not submit',
    cTooLarge: 'Photo is too large (max 15 MB).',
    cTooSmall: px => `Photo resolution too low (min ${px} px on the long edge).`,
    cJpegOnly: 'Please choose a JPEG photo.',
    cNeedContent: 'Add a note or a photo.', cNeedTurnstile: 'Please complete the anti-spam check.',
    suggestField: 'Suggest a new field',
    nfIntro: 'Propose a field missing from the packs — a maintainer reviews every proposal before it is published.',
    nfName: 'Field name', nfKind: 'Type', nfCountry: 'Country',
    nfCoords: 'Coordinates (decimal degrees)', nfLat: 'Latitude', nfLon: 'Longitude',
    nfUseGps: 'Use my position', nfGpsNone: 'No GPS position available yet.',
    nfElev: 'Elevation (m)', nfDifficulty: 'Difficulty', nfDiffUnknown: 'Unknown',
    nfRunway: 'Runway', nfLength: 'Length (m)', nfWidth: 'Width (m)',
    nfSurface: 'Surface', nfSurfacePh: 'grass, asphalt…', nfFrequency: 'Frequency (MHz)',
    nfDesc: 'Notes for pilots', nfDescPlaceholder: 'Access, obstacles, slope, who to call…',
    nfNeedBasics: 'A name and coordinates are required.',
  },
  fr: {
    settings: 'Réglages', refreshPack: 'Actualiser le pack', done: 'OK',
    share: 'Partager l’app', shareText: 'Meet the Cows — aide cockpit pour vaches (vols de campagne)',
    reportBug: 'Signaler un bug', bugNote: 'Transmis au mainteneur pour examen — aucun compte requis.',
    bugWhat: 'Que s’est-il passé ?', bugSteps: 'Étapes pour reproduire',
    bugPlaceholder: 'Décrivez le bug : ce que vous avez fait, ce que vous attendiez, ce qui s’est passé…',
    bugContact: 'Contact pour le suivi (facultatif)', bugIncluded: 'Envoyé automatiquement :',
    bugSubmit: 'Envoyer le rapport', bugSending: 'Envoi…', bugThanks: 'Merci !',
    bugThanksBody: n => `Votre rapport a été déposé pour examen (n°${n}).`,
    bugErr: 'Impossible d’envoyer le rapport', bugNeedDesc: 'Décrivez d’abord le bug.',
    bugGithubAlt: 'Vous préférez GitHub ? Ouvrez-y un ticket', bugViewIssue: 'Voir le rapport',
    shareCopied: 'Lien copié dans le presse-papiers.', shareCopyPrompt: 'Copiez ce lien :',
    selectedPacks: 'Packs sélectionnés', fieldsWord: 'terrains', downloadSize: 'Taille du téléchargement',
    app: 'Application', version: 'Version', status: 'Statut',
    betaStatus: 'Bêta — pas pour la navigation principale',
    language: 'Langue', langAuto: 'Automatique (appareil)',
    pack: 'Pack', selectedPack: 'Pack sélectionné', name: 'Nom', updated: 'Mis à jour',
    fieldsCount: 'Terrains', offline: 'Hors ligne', noPackLoaded: 'Aucun pack chargé',
    noPackSelected: 'Aucun pack sélectionné', noPackSelectedHint: 'Aucun pack sélectionné — choisissez-en un dans les Réglages (⚙).',
    downloadMedia: 'Télécharger', reloadPack: 'Recharger',
    exportCup: n => `Exporter CUP (${n} terrains)`,
    cupNote: "Fichier de points de virage pour l'application de navigation de votre choix. Consultez un terrain ici, puis rejoignez-le avec l'application de navigation de votre choix.",
    nearestList: 'Liste des plus proches',
    safetyMargin: "Marge d'arrivée de sécurité, m",
    showC: 'Afficher les terrains C', showD: 'Afficher les terrains D',
    cdNote: "Les terrains C et D sont masqués par défaut. Ils sont difficiles et potentiellement dangereux — recommandés uniquement en dernier recours d'urgence.",
    terrain: 'Relief',
    terrainRouting: 'Calculer la finesse en contournant le relief',
    terrainNote: "Avec le relief activé, la finesse requise suit un trajet qui reste dégagé du sol au lieu d'une ligne droite. Un terrain au fond d'une vallée peut devenir atteignable ; un terrain derrière une crête peut cesser de l'être.",
    terrainClearance: 'Garde au sol',
    terrainClearanceNote: c => `Les trajets calculés restent au moins ${c} m au-dessus du sol. Augmentez pour garder de la marge face au relief montant ; diminuez pour aller plus loin.`,
    terrainAttribution: 'Altitudes : Copernicus DEM (ESA). Noms des cols : © contributeurs OpenStreetMap.',
    terrainUnsupported: 'Ce navigateur ne peut pas lire les données de relief. Finesse à vol d\'oiseau.',
    terrainMissing: "Aucune donnée de relief publiée pour ce déploiement. Finesse à vol d'oiseau.",
    terrainPartial: "Les données de relief sont incomplètes ici : les terrains sans trajet gardent leur finesse à vol d'oiseau.",
    terrainSize: size => `Relief : ${size}`,
    terrainCachedCount: (done, total) => `${done} sur ${total} tuile${total === 1 ? '' : 's'} hors ligne`,
    terrainSolving: 'calcul des trajets…',
    route: 'Trajet',
    routeLength: 'Trajet',
    routeViaChip: name => `par ${name}`,
    routeViaPlain: 'contourne le relief',
    routeLimitedByCol: (name, elev, dist) => `Point critique au-dessus de ${name}, ${elev}, à ${dist}.`,
    cancel: 'Annuler',
    routeCrossing: (above, clears) => `${above} sous vous ; le trajet passe ${clears} au-dessus.`,
    routeAbove: above => `${above} sous vous.`,
    routeProfileKey: c => `Le relief le long du trajet, la ligne de garde de ${c} m au-dessus, et la pente à la finesse affichée — les deux se rejoignent au point marqué.`,
    routeProfileAlt: (dist, ratio) => `Profil du trajet sur ${dist}, pente tracée à ${ratio} pour 1`,
    routeStraight: 'Ligne droite — rien sur le chemin.',
    routeAround: (dist, legs) => `Contournement du relief : ${dist} en ${legs} branche${legs === 1 ? '' : 's'}.`,
    routeVersusDirect: d => `Ligne directe : ${d}.`,
    routeLimitedBy: (elev, dist, bearing) => `Point le plus critique au-dessus du sol à ${elev}, à ${dist} au ${bearing}.`,
    routeLimitedArrival: "Point le plus critique à l'arrivée sur le terrain.",
    routeUnchecked: "Relief non vérifié — finesse à vol d'oiseau affichée.",
    routeBlocked: 'Aucun trajet dégagé du relief depuis cette altitude.',
    colName: 'Nom', colDist: 'Dist', colGlide: 'Finesse', colDiff: 'Diff',
    fieldsLoaded: 'Terrains', noFields: 'Aucun terrain chargé.',
    waitingGps: 'En attente du GPS. Autorisez la localisation.',
    airfield: 'Aérodrome', field: 'Terrain', outlanding: 'Vache',
    footerNote: "Pas pour la navigation principale. Distance/finesse à vol d'oiseau uniquement : ni vent, ni descendance, ni relief, ni espace aérien.",
    footerNoteTerrain: "Pas pour la navigation principale. La finesse suit un trajet dégagé du relief ; la distance reste à vol d'oiseau. Ni vent, ni descendance, ni espace aérien.",
    updateBanner: '🔄 Nouvelles données de terrains disponibles.', update: 'Mettre à jour',
    sampleWarning: "Données d'exemple uniquement — n'utilisez pas ce pack en vol. Lancez l'importateur pour construire le vrai pack Guide des Aires.",
    gpsError: e => `Erreur GPS : ${e}.`,
    altMissingWarning: "L'altitude GPS est absente, la finesse requise ne peut pas être calculée. Ajoutez une altitude manuelle dans les Réglages pour les tests au sol.",
    close: 'Fermer', bearing: 'Azimut', distance: 'Distance', reqGlide: 'Finesse req.',
    compass: ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSO','SO','OSO','O','ONO','NO','NNO'],
    arrivalHeight: 'Arrivée', deltaSafe: 'Δsécu', elevation: 'Altitude', runway: 'Piste', frequency: 'Fréquence',
    glideNotShown: r => `Finesse non affichée : ${r}.`,
    notes: 'Notes', noNotes: 'Aucune note.', mediaHeading: 'Photos / docs / VAC',
    noMedia: 'Aucun média joint.', openPdf: 'Ouvrir le PDF',
    source: 'Source', imported: 'importé le', unknown: 'inconnu',
    gpsSimulated: 'Position simulée — GPS désactivé',
    groundTesting: 'Test au sol',
    testNote: "Place l'application à un lieu et une altitude choisis pour vérifier les finesses au sol. Nécessite une connexion, n'enregistre rien et remplace le GPS jusqu'à l'arrêt.",
    testPlace: 'Lieu',
    testPlacePlaceholder: 'Chercher une ville, un terrain, un sommet…',
    testSearching: 'Recherche…',
    testAltitude: 'Altitude',
    testStop: 'Arrêter le test',
    testNoResults: 'Aucun résultat.',
    testSearchFailed: 'Recherche impossible — une connexion est nécessaire.',
    testSearchFlaky: 'Recherche échouée après trois essais — connexion instable ou service indisponible.',
    testSearchRetryBtn: 'Réessayer',
    testUnnamed: 'Position choisie',
    testAttribution: 'Recherche de lieux par Photon, données OpenStreetMap.',
    testAmslLine: (ground, agl) => `Sol ici ${ground} → ${agl} AGL`,
    testAglLine: (ground, amsl) => `Sol ici ${ground} → vol à ${amsl}`,
    aglNeedsPlace: "Choisissez d'abord un lieu pour utiliser l'AGL.",
    aglNeedsTerrain: 'AGL nécessite le relief téléchargé couvrant ce lieu.',
    testBanner: (where, altitude) => `⚠︎ Position simulée : ${where}, ${altitude}. Ce n'est pas votre position réelle.`,
    altSimulated: 'simulée',
    altMissing: 'absente',
    gpsOk: acc => `OK ±${acc} m`, gpsErr: 'Erreur',
    gpsIdle: 'inactif', gpsRequesting: 'en cours', gpsUnavailable: 'indisponible',
    reasonGpsAlt: 'Altitude GPS absente', reasonFieldElev: 'Altitude terrain absente',
    reasonBelowSafe: m => `Sous l'arrivée sûre de ${m} m`,
    reasonTerrainBlocked: 'Aucun trajet dégagé du relief',
    revealConfirm: (label, severity) => `Les terrains de difficulté ${label} sont ${severity} et potentiellement dangereux — uniquement en dernier recours d'urgence, non recommandés. Les afficher quand même dans la liste ?`,
    sevDifficult: 'difficiles', sevVeryDifficult: 'très difficiles',
    noPackYet: 'Aucun pack chargé pour le moment.', noCacheApi: "Le stockage de cache n'est pas disponible dans ce navigateur.",
    cacheReady: 'prêt', cacheDownloading: 'téléchargement', cacheRefreshing: 'actualisation',
    dlSaving: 'Enregistrement hors ligne', dlFailed: 'échec(s)', dlChecking: 'Vérification des fichiers',
    cacheIncomplete: 'incomplet', cacheNotDownloaded: 'non téléchargé', cacheErrorStatus: 'erreur',
    cacheUnknown: 'inconnu',
    cpNoMedia: 'Aucun média/doc à mettre en cache', cpNoPack: 'Aucun pack chargé',
    cpCached: (c, total) => `${c}/${total} en cache`,
    cpCachedFailed: (ok, total, failed) => `${ok}/${total} en cache · ${failed} échec(s)`,
    cpInit: total => `0/${total}`,
    cpClearing: 'Effacement du pack en cache', cpCleared: n => `${n} entrées de pack effacées`,
    cpFetchIndex: "Récupération de l'index des packs", cpFetchPack: 'Récupération du pack',
    cpFresh: extra => `Pack à jour chargé · ${extra}`, cpNotChecked: 'non vérifiés',
    cpRefreshing: 'Actualisation des données…',
    cpUpdating: (ok, total, failed) => `Mise à jour ${ok}/${total} fichier(s)${failed ? ` · ${failed} échec(s)` : ''}`,
    cpUpdated: (ok, evicted, failed) => `${ok} fichier(s) mis à jour${evicted ? `, ${evicted} supprimé(s)` : ''}${failed ? `, ${failed} échec(s)` : ''}`,
    searchPlaceholder: 'Rechercher un terrain (nom ou code)', clearSearch: 'Effacer la recherche',
    searchResults: 'Résultats de recherche', noMatches: q => `Aucun terrain ne correspond à « ${q} ».`,
    whatsNew: 'Nouveautés', updatedTo: v => `🆕 Mise à jour ${v}`,
    updateReady: '🆕 Une nouvelle version est prête.', reloadNow: 'Recharger',
    migBanner: 'Meet the Cows a une nouvelle adresse. Même application — déménagez en Wi-Fi.',
    migDetails: 'Détails', migTitle: 'L’application déménage',
    migIntro: 'Meet the Cows a désormais sa propre adresse. Celle-ci continue de fonctionner, mais les mises à jour et les nouveautés arrivent sur la nouvelle.',
    migStep1: 'Ouvrez la nouvelle adresse', migStep1Note: 'touchez le bouton ci-dessous, ou saisissez-la.',
    migStep2: 'Installez-la', migStep2Note: '« Ajouter à l’écran d’accueil », comme la première fois.',
    migStep3: 'Retéléchargez vos packs', migStep3Note: 'vos cartes et fiches hors ligne ne peuvent pas suivre le déménagement : choisissez vos régions et téléchargez une fois.',
    migStep4: 'Supprimez l’ancienne icône', migStep4Note: 'une fois que la nouvelle fonctionne hors ligne.',
    migWarnLead: 'Faites-le chez vous, en Wi-Fi.', migWarnBody: 'Retélécharger vos packs représente quelques centaines de Mo. Ne le lancez pas sur le terrain ni avant un vol.',
    migOpen: h => `Ouvrir ${h}`, migSnooze: 'Me le rappeler demain', migWhy: 'Pourquoi ce changement ?',
    migSettingsAction: 'Comment déménager',
    licenceLabel: 'Licence', licenceValue: 'Usage personnel · réutilisation des données sur demande',
    noNotesFile: 'Notes de version indisponibles hors ligne.',
    contribute: 'Proposer une mise à jour', contribTitle: 'Proposer une mise à jour',
    cDate: 'Date d’observation', cDesc: 'Qu’est-ce qui a changé ?',
    cDescPlaceholder: 'Nouvelle manche à air, surface, obstacle, danger…',
    cAddPhoto: 'Ajouter des photos (JPEG)', cRemovePhoto: 'Retirer',
    cSubmitter: 'Votre nom ou pseudo (facultatif)',
    cLicense: 'J’ai réalisé ces photos/notes et j’accepte de les publier selon les conditions du projet.',
    cSubmit: 'Envoyer pour révision', cSubmitting: 'Envoi…',
    cGeoAllOk: n => n === 1 ? '📍 Localisation de la photo pré-vérifiée.' : `📍 Les ${n} photos sont pré-vérifiées par leur localisation.`,
    cGeoSomeReview: n => `📍 ${n} photo(s) sans localisation sur site — révision manuelle.`,
    cGeoNone: 'Aucune localisation sur la photo — révision manuelle.',
    cMaxPhotos: n => `Maximum ${n} photos par envoi.`,
    cThanks: 'Envoyé pour révision',
    cThanksBody: n => `Ouvert comme pull request #${n}. Visible après validation par un mainteneur.`,
    cViewPr: 'Voir sur GitHub →', cErr: 'Échec de l’envoi',
    cTooLarge: 'Photo trop volumineuse (max 15 Mo).',
    cTooSmall: px => `Résolution trop faible (min ${px} px sur le côté long).`,
    cJpegOnly: 'Veuillez choisir une photo JPEG.',
    cNeedContent: 'Ajoutez une note ou une photo.', cNeedTurnstile: 'Veuillez compléter la vérification anti-spam.',
    suggestField: 'Proposer un nouveau terrain',
    nfIntro: 'Proposez un terrain absent des packs — chaque proposition est relue par un mainteneur avant publication.',
    nfName: 'Nom du terrain', nfKind: 'Type', nfCountry: 'Pays',
    nfCoords: 'Coordonnées (degrés décimaux)', nfLat: 'Latitude', nfLon: 'Longitude',
    nfUseGps: 'Utiliser ma position', nfGpsNone: 'Pas encore de position GPS.',
    nfElev: 'Altitude (m)', nfDifficulty: 'Difficulté', nfDiffUnknown: 'Inconnue',
    nfRunway: 'Piste', nfLength: 'Longueur (m)', nfWidth: 'Largeur (m)',
    nfSurface: 'Surface', nfSurfacePh: 'herbe, asphalte…', nfFrequency: 'Fréquence (MHz)',
    nfDesc: 'Notes pour les pilotes', nfDescPlaceholder: 'Accès, obstacles, pente, qui contacter…',
    nfNeedBasics: 'Un nom et des coordonnées sont requis.',
  },
  de: {
    settings: 'Einstellungen', refreshPack: 'Paket aktualisieren', done: 'Fertig',
    share: 'App teilen', shareText: 'Meet the Cows — Cockpit-Hilfe für Außenlandungen',
    reportBug: 'Fehler melden', bugNote: 'Geht zur Prüfung an den Betreuer — kein Konto nötig.',
    bugWhat: 'Was ist passiert?', bugSteps: 'Schritte zum Reproduzieren',
    bugPlaceholder: 'Beschreibe den Fehler: was du getan hast, was du erwartet hast, was stattdessen geschah…',
    bugContact: 'Kontakt für Rückfragen (optional)', bugIncluded: 'Wird automatisch mitgeschickt:',
    bugSubmit: 'Bericht senden', bugSending: 'Wird gesendet…', bugThanks: 'Danke!',
    bugThanksBody: n => `Dein Bericht wurde zur Prüfung eingereicht (#${n}).`,
    bugErr: 'Bericht konnte nicht gesendet werden', bugNeedDesc: 'Bitte beschreibe zuerst den Fehler.',
    bugGithubAlt: 'Lieber GitHub? Dort ein Issue öffnen', bugViewIssue: 'Bericht ansehen',
    shareCopied: 'Link in die Zwischenablage kopiert.', shareCopyPrompt: 'Diesen Link kopieren:',
    selectedPacks: 'Ausgewählte Pakete', fieldsWord: 'Felder', downloadSize: 'Downloadgröße',
    app: 'App', version: 'Version', status: 'Status',
    betaStatus: 'Beta — nicht zur primären Navigation',
    language: 'Sprache', langAuto: 'Automatisch (Gerät)',
    pack: 'Paket', selectedPack: 'Ausgewähltes Paket', name: 'Name', updated: 'Aktualisiert',
    fieldsCount: 'Felder', offline: 'Offline', noPackLoaded: 'Kein Paket geladen',
    noPackSelected: 'Kein Paket ausgewählt', noPackSelectedHint: 'Kein Paket ausgewählt — wähle eines in den Einstellungen (⚙).',
    downloadMedia: 'Herunterladen', reloadPack: 'Neu laden',
    exportCup: n => `CUP exportieren (${n} Felder)`,
    cupNote: 'Wegpunktdatei für die Navigations-App Ihrer Wahl. Feld hier briefen und mit der Navigations-App Ihrer Wahl anfliegen.',
    nearestList: 'Nächstgelegene Felder',
    safetyMargin: 'Sicherheits-Ankunftsreserve, m',
    showC: 'C-Felder anzeigen', showD: 'D-Felder anzeigen',
    cdNote: 'C- und D-Felder sind standardmäßig ausgeblendet. Sie sind schwierig und möglicherweise gefährlich — nur als letzte Notfalloption empfohlen.',
    terrain: 'Gelände',
    terrainRouting: 'Gleitpfad um das Gelände herum rechnen',
    terrainNote: 'Mit eingeschaltetem Gelände folgt die erforderliche Gleitzahl einem Pfad, der vom Boden frei bleibt, statt einer Luftlinie. Ein Feld talabwärts kann erreichbar werden, eines hinter einem Grat nicht mehr.',
    terrainClearance: 'Geländefreiheit',
    terrainClearanceNote: c => `Berechnete Pfade bleiben mindestens ${c} m über Grund. Höher für mehr Spielraum zum Wegdrehen von steigendem Gelände, niedriger für mehr Reichweite.`,
    terrainAttribution: 'Höhen: Copernicus DEM (ESA). Pass- und Sattelnamen: © OpenStreetMap-Mitwirkende.',
    terrainUnsupported: 'Dieser Browser kann keine Geländedaten lesen. Gleitzahl bleibt Luftlinie.',
    terrainMissing: 'Für diese Installation sind keine Geländedaten veröffentlicht. Gleitzahl bleibt Luftlinie.',
    terrainPartial: 'Die Geländedaten sind hier unvollständig; Felder ohne Pfad behalten ihre Luftlinien-Gleitzahl.',
    terrainSize: size => `Gelände: ${size}`,
    terrainCachedCount: (done, total) => `${done} von ${total} ${total === 1 ? 'Kachel' : 'Kacheln'} offline`,
    terrainSolving: 'Pfade werden berechnet…',
    route: 'Pfad',
    routeLength: 'Pfad',
    routeViaChip: name => `über ${name}`,
    routeViaPlain: 'um das Gelände',
    routeLimitedByCol: (name, elev, dist) => `Engste Stelle über ${name}, ${elev}, ${dist} entfernt.`,
    cancel: 'Abbrechen',
    routeCrossing: (above, clears) => `${above} unter dir; der Pfad bleibt ${clears} darüber.`,
    routeAbove: above => `${above} unter dir.`,
    routeProfileKey: c => `Das Gelände entlang des Pfades, die ${c} m Freiheitslinie darüber und der Gleitpfad zur angezeigten Zahl — beide treffen sich am markierten Punkt.`,
    routeProfileAlt: (dist, ratio) => `Pfadprofil über ${dist}, Gleitpfad bei ${ratio} zu 1`,
    routeStraight: 'Luftlinie — nichts im Weg.',
    routeAround: (dist, legs) => `Um das Gelände herum: ${dist} in ${legs} Schenkel${legs === 1 ? '' : 'n'}.`,
    routeVersusDirect: d => `Direkte Linie: ${d}.`,
    routeLimitedBy: (elev, dist, bearing) => `Engste Stelle über Grund bei ${elev}, ${dist} entfernt auf ${bearing}.`,
    routeLimitedArrival: 'Engste Stelle bei der Ankunft am Feld.',
    routeUnchecked: 'Gelände nicht geprüft — Luftlinien-Gleitzahl angezeigt.',
    routeBlocked: 'Aus dieser Höhe kein vom Gelände freier Pfad.',
    colName: 'Name', colDist: 'Dist', colGlide: 'Gleit', colDiff: 'Diff',
    fieldsLoaded: 'Felder', noFields: 'Keine Felder geladen.',
    waitingGps: 'Warte auf GPS. Standortzugriff erlauben.',
    airfield: 'Flugplatz', field: 'Feld', outlanding: 'Außenlandung',
    footerNote: 'Nicht zur primären Navigation. Nur Luftlinie/Gleitzahl: kein Wind, kein Sinken, keine Geländefreiheit, kein Luftraum.',
    footerNoteTerrain: 'Nicht zur primären Navigation. Die Gleitzahl folgt einem vom Gelände freien Pfad; die Entfernung bleibt Luftlinie. Kein Wind, kein Sinken, kein Luftraum.',
    updateBanner: '🔄 Neue Felddaten verfügbar.', update: 'Aktualisieren',
    sampleWarning: 'Nur Beispieldaten — dieses Paket nicht im Flug verwenden. Importer ausführen, um das echte Guide-des-Aires-Paket zu erstellen.',
    gpsError: e => `GPS-Fehler: ${e}.`,
    altMissingWarning: 'GPS-Höhe fehlt, daher kann die erforderliche Gleitzahl nicht berechnet werden. Für Bodentests eine manuelle Höhe in den Einstellungen angeben.',
    close: 'Schließen', bearing: 'Peilung', distance: 'Entfernung', reqGlide: 'Erf. Gleit',
    compass: ['N','NNO','NO','ONO','O','OSO','SO','SSO','S','SSW','SW','WSW','W','WNW','NW','NNW'],
    arrivalHeight: 'Ankunft', deltaSafe: 'Δsicher', elevation: 'Höhe', runway: 'Bahn', frequency: 'Frequenz',
    glideNotShown: r => `Gleitzahl nicht angezeigt: ${r}.`,
    notes: 'Notizen', noNotes: 'Keine Notizen.', mediaHeading: 'Fotos / Dokumente / VAC',
    noMedia: 'Keine Medien angehängt.', openPdf: 'PDF öffnen',
    source: 'Quelle', imported: 'importiert am', unknown: 'unbekannt',
    gpsSimulated: 'Simulierte Position — GPS aus',
    groundTesting: 'Bodentest',
    testNote: 'Versetzt die App an einen gewählten Ort und eine gewählte Höhe, um Gleitzahlen am Boden zu prüfen. Braucht eine Verbindung, speichert nichts und ersetzt das GPS bis zum Beenden.',
    testPlace: 'Ort',
    testPlacePlaceholder: 'Ort, Flugplatz, Gipfel suchen…',
    testSearching: 'Suche…',
    testAltitude: 'Höhe',
    testStop: 'Test beenden',
    testNoResults: 'Nichts gefunden.',
    testSearchFailed: 'Suche fehlgeschlagen — dafür ist eine Verbindung nötig.',
    testSearchFlaky: 'Suche nach drei Versuchen fehlgeschlagen — instabile Verbindung oder Dienst nicht erreichbar.',
    testSearchRetryBtn: 'Erneut versuchen',
    testUnnamed: 'Gewählte Position',
    testAttribution: 'Ortssuche von Photon, mit OpenStreetMap-Daten.',
    testAmslLine: (ground, agl) => `Boden hier ${ground} → ${agl} AGL`,
    testAglLine: (ground, amsl) => `Boden hier ${ground} → Flug in ${amsl}`,
    aglNeedsPlace: 'Zuerst einen Ort wählen, um AGL zu nutzen.',
    aglNeedsTerrain: 'AGL braucht heruntergeladenes Gelände für diesen Ort.',
    testBanner: (where, altitude) => `⚠︎ Simulierte Position: ${where}, ${altitude}. Nicht deine echte Position.`,
    altSimulated: 'simuliert',
    altMissing: 'fehlt',
    gpsOk: acc => `OK ±${acc} m`, gpsErr: 'Fehler',
    gpsIdle: 'inaktiv', gpsRequesting: 'anfordern', gpsUnavailable: 'nicht verfügbar',
    reasonGpsAlt: 'GPS-Höhe fehlt', reasonFieldElev: 'Feldhöhe fehlt',
    reasonBelowSafe: m => `${m} m unter sicherer Ankunft`,
    reasonTerrainBlocked: 'Kein vom Gelände freier Pfad',
    revealConfirm: (label, severity) => `Felder der Schwierigkeit ${label} sind ${severity} und möglicherweise gefährlich — nur als letzte Notfalloption, nicht empfohlen. Trotzdem in der Liste anzeigen?`,
    sevDifficult: 'schwierig', sevVeryDifficult: 'sehr schwierig',
    noPackYet: 'Noch kein Paket geladen.', noCacheApi: 'Cache-Speicher ist in diesem Browser nicht verfügbar.',
    cacheReady: 'bereit', cacheDownloading: 'lädt', cacheRefreshing: 'aktualisiert',
    dlSaving: 'Offline speichern', dlFailed: 'fehlgeschlagen', dlChecking: 'Dateien werden geprüft',
    cacheIncomplete: 'unvollständig', cacheNotDownloaded: 'nicht geladen', cacheErrorStatus: 'Fehler',
    cacheUnknown: 'unbekannt',
    cpNoMedia: 'Nichts zwischenzuspeichern', cpNoPack: 'Kein Paket geladen',
    cpCached: (c, total) => `${c}/${total} zwischengespeichert`,
    cpCachedFailed: (ok, total, failed) => `${ok}/${total} zwischengespeichert · ${failed} fehlgeschlagen`,
    cpInit: total => `0/${total}`,
    cpClearing: 'Zwischengespeichertes Paket wird gelöscht', cpCleared: n => `${n} zwischengespeicherte Paketeinträge gelöscht`,
    cpFetchIndex: 'Paketindex wird geladen', cpFetchPack: 'Paket wird geladen',
    cpFresh: extra => `Aktuelles Paket geladen · ${extra}`, cpNotChecked: 'nicht geprüft',
    cpRefreshing: 'Felddaten werden aktualisiert…',
    cpUpdating: (ok, total, failed) => `Aktualisiere ${ok}/${total} Datei(en)${failed ? ` · ${failed} fehlgeschlagen` : ''}`,
    cpUpdated: (ok, evicted, failed) => `${ok} Datei(en) aktualisiert${evicted ? `, ${evicted} entfernt` : ''}${failed ? `, ${failed} fehlgeschlagen` : ''}`,
    searchPlaceholder: 'Feld suchen (Name oder Code)', clearSearch: 'Suche löschen',
    searchResults: 'Suchergebnisse', noMatches: q => `Keine Felder für „${q}“.`,
    whatsNew: 'Neuigkeiten', updatedTo: v => `🆕 Aktualisiert auf ${v}`,
    updateReady: '🆕 Eine neue Version ist bereit.', reloadNow: 'Neu laden',
    migBanner: 'Meet the Cows hat eine neue Adresse. Gleiche App — wechsle im WLAN.',
    migDetails: 'Details', migTitle: 'Die App zieht um',
    migIntro: 'Meet the Cows hat jetzt eine eigene Adresse. Diese hier funktioniert vorerst weiter, aber Updates und neue Funktionen kommen auf der neuen.',
    migStep1: 'Neue Adresse öffnen', migStep1Note: 'unten tippen oder die Adresse eingeben.',
    migStep2: 'Installieren', migStep2Note: '„Zum Startbildschirm hinzufügen“, genau wie beim ersten Mal.',
    migStep3: 'Pakete erneut laden', migStep3Note: 'deine Offline-Karten und -Blätter können nicht mitziehen: Regionen wählen und einmal herunterladen.',
    migStep4: 'Altes Symbol löschen', migStep4Note: 'sobald das neue offline funktioniert.',
    migWarnLead: 'Mach das zu Hause, im WLAN.', migWarnBody: 'Das erneute Laden der Pakete kostet einige hundert MB. Nicht am Flugplatz oder vor dem Start starten.',
    migOpen: h => `${h} öffnen`, migSnooze: 'Morgen erinnern', migWhy: 'Warum der Umzug?',
    migSettingsAction: 'Wie du umziehst',
    licenceLabel: 'Lizenz', licenceValue: 'Private Nutzung · Datenweiterverwendung auf Anfrage',
    noNotesFile: 'Versionshinweise offline nicht verfügbar.',
    contribute: 'Update beitragen', contribTitle: 'Update beitragen',
    cDate: 'Beobachtungsdatum', cDesc: 'Was hat sich geändert?',
    cDescPlaceholder: 'Neuer Windsack, Oberfläche, Hindernis, Gefahr…',
    cAddPhoto: 'Fotos hinzufügen (JPEG)', cRemovePhoto: 'Entfernen',
    cSubmitter: 'Name oder Kürzel (optional)',
    cLicense: 'Ich habe diese Fotos/Notizen erstellt und stimme der Veröffentlichung gemäß den Projektbedingungen zu.',
    cSubmit: 'Zur Prüfung senden', cSubmitting: 'Wird gesendet…',
    cGeoAllOk: n => n === 1 ? '📍 Fotostandort vorab bestätigt.' : `📍 Alle ${n} Fotos standortlich vorab bestätigt.`,
    cGeoSomeReview: n => `📍 ${n} Foto(s) ohne Standort am Feld — manuelle Prüfung.`,
    cGeoNone: 'Kein Standort im Foto — wird manuell geprüft.',
    cMaxPhotos: n => `Maximal ${n} Fotos pro Einsendung.`,
    cThanks: 'Zur Prüfung gesendet',
    cThanksBody: n => `Als Pull Request #${n} geöffnet. Erscheint, sobald ein Maintainer zustimmt.`,
    cViewPr: 'Auf GitHub ansehen →', cErr: 'Senden fehlgeschlagen',
    cTooLarge: 'Foto zu groß (max. 15 MB).',
    cTooSmall: px => `Auflösung zu niedrig (mind. ${px} px an der langen Kante).`,
    cJpegOnly: 'Bitte ein JPEG-Foto wählen.',
    cNeedContent: 'Notiz oder Foto hinzufügen.', cNeedTurnstile: 'Bitte die Anti-Spam-Prüfung abschließen.',
    suggestField: 'Neues Feld vorschlagen',
    nfIntro: 'Schlage ein Feld vor, das in den Paketen fehlt — jeder Vorschlag wird vor der Veröffentlichung geprüft.',
    nfName: 'Feldname', nfKind: 'Typ', nfCountry: 'Land',
    nfCoords: 'Koordinaten (Dezimalgrad)', nfLat: 'Breitengrad', nfLon: 'Längengrad',
    nfUseGps: 'Meine Position verwenden', nfGpsNone: 'Noch keine GPS-Position.',
    nfElev: 'Höhe (m)', nfDifficulty: 'Schwierigkeit', nfDiffUnknown: 'Unbekannt',
    nfRunway: 'Piste', nfLength: 'Länge (m)', nfWidth: 'Breite (m)',
    nfSurface: 'Oberfläche', nfSurfacePh: 'Gras, Asphalt…', nfFrequency: 'Frequenz (MHz)',
    nfDesc: 'Hinweise für Piloten', nfDescPlaceholder: 'Zufahrt, Hindernisse, Neigung, Ansprechpartner…',
    nfNeedBasics: 'Name und Koordinaten sind erforderlich.',
  },
};

// Resolve the active UI language: an explicit setting wins, otherwise follow the device.
// Pack display name in the pilot's language: pack.names is a {en,fr,de} map from the build;
// fall back to the English default name, then the id, for any older/partial pack entry.
function packName(pack) {
  const lang = resolveLang();
  return (pack.names && (pack.names[lang] || pack.names.en)) || pack.name || pack.id;
}

function resolveLang() {
  const setting = state.settings.language;
  if (SUPPORTED_LANGS.includes(setting)) return setting;
  const candidates = (navigator.languages && navigator.languages.length)
    ? navigator.languages
    : [navigator.language || 'en'];
  for (const candidate of candidates) {
    const base = String(candidate).toLowerCase().slice(0, 2);
    if (SUPPORTED_LANGS.includes(base)) return base;
  }
  return 'en';
}

// Look up a UI string for the active language, falling back to English then the raw key.
// Extra arguments are passed through to string values that are functions.
function t(key, ...args) {
  const lang = resolveLang();
  let value = STRINGS[lang]?.[key];
  if (value === undefined) value = STRINGS.en[key];
  if (value === undefined) return key;
  return typeof value === 'function' ? value(...args) : value;
}

// Field notes are a localized object ({en,fr,de}) in pack schema v8+, but old cached packs
// may still hold a plain string. Return the best available text for the active language.
function fieldNotes(field) {
  const notes = field?.notes;
  if (notes && typeof notes === 'object') {
    const lang = resolveLang();
    return notes[lang] || notes.en || notes.fr || notes.de || '';
  }
  return typeof notes === 'string' ? notes : '';
}

// Localized label for a cache status token, falling back to the raw token for anything new.
function cacheStatusLabel(status) {
  const map = {
    ready: 'cacheReady', downloading: 'cacheDownloading', refreshing: 'cacheRefreshing',
    incomplete: 'cacheIncomplete', 'not downloaded': 'cacheNotDownloaded',
    error: 'cacheErrorStatus', unknown: 'cacheUnknown',
  };
  return map[status] ? t(map[status]) : String(status ?? '');
}

// Best-options shortlist: only difficulty A entries reachable at this required glide
// ratio or better qualify for the pinned top-three picks.
//
// 25 rather than the original 20. 20 is a safe number for anything with wings, which made it
// the wrong number for this gate: it is not a glide the app promises, it is the cut-off for
// what is worth pinning, and on a modern glider a field needing 25 is a comfortable option
// rather than a marginal one. At 20 the shortlist came back short in exactly the terrain where
// a shortlist is most wanted.
//
// It stays a cut-off, not an estimate. The ratios it filters already carry the arrival margin,
// and the solver's rung ladder rounds them pessimistically, so a field near the boundary is
// likelier to be excluded than let in. Nothing here models wind or sink.
const TOP_PICK_MAX_GLIDE = 25;

let renderTimer = null;
let gpsWatchId = null;

let state = {
  settings: loadSettings(),
  packs: [],
  packManifest: null,
  currentManifestUrl: null,
  fields: [],
  position: null,
  gpsStatus: 'idle',
  gpsError: '',
  selectedFieldId: null,
  contribFor: null,
  showNewField: false,
  showBugReport: false,
  releaseNotes: [],
  showReleaseNotes: false,
  updateNoteAvailable: false,
  // A newer build is installed and cached, but this document is still running the old one.
  updateReadyOnReload: false,
  view: 'main',
  searchQuery: '',
  computedRows: [],
  cacheStatus: 'unknown',
  cacheProgress: '',
  // When an offline download/sync is running: { done, total, failed }. Drives a floating
  // progress bar updated in place (no full re-render), so the rest of the app stays usable.
  offlineSync: null,
  detailScrollTop: 0,
  dataUpdateAvailable: false,
  // Ground elevation (m) at the simulated place, sampled from downloaded terrain; null when
  // unknown (no place yet, or no tile covering it), which is what disables AGL.
  testGroundM: null,
  testSearch: null,
  testQuery: '',
  activePacks: [],
  // Terrain-routed glide. `routes` holds one entry per field the last solve answered; fields
  // absent from it were either out of the working area or have no route clear of the ground,
  // which `trusted` decides how to report.
  terrain: {
    store: null,
    available: null,      // null until the tile index has been asked for
    status: 'idle',       // idle | solving | ready | unavailable | error
    routes: new Map(),
    solvedIds: new Set(), // fields the last solve was actually asked about
    coverage: 0,
    trusted: false,
    error: '',
    cacheStatus: 'unknown',
    cacheProgress: '',
    cacheAnyTiles: false, // any tile bytes at all in the cache, current or not — drives "Remove"
  },
};

const app = document.querySelector('#app');

// Declared here rather than beside registerServiceWorker: init() runs before the rest of the
// module body, so anything it reaches must already be initialised.
let swRegistration = null;

init();

async function init() {
  render();
  registerServiceWorker();
  initReleaseNotes();
  watchForResume();
  await loadPackIndex();
  await loadSelectedPacks();
  startGps();
  if (state.settings.testMode) refreshTestGround();
  render();
  // After the packs: tile targets are the fields' bounding box. Deliberately not awaited —
  // the app is fully usable while terrain fills in behind the progress bar.
  autoSyncTerrainTiles().catch(error => console.warn('Terrain sync failed', error));
}

// Load the shipped release notes and decide whether to show the one-time "updated" banner.
// A fresh install just records the current version silently; the banner only appears when a
// previously-seen version differs from the running one (i.e. the app shell was updated).
async function initReleaseNotes() {
  try {
    const res = await fetch(RELEASE_NOTES_URL);
    if (res.ok) {
      const notes = await res.json();
      if (Array.isArray(notes)) state.releaseNotes = notes;
    }
  } catch { /* offline first visit: the sheet shows a fallback message */ }
  let seen = null;
  try { seen = localStorage.getItem(LAST_SEEN_VERSION_KEY); } catch { /* private mode */ }
  if (!seen) {
    try { localStorage.setItem(LAST_SEEN_VERSION_KEY, APP_VERSION); } catch { /* ignore */ }
  } else if (seen !== APP_VERSION) {
    state.updateNoteAvailable = true;
    render();
  }
}

function openReleaseNotes() {
  state.showReleaseNotes = true;
  state.updateNoteAvailable = false;
  try { localStorage.setItem(LAST_SEEN_VERSION_KEY, APP_VERSION); } catch { /* ignore */ }
  render();
}

function loadSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {};
    const settings = { ...DEFAULT_SETTINGS, ...(typeof stored === 'object' ? stored : {}) };
    // Migrate the old single-pack setting (packId) to the multi-select list (packIds).
    if (!Array.isArray(settings.packIds)) {
      settings.packIds = stored.packId ? [stored.packId] : [...DEFAULT_SETTINGS.packIds];
    }
    // 0.7.3: the whole-Alps pack was split into two overlapping halves. Map the retired id to
    // both so existing Alps users keep their coverage (shared media stays cached — only the
    // pack JSONs change).
    if (settings.packIds.includes('alps')) {
      settings.packIds = [...new Set(settings.packIds.flatMap(id => id === 'alps' ? ['alps-west', 'alps-east'] : [id]))];
    }
    // Terrain routing shipped on by default before it was gated behind a warning, so a stored
    // `true` may predate the warning entirely. Anyone in that state gets it switched off and is
    // asked properly, rather than keeping a setting they were never shown the terms of.
    // "Hide C/D fields", on by default, became "Show C/D fields", off by default: the same
    // behaviour said the way every other switch says itself. The stored value is the negation,
    // and it has to be read here — the line below keeps only keys that exist in DEFAULT_SETTINGS,
    // so an unmigrated hideC would simply vanish and a pilot who deliberately revealed those
    // fields would quietly stop being shown them.
    for (const grade of ['C', 'D']) {
      const hidden = stored[`hide${grade}`];
      if (typeof hidden === 'boolean') settings[`show${grade}`] = !hidden;
    }
    return Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map(key => [key, settings[key]]));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
}

async function loadPackIndex({ cacheMode = 'no-cache' } = {}) {
  // Try the configured data origin first, then the app's own origin. The second attempt only
  // exists when they differ, and covers the data host being unreachable, misconfigured, or not
  // yet populated — in which case the app keeps working from whatever the app origin serves
  // (and, offline, from the service-worker cache) instead of showing an empty field list.
  const candidates = [dataBase];
  if (dataBase.toString() !== BASE_URL.toString()) candidates.push(BASE_URL);

  for (const base of candidates) {
    try {
      const res = await fetch(new URL('packs/packs.json', base).toString(), { cache: cacheMode });
      if (!res.ok) throw new Error(`Pack index HTTP ${res.status}`);
      const index = await res.json();
      const packs = Array.isArray(index) ? index : (Array.isArray(index.packs) ? index.packs : []);
      if (!packs.length) throw new Error('Pack index contained no packs');
      if (base !== dataBase) {
        console.warn(`Pack data unavailable at ${dataBase}; falling back to ${base}`);
        dataBase = base;  // every later manifest/media URL follows the base that worked
      }
      state.packs = packs;
      return;
    } catch (error) {
      console.error(error);
    }
  }
  state.packs = [{ id: 'fr-alps', name: 'France / Alps', manifestUrl: 'packs/fr-alps/manifest.json' }];
}

function activePackIds() {
  const stored = state.settings.packIds;
  // An explicitly empty selection is honoured (the app works GPS-only, no offline data). The
  // first-pack fallback only kicks in when the stored ids no longer exist in packs.json.
  if (Array.isArray(stored) && stored.length === 0) return [];
  const isAlps = id => id === 'alps' || String(id).startsWith('alps-');
  const available = id => state.packs.some(p => p.id === id);
  let chosen = (stored || []).filter(available);
  if ((stored || []).some(id => isAlps(id) && !available(id)) && !chosen.some(isAlps)) {
    // Alps split transition: the app shell and the pack index deploy minutes apart, so the
    // stored Alps ids may not exist in the published packs.json yet (new app, old index) or
    // anymore (old app, new index). Substitute whichever Alps flavour is published — for
    // mixed selections too — rather than silently dropping the pilot's Alps coverage.
    chosen = [...chosen, ...['alps-west', 'alps-east', 'alps'].filter(available)];
  }
  chosen = chosen.length ? chosen : (state.packs[0] ? [state.packs[0].id] : []);
  // Always in published pack order (packs.json = the picker's order: the mountain ranges, then
  // the country packs), never in whatever order the ids happen to sit in localStorage. Packs
  // overlap, and loadSelectedPacks gives each shared field to the FIRST pack that carries it —
  // so this order decides whether a field in both the Pyrenees and Spain packs belongs to the
  // range or to the country. The range is the answer a pilot expects, and it must not depend on
  // the order a stored selection was written in (the Alps-split branch above appends, and older
  // settings predate the picker order entirely).
  const rank = id => {
    const index = state.packs.findIndex(p => p.id === id);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  return [...chosen].sort((a, b) => rank(a) - rank(b));
}

function activePacks() {
  return activePackIds().map(id => state.packs.find(p => p.id === id)).filter(Boolean);
}

function selectedPack() {  // legacy single-pack callers use the first active pack
  return activePacks()[0] || state.packs[0];
}

function manifestUrlForPack(pack) {
  return new URL(pack.manifestUrl || `packs/${pack.id}/manifest.json`, dataBase).toString();
}

// Load every selected pack, merge their fields and de-duplicate by id (a field shared by, e.g.,
// the France and Alps packs appears once). Each field is stamped with the manifest URL of the
// pack it came from so its media/docs resolve against the right pack directory.
async function loadSelectedPacks({ cacheMode = 'no-cache' } = {}) {
  const ids = activePackIds();
  // Persist the resolved selection but KEEP stored ids that merely aren't in the currently
  // published index — during a deploy window (or after a rollback) overwriting them would
  // permanently destroy the pilot's selection; kept ids resolve again once the index updates.
  const unavailable = (state.settings.packIds || []).filter(id => !state.packs.some(p => p.id === id));
  state.settings.packIds = [...new Set([...ids, ...unavailable])];
  saveSettings();

  if (!ids.length) {
    state.activePacks = [];
    state.fields = [];
    state.packManifest = null;
    state.currentManifestUrl = null;
    state.selectedFieldId = null;
    computeRows();
    state.cacheStatus = 'unknown';
    state.cacheProgress = t('noPackSelected');
    state.dataUpdateAvailable = false;
    return;
  }

  const byId = new Map();
  const loaded = [];
  let lastError = null;
  for (const id of ids) {
    const pack = state.packs.find(p => p.id === id);
    if (!pack) continue;
    try {
      const manifestUrl = manifestUrlForPack(pack);
      const manifestRes = await fetch(manifestUrl, { cache: cacheMode });
      if (!manifestRes.ok) throw new Error(`Manifest HTTP ${manifestRes.status}`);
      const manifest = await manifestRes.json();
      const fieldsUrl = new URL(manifest.fieldsUrl || 'fields.json', manifestUrl).toString();
      const fieldsRes = await fetch(fieldsUrl, { cache: cacheMode });
      if (!fieldsRes.ok) throw new Error(`Fields HTTP ${fieldsRes.status}`);
      const fields = await fieldsRes.json();
      for (const field of fields) {
        if (!byId.has(field.id)) {
          field._base = manifestUrl;
          field._packId = id;
          byId.set(field.id, field);
        }
      }
      loaded.push({ pack, manifest, manifestUrl });
    } catch (error) {
      console.error(error);
      lastError = error;
    }
  }

  state.activePacks = loaded;
  state.fields = [...byId.values()];
  state.packManifest = loaded[0]?.manifest || null;
  state.currentManifestUrl = loaded[0]?.manifestUrl || null;
  if (state.selectedFieldId && !state.fields.some(field => field.id === state.selectedFieldId)) {
    state.selectedFieldId = null;
  }
  computeRows();
  state.cacheProgress = '';
  if (!loaded.length) {
    state.packManifest = null;
    state.currentManifestUrl = null;
    state.fields = [];
    state.cacheStatus = 'error';
    state.cacheProgress = lastError?.message || 'No packs loaded';
    return;
  }
  updateDataUpdateFlag();
  await checkCacheStatus();
}

async function reloadSelectedPack() {
  state.cacheStatus = 'refreshing';
  state.cacheProgress = t('cpClearing');
  render();

  try {
    let deleted = 0;
    for (const pack of activePacks()) {
      deleted += await clearPackCache(pack.id);
    }
    state.cacheProgress = t('cpCleared', deleted);
    render();

    state.cacheProgress = t('cpFetchIndex');
    render();
    await loadPackIndex({ cacheMode: 'reload' });

    state.cacheProgress = t('cpFetchPack');
    render();
    await loadSelectedPacks({ cacheMode: 'reload' });

    if (state.cacheStatus !== 'error') {
      state.cacheProgress = t('cpFresh', state.cacheProgress || t('cpNotChecked'));
    }
  } catch (error) {
    console.error(error);
    state.cacheStatus = 'error';
    state.cacheProgress = error.message || String(error);
  }
}

function stopGps() {
  if (gpsWatchId !== null && 'geolocation' in navigator) {
    navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId = null;
  }
}

function startGps() {
  stopGps();
  // Simulated position wins and the receiver stays off, so a real fix can never arrive and
  // quietly replace the position under test halfway through a comparison.
  if (state.settings.testMode && Number.isFinite(state.settings.testLatitude)) {
    if (applyTestPosition()) onSimulatedPositionChanged();
    return;
  }
  if (!('geolocation' in navigator)) {
    state.gpsStatus = 'unavailable';
    state.gpsError = 'Geolocation API unavailable';
    return;
  }
  state.gpsStatus = 'requesting';
  gpsWatchId = navigator.geolocation.watchPosition(
    position => {
      const altitude = typeof position.coords.altitude === 'number' && Number.isFinite(position.coords.altitude) ? position.coords.altitude : null;
      state.position = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        altitudeM: altitude,
        accuracyM: position.coords.accuracy,
        altitudeAccuracyM: position.coords.altitudeAccuracy,
        timestamp: position.timestamp,
      };
      state.gpsStatus = 'ok';
      state.gpsError = '';
      computeRows();
      // Fire and forget: the list is already correct with straight-line numbers, and the solve
      // refines it a moment later if the glider has moved far enough to be worth redoing.
      refreshTerrainRoutes().catch(error => console.warn('Terrain routing failed', error));
      if (!state.selectedFieldId) scheduleRender();
    },
    error => {
      state.gpsStatus = 'error';
      state.gpsError = error.message;
      if (!state.selectedFieldId) scheduleRender();
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
  );
}

/** Put the simulated position in place of a GPS fix. Everything downstream reads state.position,
 *  so nothing else has to know the difference — except the warning banner, which must. */
function applyTestPosition() {
  const { testLatitude, testLongitude, testAltitudeM } = state.settings;
  if (!Number.isFinite(testLatitude) || !Number.isFinite(testLongitude)) return false;
  state.position = {
    latitude: testLatitude,
    longitude: testLongitude,
    altitudeM: Number.isFinite(Number(testAltitudeM)) ? Number(testAltitudeM) : null,
    accuracyM: 0,
    altitudeAccuracyM: 0,
    timestamp: Date.now(),
    simulated: true,
  };
  state.gpsStatus = 'simulated';
  state.gpsError = '';
  computeRows();
  return true;
}

function testModeActive() {
  return Boolean(state.settings.testMode && state.position?.simulated);
}

function activeAltitudeM() {
  return state.position?.altitudeM ?? null;
}

function altitudeLabel() {
  const altitude = activeAltitudeM();
  if (altitude === null) return t('altMissing');
  return `${fmtM(altitude)}${testModeActive() ? ` ${t('altSimulated')}` : ''}`;
}

// Distance/bearing/required-glide for one field from the current position. Shared by the
// nearest list (computeRows) and the search results, so both agree.
function metricsForField(field, altitudeM, safetyMarginM) {
  const distanceM = haversineMeters(state.position.latitude, state.position.longitude, field.latitude, field.longitude);
  const bearingDeg = bearingDegrees(state.position.latitude, state.position.longitude, field.latitude, field.longitude);
  const fieldElevationM = Number.isFinite(field.elevationM) ? field.elevationM : null;
  const usableHeightM = altitudeM !== null && fieldElevationM !== null
    ? altitudeM - fieldElevationM - safetyMarginM
    : null;
  const requiredGlideRatio = usableHeightM !== null && usableHeightM > 0 ? distanceM / usableHeightM : null;
  const glideReason = requiredGlideRatio !== null
    ? ''
    : altitudeM === null
      ? t('reasonGpsAlt')
      : fieldElevationM === null
        ? t('reasonFieldElev')
        : t('reasonBelowSafe', Math.abs(Math.round(usableHeightM)));
  return { field, distanceM, bearingDeg, usableHeightM, requiredGlideRatio, glideReason };
}

function computeRows() {
  if (!state.position) {
    state.computedRows = [];
    return;
  }
  const altitudeM = activeAltitudeM();
  const safetyMarginM = Number(state.settings.safetyMarginM) || 0;
  let rows = state.fields.map(field => metricsForField(field, altitudeM, safetyMarginM));
  rows = rows.filter(row => {
    if (!state.settings.showD && row.field.difficulty === 'D') return false;
    if (!state.settings.showC && row.field.difficulty === 'C') return false;
    // An unrated field is not an easy one, it is one nobody has assessed — it could be anything,
    // including worse than a D. So it travels with the difficult grades rather than with A and B:
    // offered only once the pilot has asked to see both C and D, and hidden the moment either is
    // put away. Keyed on the badge the row actually shows, so anything rendering "?" is covered
    // however its source spelled it; altiport and vélisurface keep their own labels and stay.
    if (difficultyLabel(row.field) === '?'
      && !(state.settings.showC && state.settings.showD)) return false;
    return true;
  });
  rows = rows.map(applyTerrainRoute);
  // One order, because there is one question: what can you reach, best first. A "nearest
  // distance" mode used to sit beside this and was retired — sorting by proximity puts a field
  // 2 km away needing a glide of 80 above one 20 km away you can actually make, which is the
  // wrong end of the list to be reading when it matters. Distance still has its own column on
  // every row, so nothing is hidden; it just stops deciding the order.
  //
  // Fields with no answer — no altitude yet, or below the safety margin — sink to the bottom and
  // fall back to distance among themselves, which is what the retired mode degenerated to anyway.
  rows.sort((a, b) => {
    if (a.requiredGlideRatio === null && b.requiredGlideRatio === null) return a.distanceM - b.distanceM;
    if (a.requiredGlideRatio === null) return 1;
    if (b.requiredGlideRatio === null) return -1;
    return a.requiredGlideRatio - b.requiredGlideRatio;
  });
  state.computedRows = rows;
}

// --- simulated position (testing only) ---------------------------------------------------------
//
// Online-only and deliberately uncached: this exists to put the app somewhere it is not, which is
// the one thing that must never survive into a flight by accident. The service worker only
// intercepts its own scope and the pack origin, so these requests pass straight through it.
//
// Photon rather than Nominatim because Nominatim sends no Access-Control-Allow-Origin and is
// therefore unusable from a browser. Both are OpenStreetMap data; Photon is Komoot's.
const GEOCODER_URL = 'https://photon.komoot.io/api/';

// One try per pause in typing was the whole error handling: any single dropped packet became
// "this needs a connection", on the kind of link where email still trickles through because
// mail clients retry and this did not. Three attempts, short backoff, and a timeout per attempt
// so a hung socket cannot pin "Searching…" forever.
const PLACE_SEARCH_ATTEMPT_DELAYS_MS = [0, 1000, 3000];
const PLACE_SEARCH_TIMEOUT_MS = 6000;

async function searchPlaces(query) {
  const url = new URL(GEOCODER_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', '6');
  const language = resolveLang();
  if (['en', 'fr', 'de'].includes(language)) url.searchParams.set('lang', language);
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), PLACE_SEARCH_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, { cache: 'no-store', signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`);
    // A rejected request (4xx short of rate limiting) will not get better by asking again.
    error.permanent = response.status >= 400 && response.status < 500 && response.status !== 429;
    throw error;
  }
  const data = await response.json();
  return (data.features || []).map(feature => {
    const properties = feature.properties || {};
    const [longitude, latitude] = feature.geometry?.coordinates || [];
    const parts = [
      properties.name,
      properties.city && properties.city !== properties.name ? properties.city : '',
      properties.state,
      properties.country,
    ];
    return { latitude, longitude, kind: properties.osm_value || '', label: parts.filter(Boolean).join(', ') };
  }).filter(place => Number.isFinite(place.latitude) && Number.isFinite(place.longitude));
}

// Long enough that a pause reads as "done typing", short enough not to feel like waiting. Below
// three characters there is nothing worth asking about, and it keeps the request count civil.
const PLACE_SEARCH_DEBOUNCE_MS = 300;
const PLACE_SEARCH_MIN_CHARS = 3;
let placeSearchTimer = null;
let placeSearchSeq = 0;

function queuePlaceSearch(query) {
  window.clearTimeout(placeSearchTimer);
  const text = String(query || '').trim();
  state.testQuery = text;
  if (text.length < PLACE_SEARCH_MIN_CHARS) {
    state.testSearch = null;
    updateTestResults();
    return;
  }
  placeSearchTimer = window.setTimeout(() => runPlaceSearch(text), PLACE_SEARCH_DEBOUNCE_MS);
}

async function runPlaceSearch(query) {
  const text = String(query || '').trim();
  if (text.length < PLACE_SEARCH_MIN_CHARS) return;
  // Typing outruns the network, so replies can land out of order. Only the newest one may write.
  const seq = ++placeSearchSeq;
  state.testSearch = { status: 'searching', results: [], error: '' };
  updateTestResults();

  let lastError = null;
  for (const delay of PLACE_SEARCH_ATTEMPT_DELAYS_MS) {
    if (delay) await new Promise(resolve => window.setTimeout(resolve, delay));
    if (seq !== placeSearchSeq) return;   // superseded by newer typing, even mid-backoff
    try {
      const results = await searchPlaces(text);
      if (seq !== placeSearchSeq) return;
      state.testSearch = { status: 'done', results, error: results.length ? '' : t('testNoResults') };
      updateTestResults();
      return;
    } catch (error) {
      lastError = error;
      if (error.permanent) break;
    }
  }
  if (seq !== placeSearchSeq) return;
  console.warn('Place search failed', lastError);
  // Only claim "needs a connection" when the browser agrees there is none; a failure while
  // online is just as likely the search service, and telling a pilot with working email that
  // they are offline reads as a lie. Either way the typed text is kept and retry is one tap.
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  state.testSearch = {
    status: 'done', results: [],
    error: offline ? t('testSearchFailed') : t('testSearchFlaky'),
    retry: true,
  };
  updateTestResults();
}

/** The results markup on its own, so it can be patched in without touching the input. */
function renderTestResults() {
  const search = state.testSearch;
  if (!search) return '';
  if (search.status === 'searching') return `<p class="settings-note">${escapeHtml(t('testSearching'))}</p>`;
  if (search.error) {
    return `<p class="settings-note">${escapeHtml(search.error)}</p>`
      + (search.retry ? `<div class="button-row single"><button id="retryPlaceSearch">${t('testSearchRetryBtn')}</button></div>` : '');
  }
  return search.results.map((place, index) => `
      <button class="test-result" data-test-index="${index}">
        <span class="test-result-name">${escapeHtml(place.label)}</span>
        <span class="test-result-meta">${escapeHtml(place.kind)} · ${place.latitude.toFixed(4)}, ${place.longitude.toFixed(4)}</span>
      </button>`).join('');
}

function updateTestResults() {
  const container = document.querySelector('#testResults');
  if (!container) return;
  container.innerHTML = renderTestResults();
  attachTestResultEvents();
}

function attachTestResultEvents() {
  document.querySelectorAll('.test-result').forEach(button => button.addEventListener('click', () => {
    const place = state.testSearch?.results?.[Number(button.dataset.testIndex)];
    if (place) startTestMode(place);
  }));
  document.querySelector('#retryPlaceSearch')?.addEventListener('click', () => runPlaceSearch(state.testQuery));
}

/** Adopt a searched place as the simulated position. */
function startTestMode(place) {
  state.testSearch = null;
  state.testQuery = '';
  state.settings.testMode = true;
  state.settings.testLatitude = place.latitude;
  state.settings.testLongitude = place.longitude;
  state.settings.testLabel = place.label;
  saveSettings();
  stopGps();
  applyTestPosition();
  onSimulatedPositionChanged();
  refreshTestGround();
  render();
}

// --- ground under the simulated place, for the AGL altitude reference --------------------------

let testGroundToken = 0;

/**
 * Sample the terrain under the chosen place from the downloaded tiles. Async and cancellable
 * (a newer place wins); ends with testGroundM either the ground in metres or null, and null is
 * what greys the AGL option out — a reference above unknown ground would be a made-up number.
 */
async function refreshTestGround() {
  const token = ++testGroundToken;
  const { testLatitude, testLongitude } = state.settings;
  let ground = null;
  if (Number.isFinite(testLatitude) && Number.isFinite(testLongitude)
      && terrainSupported() && 'caches' in window) {
    try {
      // Strictly from tiles already on the phone — the note promises "downloaded terrain", and
      // a greyed-out unit toggle is never worth a network fetch the pilot did not ask for
      // (least of all right after they deleted the tiles).
      const key = tileKeyFor(testLatitude, testLongitude);
      const cache = await caches.open(DATA_CACHE);
      const cachedTile = await cache.match(terrainTileUrls([key])[0], { ignoreSearch: true });
      if (cachedTile) {
        const store = terrainStore();
        const tiles = await store.loadBounds({
          south: testLatitude, north: testLatitude, west: testLongitude, east: testLongitude,
        });
        const tile = tiles.get(key);
        if (tile) {
          const row = Math.min(tile.samples - 1, Math.floor((tile.lat0 + 1 - testLatitude) * tile.samples));
          const col = Math.min(tile.samples - 1, Math.floor((testLongitude - tile.lon0) * tile.samples));
          const sample = tile.elevations[row * tile.samples + col];
          if (sample !== TERRAIN_NODATA) ground = sample;
        }
      }
    } catch { /* unreadable cache or tile: AGL stays unavailable */ }
  }
  if (token !== testGroundToken) return;
  state.testGroundM = ground;
  if (ground === null && state.settings.testAltitudeMode === 'agl') {
    // The reference just lost its ground (place moved off the covered area): fall back to sea
    // level rather than keep showing an AGL number that no longer means anything.
    state.settings.testAltitudeMode = 'amsl';
    saveSettings();
  }
  if (ground !== null && state.settings.testAltitudeMode === 'agl') applyTestAgl();
  // A new place can have its ground above the altitude carried over from the last one. Lift the
  // altitude to meet it rather than leave the handle pinned below the start of its own track,
  // where the slider would show one number and the solver would use another.
  if (state.settings.testAltitudeMode !== 'agl' && ground !== null
      && Number(state.settings.testAltitudeM) < testAltitudeFloorM()) {
    state.settings.testAltitudeM = testAltitudeFloorM();
    saveSettings();
    if (state.settings.testMode && Number.isFinite(state.settings.testLatitude)) {
      applyTestPosition();
      onSimulatedPositionChanged();
    }
  }
  render();
}

// The AMSL slider's granularity. The floor is rounded to it, so the two cannot drift apart and
// leave a track whose values are all offset by the odd metres of some hillside.
const TEST_AMSL_STEP_M = 100;

/**
 * Lowest altitude the AMSL slider may offer: the ground at the chosen place, rounded UP to the
 * slider's step.
 *
 * Underground is not a position a glide can be computed from — every field would come back
 * unreachable and the reason would be invisible. AGL has no equivalent problem: its zero IS the
 * ground, and a negative AGL is not reachable on a slider that starts at zero.
 *
 * Rounded up rather than exact because a range input steps from its own minimum: an exact floor
 * of 2010 m makes every reachable value 2010, 2110, 2210, and asking for 3000 is then simply
 * impossible. Rounding up keeps the round numbers a pilot actually thinks in, costs at most 99 m
 * at the very bottom of the track, and errs upward — the safe direction, since the point is to
 * stay out of the ground rather than to hug it.
 *
 * Sea level when the ground is unknown, which is the only honest floor available then.
 */
function testAltitudeFloorM() {
  const ground = state.testGroundM;
  if (!Number.isFinite(ground)) return 0;
  return Math.ceil(ground / TEST_AMSL_STEP_M) * TEST_AMSL_STEP_M;
}

/** In AGL mode the stored absolute altitude follows ground + AGL, so downstream needs no mode. */
function applyTestAgl() {
  if (!Number.isFinite(state.testGroundM)) return;
  state.settings.testAltitudeM = state.testGroundM + (Number(state.settings.testAglM) || 0);
  saveSettings();
  if (state.settings.testMode && Number.isFinite(state.settings.testLatitude)) {
    applyTestPosition();
    onSimulatedPositionChanged();
  }
}

function stopTestMode() {
  state.settings.testMode = false;
  saveSettings();
  state.position = null;
  state.gpsStatus = 'idle';
  state.testSearch = null;
  onSimulatedPositionChanged();
  startGps();
  render();
}

// A simulated move is instant and arbitrary, so none of refreshTerrainRoutes' "has the glider
// moved far enough" throttling applies: the last solve is discarded outright and a new one forced.
function onSimulatedPositionChanged() {
  invalidateTerrainRoutes();
  refreshTerrainRoutes().catch(error => console.warn('Terrain routing failed', error));
}
// --- terrain-routed glide ----------------------------------------------------------------------
//
// The straight-line numbers above are computed first and always; routing then replaces them for
// the fields it has an answer for. That ordering is deliberate — the list is useful the instant
// there is a GPS fix, and a slow or missing terrain solve can only ever improve it, never delay it.

let glideWorker = null;
let glideRequestId = 0;
let lastTerrainSolve = null;

function terrainClearanceM() {
  const value = Number(state.settings.terrainClearanceM);
  if (!Number.isFinite(value)) return DEFAULT_SETTINGS.terrainClearanceM;
  return Math.min(TERRAIN_CLEARANCE_MAX_M, Math.max(TERRAIN_CLEARANCE_MIN_M, value));
}

function terrainStore() {
  const terrain = state.terrain;
  // dataBase settles only after loadPackIndex has proved which origin serves the packs, and it
  // can differ between deployments, so the store is rebuilt if it moves.
  if (!terrain.store || String(terrain.store.baseUrl) !== String(dataBase)) {
    terrain.store = new TerrainStore({ baseUrl: dataBase, cacheName: DATA_CACHE });
  }
  return terrain.store;
}

// A routed path is only worth mentioning when it actually goes somewhere else. Below this it is
// the straight line with grid noise on it, and a chip would be decoration.
const ROUTE_DETOUR_RATIO = 1.1;

function routeIsDetour(row) {
  const route = row?.route;
  if (!route || route.direct || !Number.isFinite(route.pathLengthM)) return false;
  return route.pathLengthM > (row.distanceM || 0) * ROUTE_DETOUR_RATIO;
}

/**
 * What to call the place a routed glide is pinched at — a named col, or nothing.
 *
 * There used to be a fallback to the compass point the route heads for, and it was the wrong
 * shape of answer: "west of track" reads as an instruction to fly west, and this app does not
 * navigate. It reports what a glide costs; the pilot flies it on whatever they navigate with.
 * A named col escapes that because it is a place a pilot already knows, not a heading. With no
 * name the chip says only that the glide goes around terrain, which is the whole of what the app
 * is entitled to claim.
 */
function routeVia(row) {
  return row?.route?.critical?.colName || '';
}

/** Replace a row's straight-line glide with the routed one, or say why there isn't one. */
function applyTerrainRoute(row) {
  const terrain = state.terrain;
  const route = terrain.routes.get(row.field.id);
  if (route) {
    row.directGlideRatio = row.requiredGlideRatio;
    row.requiredGlideRatio = route.requiredGlideRatio;
    row.route = route;
    row.terrainState = route.direct ? 'direct' : 'routed';
    row.glideReason = '';
    return row;
  }
  // No route came back. That only means "unreachable" when the solve actually looked at this
  // field and had the ground data to judge it; otherwise the straight-line number stands, marked
  // as what it is.
  if (terrain.status === 'ready' && terrain.trusted
      && terrain.solvedIds.has(row.field.id) && row.requiredGlideRatio !== null) {
    row.directGlideRatio = row.requiredGlideRatio;
    row.requiredGlideRatio = null;
    row.terrainState = 'blocked';
    row.glideReason = t('reasonTerrainBlocked');
    return row;
  }
  row.terrainState = terrain.status === 'ready' ? 'unchecked' : 'pending';
  return row;
}

/**
 * Which tiles a pilot flying this pack should carry. The bounding box of the loaded fields is
 * the honest answer: a route runs between fields, so the ground under them is the ground it
 * crosses. Anything beyond that is fetched on demand while there is still a radio.
 */
function terrainDownloadTargets() {
  const index = state.terrain.store?.index;
  if (!index || !index.tiles?.length || !state.fields.length) return { keys: [], bytes: 0 };

  let south = Infinity, north = -Infinity, west = Infinity, east = -Infinity;
  for (const field of state.fields) {
    if (!Number.isFinite(field.latitude) || !Number.isFinite(field.longitude)) continue;
    south = Math.min(south, field.latitude); north = Math.max(north, field.latitude);
    west = Math.min(west, field.longitude); east = Math.max(east, field.longitude);
  }
  if (!Number.isFinite(south)) return { keys: [], bytes: 0 };

  const published = new Map(index.tiles.map(entry => [entry.key, entry.bytes]));
  const keys = tileKeysForBounds({ south, west, north, east }).filter(key => published.has(key));
  return { keys, bytes: keys.reduce((total, key) => total + (published.get(key) || 0), 0) };
}

// Versioned addresses (…?v=<hash>), so a rebuilt tile is a cache miss everywhere at once —
// see TerrainStore.tileUrl. Everything that fetches, counts or sweeps tiles goes through this,
// which is what keeps the download, the status line and the solver telling one story.
function terrainTileUrls(keys) {
  const store = terrainStore();
  return keys.map(key => store.tileUrl(key));
}

async function checkTerrainCacheStatus() {
  const terrain = state.terrain;
  if (!('caches' in window)) { terrain.cacheStatus = 'unknown'; return; }
  const { keys } = terrainDownloadTargets();
  if (!keys.length) { terrain.cacheStatus = 'unknown'; terrain.cacheProgress = ''; return; }
  const cache = await caches.open(DATA_CACHE);
  await reconcileTerrainCache(cache);
  const requests = await cache.keys();
  const cached = new Set(requests.map(request => request.url));
  const have = terrainTileUrls(keys).filter(url => cached.has(url)).length;
  terrain.cacheStatus = have === keys.length ? 'ready' : have > 0 ? 'incomplete' : 'not downloaded';
  terrain.cacheProgress = t('terrainCachedCount', have, keys.length);
  // Whether ANY tile bytes sit in the cache — current, superseded or legacy — which is the
  // question "is there something to remove" actually asks. `have` cannot answer it: a pilot
  // whose tiles predate a rebuild has 0 current tiles and 70 MB on the phone.
  terrain.cacheAnyTiles = requests.some(request => new URL(request.url).pathname.endsWith('.terr'));
}

/**
 * Bring every cached tile in line with the index, without spending a byte of network.
 *
 * Two moves, each per tile key. ADOPT: an entry from before URLs carried a version sits under
 * the bare key; when its bytes hash to exactly what the index says the tile is today, it IS the
 * current tile in everything but its address, so it moves there and the old entry goes — one
 * hash each, once, and never a re-download of megabytes the pilot already paid for. SWEEP: an
 * entry whose replacement is genuinely in the cache is dead weight and goes — and not a moment
 * before, because until the replacement is really there, the old bytes are what fetchTile falls
 * back to when there is no radio. Stale bytes with no replacement therefore stay, counted as
 * out of date by the status line and replaced over the wire by the next download or solve.
 */
async function reconcileTerrainCache(cache) {
  const store = terrainStore();
  if (!store.index) return;
  const published = new Map((store.index.tiles || []).map(entry => [entry.key, entry.sha256]));
  for (const request of await cache.keys()) {
    const url = new URL(request.url);
    if (!url.pathname.endsWith('.terr')) continue;
    const key = url.pathname.split('/').pop().replace(/\.terr$/, '');
    const sha = published.get(key);
    if (!sha) continue;                                  // not this index's tile: leave it be
    const currentUrl = store.tileUrl(key);
    if (request.url === currentUrl) continue;            // already the current entry
    if (await cache.match(currentUrl)) { await cache.delete(request); continue; }
    if (url.search || !crypto?.subtle) continue;         // superseded version: keep as fallback
    try {
      const legacy = await cache.match(request);
      const bytes = await legacy.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
      if (hex === sha) {
        await cache.put(currentUrl, new Response(bytes, {
          headers: { 'content-type': 'application/octet-stream' },
        }));
        await cache.delete(request);
      }
    } catch { /* hashing is an optimisation; the download path still replaces the tile */ }
  }
}

/**
 * Load the tile index and cache count the settings page needs, then re-render — but only when
 * the answer actually changed. This runs from attachEvents, so an unconditional render() here
 * would re-enter itself forever.
 */
let terrainStatusPending = false;
let terrainStatusSignature = '';
let terrainStatusRetry = null;
async function refreshTerrainStatus() {
  if (terrainStatusPending || !terrainSupported()) return;
  terrainStatusPending = true;
  clearTimeout(terrainStatusRetry);
  terrainStatusRetry = null;
  try {
    // Asked every time, not only when the answer is still unknown: a "no" here greys out the
    // switch and the download button, so latching it would leave a pilot who lost the network for
    // a moment with no way back short of restarting. loadIndex caches the yes and rate-limits the
    // retry, which makes the repeated call free in the case that matters.
    const wasAvailable = state.terrain.available;
    state.terrain.available = Boolean(await terrainStore().loadIndex());
    await checkTerrainCacheStatus();
    const terrain = state.terrain;
    // With no download button, opening Settings IS the retry: a sync that lost tiles to a
    // dropped connection runs again the next time the pilot comes looking at the state.
    // Once per visit — this function runs on every settings render, and a failing sync
    // re-renders, so an ungated retry here is a render loop.
    if (!terrainSyncRetriedThisVisit && terrain.available
        && (terrain.cacheStatus === 'incomplete' || terrain.cacheStatus === 'not downloaded')) {
      terrainSyncRetriedThisVisit = true;
      autoSyncTerrainTiles().catch(() => {});
    }
    const signature = `${terrain.available}|${terrain.cacheStatus}|${terrain.cacheProgress}`;
    if (signature !== terrainStatusSignature) {
      terrainStatusSignature = signature;
      render();
    }
    // Terrain that was missing and is now there is a solve waiting to happen: the last one gave
    // up, and nothing else will ask again until the glider has moved far enough to count.
    if (terrain.available && wasAvailable === false && state.settings.terrainRouting) {
      invalidateTerrainRoutes();
      refreshTerrainRoutes().catch(error => console.warn('Terrain routing failed', error));
    }
    // An unreachable index greys out the switch and the download button. Keep asking for as long
    // as the pilot is sitting in front of those dead controls, so the moment the signal comes back
    // they light up on their own rather than only after a restart. Settings is one page with two
    // requests on it; this stops the instant they navigate away.
    if (!terrain.available && state.view === 'settings') {
      terrainStatusRetry = setTimeout(() => {
        if (state.view === 'settings') refreshTerrainStatus();
      }, TERRAIN_STATUS_RETRY_MS);
    }
  } catch (error) {
    console.warn('Terrain status failed', error);
  } finally {
    terrainStatusPending = false;
  }
}

// Terrain ships by default. Nobody downloads or removes it: tiles for the selected packs
// fetch themselves on open, and again whenever the published index moves (the service
// worker's terrain-changed report) or the pilot turns routing on. Settings keeps showing
// the size and the offline state — the information survives, only the chores went away.
// One sync at a time: a second request while one runs is the boot and a notification
// racing, not new work.
let terrainSyncInFlight = false;
let terrainSyncRetriedThisVisit = false;  // reset each time Settings opens
async function autoSyncTerrainTiles() {
  if (terrainSyncInFlight) return;
  if (!state.settings.terrainRouting || !terrainSupported()) return;
  if (!('caches' in window) || navigator.onLine === false) return;
  terrainSyncInFlight = true;
  try {
    await terrainStore().loadIndex();  // cheap when already loaded; targets need the index
    await syncTerrainTiles();
  } finally {
    terrainSyncInFlight = false;
  }
}

async function syncTerrainTiles() {
  const { keys } = terrainDownloadTargets();
  if (!keys.length || !('caches' in window)) return;
  const urls = terrainTileUrls(keys);
  const cache = await caches.open(DATA_CACHE);
  // Cheap when checkTerrainCacheStatus already ran it, and not guaranteed to have run: a tile
  // that can be adopted from the old cache must never be paid for over the radio.
  await reconcileTerrainCache(cache);
  const cached = new Set((await cache.keys()).map(request => request.url));
  const toFetch = urls.filter(url => !cached.has(url));

  state.terrain.cacheStatus = 'downloading';
  let failed = 0;
  if (toFetch.length) {
    state.offlineSync = { done: 0, total: toFetch.length, failed: 0 };
    render();
    for (let i = 0; i < toFetch.length; i += 1) {
      try {
        const response = await fetch(toFetch[i]);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        await cache.put(toFetch[i], response.clone());
      } catch (error) {
        console.warn('Terrain tile download failed', toFetch[i], error);
        failed += 1;
      }
      state.offlineSync = { done: i + 1, total: toFetch.length, failed };
      updateOfflineBar();
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  state.offlineSync = null;
  // checkTerrainCacheStatus reconciles on the way through, which is also what sweeps the
  // predecessors of every tile this download just replaced.
  await checkTerrainCacheStatus();
  // Newly downloaded ground can change every answer, so throw away the last solve — and the store
  // has to forget what it could not reach before, or it will answer from that instead of from the
  // tiles now sitting in the cache. Decoded tiles held in memory go too: they were decoded from
  // the superseded bytes, and fetchTile answers from memory first.
  state.terrain.store?.retryFailures();
  state.terrain.store?.dropDecodedTiles();
  state.terrain.available = null;
  invalidateTerrainRoutes();
  // The ground under a simulated place may just have become known — the AGL reference follows.
  if (state.settings.testMode) refreshTestGround();
  render();
  refreshTerrainRoutes().catch(error => console.warn('Terrain routing failed', error));
}

/** Forget the last solve so the next refresh runs even if the glider has not moved. */
function invalidateTerrainRoutes() {
  lastTerrainSolve = null;
  state.terrain.routes = new Map();
  state.terrain.solvedIds = new Set();
  if (state.terrain.status !== 'unavailable') state.terrain.status = 'idle';
  computeRows();
}

function terrainInputsChanged(altitudeM) {
  const last = lastTerrainSolve;
  if (!last) return true;
  if (last.clearanceM !== terrainClearanceM()) return true;
  if (last.safetyMarginM !== (Number(state.settings.safetyMarginM) || 0)) return true;
  if (last.fieldCount !== state.fields.length) return true;
  if (Math.abs(last.altitudeM - altitudeM) >= TERRAIN_RESOLVE_ALTITUDE_M) return true;
  return haversineMeters(last.latitude, last.longitude, state.position.latitude, state.position.longitude)
    >= TERRAIN_RESOLVE_DISTANCE_M;
}

function ensureGlideWorker() {
  if (glideWorker) return glideWorker;
  try {
    glideWorker = new Worker(new URL('glide-worker.js', import.meta.url));
    glideWorker.onmessage = onGlideResult;
    glideWorker.onerror = error => {
      console.warn('Glide worker failed', error);
      // Drop it rather than retry in a loop: without routing the app is exactly what it was
      // before this feature, which is a working app.
      glideWorker?.terminate();
      glideWorker = null;
      state.terrain.status = 'error';
      state.terrain.error = error.message || 'worker error';
      state.terrain.routes = new Map();
      computeRows();
      scheduleRender();
    };
  } catch (error) {
    console.warn('Workers unavailable', error);
    state.terrain.status = 'unavailable';
    glideWorker = null;
  }
  return glideWorker;
}

function onGlideResult(event) {
  const message = event.data;
  const terrain = state.terrain;
  // A solve that finished after a newer one started is stale: the glider has moved on.
  if (!message || message.id !== glideRequestId) return;

  if (message.type === 'error') {
    terrain.status = 'error';
    terrain.error = message.message;
    terrain.routes = new Map();
  } else if (message.type === 'solved') {
    terrain.routes = new Map(Object.entries(message.results));
    terrain.status = 'ready';
    terrain.error = '';
    nameRouteCols();
  }
  computeRows();
  scheduleRender();
}

/** Match each route's pinch point to a named col, if the deployment ships them. */
function nameRouteCols() {
  const store = state.terrain.store;
  if (!store?.cols) return;
  for (const route of state.terrain.routes.values()) {
    if (!route.critical) continue;
    const col = store.nearestCol(route.critical.latitude, route.critical.longitude);
    // Only the name is taken. OpenStreetMap also carries the col's surveyed height, and it reads
    // more authoritative — but it is not the ground this glide was measured against. A max-pooled
    // cell near a saddle catches the shoulder, so it sits ~100 m above the surveyed notch, and
    // quoting the surveyed figure beside a margin computed from the shoulder gives a route block
    // whose own numbers disagree and whose height is optimistic by the difference.
    if (col) route.critical.colName = col.name;
  }
}

/**
 * Route every nearby field, if terrain is available and the picture has changed enough to be
 * worth the arithmetic. Never throws and never blocks a render: on any failure the straight-line
 * numbers simply stay.
 */
async function refreshTerrainRoutes() {
  const terrain = state.terrain;

  if (!state.settings.terrainRouting) {
    if (terrain.routes.size) { terrain.routes = new Map(); computeRows(); }
    terrain.status = 'idle';
    return;
  }
  if (!terrainSupported()) {
    terrain.status = 'unavailable';
    terrain.available = false;
    return;
  }
  if (!state.position || !state.fields.length || terrain.status === 'solving') return;
  const altitudeM = activeAltitudeM();
  if (altitudeM === null || !terrainInputsChanged(altitudeM)) return;

  const store = terrainStore();
  terrain.available = Boolean(await store.loadIndex());
  if (!terrain.available) {
    terrain.status = 'unavailable';
    scheduleRender();
    return;
  }

  // Unconditional, not hung off "is this the first solve": the col names once lived behind a
  // first-look guard, and because opening Settings had already taken that first look, the names
  // never loaded on the path where a pilot switches terrain on by hand — which is every first
  // use. loadCols returns immediately once it has an answer, so asking each time costs nothing.
  //
  // Awaited rather than raced: it is a couple of hundred kilobytes against megabytes of tiles,
  // and racing it meant the first routes came out labelled "S of track" and silently corrected
  // themselves a second later, which reads as a glitch even though both answers were true.
  await store.loadCols().catch(() => null);

  const clearanceM = terrainClearanceM();
  const safetyMarginM = Number(state.settings.safetyMarginM) || 0;
  // Solve the fields the list puts first, which means taking computedRows in its own order —
  // by required glide, with the fields that have no answer already sunk to the bottom.
  //
  // It used to take the nearest by distance, and the two orders are not the same list. The
  // solver covers TERRAIN_MAX_TARGETS fields while the list shows more, so choosing by distance
  // scattered the routed ones through a list ordered by glide: a checked row and an unchecked
  // one sat next to each other looking identical, and the unchecked one shows the straight-line
  // glide, which is the optimistic of the two. Following the list's own order puts every routed
  // field at the top and leaves the unchecked ones at the bottom, where they are least likely to
  // be the field anyone picks.
  const candidates = state.computedRows
    .filter(row => Number.isFinite(row.field.elevationM))
    .slice(0, TERRAIN_MAX_TARGETS);
  if (!candidates.length) return;

  // Wide enough that a route can go the long way round: half again the distance to the farthest
  // field worth answering, floored so a solve is never trivially small and capped so a phone is
  // never asked to flood half of Europe.
  //
  // The MAXIMUM, not the last one: that shortcut held only while these were sorted by distance,
  // and reading it off a glide-ordered list would size the search area from whichever field
  // happened to land 80th.
  const farthestM = candidates.reduce((far, row) => Math.max(far, row.distanceM || 0), 0);
  const radiusM = Math.min(90000, Math.max(15000, farthestM * 1.5));

  terrain.status = 'solving';
  lastTerrainSolve = {
    latitude: state.position.latitude,
    longitude: state.position.longitude,
    altitudeM, clearanceM, safetyMarginM,
    fieldCount: state.fields.length,
  };

  let grid = null;
  try {
    grid = await store.routingGrid({
      latitude: state.position.latitude,
      longitude: state.position.longitude,
      radiusM,
    });
  } catch (error) {
    console.warn('Terrain grid failed', error);
  }
  if (!grid) {
    terrain.status = 'unavailable';
    terrain.routes = new Map();
    computeRows();
    scheduleRender();
    return;
  }

  const worker = ensureGlideWorker();
  if (!worker) {
    terrain.routes = new Map();
    computeRows();
    scheduleRender();
    return;
  }

  terrain.coverage = grid.coverage;
  terrain.trusted = grid.coverage >= TERRAIN_TRUST_COVERAGE;
  terrain.solvedIds = new Set(candidates.map(row => row.field.id));
  glideRequestId += 1;

  const payload = { ...grid, elevations: grid.elevations.buffer };
  worker.postMessage({
    type: 'solve',
    id: glideRequestId,
    grid: payload,
    latitude: state.position.latitude,
    longitude: state.position.longitude,
    altitudeM,
    clearanceM,
    safetyMarginM,
    targets: candidates.map(row => ({
      id: row.field.id,
      latitude: row.field.latitude,
      longitude: row.field.longitude,
      elevationM: row.field.elevationM,
    })),
  }, [payload.elevations]);
}

function scheduleRender() {
  if (renderTimer !== null) return;
  renderTimer = window.setTimeout(() => {
    renderTimer = null;
    // A GPS tick must not rebuild an open form — a full render would wipe everything the
    // pilot typed into the contribute/new-field/bug dialog and orphan its Turnstile widget.
    // Refresh the status strip in place and leave the rest for the next real render.
    if (state.contribFor || state.showNewField || state.showBugReport) {
      updateStatusStrip();
      return;
    }
    // Same idea mid-typing in the search box — replacing the focused input makes the phone
    // keyboard flicker. Refresh the status strip and result list in place instead.
    const search = document.querySelector('#fieldSearch');
    if (search && document.activeElement === search) {
      updateStatusStrip();
      updateSearchResults();
      return;
    }
    // Likewise the place search in Settings. This one bites harder: the thing most likely to
    // schedule a render while it is being typed into is a terrain solve finishing, which is
    // precisely what the pilot is in the middle of setting up.
    const place = document.querySelector('#testPlace');
    if (place && document.activeElement === place) {
      updateStatusStrip();
      return;
    }
    render();
  }, 1000);
}

// Lets a test fire the render path that used to eat the search box. Harmless in production:
// scheduleRender is what a GPS tick or a finished terrain solve already calls.
self.__mtcScheduleRenderProbe = scheduleRender;
self.__mtcState = state;   // read-only diagnostics hook for the browser tests
// The waypoint file is the one output that leaves for another device, so a test needs to read it
// without driving a download. Pure function of state; calling it changes nothing. Defaults to
// every loaded field so a caller that only wants to inspect the CUP rows need not group by pack.
self.__mtcGenerateCupProbe = fields => generateCupText(fields || state.fields);

function updateStatusStrip() {
  const el = document.querySelector('#statusArea');
  if (el) el.innerHTML = renderStatus();
}

// Percent of the current phase. Weighted by bytes when the phase carries sizes (the media
// download: files span two orders of magnitude, and a count-based bar crawls through
// thumbnails then freezes on a chart PDF then leaps); by item count otherwise (the checking
// phase and terrain tiles, where items cost roughly the same).
function offlineBarPct(s) {
  if (s.totalWeight) return Math.round((s.doneWeight / s.totalWeight) * 100);
  return s.total ? Math.round((s.done / s.total) * 100) : 0;
}

function renderOfflineBar() {
  const s = state.offlineSync;
  if (!s) return '';
  const pct = offlineBarPct(s);
  const failed = s.failed ? ` · ${s.failed} ${t('dlFailed')}` : '';
  // The checking phase (see downloadOfflinePack) counts cache lookups, not downloads: with
  // every pack selected there are a few thousand of them, and until this bar existed they
  // were seconds of nothing happening after the tap.
  const label = s.checking ? t('dlChecking') : t('dlSaving');
  return `
    <div class="offline-bar" role="status" aria-live="polite">
      <div class="offline-bar-track"><div class="offline-bar-fill" id="offlineBarFill" style="width:${pct}%"></div></div>
      <div class="offline-bar-label" id="offlineBarLabel">${escapeHtml(label)} · ${pct}%${failed}</div>
    </div>`;
}

// Update the floating download bar in place (no full re-render), so the field list, search box
// and keyboard stay put while media downloads in the background.
function updateOfflineBar() {
  const s = state.offlineSync;
  if (!s) return;
  const pct = offlineBarPct(s);
  const fill = document.querySelector('#offlineBarFill');
  const label = document.querySelector('#offlineBarLabel');
  if (fill) fill.style.width = pct + '%';
  if (label) label.textContent = `${s.checking ? t('dlChecking') : t('dlSaving')} · ${pct}%${s.failed ? ` · ${s.failed} ${t('dlFailed')}` : ''}`;
}

function render() {
  const scrollY = window.scrollY;
  const activeDetail = document.querySelector('.detail');
  if (activeDetail) state.detailScrollTop = activeDetail.scrollTop;
  // Preserve search focus + caret: render() replaces innerHTML on every keystroke.
  const searchEl = document.querySelector('#fieldSearch');
  const searchWasFocused = !!searchEl && document.activeElement === searchEl;
  const searchCaret = searchEl ? searchEl.selectionStart : null;
  document.documentElement.lang = resolveLang();
  computeRows();
  const selected = state.fields.find(f => f.id === state.selectedFieldId);
  app.innerHTML = `
    <div class="app-shell">
      <header class="header compact-header">
        <div class="title-row">
          <button id="settingsToggle" class="icon-button" title="${t('settings')}" aria-label="${t('settings')}">⚙</button>
          <h1>🐄 Meet the Cows</h1>
          <button id="sharePack" class="icon-button" title="${t('share')}" aria-label="${t('share')}">${SHARE_ICON}</button>
        </div>
        <div id="statusArea">${renderStatus()}</div>
      </header>
      ${renderTestBanner()}
      <main class="main">
        ${state.view === 'settings' ? renderSettingsPage() : renderMainPage()}
      </main>
      ${selected ? renderDetail(selected) : ''}
      ${state.contribFor ? renderContribute(state.fields.find(f => f.id === state.contribFor)) : ''}
      ${renderNewField()}
      ${state.showReleaseNotes ? renderReleaseNotes() : ''}
      ${renderMigrationSheet()}
      ${renderBugReport()}
      ${renderOfflineBar()}
    </div>
  `;
  // Lock background scroll while an overlay is open, so scrolling a short bottom-sheet doesn't
  // fall through to the list behind it.
  document.body.classList.toggle('modal-open', !!(selected || state.contribFor || state.showNewField || state.showReleaseNotes || state.showBugReport || state.showMigrationSheet));
  attachEvents();
  requestAnimationFrame(() => {
    const detail = document.querySelector('.detail');
    if (detail) {
      detail.scrollTop = state.detailScrollTop || 0;
    } else if (state.view === 'main') {
      if (searchWasFocused) {
        const s = document.querySelector('#fieldSearch');
        if (s) {
          s.focus();
          const caret = searchCaret == null ? s.value.length : searchCaret;
          try { s.setSelectionRange(caret, caret); } catch { /* ignore */ }
        }
      }
      window.scrollTo({ top: scrollY, behavior: 'instant' });
    }
  });
}

function renderStatus() {
  // Deliberately minimal: a green/red dot instead of live accuracy/fix-age text. The old
  // per-second readouts forced constant re-renders that twice broke open forms and the
  // search keyboard; the detail (accuracy, error) lives in the dot's tooltip/aria-label.
  const ok = state.gpsStatus === 'ok';
  const label = escapeHtml(gpsLabel());
  return `
    <div class="gps-strip">
      <span title="${label}"><strong>GPS</strong> <span class="gps-dot ${ok ? 'ok' : 'bad'}" role="img" aria-label="${label}"></span></span>
      <span><strong>Alt</strong> ${altitudeLabel()}</span>
      <span><strong>${t('fieldsLoaded')}</strong> ${state.fields.length}</span>
    </div>
  `;
}

function gpsLabel() {
  if (state.gpsStatus === 'ok') return t('gpsOk', Math.round(state.position?.accuracyM || 0));
  if (state.gpsStatus === 'error') return t('gpsErr');
  const map = { idle: 'gpsIdle', requesting: 'gpsRequesting', unavailable: 'gpsUnavailable', simulated: 'gpsSimulated' };
  return map[state.gpsStatus] ? t(map[state.gpsStatus]) : state.gpsStatus;
}

// Shown above everything, in red, whenever the position on screen is invented. A cockpit aid
// quietly reporting fields near a place you are not is the worst thing this app could do.
function renderTestBanner() {
  if (!testModeActive()) return '';
  const where = state.settings.testLabel || `${state.settings.testLatitude.toFixed(3)}, ${state.settings.testLongitude.toFixed(3)}`;
  const agl = state.settings.testAltitudeMode === 'agl' && Number.isFinite(state.testGroundM);
  const altitudeText = fmtM(state.position.altitudeM ?? 0)
    + (agl ? ` (${fmtM(Number(state.settings.testAglM) || 0)} AGL)` : '');
  return `<div class="test-banner">
      <span>${escapeHtml(t('testBanner', where, altitudeText))}</span>
      <button id="testBannerStop">${t('testStop')}</button>
    </div>`;
}

function renderWarnings() {
  const items = [];
  if (state.packManifest?.isSample) items.push(escapeHtml(t('sampleWarning')));
  if (state.gpsStatus === 'error') items.push(escapeHtml(t('gpsError', state.gpsError)));
  if (state.position && state.position.altitudeM === null && !testModeActive()) items.push(escapeHtml(t('altMissingWarning')));
  if (!items.length) return '';
  return items.map(i => `<div class="warning">${i}</div>`).join('');
}

function renderMainPage() {
  return `
    ${renderSearchBox()}
    ${renderMigrationBanner()}
    ${renderReloadBanner()}
    ${renderReleaseBanner()}
    ${renderUpdateBanner()}
    ${renderWarnings()}
    <div id="fieldListArea">${renderFieldList()}</div>
    <p class="footer-note">${escapeHtml(t(terrainRoutingLive() ? 'footerNoteTerrain' : 'footerNote'))}</p>
  `;
}

/** True when the glide numbers on screen are actually coming from routed paths. */
function terrainRoutingLive() {
  return state.settings.terrainRouting && state.terrain.routes.size > 0;
}

// Shown only on a retired deployment (see MIGRATION). Amber rather than the teal used by the
// update banners, so it reads as "something different", without the red that means danger.
// Never blocks the app: a pilot at the airfield must always reach their fields.
function migrationSnoozed() {
  try {
    return Number(localStorage.getItem(MIGRATION_SNOOZE_KEY) || 0) > Date.now();
  } catch {
    return false;  // private mode / storage disabled: show the notice rather than hide it
  }
}

/**
 * The permanent way back to the move instructions, in Settings.
 *
 * Dismissing the banner used to close the only door to them: a pilot who reads "the app has
 * moved", thinks "not now", and comes back an hour later ready to do it found nothing at all,
 * and had to wait for the reminder to come round again. A move is exactly the kind of thing
 * people choose their own moment for, so the instructions have to keep still.
 *
 * Only exists on a retired deployment — MIGRATION is null on the canonical origin, on a labelled
 * channel and on localhost, and this renders nothing there.
 */
function renderMigrationCard() {
  if (!MIGRATION) return '';
  return `
      <div class="settings-card">
        <h3>${escapeHtml(t('migTitle'))}</h3>
        <p class="settings-note">${escapeHtml(t('migIntro'))}</p>
        <div class="button-row single">
          <button class="primary" id="migrationSettingsBtn">${escapeHtml(t('migSettingsAction'))}</button>
        </div>
      </div>`;
}

function renderMigrationBanner() {
  if (!MIGRATION || migrationSnoozed()) return '';
  return `
    <div class="migration-banner">
      <span>${escapeHtml(t('migBanner'))}</span>
      <button id="migrationBannerBtn">${escapeHtml(t('migDetails'))}</button>
    </div>
  `;
}

/**
 * The terms of switching terrain routing on, shown every time it is switched on.
 *
 * Not a one-off dismissal stored on the device: this feature changes which fields the app calls
 * reachable, and the moment a pilot chooses to trust it is the moment worth interrupting. Turning
 * it off is never gated — only turning it on.
 */
function renderMigrationSheet() {
  if (!MIGRATION || !state.showMigrationSheet) return '';
  const step = (n, title, note) => `
    <div class="mig-step"><span class="mig-step-n">${n}</span>
      <span><strong>${escapeHtml(title)}</strong> <span class="mig-step-note">— ${escapeHtml(note)}</span></span>
    </div>`;
  const why = MIGRATION.site
    ? `<a class="mig-why" href="${escapeHtml(MIGRATION.site)}" target="_blank" rel="noopener">${escapeHtml(t('migWhy'))}</a>`
    : '';
  return `
    <div class="detail-backdrop" id="migrationBackdrop">
      <article class="detail" role="dialog" aria-modal="true" aria-label="${escapeHtml(t('migTitle'))}">
        <button id="closeMigration">${t('close')}</button>
        <div class="detail-title-row"><h2>${escapeHtml(t('migTitle'))}</h2></div>
        <p class="detail-meta">${escapeHtml(t('migIntro'))}</p>
        <div class="mig-url">🐄 ${escapeHtml(MIGRATION.host)}</div>
        <div class="mig-steps">
          ${step(1, t('migStep1'), t('migStep1Note'))}
          ${step(2, t('migStep2'), t('migStep2Note'))}
          ${step(3, t('migStep3'), t('migStep3Note'))}
          ${step(4, t('migStep4'), t('migStep4Note'))}
        </div>
        <div class="mig-warn">⚠️ <span><strong>${escapeHtml(t('migWarnLead'))}</strong> ${escapeHtml(t('migWarnBody'))}</span></div>
        <div class="button-row single">
          <a class="mig-go" href="${escapeHtml(MIGRATION.url)}">${escapeHtml(t('migOpen', MIGRATION.host))}</a>
          <button id="migrationSnooze">${escapeHtml(t('migSnooze'))}</button>
          ${why}
        </div>
      </article>
    </div>
  `;
}

// One-time banner after an app-shell update; opening the notes (or any later visit after
// openReleaseNotes records the version) makes it disappear.
function renderReleaseBanner() {
  if (!state.updateNoteAvailable) return '';
  return `
    <div class="update-banner">
      <span>${escapeHtml(t('updatedTo', APP_VERSION))}</span>
      <button id="releaseBannerBtn" class="primary">${t('whatsNew')}</button>
    </div>
  `;
}

// Shown when a new build has been downloaded but this document still runs the old one — the
// case an installed app hits when it is resumed for weeks without ever being relaunched.
// Reloading is the pilot's call: doing it unasked would discard whatever they were reading.
function renderReloadBanner() {
  if (!state.updateReadyOnReload) return '';
  return `
    <div class="update-banner">
      <span>${escapeHtml(t('updateReady'))}</span>
      <button id="reloadAppBtn" class="primary">${escapeHtml(t('reloadNow'))}</button>
    </div>
  `;
}

function renderReleaseNotes() {
  const lang = resolveLang();
  const entries = (Array.isArray(state.releaseNotes) ? state.releaseNotes : []).map(entry => {
    const bullets = (Array.isArray(entry[lang]) ? entry[lang] : entry.en) || [];
    return `
      <div class="release-entry${entry.version === APP_VERSION ? '' : ' past'}">
        <div class="release-head"><strong>${escapeHtml(entry.version || '')}</strong><span>${escapeHtml(entry.date || '')}</span></div>
        <ul>${bullets.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
      </div>`;
  }).join('');
  return `
    <div class="detail-backdrop" id="notesBackdrop">
      <article class="detail" role="dialog" aria-modal="true" aria-label="${escapeHtml(t('whatsNew'))}">
        <button id="closeNotes">${t('close')}</button>
        <div class="detail-title-row"><h2>${t('whatsNew')}</h2></div>
        <div class="release-list">${entries || `<p class="footer-note">${escapeHtml(t('noNotesFile'))}</p>`}</div>
      </article>
    </div>
  `;
}

function renderUpdateBanner() {
  if (!state.dataUpdateAvailable) return '';
  return `
    <div class="update-banner">
      <span>${escapeHtml(t('updateBanner'))}</span>
      <button id="syncDataBtn" class="primary">${t('update')}</button>
    </div>
  `;
}

/**
 * A setting that is on or off, as a labelled row with the switch on the right.
 *
 * The control is still a real checkbox — same id, same change event, same label and keyboard
 * behaviour — with only its appearance replaced, so nothing downstream has to know it is drawn
 * differently. A switch reads as a state rather than as a choice being ticked, which is what
 * these settings are, and it is a far better target for a thumb.
 */
function switchRow(id, label, note, checked, disabled = false) {
  return `
        <div class="set-row">
          <div class="set-top">
            <label for="${id}">${escapeHtml(label)}</label>
            <input id="${id}" type="checkbox" class="switch" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} />
          </div>
          ${note ? `<p class="set-sub">${escapeHtml(note)}</p>` : ''}
        </div>`;
}

/** A setting with a magnitude: the value sits beside its own label, the track spans the row. */
function sliderRow({ id, valueId, label, value, display, min, max, step, note, noteId, disabled }) {
  return `
        <div class="set-row">
          <div class="set-top">
            <label for="${id}">${escapeHtml(label)}</label>
            <output id="${valueId}" for="${id}" class="set-value">${escapeHtml(display)}</output>
          </div>
          <input id="${id}" type="range" min="${min}" max="${max}" step="${step}"
                 value="${value}" ${disabled ? 'disabled' : ''} />
          ${note ? `<p class="set-sub"${noteId ? ` id="${noteId}"` : ''}>${escapeHtml(note)}</p>` : ''}
        </div>`;
}

function renderSettingsPage() {
  const activeIds = new Set(activePackIds());
  // Hidden packs (e.g. the transitional whole-Alps alias kept for old cached shells) stay
  // resolvable but are not offered in the picker.
  const packList = state.packs.filter(p => !p.hidden).map(p => {
    const count = typeof p.fieldsCount === 'number' ? `${p.fieldsCount} ${t('fieldsWord')}` : '';
    return `<label class="pack-option">
        <span class="pack-name">${escapeHtml(packName(p))}</span>
        <span class="pack-meta">${escapeHtml(count)}</span>
        <input type="checkbox" class="packCheck switch" value="${escapeHtml(p.id)}" ${activeIds.has(p.id) ? 'checked' : ''} />
      </label>`;
  }).join('');
  const manifest = state.packManifest;
  const langOptions = [
    ['auto', t('langAuto')],
    ['en', 'English'],
    ['fr', 'Français'],
    ['de', 'Deutsch'],
  ].map(([value, label]) => `<option value="${value}" ${state.settings.language === value ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('');
  return `
    <section class="settings-page">
      <div class="settings-head">
        <h2>${t('settings')}</h2>
        <button id="closeSettings">${t('done')}</button>
      </div>

      ${renderMigrationCard()}

      <div class="settings-card">
        <h3>${t('app')}</h3>
        <div class="set-row">
          <div class="set-top">
            <label for="languageSelect">${t('language')}</label>
            <select id="languageSelect" class="set-control">${langOptions}</select>
          </div>
        </div>
        <dl class="meta-list">
          <div><dt>${t('version')}</dt><dd>${escapeHtml(APP_VERSION)} · <a href="#" id="whatsNewLink">${t('whatsNew')}</a></dd></div>
          <div><dt>${t('licenceLabel')}</dt><dd><a href="${DATA_LICENCE_URL}" target="_blank" rel="noopener">${escapeHtml(t('licenceValue'))}</a></dd></div>
          <div><dt>${t('status')}</dt><dd>${escapeHtml(t('betaStatus'))}</dd></div>
        </dl>
        <div class="button-row single">
          <button id="reportBug">🐞 ${t('reportBug')}</button>
        </div>
        <p class="settings-note">${escapeHtml(t('bugNote'))}</p>
      </div>

      <div class="settings-card">
        <h3>${t('pack')}</h3>
        <label>${t('selectedPacks')}</label>
        <div class="pack-list">${packList}</div>
        <dl class="meta-list">
          <div><dt>${t('downloadSize')}</dt><dd class="download-total">${escapeHtml(formatBytes(selectionDownloadBytes()))}</dd></div>
          <div><dt>${t('fieldsCount')}</dt><dd>${state.fields.length}</dd></div>
          <div><dt>${t('version')}</dt><dd>${escapeHtml(manifest?.version || '—')}</dd></div>
          <div><dt>${t('offline')}</dt><dd>${escapeHtml(cacheStatusLabel(state.cacheStatus))}${state.cacheProgress ? ` · ${escapeHtml(state.cacheProgress)}` : ''}</dd></div>
        </dl>
        <div class="button-row">
          <button class="primary" id="downloadPack">${t('downloadMedia')}</button>
          <button id="reloadPackSettings">${t('reloadPack')}</button>
        </div>
        <div class="button-row single">
          <button id="exportCup">${t('exportCup', state.fields.length)}</button>
        </div>
        <p class="settings-note">${escapeHtml(t('cupNote'))}</p>
      </div>

      <div class="settings-card">
        <h3>${t('nearestList')}</h3>
        <div class="set-row">
          <div class="set-top">
            <label for="safetyMarginM">${t('safetyMargin')}</label>
            <input id="safetyMarginM" class="set-control" inputmode="numeric" type="number"
                   min="0" step="50" value="${state.settings.safetyMarginM}" />
          </div>
        </div>
        ${switchRow('showC', t('showC'), '', state.settings.showC)}
        ${switchRow('showD', t('showD'), t('cdNote'), state.settings.showD)}
      </div>

      ${renderTerrainCard()}
      ${renderTestingCard()}
    </section>
  `;
}

function renderTerrainCard() {
  const terrain = state.terrain;
  const supported = terrainSupported();
  const targets = terrainDownloadTargets();
  const disabled = !supported || terrain.available === false;

  let status = '';
  if (!supported) status = t('terrainUnsupported');
  else if (terrain.available === false) status = t('terrainMissing');
  else if (terrain.status === 'solving') status = t('terrainSolving');
  else if (terrain.status === 'ready' && !terrain.trusted) status = t('terrainPartial');

  return `
      <div class="settings-card">
        <h3>${t('terrain')}</h3>
        ${switchRow('terrainRouting', t('terrainRouting'), t('terrainNote'), state.settings.terrainRouting, disabled)}
        ${sliderRow({
          id: 'terrainClearanceM',
          valueId: 'terrainClearanceValue',
          label: t('terrainClearance'),
          value: terrainClearanceM(),
          display: fmtM(terrainClearanceM()),
          min: TERRAIN_CLEARANCE_MIN_M,
          max: TERRAIN_CLEARANCE_MAX_M,
          step: TERRAIN_CLEARANCE_STEP_M,
          note: t('terrainClearanceNote', terrainClearanceM()),
          noteId: 'terrainClearanceNote',
          disabled: !state.settings.terrainRouting || disabled,
        })}
        ${status ? `<p class="settings-note">${escapeHtml(status)}</p>` : ''}
        <p class="settings-note">${escapeHtml(`${targets.keys.length ? `${t('terrainSize', formatBytes(targets.bytes))} · ` : ''}${t('terrainAttribution')}`)}</p>
      </div>`;
}

// Last in Settings and collapsed by default: useful on the ground, never wanted in the air.
function renderTestingCard() {
  const settings = state.settings;
  const active = testModeActive();

  return `
      <div class="settings-card">
        ${switchRow('testMode', t('groundTesting'), t('testNote'), settings.testMode)}
        ${settings.testMode ? `
        ${active ? `
        <div class="test-active">
          <div><strong>${escapeHtml(settings.testLabel || t('testUnnamed'))}</strong></div>
          <div class="test-active-meta">${settings.testLatitude.toFixed(4)}, ${settings.testLongitude.toFixed(4)} · ${fmtM(settings.testAltitudeM)}</div>
        </div>` : ''}
        <label for="testPlace">${t('testPlace')}</label>
        <input id="testPlace" type="search" inputmode="search" autocomplete="off"
               value="${escapeHtml(state.testQuery || '')}"
               placeholder="${escapeHtml(t('testPlacePlaceholder'))}" />
        <div class="test-results" id="testResults">${renderTestResults()}</div>
        ${renderTestAltitudeRow()}
        <p class="settings-note">${escapeHtml(t('testAttribution'))}</p>` : ''}
      </div>`;
}

// The altitude for the simulated position, given against one of two references: AMSL (sea
// level, the default) or AGL (the ground at the chosen place). One slider whose meaning the
// small toggle switches, with a line underneath always translating into the other reference —
// so whichever way the pilot thinks, both numbers are in view. AGL needs the ground, so it is
// greyed out until a place is chosen and a downloaded tile covers it.
function renderTestAltitudeRow() {
  const settings = state.settings;
  const ground = state.testGroundM;
  const aglAvailable = Number.isFinite(ground);
  const agl = settings.testAltitudeMode === 'agl' && aglAvailable;
  const value = agl ? (Number(settings.testAglM) || 0) : (Number(settings.testAltitudeM) || 0);
  // In AMSL the track starts at the ground rather than at the sea, so the handle cannot be put
  // underground. See testAltitudeFloorM for why it is the ground rounded up to the step.
  const floor = testAltitudeFloorM();
  // Somewhere with ground above the usual 6000 m ceiling would otherwise get a slider with no
  // travel at all.
  const ceiling = Math.max(6000, floor + 1000);

  let note = '';
  if (agl) {
    note = t('testAglLine', fmtM(ground), fmtM(ground + value));
  } else if (aglAvailable) {
    note = t('testAmslLine', fmtM(ground), fmtM(Math.max(0, value - ground)));
  } else {
    note = Number.isFinite(settings.testLatitude) ? t('aglNeedsTerrain') : t('aglNeedsPlace');
  }
  return `
        <div class="set-row">
          <div class="set-top">
            <label for="testAltitudeM">${t('testAltitude')}</label>
            <div class="unit-toggle" role="group">
              <button id="altUnitAmsl" type="button" class="${agl ? '' : 'active'}" aria-pressed="${!agl}">AMSL</button>
              <button id="altUnitAgl" type="button" class="${agl ? 'active' : ''}" aria-pressed="${agl}" ${aglAvailable ? '' : 'disabled'}>AGL</button>
            </div>
            <output id="testAltitudeValue" for="testAltitudeM" class="set-value">${agl ? `${fmtM(value)} AGL` : fmtM(value)}</output>
          </div>
          <input id="testAltitudeM" type="range" min="${agl ? 0 : floor}" max="${agl ? 3000 : ceiling}" step="${agl ? 50 : TEST_AMSL_STEP_M}" value="${Math.max(agl ? 0 : floor, value)}" />
          <p class="set-sub" id="testAltitudeNote">${escapeHtml(note)}</p>
        </div>`;
}


function difficultyLabel(field) {
  const value = String(field?.difficulty || field?.rawDifficulty || '').trim();
  const normalized = value.toLowerCase().replace(/[{}\s_-]+/g, '');
  if (['a', 'facile', 'easy', 'aerodrome'].includes(normalized)) return 'A';
  if (['b', 'normal', 'terrain'].includes(normalized)) return 'B';
  if (['c', 'difficile', 'hard'].includes(normalized)) return 'C';
  if (['d', 'tresdifficile', 'trèsdifficile', 'veryhard', 'verydifficult'].includes(normalized)) return 'D';
  if (['altiport', 'velisurface', 'vélisurface'].includes(normalized)) return value || '?';
  // Anything else (notably UNKNOWN) renders as a compact "?" so the badge never
  // stretches over the glide-ratio column — and needs no localization.
  return '?';
}

function difficultyBadgeClass(field) {
  const label = difficultyLabel(field).toUpperCase();
  if (label === 'A') return 'badge-a';
  if (label === 'B') return 'badge-b';
  if (label === 'C') return 'badge-c';
  if (label === 'D') return 'badge-d';
  return 'badge-unknown';
}

// The three best safe options, pinned above the rest of the list: difficulty A only,
// required glide ratio TOP_PICK_MAX_GLIDE or better, airfields ranked before fields,
// then lowest required glide first.
function topPickRows() {
  return state.computedRows
    .filter(row => row.field.difficulty === 'A'
      && row.requiredGlideRatio !== null
      && row.requiredGlideRatio <= TOP_PICK_MAX_GLIDE)
    .sort((a, b) => {
      const airfieldFirst = (a.field.kind === 'airfield' ? 0 : 1) - (b.field.kind === 'airfield' ? 0 : 1);
      return airfieldFirst || a.requiredGlideRatio - b.requiredGlideRatio;
    })
    .slice(0, 3);
}

const SEARCH_RESULT_LIMIT = 80;

// Lowercase + strip accents so "pre" matches "Pré" and "amberieu" matches "Ambérieu".
function normalizeSearch(value) {
  return String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// Fields whose name or code contain every search token. Unlike the nearest list this searches
// the whole pack (including hidden C/D fields and beyond the distance cap) because the pilot
// asked for a specific place — e.g. to open it and contribute an update.
function searchMatches(query) {
  const tokens = normalizeSearch(query).split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const matched = state.fields.filter(field => {
    // Raw code, not displayCode: a minted key is never shown, but matching it costs nothing and
    // lets anyone who has one from an export find the field again.
    const hay = normalizeSearch(`${field.name || ''} ${field.code || ''}`);
    return tokens.every(tok => hay.includes(tok));
  });
  if (state.position) {
    const altitudeM = activeAltitudeM();
    const safetyMarginM = Number(state.settings.safetyMarginM) || 0;
    return matched
      .map(field => metricsForField(field, altitudeM, safetyMarginM))
      .sort((a, b) => a.distanceM - b.distanceM)
      .slice(0, SEARCH_RESULT_LIMIT);
  }
  return matched
    .slice()
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .slice(0, SEARCH_RESULT_LIMIT)
    .map(field => ({ field, distanceM: null, requiredGlideRatio: null, glideReason: '' }));
}

function renderSearchBox() {
  const q = state.searchQuery;
  return `
    <div class="search-box">
      <span class="search-ic" aria-hidden="true">🔍</span>
      <input id="fieldSearch" type="text" inputmode="search" enterkeyhint="search" autocomplete="off"
        placeholder="${escapeHtml(t('searchPlaceholder'))}" aria-label="${escapeHtml(t('searchPlaceholder'))}"
        value="${escapeHtml(q)}" />
      <button id="clearSearch" class="search-clear" ${q ? '' : 'hidden'} title="${escapeHtml(t('clearSearch'))}" aria-label="${escapeHtml(t('clearSearch'))}">✕</button>
    </div>
  `;
}

function renderFieldRow(row) {
  const { field, distanceM, requiredGlideRatio, glideReason, terrainState } = row;
  // The number a pilot reads is the same size whatever produced it; only a small mark says the
  // glide had to go around something, and only when it actually did.
  const routed = terrainState === 'routed' ? ' routed' : '';
  // The chip appears only for a real detour, so flat country sees no change at all — and it says
  // where the route goes, which is the part you cannot get from the number.
  const via = routeIsDetour(row) ? routeVia(row) : '';
  // Distance first: a long col name is the part that can be cut without losing the point, and
  // putting it last means the ellipsis eats the name's tail rather than the number.
  // The mountain mark is drawn by CSS — a ::before on both this chip and the glide figure — from
  // one shared definition, so the two cannot drift apart: they are the same statement twice.
  const chip = routeIsDetour(row)
    ? `<span class="field-via">${escapeHtml(fmtKm(row.route.pathLengthM))} ${escapeHtml(via ? t('routeViaChip', via) : t('routeViaPlain'))}</span>`
    : '';
  return `
    <button class="field-row" data-field-id="${field.id}" title="${escapeHtml(glideReason || '')}">
      <span class="field-main">
        <span class="field-name">${escapeHtml(shortFieldName(field.name))}</span>
        <span class="field-sub">${escapeHtml([displayCode(field), field.kind === 'airfield' ? t('airfield') : t('field')].filter(Boolean).join(' · '))}</span>
        ${chip}
      </span>
      <span class="field-distance"><span class="field-km">${Number.isFinite(distanceM) ? fmtKm(distanceM) : '—'}</span>${
        Number.isFinite(row.bearingDeg) ? `<span class="field-dir">${escapeHtml(compassPoint(row.bearingDeg))}</span>` : ''
      }</span>
      <span class="field-glide ${requiredGlideRatio ? '' : 'missing'}${routed}">${requiredGlideRatio ? `${Math.round(requiredGlideRatio)}` : '—'}</span>
      <span class="badge ${difficultyBadgeClass(field)}">${escapeHtml(difficultyLabel(field))}</span>
    </button>
  `;
}

function renderFieldList() {
  if (!state.fields.length) {
    const message = activePackIds().length ? t('noFields') : t('noPackSelectedHint');
    return `<div class="warning">${escapeHtml(message)}</div>`;
  }
  const query = state.searchQuery.trim();
  if (query) {
    // The suggest row closes every search — most prominently the fruitless one, where a pilot
    // just discovered the field they know is missing from the pack.
    const suggest = `<button id="suggestField" class="suggest-field">➕ ${t('suggestField')}</button>`;
    const rows = searchMatches(query);
    if (!rows.length) return `<div class="warning">${escapeHtml(t('noMatches', query))}</div>${suggest}`;
    return `
      <section class="field-list" aria-label="${escapeHtml(t('searchResults'))}">
        <div class="field-list-head">
          <span>${t('colName')}</span><span>${t('colDist')}</span><span>${t('colGlide')}</span><span>${t('colDiff')}</span>
        </div>
        ${rows.map(renderFieldRow).join('')}
      </section>
      ${suggest}
    `;
  }
  if (!state.position) return `<div class="warning">${escapeHtml(t('waitingGps'))}</div>`;
  const picks = topPickRows();
  const pickIds = new Set(picks.map(row => row.field.id));
  const rest = state.computedRows.filter(row => !pickIds.has(row.field.id)).slice(0, 120);
  return `
    <section class="field-list" aria-label="${t('nearestList')}">
      <div class="field-list-head">
        <span>${t('colName')}</span><span>${t('colDist')}</span><span>${t('colGlide')}</span><span>${t('colDiff')}</span>
      </div>
      ${picks.map(renderFieldRow).join('')}
      ${picks.length && rest.length ? '<div class="top-picks-divider" role="separator"></div>' : ''}
      ${rest.map(renderFieldRow).join('')}
    </section>
  `;
}

function renderDetail(field) {
  const row = state.computedRows.find(r => r.field.id === field.id);
  const glideNote = row?.glideReason ? `<p class="inline-note">${escapeHtml(t('glideNotShown', row.glideReason))}</p>` : '';
  const media = (field.media || []).map(item => renderMediaItem(item, field._base)).join('') || `<p class="footer-note">${escapeHtml(t('noMedia'))}</p>`;
  const kindLabel = field.kind === 'airfield' ? t('airfield') : t('outlanding');
  const arrivalHeightM = state.settings.terrainRouting ? routeArrivalHeightM(row) : null;
  return `
    <div class="detail-backdrop" id="detailBackdrop">
      <article class="detail" role="dialog" aria-modal="true">
        <button id="closeDetail">${t('close')}</button>
        <div class="detail-title-row">
          <h2>${escapeHtml(field.name)}</h2>
          <span class="badge detail-badge ${difficultyBadgeClass(field)}">${escapeHtml(difficultyLabel(field))}</span>
        </div>
        <div class="detail-meta">${escapeHtml([displayCode(field), kindLabel, field.rawDifficulty].filter(Boolean).join(' · '))}</div>
        <div class="detail-grid">
          <div class="detail-card"><span class="status-label">${t('bearing')}</span><strong>${row && Number.isFinite(row.bearingDeg) ? `${fmtDeg(row.bearingDeg)} ${escapeHtml(compassPoint(row.bearingDeg))}` : '—'}</strong></div>
          <div class="detail-card"><span class="status-label">${t('distance')}</span><strong>${row ? fmtKm(row.distanceM) : '—'}</strong></div>
          ${routeIsDetour(row) ? `<div class="detail-card"><span class="status-label">${t('routeLength')}</span><strong>${fmtKm(row.route.pathLengthM)}</strong></div>` : ''}
          <div class="detail-card"><span class="status-label">${t('reqGlide')}</span><strong>${row?.requiredGlideRatio ? `${Math.round(row.requiredGlideRatio)}` : '—'}</strong></div>
          ${arrivalHeightM !== null ? `<div class="detail-card"><span class="status-label">${t('arrivalHeight')}</span><strong>${fmtSignedM(arrivalHeightM)}</strong></div>` : ''}
          <div class="detail-card"><span class="status-label">${t('deltaSafe')}</span><strong>${row?.usableHeightM !== null && row ? fmtSignedM(row.usableHeightM) : '—'}</strong></div>
          <div class="detail-card"><span class="status-label">${t('elevation')}</span><strong>${field.elevationM !== null ? fmtM(field.elevationM) : '—'}</strong></div>
          <div class="detail-card"><span class="status-label">${t('runway')}</span><strong>${escapeHtml(formatRunwayDimensions(field))}</strong></div>
          <div class="detail-card"><span class="status-label">${t('frequency')}</span><strong>${escapeHtml(formatFrequency(field))}</strong></div>
        </div>
        ${glideNote}
        ${renderRouteBlock(row)}
        <h3>${t('notes')}</h3>
        <div class="notes">${escapeHtml(fieldNotes(field) || t('noNotes'))}</div>
        <h3>${t('mediaHeading')}</h3>
        <div class="media-grid">${media}</div>
        <p class="footer-note">${t('source')}: ${escapeHtml(field.source?.name || t('unknown'))} ${field.source?.importedAt ? `· ${t('imported')} ${escapeHtml(field.source.importedAt)}` : ''}</p>
        <div class="button-row single">
          <button id="openContribute" class="primary contribute-btn">📷 ${t('contribute')}</button>
        </div>
      </article>
    </div>
  `;
}



/**
 * The two things the pinch point's elevation alone does not say: how much height you have over it
 * now, and how much the reported glide leaves when it crosses.
 *
 * The second is the clearance setting by construction — the tightest point is *defined* as where
 * the glide grazes the clearance envelope, so it could not be anything else. Saying it anyway
 * closes the loop: it shows the pilot that the ratio is bounded by their own margin rather than by
 * the ground, and it is read off the geometry rather than off the setting, so a route solved under
 * an older clearance still reports what that route actually does.
 *
 * The first is the number that moves. It is also the one that makes the ratio legible: the glide
 * has to cover the distance to the point on roughly the height standing between you and it.
 */
function routeCrossingLine(route) {
  const critical = route?.critical;
  const altitude = activeAltitudeM();
  if (!critical || altitude === null || !Number.isFinite(critical.elevationM)) return '';
  const above = altitude - critical.elevationM;
  if (!(above > 0)) return '';
  const clears = Number.isFinite(critical.atM) && route.requiredGlideRatio > 0
    ? above - critical.atM / route.requiredGlideRatio
    : null;
  return clears !== null && clears > 0
    ? t('routeCrossing', fmtM(above), fmtM(clears))
    : t('routeAbove', fmtM(above));
}

/**
 * How high over the field the required glide actually puts you.
 *
 * When a col sets the ratio rather than the arrival does, the glide is sized for the col — it
 * crosses that with the clearance and then goes on descending at the same slope to a field that
 * needed much less, so it lands in with a good deal more than the safety margin. That surplus is
 * a real reason to prefer one field over another and a bare ratio hides it completely. When the
 * arrival is what sets the ratio this comes back as the margin exactly, which is the honest
 * answer: there is nothing spare.
 */
function routeArrivalHeightM(row) {
  const route = row?.route;
  const altitude = activeAltitudeM();
  const elevation = row?.field?.elevationM;
  if (!route || altitude === null || !Number.isFinite(elevation)) return null;
  if (!(route.requiredGlideRatio > 0) || !Number.isFinite(route.pathLengthM)) return null;
  return altitude - route.pathLengthM / route.requiredGlideRatio - elevation;
}

/**
 * What the glide had to do to get here. Only shown when terrain routing produced something to
 * say — with the feature off, or with no terrain published, the detail sheet looks as it always did.
 */
function renderRouteBlock(row) {
  if (!state.settings.terrainRouting || !row) return '';
  const route = row.route;
  const lines = [];

  if (route && route.direct) {
    lines.push(t('routeStraight'));
  } else if (route) {
    lines.push(t('routeAround', fmtKm(route.pathLengthM), route.legs));
    if (Number.isFinite(row.distanceM)) lines.push(t('routeVersusDirect', fmtKm(row.distanceM)));
    if (route.critical) {
      const distanceM = haversineMeters(
        state.position.latitude, state.position.longitude,
        route.critical.latitude, route.critical.longitude,
      );
      const bearingDeg = bearingDegrees(
        state.position.latitude, state.position.longitude,
        route.critical.latitude, route.critical.longitude,
      );
      lines.push(route.critical.colName
        ? t('routeLimitedByCol', route.critical.colName,
            fmtM(route.critical.elevationM), fmtKm(distanceM))
        : t('routeLimitedBy', fmtM(route.critical.elevationM), fmtKm(distanceM), fmtDeg(bearingDeg)));
      const crossing = routeCrossingLine(route);
      if (crossing) lines.push(crossing);
    } else {
      lines.push(t('routeLimitedArrival'));
    }
  } else if (row.terrainState === 'blocked') {
    lines.push(t('routeBlocked'));
  } else if (row.terrainState === 'unchecked') {
    lines.push(t('routeUnchecked'));
  } else if (state.terrain.status === 'solving') {
    lines.push(t('terrainSolving'));
  } else {
    return '';
  }

  return `
    <h3>${t('route')}</h3>
    <p class="route-summary">${lines.map(line => escapeHtml(line)).join('<br />')}</p>
    ${renderRouteProfile(row)}
  `;
}

/**
 * The route in profile: ground, the clearance envelope above it, and the glide line drawn at the
 * ratio the app is reporting. The point where those two meet is the answer's whole justification,
 * so it is marked.
 *
 * Hand-built SVG rather than a chart library — it is four paths, and this ships to a cockpit
 * where every kilobyte is downloaded once over a phone connection and then flown with.
 */
function renderRouteProfile(row) {
  const route = row?.route;
  const profile = route?.profile;
  if (!profile?.terrain?.length || !state.position) return '';
  const altitude = activeAltitudeM();
  if (altitude === null) return '';

  const width = 320;
  const height = 130;
  const padLeft = 34;
  const padBottom = 16;
  const padTop = 8;
  const plotWidth = width - padLeft - 6;
  const plotHeight = height - padTop - padBottom;

  const clearance = terrainClearanceM();
  const terrain = profile.terrain.map(v => (Number.isFinite(v) ? v : null));
  const known = terrain.filter(v => v !== null);
  if (!known.length) return '';
  const arrival = Number.isFinite(row.field.elevationM) ? row.field.elevationM : known[known.length - 1];

  const top = Math.max(altitude, ...known.map(v => v + clearance)) + 100;
  const bottom = Math.min(arrival, ...known) - 80;
  const span = Math.max(1, top - bottom);
  const x = i => padLeft + (i / (terrain.length - 1)) * plotWidth;
  const y = metres => padTop + (1 - (metres - bottom) / span) * plotHeight;

  const line = values => values
    .map((v, i) => (v === null ? null : `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`))
    .filter(Boolean).join(' ');
  const groundPath = `${line(terrain)} L${x(terrain.length - 1).toFixed(1)},${y(bottom).toFixed(1)} L${x(0).toFixed(1)},${y(bottom).toFixed(1)} Z`;
  const envelopePath = line(terrain.map(v => (v === null ? null : v + clearance)));

  // The glide line: altitude falls by one metre per `ratio` metres flown.
  const ratio = route.requiredGlideRatio;
  const glideEnd = altitude - profile.lengthM / ratio;
  const glidePath = `M${x(0).toFixed(1)},${y(altitude).toFixed(1)} L${x(terrain.length - 1).toFixed(1)},${y(glideEnd).toFixed(1)}`;

  let marker = '';
  if (route.critical && Number.isFinite(route.critical.atM)) {
    const at = Math.min(1, Math.max(0, route.critical.atM / profile.lengthM));
    const markerX = padLeft + at * plotWidth;
    const markerY = y(altitude - route.critical.atM / ratio);
    const label = route.critical.colName || fmtM(route.critical.elevationM);
    marker = `
      <line x1="${markerX.toFixed(1)}" y1="${padTop}" x2="${markerX.toFixed(1)}" y2="${(padTop + plotHeight).toFixed(1)}" class="rp-mark" />
      <circle cx="${markerX.toFixed(1)}" cy="${markerY.toFixed(1)}" r="3.5" class="rp-dot" />
      <text x="${Math.min(markerX + 5, width - 4).toFixed(1)}" y="${(padTop + 10).toFixed(1)}"
            class="rp-label" text-anchor="${markerX > width * 0.6 ? 'end' : 'start'}">${escapeHtml(label)}</text>`;
  }

  const ticks = [bottom + span, bottom + span / 2, bottom]
    .map(v => `<text x="${padLeft - 5}" y="${(y(v) + 3).toFixed(1)}" class="rp-axis" text-anchor="end">${Math.round(v / 100) * 100}</text>`)
    .join('');

  return `
    <svg class="route-profile" viewBox="0 0 ${width} ${height}" role="img"
         aria-label="${escapeHtml(t('routeProfileAlt', fmtKm(profile.lengthM), Math.round(ratio)))}">
      <path d="${groundPath}" class="rp-ground" />
      <path d="${envelopePath}" class="rp-envelope" />
      <path d="${glidePath}" class="rp-glide" />
      ${marker}
      ${ticks}
      <text x="${padLeft}" y="${height - 4}" class="rp-axis">0</text>
      <text x="${width - 6}" y="${height - 4}" class="rp-axis" text-anchor="end">${escapeHtml(fmtKm(profile.lengthM))}</text>
    </svg>
    <p class="route-profile-key">${escapeHtml(t('routeProfileKey', clearance))}</p>`;
}

function formatRunwayDimensions(field) {
  const length = Number(field.lengthM);
  const width = Number(field.widthM);
  if (Number.isFinite(length) && length > 0 && Number.isFinite(width) && width > 0) {
    return `${Math.round(length)} × ${Math.round(width)} m`;
  }
  if (Number.isFinite(length) && length > 0) return `${Math.round(length)} m`;
  return '—';
}

function formatFrequency(field) {
  if (field.frequency) return field.frequency;
  const freqs = Array.isArray(field.frequencies) ? field.frequencies : [];
  if (!freqs.length) return '—';
  const first = freqs[0];
  const mhz = typeof first.mhz === 'number' ? first.mhz.toFixed(3) : '';
  return [mhz, first.type || first.description].filter(Boolean).join(' ') || '—';
}

function renderMediaItem(item, base) {
  const caption = item.caption || item.source || item.type;
  // Credit the publisher on the card itself. The manifest and the pack notices carry it too, but
  // this is where a pilot actually opens a chart, and some publishers require the attribution
  // wherever their cartography appears (ENAIRE's permission is explicit about it). Suppressed
  // when it would only repeat the caption — a photo whose caption already IS its source.
  const credit = item.source && item.source !== caption
    ? `<div class="media-credit">${escapeHtml(item.source)}</div>` : '';
  // A gated chart is fetched from the chart Worker; everything else, and any chart in a
  // deployment with no Worker configured, keeps using the URL published in the pack.
  const gated = chartUrl(item);
  // Token still being minted: render the card without the iframe rather than fire a tokenless
  // request that 403s and flashes a broken viewer. The mint's completion re-renders the detail
  // (see attachFieldRowEvents) with the best URL there is — tokened, or bare when minting
  // failed, which the service worker still answers from the cache for a downloaded chart.
  if (gated && !chartToken.value && chartTokenPending) {
    return `<div class="media-card"><div class="caption">${escapeHtml(caption)}</div>${credit}</div>`;
  }
  const mediaUrl = gated
    ? tokenedChartUrl(gated)
    : new URL(item.url, base || state.currentManifestUrl || BASE_URL).toString();
  if (item.type === 'pdf') {
    return `<div class="media-card"><iframe src="${mediaUrl}" title="${escapeHtml(caption)}"></iframe><div class="caption"><a href="${mediaUrl}" target="_blank" rel="noopener">${t('openPdf')}</a> · ${escapeHtml(caption)}</div>${credit}</div>`;
  }
  return `<div class="media-card"><img src="${mediaUrl}" alt="${escapeHtml(caption)}" loading="lazy" /><div class="caption">${escapeHtml(caption)}</div>${credit}</div>`;
}

// --- Community contribution form (Phase 2) ---

// Shared tail of the contribute and new-field forms: photo staging, geo line, submitter,
// licence, anti-spam widget, error area and submit. Identical ids on purpose — the shared
// staging/restore/submit helpers work on whichever of the two forms is open.
function renderContribFormTail() {
  return `
          <input id="cPhoto" type="file" accept="image/jpeg" multiple hidden />
          <button type="button" id="cPhotoBtn" class="contrib-photo-btn">🖼️ ${t('cAddPhoto')}</button>
          <div id="cPhotoList" class="contrib-photo-list"></div>
          <div id="cGeo" class="contrib-geo" hidden></div>
          <input id="cSubmitter" type="text" autocomplete="off" placeholder="${escapeHtml(t('cSubmitter'))}" />
          <label class="checkbox-row contrib-license"><input id="cLicense" type="checkbox" /><span>${escapeHtml(t('cLicense'))}</span></label>
          <div id="cTurnstile" class="contrib-turnstile"></div>
          <div id="cError" class="contrib-error" hidden></div>
          <button id="cSubmit" class="primary contrib-submit" disabled>${t('cSubmit')}</button>`;
}

function renderContribute(field) {
  if (!field) return '';
  const today = new Date().toISOString().slice(0, 10);
  return `
    <div class="detail-backdrop contrib-backdrop" id="contribBackdrop">
      <article class="detail contrib" role="dialog" aria-modal="true" aria-label="${escapeHtml(t('contribTitle'))}">
        <button id="closeContribute">${t('close')}</button>
        <div class="detail-title-row"><h2>${escapeHtml(t('contribTitle'))}</h2></div>
        <div class="detail-meta">${escapeHtml([shortFieldName(field.name), displayCode(field)].filter(Boolean).join(' · '))}</div>
        <div id="contribBody" class="contrib-form">
          <label for="cDate">${t('cDate')}</label>
          <input id="cDate" type="date" value="${today}" />
          <label for="cDesc">${t('cDesc')}</label>
          <textarea id="cDesc" rows="4" placeholder="${escapeHtml(t('cDescPlaceholder'))}"></textarea>
          ${renderContribFormTail()}
        </div>
      </article>
    </div>
  `;
}

function openContribute(fieldId) {
  contribForm = { photos: [], busy: false, turnstileWidget: null };
  state.contribFor = fieldId;
  render();
}

function closeContribute() {
  state.contribFor = null;
  contribForm = null;
  render();
}

function contribShowError(message) {
  const el = document.querySelector('#cError');
  if (!el) return;
  if (!message) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.textContent = message;
}

function updateContribValidity() {
  const submit = document.querySelector('#cSubmit');
  if (!submit || !contribForm) return;
  const hasNote = (document.querySelector('#cDesc')?.value || '').trim().length > 0;
  const licensed = !!document.querySelector('#cLicense')?.checked;
  submit.disabled = contribForm.busy || !licensed || !(hasNote || contribForm.photos.length);
}

// Aggregate geo line under the photo list: every staged photo pre-verified -> ok; otherwise
// say how many will need manual review. The Worker re-checks per photo authoritatively.
function showContribGeo(photos) {
  const el = document.querySelector('#cGeo');
  if (!el) return;
  if (!photos.length) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.classList.remove('ok', 'warn');
  const unverified = photos.filter(p => !p.geo.verified).length;
  if (!unverified) { el.classList.add('ok'); el.textContent = t('cGeoAllOk', photos.length); }
  else { el.classList.add('warn'); el.textContent = t('cGeoSomeReview', unverified); }
}

// Advisory client-side geo hint against target coordinates (an existing field, or the
// coordinates typed into the new-field form). The Worker re-checks authoritatively.
function contribGeoHint(targetLat, targetLon, exifGps) {
  const hasTarget = Number.isFinite(targetLat) && Number.isFinite(targetLon);
  if (exifGps && hasTarget) {
    const d = Math.round(haversineMeters(exifGps.lat, exifGps.lon, targetLat, targetLon));
    return { verified: d <= CONTRIB_GEO_RADIUS_M, source: 'exif', distanceM: d };
  }
  if (state.position && hasTarget) {
    const d = Math.round(haversineMeters(state.position.latitude, state.position.longitude, targetLat, targetLon));
    if (d <= CONTRIB_GEO_RADIUS_M) return { verified: true, source: 'device', distanceM: d };
  }
  return { verified: false, source: 'none', distanceM: null };
}

// Stage picked files onto `form.photos` (shared by the update form and the new-field form).
// A file that fails validation shows the error and is skipped — photos already staged stay,
// visibly listed, so a bad pick can never silently drop or replace a good one.
async function stageContribPhotos(form, files, coordsProvider) {
  const isLive = () => form === contribForm || form === newFieldForm;
  contribShowError('');
  for (const file of Array.from(files || [])) {
    if (!isLive()) return;
    if (form.photos.length >= CONTRIB_MAX_PHOTOS) { contribShowError(t('cMaxPhotos', CONTRIB_MAX_PHOTOS)); break; }
    let blob = file;
    let name = file.name || 'photo.jpg';
    let exifGps = null;
    try {
      if (file.type === 'image/jpeg') {
        const buf = await file.arrayBuffer();
        exifGps = readJpegGps(buf);
      } else {
        // Convert PNG/HEIC-that-slipped-through to JPEG so the Worker (JPEG-only) accepts it.
        // Conversion loses EXIF, so the geo hint falls back to device GPS. (The picker asks for
        // image/jpeg, so iPhones transcode HEIC at pick time and keep the EXIF GPS.)
        blob = await imageToJpeg(file);
        name = name.replace(/\.[^.]+$/, '') + '.jpg';
      }
    } catch {
      if (isLive()) contribShowError(t('cJpegOnly'));
      continue;
    }
    if (!isLive()) return; // form closed/reopened during the decode
    if (blob.size > CONTRIB_MAX_BYTES) { contribShowError(t('cTooLarge')); continue; }
    const longEdge = await imageLongEdge(blob);
    if (!isLive()) return;
    if (longEdge != null && longEdge < CONTRIB_MIN_LONG_EDGE) { contribShowError(t('cTooSmall', CONTRIB_MIN_LONG_EDGE)); continue; }
    const target = coordsProvider();
    // exifGps is kept so the new-field form can re-verdict photos when the coordinates change.
    form.photos.push({ blob, name, exifGps, geo: contribGeoHint(target?.lat, target?.lon, exifGps) });
  }
  const input = document.querySelector('#cPhoto');
  if (input) input.value = ''; // re-picking the same file must fire `change` again
  renderContribPhotoList(form);
}

// Forms live in module state (contribForm/newFieldForm) precisely so a re-render cannot lose
// them; these two helpers close the DOM half of that promise. Every input/change lands in
// form.values, and after any full render the wire functions put the values, the staged photo
// list, and a fresh Turnstile widget back — so nothing the pilot entered silently disappears
// (or worse, gets submitted invisibly).
function trackFormValues(form) {
  const body = document.querySelector('#contribBody');
  if (!body) return;
  const save = e => {
    const el = e.target;
    if (!form || !el || !el.id) return;
    if (!form.values) form.values = {};
    form.values[el.id] = el.type === 'checkbox' ? el.checked : el.value;
  };
  body.addEventListener('input', save);
  body.addEventListener('change', save);
}

function restoreFormState(form) {
  for (const [id, value] of Object.entries(form.values || {})) {
    const el = document.querySelector(`#${id}`);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!value;
    else el.value = value;
  }
  // A re-render destroys the widget's DOM while the stale widget id survives; reset it so
  // ensureTurnstile mounts a fresh one (tokens are single-use anyway).
  if (form.turnstileWidget != null && !document.querySelector('#cTurnstile')?.childElementCount) {
    form.turnstileWidget = null;
  }
  renderContribPhotoList(form);
}

function renderContribPhotoList(form) {
  const list = document.querySelector('#cPhotoList');
  if (!list) return;
  list.innerHTML = form.photos.map((p, i) => `
    <div class="contrib-photo-row">
      <span class="contrib-photo-geo ${p.geo.verified ? 'ok' : 'warn'}" title="${escapeHtml(p.geo.verified ? t('cGeoAllOk', 1) : t('cGeoNone'))}">${p.geo.verified ? '📍' : '❓'}</span>
      <span class="contrib-photo-name">${escapeHtml(p.name)} · ${(p.blob.size / 1024 / 1024).toFixed(1)} MB</span>
      <button type="button" class="contrib-photo-remove" data-photo-idx="${i}" aria-label="${escapeHtml(t('cRemovePhoto'))}">✕</button>
    </div>
  `).join('');
  list.querySelectorAll('.contrib-photo-remove').forEach(btn => btn.addEventListener('click', () => {
    form.photos.splice(Number(btn.getAttribute('data-photo-idx')), 1);
    renderContribPhotoList(form);
  }));
  const btn = document.querySelector('#cPhotoBtn');
  if (btn) btn.textContent = `🖼️ ${t('cAddPhoto')}${form.photos.length ? ` (${form.photos.length}/${CONTRIB_MAX_PHOTOS})` : ''}`;
  showContribGeo(form.photos);
  if (form === contribForm) updateContribValidity();
  else updateNewFieldValidity();
}

async function imageToJpeg(file) {
  const bmp = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width; canvas.height = bmp.height;
  canvas.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close?.();
  return await new Promise((res, rej) => canvas.toBlob(b => b ? res(b) : rej(new Error('encode failed')), 'image/jpeg', 0.9));
}

async function imageLongEdge(blob) {
  try {
    const bmp = await createImageBitmap(blob);
    const edge = Math.max(bmp.width, bmp.height);
    bmp.close?.();
    return edge;
  } catch {
    return null; // can't decode here; the Worker still checks
  }
}

// Minimal EXIF GPS reader for JPEG (advisory). Returns {lat, lon} or null.
function readJpegGps(buffer) {
  try {
    const view = new DataView(buffer);
    if (view.getUint16(0) !== 0xffd8) return null;
    let off = 2;
    while (off + 4 < view.byteLength) {
      const marker = view.getUint16(off);
      if (marker === 0xffe1) return parseExifGps(view, off + 4);
      if ((marker & 0xff00) !== 0xff00) break;
      off += 2 + view.getUint16(off + 2);
    }
  } catch { /* ignore */ }
  return null;
}

function parseExifGps(view, start) {
  if (view.getUint32(start) !== 0x45786966) return null; // "Exif"
  const tiff = start + 6;
  const le = view.getUint16(tiff) === 0x4949;
  const u16 = o => view.getUint16(o, le);
  const u32 = o => view.getUint32(o, le);
  const ifd0 = tiff + u32(tiff + 4);
  const count0 = u16(ifd0);
  let gpsOff = 0;
  for (let i = 0; i < count0; i++) {
    const e = ifd0 + 2 + i * 12;
    if (u16(e) === 0x8825) { gpsOff = tiff + u32(e + 8); break; }
  }
  if (!gpsOff) return null;
  const gCount = u16(gpsOff);
  let latRef = 'N', lonRef = 'E', lat = null, lon = null;
  const dms = valueOff => {
    const o = tiff + valueOff;
    const r = p => u32(o + p) / (u32(o + p + 4) || 1);
    return r(0) + r(8) / 60 + r(16) / 3600;
  };
  for (let i = 0; i < gCount; i++) {
    const e = gpsOff + 2 + i * 12;
    const tag = u16(e);
    if (tag === 0x0001) latRef = String.fromCharCode(view.getUint8(e + 8));
    else if (tag === 0x0003) lonRef = String.fromCharCode(view.getUint8(e + 8));
    else if (tag === 0x0002) lat = dms(u32(e + 8));
    else if (tag === 0x0004) lon = dms(u32(e + 8));
  }
  if (lat == null || lon == null) return null;
  return {
    lat: latRef === 'S' ? -lat : lat,
    lon: lonRef === 'W' ? -lon : lon,
  };
}

function ensureTurnstile(callback) {
  if (window.turnstile) return callback();
  const existing = document.querySelector('#turnstile-script');
  if (!existing) {
    const s = document.createElement('script');
    s.id = 'turnstile-script';
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true; s.defer = true;
    document.head.appendChild(s);
  }
  const timer = setInterval(() => { if (window.turnstile) { clearInterval(timer); callback(); } }, 120);
  setTimeout(() => clearInterval(timer), 8000);
}

// Mount a Turnstile widget for a form (contribute / new-field / bug). getForm re-reads the
// module global so a form closed (or closed-and-reopened) while the script was still loading
// never gets a widget mounted into a dead overlay.
function mountTurnstile(getForm, selector) {
  const form = getForm();
  if (!form || form.turnstileWidget != null) return;
  ensureTurnstile(() => {
    const holder = document.querySelector(selector);
    const live = getForm();
    if (holder && window.turnstile && live === form && live.turnstileWidget == null) {
      try { live.turnstileWidget = window.turnstile.render(holder, { sitekey: TURNSTILE_SITEKEY }); } catch { /* already rendered */ }
    }
  });
}

// Shared submit pipeline of the contribute and new-field forms: anti-spam token check, busy
// toggle, photo payload, POST, stale-form guards, error display and the single-use token
// reset (without it every retry re-sends a token the Worker already redeemed and the spam
// check fails forever). Callers pre-validate and provide the form-specific payload.
async function submitContribForm({ form, fd, stillOpen, onClose, updateValidity }) {
  let token = '';
  if (window.turnstile && form.turnstileWidget != null) {
    token = window.turnstile.getResponse(form.turnstileWidget) || '';
    if (!token) { contribShowError(t('cNeedTurnstile')); return; }
  }
  if (token) fd.set('turnstileToken', token);
  if (state.position) { fd.set('deviceLat', String(state.position.latitude)); fd.set('deviceLon', String(state.position.longitude)); }
  for (const p of form.photos) fd.append('photos', p.blob, p.name || 'photo.jpg');

  const submit = document.querySelector('#cSubmit');
  form.busy = true;
  if (submit) { submit.disabled = true; submit.textContent = t('cSubmitting'); }

  try {
    const res = await fetch(CONTRIB_ENDPOINT, { method: 'POST', body: fd });
    const data = await res.json().catch(() => ({}));
    if (!stillOpen()) return; // form closed while the request was in flight
    if (res.ok && data.ok) { showContribSuccess(data, onClose); return; }
    contribShowError(`${t('cErr')}: ${String(data.error || res.status)}`);
  } catch (err) {
    if (!stillOpen()) return;
    contribShowError(`${t('cErr')}: ${String(err && err.message || err)}`);
  }
  try { if (window.turnstile && form.turnstileWidget != null) window.turnstile.reset(form.turnstileWidget); } catch { /* widget gone */ }
  form.busy = false;
  if (submit) { submit.textContent = t('cSubmit'); }
  updateValidity();
}

async function submitContribution(field) {
  const form = contribForm;
  if (!form || form.busy) return;
  contribShowError('');
  const fd = new FormData();
  fd.set('fieldId', field.id);
  // Raw code, not displayCode: this identifies the field to the review queue, and a minted key
  // still identifies it. fieldId is the authoritative key; this is corroboration.
  fd.set('fieldCode', field.code || '');
  fd.set('fieldName', field.name || '');
  fd.set('fieldLat', String(field.latitude));
  fd.set('fieldLon', String(field.longitude));
  fd.set('date', document.querySelector('#cDate')?.value || new Date().toISOString().slice(0, 10));
  fd.set('description', (document.querySelector('#cDesc')?.value || '').trim());
  fd.set('submitter', (document.querySelector('#cSubmitter')?.value || '').trim());
  await submitContribForm({
    form, fd,
    stillOpen: () => contribForm === form,
    onClose: closeContribute,
    updateValidity: updateContribValidity,
  });
}

function showContribSuccess(data, onDone) {
  const body = document.querySelector('#contribBody');
  if (!body) return;
  const verified = data.geo && data.geo.verified;
  body.innerHTML = `
    <div class="contrib-done">
      <div class="contrib-tick">✓</div>
      <div class="contrib-done-title">${escapeHtml(t('cThanks'))}</div>
      <div class="contrib-done-body">${escapeHtml(t('cThanksBody', data.prNumber))}</div>
      ${verified ? '<span class="contrib-geo ok inline">● geo-verified</span>' : ''}
      ${data.prUrl ? `<a href="${escapeHtml(data.prUrl)}" target="_blank" rel="noopener" class="contrib-pr">${t('cViewPr')}</a>` : ''}
      <button id="cDone" class="primary">${t('done')}</button>
    </div>
  `;
  document.querySelector('#cDone')?.addEventListener('click', onDone);
}

// --- "Suggest a new field": a proposal form reached from the search results. Submits the
// proposed field's data + photos to the same intake Worker, which opens a reviewable PR. ---

function renderNewField() {
  if (!state.showNewField) return '';
  const countries = ['FR', 'CH', 'DE', 'IT', 'AT'];
  return `
    <div class="detail-backdrop contrib-backdrop" id="newFieldBackdrop">
      <article class="detail contrib" role="dialog" aria-modal="true" aria-label="${escapeHtml(t('suggestField'))}">
        <button id="closeNewField">${t('close')}</button>
        <div class="detail-title-row"><h2>${escapeHtml(t('suggestField'))}</h2></div>
        <div class="detail-meta">${escapeHtml(t('nfIntro'))}</div>
        <div id="contribBody" class="contrib-form">
          <label for="nfName">${t('nfName')}</label>
          <input id="nfName" type="text" autocomplete="off" value="${escapeHtml(state.searchQuery.trim())}" />
          <div class="nf-grid">
            <div><label for="nfKind">${t('nfKind')}</label>
              <select id="nfKind">
                <option value="outlanding">${escapeHtml(t('outlanding'))}</option>
                <option value="airfield">${escapeHtml(t('airfield'))}</option>
              </select></div>
            <div><label for="nfCountry">${t('nfCountry')}</label>
              <select id="nfCountry">${countries.map(c => `<option value="${c}">${c}</option>`).join('')}</select></div>
          </div>
          <label>${t('nfCoords')}</label>
          <div class="nf-grid nf-coords">
            <input id="nfLat" type="number" step="any" min="-90" max="90" placeholder="${escapeHtml(t('nfLat'))}" />
            <input id="nfLon" type="number" step="any" min="-180" max="180" placeholder="${escapeHtml(t('nfLon'))}" />
            <button type="button" id="nfUseGps" class="contrib-photo-btn">📍 ${t('nfUseGps')}</button>
          </div>
          <div class="nf-grid">
            <div><label for="nfElev">${t('nfElev')}</label><input id="nfElev" type="number" step="1" /></div>
            <div><label for="nfDifficulty">${t('nfDifficulty')}</label>
              <select id="nfDifficulty">
                <option value="">${escapeHtml(t('nfDiffUnknown'))}</option>
                <option value="A">A</option><option value="B">B</option><option value="C">C</option>
              </select></div>
          </div>
          <div class="nf-grid nf-runway">
            <div><label for="nfRunway">${t('nfRunway')}</label><input id="nfRunway" type="text" autocomplete="off" placeholder="07/25" /></div>
            <div><label for="nfLength">${t('nfLength')}</label><input id="nfLength" type="number" step="1" min="0" /></div>
            <div><label for="nfWidth">${t('nfWidth')}</label><input id="nfWidth" type="number" step="1" min="0" /></div>
          </div>
          <div class="nf-grid">
            <div><label for="nfSurface">${t('nfSurface')}</label><input id="nfSurface" type="text" autocomplete="off" placeholder="${escapeHtml(t('nfSurfacePh'))}" /></div>
            <div><label for="nfFrequency">${t('nfFrequency')}</label><input id="nfFrequency" type="text" autocomplete="off" placeholder="123.500" /></div>
          </div>
          <label for="cDesc">${t('nfDesc')}</label>
          <textarea id="cDesc" rows="4" placeholder="${escapeHtml(t('nfDescPlaceholder'))}"></textarea>
          ${renderContribFormTail()}
        </div>
      </article>
    </div>
  `;
}

function openNewField() {
  newFieldForm = { photos: [], busy: false, turnstileWidget: null };
  state.showNewField = true;
  render();
}

function closeNewField() {
  state.showNewField = false;
  newFieldForm = null;
  render();
}

function newFieldCoords() {
  // A blank number input reads '' and Number('') is 0 — a half-filled pair must not validate
  // as a field on the equator/prime meridian, so each axis is required to be non-blank.
  const latRaw = (document.querySelector('#nfLat')?.value ?? '').trim();
  const lonRaw = (document.querySelector('#nfLon')?.value ?? '').trim();
  if (latRaw === '' || lonRaw === '') return null;
  const lat = Number(latRaw);
  const lon = Number(lonRaw);
  const plausible = Number.isFinite(lat) && Number.isFinite(lon)
    && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && (lat !== 0 || lon !== 0);
  return plausible ? { lat, lon } : null;
}

function updateNewFieldValidity() {
  const submit = document.querySelector('#cSubmit');
  if (!submit || !newFieldForm) return;
  const named = (document.querySelector('#nfName')?.value || '').trim().length >= 3;
  const licensed = !!document.querySelector('#cLicense')?.checked;
  submit.disabled = newFieldForm.busy || !licensed || !named || !newFieldCoords();
}

async function submitNewField() {
  const form = newFieldForm;
  if (!form || form.busy) return;
  contribShowError('');
  const coords = newFieldCoords();
  const name = (document.querySelector('#nfName')?.value || '').trim();
  if (!name || !coords) { contribShowError(t('nfNeedBasics')); return; }
  const val = id => (document.querySelector(`#${id}`)?.value || '').trim();
  const fd = new FormData();
  fd.set('type', 'new-field');
  fd.set('name', name);
  fd.set('kind', val('nfKind') || 'outlanding');
  fd.set('country', val('nfCountry'));
  fd.set('lat', String(coords.lat));
  fd.set('lon', String(coords.lon));
  fd.set('elevationM', val('nfElev'));
  fd.set('difficulty', val('nfDifficulty'));
  fd.set('runway', val('nfRunway'));
  fd.set('lengthM', val('nfLength'));
  fd.set('widthM', val('nfWidth'));
  fd.set('surface', val('nfSurface'));
  fd.set('frequency', val('nfFrequency'));
  fd.set('description', val('cDesc'));
  fd.set('submitter', val('cSubmitter'));
  await submitContribForm({
    form, fd,
    stillOpen: () => newFieldForm === form,
    onClose: closeNewField,
    updateValidity: updateNewFieldValidity,
  });
}

function wireNewFieldForm() {
  document.querySelector('#closeNewField')?.addEventListener('click', closeNewField);
  document.querySelector('#newFieldBackdrop')?.addEventListener('click', e => { if (e.target.id === 'newFieldBackdrop') closeNewField(); });
  document.querySelector('#nfUseGps')?.addEventListener('click', () => {
    if (!state.position) { contribShowError(t('nfGpsNone')); return; }
    const latInput = document.querySelector('#nfLat');
    const lonInput = document.querySelector('#nfLon');
    if (latInput) latInput.value = state.position.latitude.toFixed(5);
    if (lonInput) lonInput.value = state.position.longitude.toFixed(5);
    // Programmatic .value changes fire no input event: persist + re-verdict explicitly.
    if (!newFieldForm.values) newFieldForm.values = {};
    newFieldForm.values.nfLat = latInput?.value ?? '';
    newFieldForm.values.nfLon = lonInput?.value ?? '';
    contribShowError('');
    updateNewFieldValidity();
    refreshPhotoGeo();
  });
  document.querySelector('#cPhotoBtn')?.addEventListener('click', () => document.querySelector('#cPhoto')?.click());
  document.querySelector('#cPhoto')?.addEventListener('change', e => stageContribPhotos(newFieldForm, e.target.files, newFieldCoords));
  // Coordinate edits also refresh each staged photo's advisory geo verdict — a photo added
  // before the coordinates were typed must not keep its 'no location' marker forever.
  const refreshPhotoGeo = () => {
    if (!newFieldForm) return;
    const target = newFieldCoords();
    for (const p of newFieldForm.photos) p.geo = contribGeoHint(target?.lat, target?.lon, p.exifGps || null);
    renderContribPhotoList(newFieldForm);
  };
  for (const id of ['nfName', 'nfLat', 'nfLon']) {
    document.querySelector(`#${id}`)?.addEventListener('input', () => {
      updateNewFieldValidity();
      if (id !== 'nfName') refreshPhotoGeo();
    });
  }
  document.querySelector('#cLicense')?.addEventListener('change', updateNewFieldValidity);
  document.querySelector('#cSubmit')?.addEventListener('click', submitNewField);
  if (newFieldForm) { trackFormValues(newFieldForm); restoreFormState(newFieldForm); }
  mountTurnstile(() => newFieldForm, '#cTurnstile');
  updateNewFieldValidity();
}

// --- In-app bug report: a short anonymous form; the Worker files the GitHub issue. ---

function renderBugReport() {
  if (!state.showBugReport) return '';
  return `
    <div class="detail-backdrop contrib-backdrop" id="bugBackdrop">
      <article class="detail contrib" role="dialog" aria-modal="true" aria-label="${escapeHtml(t('reportBug'))}">
        <button id="closeBug">${t('close')}</button>
        <div class="detail-title-row"><h2>🐞 ${t('reportBug')}</h2></div>
        <div id="bugBody" class="contrib-form">
          <label for="bugDesc">${t('bugWhat')}</label>
          <textarea id="bugDesc" rows="5" placeholder="${escapeHtml(t('bugPlaceholder'))}"></textarea>
          <input id="bugContact" type="text" autocomplete="off" placeholder="${escapeHtml(t('bugContact'))}" />
          <p class="settings-note bug-diag">${escapeHtml(t('bugIncluded'))}<br>${escapeHtml(bugDiagnostics()).replace(/\n/g, '<br>')}</p>
          <div id="bugTurnstile" class="contrib-turnstile"></div>
          <div id="bugError" class="contrib-error" hidden></div>
          <button id="bugSubmit" class="primary contrib-submit" disabled>${t('bugSubmit')}</button>
          <a class="settings-note bug-github" href="${githubIssueUrl()}" target="_blank" rel="noopener">${escapeHtml(t('bugGithubAlt'))}</a>
        </div>
      </article>
    </div>
  `;
}

function openBugReport() {
  bugForm = { busy: false, turnstileWidget: null };
  state.showBugReport = true;
  render();
}

function closeBugReport() {
  bugForm = null;
  state.showBugReport = false;
  render();
}

function wireBugForm() {
  document.querySelector('#closeBug')?.addEventListener('click', closeBugReport);
  document.querySelector('#bugBackdrop')?.addEventListener('click', e => { if (e.target.id === 'bugBackdrop') closeBugReport(); });
  document.querySelector('#bugDesc')?.addEventListener('input', updateBugValidity);
  document.querySelector('#bugSubmit')?.addEventListener('click', submitBugReport);
  mountTurnstile(() => bugForm, '#bugTurnstile');
  updateBugValidity();
}

function updateBugValidity() {
  const submit = document.querySelector('#bugSubmit');
  if (submit && bugForm && !bugForm.busy) submit.disabled = !(document.querySelector('#bugDesc')?.value || '').trim();
}

function bugShowError(message) {
  const form = bugForm;
  if (form) form.busy = false;
  const el = document.querySelector('#bugError');
  if (el) { el.hidden = false; el.textContent = message; }
  const submit = document.querySelector('#bugSubmit');
  if (submit) submit.textContent = t('bugSubmit');
  updateBugValidity();
  // Turnstile tokens are single-use: reset so a retry gets a fresh token.
  try { if (window.turnstile && form && form.turnstileWidget != null) window.turnstile.reset(form.turnstileWidget); } catch { /* widget gone */ }
}

async function submitBugReport() {
  const form = bugForm;
  if (!form || form.busy) return;
  const description = (document.querySelector('#bugDesc')?.value || '').trim();
  if (!description) { bugShowError(t('bugNeedDesc')); return; }
  let token = '';
  if (window.turnstile && form.turnstileWidget != null) {
    token = window.turnstile.getResponse(form.turnstileWidget) || '';
    if (!token) { bugShowError(t('cNeedTurnstile')); return; }
  }
  const submit = document.querySelector('#bugSubmit');
  form.busy = true;
  if (submit) { submit.disabled = true; submit.textContent = t('bugSending'); }

  const fd = new FormData();
  fd.set('description', description);
  fd.set('contact', (document.querySelector('#bugContact')?.value || '').trim());
  fd.set('diagnostics', bugDiagnostics());
  if (token) fd.set('turnstileToken', token);

  try {
    const res = await fetch(BUG_ENDPOINT, { method: 'POST', body: fd });
    const data = await res.json().catch(() => ({}));
    if (bugForm !== form) return; // form closed while the request was in flight
    if (res.ok && data.ok) { showBugSuccess(data); return; }
    bugShowError(`${t('bugErr')}: ${String(data.error || res.status)}`);
  } catch (error) {
    if (bugForm !== form) return;
    bugShowError(`${t('bugErr')}: ${error.message || error}`);
  }
}

function showBugSuccess(data) {
  const body = document.querySelector('#bugBody');
  if (!body) return;
  body.innerHTML = `
    <div class="contrib-done">
      <div class="contrib-tick">✓</div>
      <div class="contrib-done-title">${escapeHtml(t('bugThanks'))}</div>
      <div class="contrib-done-body">${escapeHtml(t('bugThanksBody', data.issueNumber))}</div>
      ${data.issueUrl ? `<a href="${escapeHtml(data.issueUrl)}" target="_blank" rel="noopener" class="contrib-pr">${t('bugViewIssue')}</a>` : ''}
      <button id="bugDone" class="primary">${t('done')}</button>
    </div>
  `;
  document.querySelector('#bugDone')?.addEventListener('click', closeBugReport);
}

function wireContribForm(field) {
  document.querySelector('#closeContribute')?.addEventListener('click', closeContribute);
  document.querySelector('#contribBackdrop')?.addEventListener('click', e => { if (e.target.id === 'contribBackdrop') closeContribute(); });
  document.querySelector('#cPhotoBtn')?.addEventListener('click', () => document.querySelector('#cPhoto')?.click());
  document.querySelector('#cPhoto')?.addEventListener('change', e => stageContribPhotos(contribForm, e.target.files, () => ({ lat: field.latitude, lon: field.longitude })));
  document.querySelector('#cDesc')?.addEventListener('input', updateContribValidity);
  document.querySelector('#cLicense')?.addEventListener('change', updateContribValidity);
  document.querySelector('#cSubmit')?.addEventListener('click', () => submitContribution(field));
  if (contribForm) { trackFormValues(contribForm); restoreFormState(contribForm); }
  mountTurnstile(() => contribForm, '#cTurnstile');
  updateContribValidity();
}

// Update only the results list while typing — a full render() would rebuild the focused
// search input and make the phone keyboard flicker (same in-place pattern as the download bar).
function updateSearchResults() {
  const area = document.querySelector('#fieldListArea');
  if (!area) { render(); return; }
  area.innerHTML = renderFieldList();
  attachFieldRowEvents(area);
  const clear = document.querySelector('#clearSearch');
  if (clear) clear.hidden = !state.searchQuery;
}

function attachFieldRowEvents(root) {
  root.querySelectorAll('[data-field-id]').forEach(row => row.addEventListener('click', () => {
    state.selectedFieldId = row.getAttribute('data-field-id');
    state.detailScrollTop = 0;
    // A gated chart in this field renders as an <iframe>, whose src wants a token. Start the
    // mint BEFORE rendering: its synchronous head sets chartTokenPending, which makes the
    // render below show the chart card without an iframe instead of firing a tokenless request
    // that can only 403. When the mint settles — token or not — re-render: with the token, or
    // with the bare URL, which the service worker still answers from cache for a downloaded
    // chart. Offline, the failed mint settles in milliseconds; nothing waits on the network.
    const field = state.fields.find(f => f.id === state.selectedFieldId);
    if (field?.media?.some(item => chartUrl(item))) {
      ensureChartToken().then(() => {
        if (state.selectedFieldId === field.id) render();
      });
    }
    render();
  }));
  // Rendered as part of the search results, so it must be (re)wired on every in-place update.
  root.querySelectorAll('#suggestField').forEach(btn => btn.addEventListener('click', openNewField));
}

function attachEvents() {
  document.querySelector('#fieldSearch')?.addEventListener('input', e => { state.searchQuery = e.target.value; updateSearchResults(); });
  document.querySelector('#clearSearch')?.addEventListener('click', () => {
    state.searchQuery = '';
    const search = document.querySelector('#fieldSearch');
    if (search) search.value = '';
    updateSearchResults();
    search?.focus();
  });
  document.querySelector('#openContribute')?.addEventListener('click', () => openContribute(state.selectedFieldId));
  if (state.contribFor) {
    const contribField = state.fields.find(f => f.id === state.contribFor);
    if (contribField) wireContribForm(contribField);
  }
  if (state.showNewField) wireNewFieldForm();
  document.querySelector('#releaseBannerBtn')?.addEventListener('click', openReleaseNotes);
  document.querySelector('#reloadAppBtn')?.addEventListener('click', () => location.reload());
  document.querySelector('#whatsNewLink')?.addEventListener('click', e => { e.preventDefault(); openReleaseNotes(); });
  document.querySelector('#closeNotes')?.addEventListener('click', () => { state.showReleaseNotes = false; render(); });
  document.querySelector('#notesBackdrop')?.addEventListener('click', e => {
    if (e.target.id === 'notesBackdrop') { state.showReleaseNotes = false; render(); }
  });
  document.querySelector('#migrationBannerBtn')?.addEventListener('click', () => { state.showMigrationSheet = true; render(); });
  document.querySelector('#migrationSettingsBtn')?.addEventListener('click', () => { state.showMigrationSheet = true; render(); });
  document.querySelector('#closeMigration')?.addEventListener('click', () => { state.showMigrationSheet = false; render(); });
  document.querySelector('#migrationBackdrop')?.addEventListener('click', e => {
    if (e.target.id === 'migrationBackdrop') { state.showMigrationSheet = false; render(); }
  });
  document.querySelector('#migrationSnooze')?.addEventListener('click', () => {
    try { localStorage.setItem(MIGRATION_SNOOZE_KEY, String(Date.now() + MIGRATION_SNOOZE_MS)); } catch { /* storage disabled */ }
    state.showMigrationSheet = false;
    render();
  });
  document.querySelector('#settingsToggle')?.addEventListener('click', () => { state.view = state.view === 'settings' ? 'main' : 'settings'; if (state.view === 'settings') terrainSyncRetriedThisVisit = false; render(); });
  // The terrain card needs the published tile index and a cache count, neither of which is worth
  // fetching until someone opens Settings. refreshTerrainStatus re-renders once when they land.
  if (state.view === 'settings') refreshTerrainStatus();
  document.querySelector('#closeSettings')?.addEventListener('click', () => { state.view = 'main'; render(); });
  document.querySelector('#sharePack')?.addEventListener('click', shareApp);
  document.querySelector('#reportBug')?.addEventListener('click', openBugReport);
  if (state.showBugReport) wireBugForm();
  document.querySelector('#reloadPackSettings')?.addEventListener('click', async () => { await reloadSelectedPack(); render(); });
  document.querySelector('#languageSelect')?.addEventListener('change', e => {
    state.settings.language = e.target.value;
    saveSettings();
    render();
  });
  document.querySelectorAll('.packCheck').forEach(cb => cb.addEventListener('change', async () => {
    const chosen = Array.from(document.querySelectorAll('.packCheck')).filter(c => c.checked).map(c => c.value);
    state.settings.packIds = chosen;  // empty is allowed: the app then runs GPS-only
    saveSettings();
    state.cacheStatus = 'refreshing';
    state.cacheProgress = t('cpFetchPack');
    render();
    await loadSelectedPacks();
    render();
  }));
  document.querySelector('#safetyMarginM')?.addEventListener('change', e => {
    state.settings.safetyMarginM = Number(e.target.value);
    saveSettings();
    render();
  });
  document.querySelector('#terrainRouting')?.addEventListener('change', e => {
    // No consent sheet: the routed glide is the conservative option (max-pooled terrain, the
    // clearance ramp, and it refuses what it cannot prove), so a warning would guard the wrong
    // thing. The "Experimental" tag on the card is the honest label, and it stays.
    if (!e.target.checked) {
      state.settings.terrainRouting = false;
      saveSettings();
      invalidateTerrainRoutes();
      render();
      return;
    }
    state.settings.terrainRouting = true;
    saveSettings();
    // Switching it on is a fresh start: whatever the network refused last time is worth one more
    // try, since the pilot is asking for terrain now and may well be somewhere else than they were.
    state.terrain.store?.retryFailures();
    state.terrain.available = null;
    invalidateTerrainRoutes();
    render();
    refreshTerrainRoutes().catch(error => console.warn('Terrain routing failed', error));
    autoSyncTerrainTiles().catch(error => console.warn('Terrain sync failed', error));
  });
  // Dragging fires continuously, so the live readout updates in place and nothing else happens
  // until the pilot lets go. A wavefront per pixel of travel would be absurd, and a re-render
  // mid-drag would tear the slider out from under their thumb.
  document.querySelector('#terrainClearanceM')?.addEventListener('input', e => {
    const metres = Number(e.target.value);
    const readout = document.querySelector('#terrainClearanceValue');
    if (readout) readout.textContent = fmtM(metres);
    const note = document.querySelector('#terrainClearanceNote');
    if (note) note.textContent = t('terrainClearanceNote', metres);
  });
  document.querySelector('#terrainClearanceM')?.addEventListener('change', e => {
    state.settings.terrainClearanceM = Number(e.target.value);
    saveSettings();
    invalidateTerrainRoutes();
    render();
    refreshTerrainRoutes().catch(error => console.warn('Terrain routing failed', error));
    autoSyncTerrainTiles().catch(error => console.warn('Terrain sync failed', error));
  });
  for (const id of ['showC', 'showD']) {
    document.querySelector(`#${id}`)?.addEventListener('change', e => {
      if (e.target.checked) {
        // Revealing difficult fields — make the pilot acknowledge the risk before showing them.
        const label = id === 'showC' ? 'C' : 'D';
        const severity = label === 'D' ? t('sevVeryDifficult') : t('sevDifficult');
        const ok = confirm(t('revealConfirm', label, severity));
        if (!ok) {
          e.target.checked = false; // decline: leave them hidden
          return;
        }
      }
      state.settings[id] = e.target.checked;
      saveSettings();
      render();
    });
  }
  // The ground-testing switch. On: the card extends to pick a place and altitude, and a place
  // remembered from last time resumes at once. Off: back to the real GPS.
  document.querySelector('#testMode')?.addEventListener('change', e => {
    if (!e.target.checked) { stopTestMode(); return; }
    state.settings.testMode = true;
    saveSettings();
    if (Number.isFinite(state.settings.testLatitude)) {
      stopGps();
      applyTestPosition();
      onSimulatedPositionChanged();
    }
    refreshTestGround();
    render();
  });
  document.querySelector('#testPlace')?.addEventListener('input', e => queuePlaceSearch(e.target.value));
  document.querySelector('#testPlace')?.addEventListener('keydown', e => {
    // Enter only skips the wait; it is not required to get results.
    if (e.key === 'Enter') {
      e.preventDefault();
      window.clearTimeout(placeSearchTimer);
      runPlaceSearch(e.target.value);
    }
  });
  attachTestResultEvents();
  // The AMSL/AGL reference toggle: same number line, different zero.
  document.querySelector('#altUnitAmsl')?.addEventListener('click', () => {
    if (state.settings.testAltitudeMode === 'amsl') return;
    state.settings.testAltitudeMode = 'amsl';
    saveSettings();
    render();
  });
  document.querySelector('#altUnitAgl')?.addEventListener('click', () => {
    if (state.settings.testAltitudeMode === 'agl' || !Number.isFinite(state.testGroundM)) return;
    state.settings.testAltitudeMode = 'agl';
    applyTestAgl();
    render();
  });
  // Dragging updates the readout only; the position is re-adopted on release, same reasoning as
  // the terrain clearance slider.
  document.querySelector('#testAltitudeM')?.addEventListener('input', e => {
    const agl = state.settings.testAltitudeMode === 'agl' && Number.isFinite(state.testGroundM);
    const value = Number(e.target.value);
    const readout = document.querySelector('#testAltitudeValue');
    if (readout) readout.textContent = agl ? `${fmtM(value)} AGL` : fmtM(value);
    const note = document.querySelector('#testAltitudeNote');
    if (note && Number.isFinite(state.testGroundM)) {
      note.textContent = agl
        ? t('testAglLine', fmtM(state.testGroundM), fmtM(state.testGroundM + value))
        : t('testAmslLine', fmtM(state.testGroundM), fmtM(Math.max(0, value - state.testGroundM)));
    }
  });
  document.querySelector('#testAltitudeM')?.addEventListener('change', e => {
    const value = Number(e.target.value);
    if (state.settings.testAltitudeMode === 'agl' && Number.isFinite(state.testGroundM)) {
      state.settings.testAglM = value;
      applyTestAgl();
    } else {
      // The browser clamps the handle to the track, but the value can still arrive from a stale
      // render or a scripted change — the floor is enforced here so the stored altitude and the
      // slider can never tell different stories.
      state.settings.testAltitudeM = Math.max(testAltitudeFloorM(), value);
      saveSettings();
      if (state.settings.testMode && Number.isFinite(state.settings.testLatitude)) {
        applyTestPosition();
        onSimulatedPositionChanged();
      }
    }
    render();
  });
  document.querySelector('#testBannerStop')?.addEventListener('click', stopTestMode);
  document.querySelector('#downloadPack')?.addEventListener('click', downloadOfflinePack);
  document.querySelector('#exportCup')?.addEventListener('click', exportCup);
  document.querySelector('#syncDataBtn')?.addEventListener('click', () => {
    // Jump to Settings so the pilot watches the sync progress there, instead of the
    // banner appearing to do nothing (progress only renders on the settings page).
    terrainSyncRetriedThisVisit = false;
    state.view = 'settings';
    syncPackDelta();
  });
  attachFieldRowEvents(document);
  document.querySelector('.detail')?.addEventListener('scroll', e => { state.detailScrollTop = e.currentTarget.scrollTop; }, { passive: true });
  document.querySelector('#closeDetail')?.addEventListener('click', () => { state.selectedFieldId = null; state.detailScrollTop = 0; render(); });
  document.querySelector('#detailBackdrop')?.addEventListener('click', e => {
    if (e.target.id === 'detailBackdrop') { state.selectedFieldId = null; state.detailScrollTop = 0; render(); }
  });
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // The worker answers pack data from the cache and refreshes it behind us, so the manifest this
  // page loaded may already be yesterday's by the time it renders. When the refresh finds the
  // published data has actually moved, the worker says so and we re-read it — from the cache it
  // has just updated, so this costs no round trip and cannot stall.
  navigator.serviceWorker.addEventListener('message', event => {
    if (event.data?.type === 'mtc-pack-changed') schedulePackReread();
    if (event.data?.type === 'mtc-notes-changed') rereadReleaseNotes();
    if (event.data?.type === 'mtc-terrain-index-changed') scheduleTerrainIndexReread();
  });
  // On a first-ever visit the worker claims this page as soon as it activates, which is also a
  // controllerchange — but nothing about the running code is stale, so only a page that ALREADY
  // had a controller is looking at a genuinely new build.
  let controlled = !!navigator.serviceWorker.controller;
  // A new worker taking over means the cache now holds code this document is not running. Never
  // reload from under the pilot — say so and let them pick the moment.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (controlled) {
      state.updateReadyOnReload = true;
      render();
    }
    controlled = true;
  });
  try {
    swRegistration = await navigator.serviceWorker.register(new URL('service-worker.js', BASE_URL));
  } catch (e) { console.warn(e); }
}

// An installed app is not reloaded, it is resumed: iOS keeps it suspended in the app switcher
// and hands the same document back, so init() runs once and may not run again for days. Nothing
// below happens on its own in that document — the update check and the notes re-read are the two
// things a launch would have done.
const RESUME_CHECK_MS = 60000;
let lastResumeCheck = 0;

function watchForResume() {
  document.addEventListener('visibilitychange', checkForUpdatesOnResume);
  // A bfcache restore fires pageshow with persisted=true and no visibilitychange at all.
  window.addEventListener('pageshow', event => { if (event.persisted) checkForUpdatesOnResume(); });
}

function checkForUpdatesOnResume() {
  if (document.visibilityState !== 'visible') return;
  const now = Date.now();
  // App-switching is constant in the cockpit; a check per switch would be a request per switch.
  if (now - lastResumeCheck < RESUME_CHECK_MS) return;
  lastResumeCheck = now;
  // Re-fetch the worker script. A changed build installs, claims the page, and tells us via
  // controllerchange. Failure is the normal offline case and needs no handling.
  swRegistration?.update().catch(() => {});
  rereadReleaseNotes();
}

// Read the notes again. The worker serves them from the cache, so this is free when nothing
// moved; when the worker has just refreshed them it is the updated copy, still with no round trip.
async function rereadReleaseNotes() {
  try {
    const res = await fetch(RELEASE_NOTES_URL);
    if (!res.ok) return;
    const notes = await res.json();
    if (!Array.isArray(notes) || !notes.length) return;
    state.releaseNotes = notes;
    render();
  } catch { /* offline: keep what we have */ }
}

// The published terrain index moved: forget the held copy and recount what is offline against
// the new one. Routes are NOT invalidated — the cached tiles still carry their versioned URLs
// and still route; what changes is the accounting, so Settings can say "1 of 2 tiles offline"
// and the download button has work again, in this session rather than the next one. Debounced
// like the pack re-read, and for the same reason.
let terrainIndexRereadTimer = null;
function scheduleTerrainIndexReread() {
  clearTimeout(terrainIndexRereadTimer);
  terrainIndexRereadTimer = setTimeout(async () => {
    terrainIndexRereadTimer = null;
    try {
      const store = state.terrain.store;
      if (!store) return;
      store.dropIndex();
      // Reload before recounting: checkTerrainCacheStatus reads store.index as a property and
      // loads nothing itself. The fetch is answered by the copy the worker's refresh just
      // cached, so this settles locally.
      await store.loadIndex();
      await checkTerrainCacheStatus();
      await autoSyncTerrainTiles();
      render();
    } catch (error) {
      console.warn('Terrain index re-read failed', error);
    }
  }, 400);
}

// Several files change together on a rebuild — packs.json and every manifest — so the worker
// reports several times in a row. Coalesce: one re-read after the last of them.
let packRereadTimer = null;
function schedulePackReread() {
  clearTimeout(packRereadTimer);
  packRereadTimer = setTimeout(async () => {
    packRereadTimer = null;
    try {
      await loadPackIndex();
      await loadSelectedPacks();
      render();
    } catch (error) {
      console.warn('Pack re-read failed', error);
    }
  }, 400);
}

async function clearPackCache(packId) {
  if (!('caches' in window) || !packId) return 0;
  const packRootUrl = new URL(`packs/${packId}/`, dataBase).toString();
  const cache = await caches.open(DATA_CACHE);
  let deleted = 0;
  for (const request of await cache.keys()) {
    if (request.url === packIndexUrl() || request.url.startsWith(packRootUrl)) {
      if (await cache.delete(request)) deleted += 1;
    }
  }
  return deleted;
}

// Every media/doc URL the current selection references, mapped to the file size the build
// stamped on it (0 when a pack predates the bytes stamp — those are only presence-checked).
function buildOfflineMediaTargets() {
  const targets = new Map();
  for (const field of state.fields) {
    const base = field._base || state.currentManifestUrl;
    if (!base) continue;
    for (const media of field.media || []) {
      if (!media?.url) continue;
      // Gated charts are targeted by their token-free Worker URL, which is also what they are
      // cached under — so a rotating token never turns a cached chart into a missing one.
      const url = chartUrl(media) || new URL(media.url, base).toString();
      if (!targets.has(url)) targets.set(url, Number(media.bytes) || 0);
    }
  }
  return targets;
}

function buildOfflineMediaUrls() {
  return Array.from(buildOfflineMediaTargets().keys());
}

async function downloadOfflinePack() {
  if (!('caches' in window)) {
    alert(t('noCacheApi'));
    return;
  }

  const targets = buildOfflineMediaTargets();
  if (!targets.size) {
    state.cacheStatus = state.packManifest ? 'ready' : 'unknown';
    state.cacheProgress = state.packManifest ? t('cpNoMedia') : t('cpNoPack');
    render();
    return;
  }

  const cache = await caches.open(DATA_CACHE);
  state.cacheStatus = 'downloading';

  // Delta sync: always fetch files missing from the cache; additionally, when any selected
  // pack's version drifted since the last recorded sync (or none was recorded), re-fetch files
  // whose cached size no longer matches the size the build stamped in fields.json. One updated
  // photo costs one download, not the whole pack.
  const anyDrift = (state.activePacks || []).some(({ pack, manifest }) => {
    const synced = localStorage.getItem(syncedVersionKey(pack.id)) || '';
    return !synced || synced !== (manifest?.version || '');
  });
  // The scan below is thousands of sequential cache lookups when every pack is selected —
  // seconds of dead air on a phone. Show the bar for it, in its "checking" phase, from the
  // first frame after the tap.
  const cachedUrls = new Set((await cache.keys()).map(request => request.url));
  state.offlineSync = { done: 0, total: targets.size, failed: 0, checking: true };
  render();
  const toFetch = [];
  let kept = 0;
  let scanned = 0;
  for (const [url, expectedBytes] of targets) {
    scanned += 1;
    if (scanned % 100 === 0) {
      state.offlineSync = { done: scanned, total: targets.size, failed: 0, checking: true };
      updateOfflineBar();
      await new Promise(resolve => setTimeout(resolve, 0)); // let the bar paint
    }
    if (!cachedUrls.has(url)) { toFetch.push(url); continue; }
    if (anyDrift && expectedBytes) {
      const cached = await cache.match(url);
      const cachedBytes = Number(cached?.headers?.get('content-length') || 0);
      if (cachedBytes && cachedBytes !== expectedBytes) { toFetch.push(url); continue; }
    }
    kept += 1;
  }

  let ok = kept;
  let failed = 0;
  if (toFetch.length) {
    // Byte weights for the bar: the size the build stamped on each file, and the average of
    // the known sizes for anything unstamped (packs from before the bytes stamp), so a mixed
    // list still reaches 100% exactly when the last file lands.
    const sizes = toFetch.map(url => targets.get(url) || 0);
    const knownSizes = sizes.filter(Boolean);
    const averageSize = knownSizes.length ? knownSizes.reduce((a, b) => a + b, 0) / knownSizes.length : 1;
    const weights = sizes.map(size => size || averageSize);
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    let doneWeight = 0;
    state.offlineSync = { done: 0, total: toFetch.length, failed: 0, doneWeight, totalWeight };
    render();  // once: shows the floating bar; per-file updates below are in place (no re-render)
    for (let i = 0; i < toFetch.length; i += 1) {
      const url = toFetch[i];
      try {
        // Re-checked per chart, not once for the whole run: an all-packs download on cockpit
        // bandwidth can outlive the token's hour, and ensureChartToken is a no-op until the
        // expiry gets close.
        if (isChartUrl(url)) await ensureChartToken();
        const response = await fetch(isChartUrl(url) ? tokenedChartUrl(url) : url, { cache: 'reload' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        // Stored under the token-free URL on purpose — see chartUrl.
        await cache.put(url, response.clone());
        ok += 1;
      } catch (error) {
        if (await cache.match(url)) {
          ok += 1;
          console.warn('Offline cache kept existing entry', url, error);
        } else {
          console.warn('Offline cache failed', url, error);
          failed += 1;
        }
      }

      doneWeight += weights[i];  // progress is work attempted; a failed file still advances
      state.offlineSync = { done: i + 1, total: toFetch.length, failed, doneWeight, totalWeight };
      updateOfflineBar();
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  // Record each pack's synced version so the data-update banner can compare it against the
  // published one. Only after a clean sync: on failures the old baseline stays, keeping the
  // update prompt alive for a retry.
  if (failed === 0) {
    for (const { pack, manifest } of state.activePacks || []) {
      storeSyncedVersion(pack.id, manifest?.version);
    }
    updateDataUpdateFlag();
  }

  state.offlineSync = null;
  state.cacheStatus = failed === 0 ? 'ready' : 'incomplete';
  state.cacheProgress = t('cpCachedFailed', ok, targets.size, failed);
  render();  // once at the end: hides the bar, refreshes the offline status line
}

async function checkCacheStatus() {
  if (!('caches' in window) || !state.packManifest || !state.currentManifestUrl) {
    state.cacheStatus = 'unknown';
    return;
  }
  const cache = await caches.open(DATA_CACHE);
  const urls = buildOfflineMediaUrls();
  if (!urls.length) {
    state.cacheStatus = 'ready';
    state.cacheProgress = t('cpNoMedia');
    return;
  }

  // One keys() call instead of one match() round-trip per file (~1500 on a full pack).
  const cachedUrls = new Set((await cache.keys()).map(request => request.url));
  let cached = 0;
  for (const url of urls) {
    if (cachedUrls.has(url)) cached += 1;
  }
  state.cacheStatus = cached === urls.length ? 'ready' : cached > 0 ? 'incomplete' : 'not downloaded';
  state.cacheProgress = t('cpCached', cached, urls.length);
}

function updateDataUpdateFlag() {
  // Only prompt pilots who already downloaded a pack: a newer published version than the one
  // they last synced means their offline media/docs are stale. True if ANY active pack drifted.
  state.dataUpdateAvailable = (state.activePacks || []).some(({ pack, manifest }) => {
    const synced = localStorage.getItem(syncedVersionKey(pack.id)) || '';
    const live = manifest?.version || '';
    return Boolean(synced && live && synced !== live);
  });
}

function storeSyncedVersion(packId, version) {
  if (!packId || !version) return;
  try {
    localStorage.setItem(syncedVersionKey(packId), version);
    localStorage.removeItem(syncedManifestKey(packId)); // legacy blob from the old hash delta
  } catch (error) {
    console.warn('Could not persist synced pack version', error);
  }
}

function isPackMediaOrDocUrl(url) {
  return url.includes('/packs/') && (url.includes('/media/') || url.includes('/docs/'));
}

/** A chart served by the chart Worker — cached, counted and evicted like any other pack asset. */
function isChartUrl(url) {
  return !!chartsBase && String(url).startsWith(new URL('charts/', chartsBase).toString());
}

// Data update across the selected packs: reload each pack's data, delta-sync its media (see
// downloadOfflinePack — missing files always, size-drifted files when a pack version changed),
// then evict cached media/docs the current selection no longer references.
async function syncPackDelta() {
  if (!('caches' in window)) {
    alert(t('noCacheApi'));
    return;
  }
  state.cacheStatus = 'downloading';
  state.cacheProgress = t('cpRefreshing');
  render();

  await loadSelectedPacks({ cacheMode: 'reload' });
  await downloadOfflinePack();

  try {
    const cache = await caches.open(DATA_CACHE);
    const referenced = new Set(buildOfflineMediaUrls());
    for (const request of await cache.keys()) {
      // Charts are evicted on the same rule as pack media. Their cache keys are token-free
      // (see chartUrl), so they compare equal to what buildOfflineMediaUrls lists — a token
      // in the key would make every chart look unreferenced and delete the lot on each sync.
      if ((isPackMediaOrDocUrl(request.url) || isChartUrl(request.url)) && !referenced.has(request.url)) {
        await cache.delete(request);
      }
    }
  } catch (error) {
    console.warn('Stale-media eviction skipped', error);
  }
}

// --- CUP export, generated in-app from the loaded fields (offline, always in sync) ---
//
// CUP is the de-facto waypoint interchange format for soaring — SeeYou, XCSoar, LK8000, the
// LX and Naviter instruments all read it — so nothing here is written for one vendor.

function cupCoord(value, isLat) {
  const hemi = value >= 0 ? (isLat ? 'N' : 'E') : (isLat ? 'S' : 'W');
  const abs = Math.abs(value);
  const deg = Math.floor(abs);
  const minutes = (abs - deg) * 60;
  // DDMM.mmm for latitude, DDDMM.mmm for longitude.
  return `${String(deg).padStart(isLat ? 2 : 3, '0')}${minutes.toFixed(3).padStart(6, '0')}${hemi}`;
}

function cupQuote(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function cupFrequency(field) {
  const freqs = Array.isArray(field.frequencies) ? field.frequencies : [];
  const mhz = freqs.find(f => typeof f?.mhz === 'number')?.mhz;
  if (typeof mhz === 'number') return mhz.toFixed(3);
  const match = String(field.frequency || '').match(/\d{3}\.\d{1,3}/);
  return match ? match[0] : '';
}

// Structured note labels the build writes, with the forms DeepL emits in French/German, so the
// CUP builder can pull values out of a note in whichever language the pilot exported.
const CUP_LABELS = {
  surface: ['Surface', 'Oberfläche', 'Oberflaeche'],
  direction: ['Direction', 'Richtung'],
};
const escapeRegExp = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Pull a labelled value ("Surface: grass", "Direction: 07/25") out of the notes block. Field
// imports write these as their own lines; returns '' when no variant is present.
function cupNoteValue(notes, labels) {
  const alt = (Array.isArray(labels) ? labels : [labels]).map(escapeRegExp).join('|');
  const match = new RegExp(`^\\s*(?:${alt})\\s*:\\s*(.+)$`, 'im').exec(String(notes || ''));
  if (!match) return '';
  return match[1].split(/[.;\n]/)[0].trim().replace(/\s+/g, ' ').slice(0, 40);
}

// Minimal waypoint description: difficulty, runway (direction + dimensions), surface, and
// frequency — nothing else. The detailed notes and photos stay in the app; briefing happens
// there, the CUP is only for navigating to the field.
function cupDescription(field) {
  const notes = fieldNotes(field);
  const parts = [];
  if (field.difficulty && field.difficulty !== 'UNKNOWN') parts.push(`[${field.difficulty}]`);
  const direction = cupNoteValue(notes, CUP_LABELS.direction)
    || (Number.isFinite(field.runwayDirectionDeg) ? `${String(Math.round(field.runwayDirectionDeg)).padStart(3, '0')}°` : '');
  if (direction) parts.push(direction);
  const length = Number(field.lengthM);
  const width = Number(field.widthM);
  if (Number.isFinite(length) && length > 0 && Number.isFinite(width) && width > 0) {
    parts.push(`${Math.round(length)}×${Math.round(width)} m`);
  } else if (Number.isFinite(length) && length > 0) {
    parts.push(`${Math.round(length)} m`);
  }
  const surface = cupNoteValue(notes, CUP_LABELS.surface);
  if (surface) parts.push(surface);
  const freq = cupFrequency(field);
  if (freq) parts.push(`${freq} MHz`);
  return parts.join(' · ');
}

function generateCupText(fields) {
  // Style: 5 = airfield (solid surface), 3 = outlanding field.
  const rows = ['name,code,country,lat,lon,elev,style,rwdir,rwlen,freq,desc'];
  for (const field of fields) {
    if (!Number.isFinite(field.latitude) || !Number.isFinite(field.longitude)) continue;
    const name = String(field.name || displayCode(field) || 'field').replace(/^#?\d+\s+/, '').trim();
    const elev = Number.isFinite(field.elevationM) ? `${Math.round(field.elevationM)}m` : '';
    const rwdir = Number.isFinite(field.runwayDirectionDeg) ? Math.round(field.runwayDirectionDeg) : '';
    const rwlen = Number.isFinite(field.lengthM) && field.lengthM > 0 ? `${Math.round(field.lengthM)}m` : '';
    rows.push([
      cupQuote(name),
      cupQuote(displayCode(field)),
      String(field.country || '').slice(0, 2),
      cupCoord(field.latitude, true),
      cupCoord(field.longitude, false),
      elev,
      field.kind === 'airfield' ? 5 : 3,
      rwdir,
      rwlen,
      cupFrequency(field),
      cupQuote(cupDescription(field)),
    ].join(','));
  }
  return rows.join('\r\n') + '\r\n';
}

// One CUP per selected pack, in picker order. Fields are deduped by id when the packs load and
// tagged with the pack they came from, so a field the Alps and France packs share is written to
// exactly one file — importing the whole set never produces duplicate waypoints.
function cupFilesByPack() {
  const order = activePackIds();
  if (!order.length) return [];
  const groups = new Map(order.map(id => [id, []]));
  for (const field of state.fields) {
    if (!Number.isFinite(field.latitude) || !Number.isFinite(field.longitude)) continue;
    groups.get(groups.has(field._packId) ? field._packId : order[0]).push(field);
  }
  const lang = resolveLang();
  return [...groups]
    .filter(([, fields]) => fields.length)
    .map(([id, fields]) => ({
      name: `meet-the-cows-${id}-${lang}.cup`,
      text: generateCupText(fields),
    }));
}

// --- Minimal ZIP writer -----------------------------------------------------------------
// Written here rather than pulled from a library: the app is offline-first and its CSP allows
// no third-party script. Deflate when the platform offers it, stored otherwise — both are
// valid ZIP, so a browser without CompressionStream still gets a readable file.

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let bit = 0; bit < 8; bit += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

async function deflateRawBytes(bytes) {
  if (typeof CompressionStream !== 'function') return null;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    const out = new Uint8Array(await new Response(stream).arrayBuffer());
    return out.length < bytes.length ? out : null;
  } catch (error) {
    console.warn('deflate unavailable, storing ZIP entries uncompressed', error);
    return null;
  }
}

/** entries: [{ name, text }] -> Blob of a ZIP archive. */
async function buildZipBlob(entries) {
  const encoder = new TextEncoder();
  const now = new Date();
  // MS-DOS packed date/time: seconds have 2-second resolution, years count from 1980.
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  const parts = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const raw = encoder.encode(entry.text);
    const deflated = await deflateRawBytes(raw);
    const body = deflated || raw;
    const method = deflated ? 8 : 0;
    const crc = crc32(raw);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034B50, true);
    local.setUint16(4, 20, true);           // version needed
    local.setUint16(6, 0, true);            // flags
    local.setUint16(8, method, true);
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, raw.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);           // extra length
    parts.push(new Uint8Array(local.buffer), nameBytes, body);

    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014B50, true);
    dir.setUint16(4, 20, true);             // version made by
    dir.setUint16(6, 20, true);             // version needed
    dir.setUint16(8, 0, true);
    dir.setUint16(10, method, true);
    dir.setUint16(12, dosTime, true);
    dir.setUint16(14, dosDate, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, body.length, true);
    dir.setUint32(24, raw.length, true);
    dir.setUint16(28, nameBytes.length, true);
    dir.setUint32(42, offset, true);        // local header offset
    central.push(new Uint8Array(dir.buffer), nameBytes);

    offset += 30 + nameBytes.length + body.length;
  }

  const centralSize = central.reduce((sum, chunk) => sum + chunk.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054B50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

async function shareOrDownload(blob, filename) {
  // Prefer the share sheet on phones (Save to Files, or open straight into a nav app).
  try {
    const file = new File([blob], filename, { type: blob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: filename });
      return;
    }
  } catch (error) {
    if (error?.name === 'AbortError') return;
    console.warn('share failed, falling back to download', error);
  }
  // Fallback: a direct file download (desktop, Android).
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function exportCup() {
  if (!state.fields.length) { alert(t('noPackYet')); return; }
  const files = cupFilesByPack();
  if (!files.length) { alert(t('noPackYet')); return; }
  // One pack selected stays one .cup: zipping a single file would only make the pilot unpack it.
  if (files.length === 1) {
    await shareOrDownload(new Blob([files[0].text], { type: 'text/plain' }), files[0].name);
    return;
  }
  const blob = await buildZipBlob(files);
  await shareOrDownload(blob, `meet-the-cows-${resolveLang()}.zip`);
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = deg => deg * Math.PI / 180;
  const phi1 = toRad(lat1), phi2 = toRad(lat2);
  const dPhi = toRad(lat2 - lat1), dLambda = toRad(lon2 - lon1);
  const a = Math.sin(dPhi/2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda/2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearingDegrees(lat1, lon1, lat2, lon2) {
  const toRad = deg => deg * Math.PI / 180;
  const toDeg = rad => rad * 180 / Math.PI;
  const phi1 = toRad(lat1), phi2 = toRad(lat2);
  const lambda1 = toRad(lon1), lambda2 = toRad(lon2);
  const y = Math.sin(lambda2 - lambda1) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(lambda2 - lambda1);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}


function shortFieldName(name) {
  const cleaned = String(name || '').replace(/^#?\d+\s+/, '').trim();
  return cleaned.length > 34 ? `${cleaned.slice(0, 33)}…` : cleaned;
}

// An OpenAIP record with no published identifier gets a key minted from its name and position —
// FR_PLATEAU_DE_L_ALP_44P351_6P724 — so runways and frequencies have something to join on. The
// pack build no longer publishes those as codes, but a pilot carrying an already-downloaded region
// keeps them until they fetch it again, which for a few hundred megabytes can be a whole season.
// So they are also filtered on the way to the screen. Matched on the minted shape's own tail
// (…_LATpDEC_LONpDEC, minus signs written as M) rather than on length: 'Ste-Jalle_2' is a real
// code at eleven characters, and a length rule would have eaten it.
const MINTED_CODE_RE = /_M?\d+P\d+_M?\d+P\d+$/;

/** The code as a pilot should see it: a real identifier, or nothing at all. */
function displayCode(field) {
  const code = String(field?.code || '');
  return MINTED_CODE_RE.test(code) ? '' : code;
}

function fmtKm(m) { return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`; }
function fmtM(m) { return `${Math.round(m)} m`; }
function fmtSignedM(m) { return `${m >= 0 ? '+' : ''}${Math.round(m)} m`; }
function fmtDeg(d) { return `${Math.round(d).toString().padStart(3, '0')}°`; }
/**
 * The compass point a bearing falls in, in the reader's own language.
 *
 * Sixteen points rather than eight: at eight, a field 20° off north still reads "N", which is
 * a wide enough lie to send someone looking over the wrong shoulder. The letters differ by
 * language — French counts from Ouest (SO, O, NO), German from Ost and West — so they come
 * from the string table rather than being spelled out here.
 *
 * This is a TRUE bearing, not one relative to the aircraft: the app watches position and not
 * heading, so "NE" means north-east of the pilot, never 45° right of where the nose points.
 */
function compassPoint(deg) {
  if (!Number.isFinite(deg)) return '';
  const points = t('compass');
  return points[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c])); }
