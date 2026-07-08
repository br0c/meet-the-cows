const APP_VERSION = '0.5.0-beta';
// Stable data cache (media/docs/pack JSON); matches service-worker.js so app updates don't
// wipe a downloaded pack. (Old versioned caches are dropped by the service worker on activate.)
const DATA_CACHE = 'mtc-data';
const BASE_URL = new URL('..', import.meta.url);
const PACK_INDEX_URL = new URL('packs/packs.json', BASE_URL).toString();
const SETTINGS_KEY = 'mtc-settings-v2';
const syncedVersionKey = packId => `mtc-synced-version-${packId}`;
const syncedManifestKey = packId => `mtc-synced-manifest-${packId}`;

/** @typedef {{ id:string, kind?:'outlanding'|'airfield', name:string, code?:string, country?:string, latitude:number, longitude:number, elevationM:number|null, difficulty:string, rawDifficulty?:string, lengthM:number|null, widthM:number|null, runwayDirectionDeg:number|null, frequency?:string, frequencies?:Array<{type?:string,mhz?:number,description?:string,source?:string}>, notes:string, source?:object, media:Array<{type:string,url:string,thumbnailUrl?:string,caption?:string,source?:string,updatedAt?:string}> }} Field */

const DEFAULT_SETTINGS = {
  packId: 'fr-alps',
  language: 'auto',
  safetyMarginM: 250,
  hideC: true,
  hideD: true,
  sortMode: 'glide',
  useManualAltitude: false,
  manualAltitudeM: 2500,
};

// Languages the app UI and pack notes are translated into. 'auto' follows the device.
const SUPPORTED_LANGS = ['en', 'fr', 'de'];

// UI string table. Plain strings, or functions for values that interpolate. Every user-facing
// label in the app resolves through t(); pack field notes are localized in the pack itself.
const STRINGS = {
  en: {
    settings: 'Settings', refreshPack: 'Refresh pack', done: 'Done',
    app: 'App', version: 'Version', status: 'Status',
    betaStatus: 'Beta — not for primary navigation',
    language: 'Language', langAuto: 'Automatic (device)',
    pack: 'Pack', selectedPack: 'Selected pack', name: 'Name', updated: 'Updated',
    fieldsCount: 'Fields', offline: 'Offline', progress: 'Progress', noPackLoaded: 'No pack loaded',
    downloadMedia: 'Download / verify media & docs', reloadPack: 'Reload pack',
    exportCup: n => `Export CUP for SeeYou (${n} fields)`,
    cupNote: 'Waypoint file for SeeYou Navigator and other nav apps. Brief a field here, then navigate to it in SeeYou.',
    nearestList: 'Nearest list', sort: 'Sort',
    sortGlide: 'Best glide ratio', sortDistance: 'Nearest distance',
    safetyMargin: 'Safety arrival margin, m',
    useManualAlt: 'Use manual altitude for testing', manualAlt: 'Manual altitude, m',
    manualAltNote: 'Manual altitude is only for ground testing. In flight, leave it off and use phone GPS altitude.',
    hideC: 'Hide C fields', hideD: 'Hide D fields',
    cdNote: 'C and D fields are hidden by default. They are difficult and possibly dangerous — recommended only as last-resort emergency options.',
    colName: 'Name', colDist: 'Dist', colGlide: 'Glide', colDiff: 'Diff',
    shown: 'Shown', noFields: 'No fields loaded.',
    waitingGps: 'Waiting for GPS. Enable location permission.',
    airfield: 'Airfield', field: 'Field', outlanding: 'Outlanding',
    footerNote: 'Not for primary navigation. Straight-line distance/glide only: no wind, sink, terrain clearance or airspace.',
    updateBanner: '🔄 New field data available.', update: 'Update',
    sampleWarning: 'Sample data only — do not use this pack in flight. Run the importer to build the real Guide des Aires pack.',
    gpsError: e => `GPS error: ${e}.`,
    altMissingWarning: 'GPS altitude is missing, so required glide ratio cannot be computed. Add a manual altitude in Settings for ground testing.',
    close: 'Close', bearing: 'Bearing', distance: 'Distance', reqGlide: 'Req glide',
    deltaSafe: 'Δsafe', elevation: 'Elevation', runway: 'Runway', frequency: 'Frequency',
    glideNotShown: r => `Glide not shown: ${r}.`,
    notes: 'Notes', noNotes: 'No notes.', mediaHeading: 'Photos / docs / VAC',
    noMedia: 'No media attached.', openPdf: 'Open PDF',
    source: 'Source', imported: 'imported', unknown: 'unknown',
    altMissing: 'missing', altManual: 'manual',
    gpsOk: acc => `OK ±${acc}m`, gpsErr: 'Error',
    gpsIdle: 'idle', gpsRequesting: 'requesting', gpsUnavailable: 'unavailable',
    reasonGpsAlt: 'GPS altitude missing', reasonFieldElev: 'Field elevation missing',
    reasonBelowSafe: m => `Below safe arrival by ${m} m`,
    revealConfirm: (label, severity) => `Difficulty ${label} fields are ${severity} and possibly dangerous — last-resort emergency options only, not recommended. Show them in the nearest list anyway?`,
    sevDifficult: 'difficult', sevVeryDifficult: 'very difficult',
    noPackYet: 'No pack loaded yet.', noCacheApi: 'Cache Storage is not available in this browser.',
    cacheReady: 'ready', cacheDownloading: 'downloading', cacheRefreshing: 'refreshing',
    cacheIncomplete: 'incomplete', cacheNotDownloaded: 'not downloaded', cacheErrorStatus: 'error',
    cacheUnknown: 'unknown',
    cpNoMedia: 'No media/docs to cache', cpNoPack: 'No pack loaded',
    cpCached: (c, total) => `${c}/${total} media/docs cached`,
    cpCachedFailed: (ok, total, failed) => `${ok}/${total} media/docs cached · ${failed} failed`,
    cpInit: total => `0/${total} media/docs`,
    cpClearing: 'Clearing cached pack', cpCleared: n => `Cleared ${n} cached pack entries`,
    cpFetchIndex: 'Fetching fresh pack index', cpFetchPack: 'Fetching fresh pack',
    cpFresh: extra => `Fresh pack loaded · ${extra}`, cpNotChecked: 'media/docs not checked',
    cpRefreshing: 'Refreshing field data…',
    cpUpdating: (ok, total, failed) => `Updating ${ok}/${total} file(s)${failed ? ` · ${failed} failed` : ''}`,
    cpUpdated: (ok, evicted, failed) => `Updated ${ok} file(s)${evicted ? `, removed ${evicted}` : ''}${failed ? `, ${failed} failed` : ''}`,
    searchPlaceholder: 'Search a field by name or code', clearSearch: 'Clear search',
    searchResults: 'Search results', noMatches: q => `No fields match “${q}”.`,
  },
  fr: {
    settings: 'Réglages', refreshPack: 'Actualiser le pack', done: 'OK',
    app: 'Application', version: 'Version', status: 'Statut',
    betaStatus: 'Bêta — pas pour la navigation principale',
    language: 'Langue', langAuto: 'Automatique (appareil)',
    pack: 'Pack', selectedPack: 'Pack sélectionné', name: 'Nom', updated: 'Mis à jour',
    fieldsCount: 'Terrains', offline: 'Hors ligne', progress: 'Progression', noPackLoaded: 'Aucun pack chargé',
    downloadMedia: 'Télécharger / vérifier médias & docs', reloadPack: 'Recharger le pack',
    exportCup: n => `Exporter CUP pour SeeYou (${n} terrains)`,
    cupNote: 'Fichier de points de virage pour SeeYou Navigator et autres apps de nav. Consultez un terrain ici, puis naviguez-y dans SeeYou.',
    nearestList: 'Liste des plus proches', sort: 'Tri',
    sortGlide: 'Meilleure finesse requise', sortDistance: 'Distance la plus courte',
    safetyMargin: "Marge d'arrivée de sécurité, m",
    useManualAlt: 'Altitude manuelle (test au sol)', manualAlt: 'Altitude manuelle, m',
    manualAltNote: "L'altitude manuelle sert uniquement aux tests au sol. En vol, désactivez-la et utilisez l'altitude GPS du téléphone.",
    hideC: 'Masquer les terrains C', hideD: 'Masquer les terrains D',
    cdNote: "Les terrains C et D sont masqués par défaut. Ils sont difficiles et potentiellement dangereux — recommandés uniquement en dernier recours d'urgence.",
    colName: 'Nom', colDist: 'Dist', colGlide: 'Finesse', colDiff: 'Diff',
    shown: 'Affichés', noFields: 'Aucun terrain chargé.',
    waitingGps: 'En attente du GPS. Autorisez la localisation.',
    airfield: 'Aérodrome', field: 'Terrain', outlanding: 'Vache',
    footerNote: "Pas pour la navigation principale. Distance/finesse à vol d'oiseau uniquement : ni vent, ni descendance, ni relief, ni espace aérien.",
    updateBanner: '🔄 Nouvelles données de terrains disponibles.', update: 'Mettre à jour',
    sampleWarning: "Données d'exemple uniquement — n'utilisez pas ce pack en vol. Lancez l'importateur pour construire le vrai pack Guide des Aires.",
    gpsError: e => `Erreur GPS : ${e}.`,
    altMissingWarning: "L'altitude GPS est absente, la finesse requise ne peut pas être calculée. Ajoutez une altitude manuelle dans les Réglages pour les tests au sol.",
    close: 'Fermer', bearing: 'Relèvement', distance: 'Distance', reqGlide: 'Finesse req.',
    deltaSafe: 'Δsécu', elevation: 'Altitude', runway: 'Piste', frequency: 'Fréquence',
    glideNotShown: r => `Finesse non affichée : ${r}.`,
    notes: 'Notes', noNotes: 'Aucune note.', mediaHeading: 'Photos / docs / VAC',
    noMedia: 'Aucun média joint.', openPdf: 'Ouvrir le PDF',
    source: 'Source', imported: 'importé le', unknown: 'inconnu',
    altMissing: 'absente', altManual: 'manuelle',
    gpsOk: acc => `OK ±${acc} m`, gpsErr: 'Erreur',
    gpsIdle: 'inactif', gpsRequesting: 'en cours', gpsUnavailable: 'indisponible',
    reasonGpsAlt: 'Altitude GPS absente', reasonFieldElev: 'Altitude terrain absente',
    reasonBelowSafe: m => `Sous l'arrivée sûre de ${m} m`,
    revealConfirm: (label, severity) => `Les terrains de difficulté ${label} sont ${severity} et potentiellement dangereux — uniquement en dernier recours d'urgence, non recommandés. Les afficher quand même dans la liste ?`,
    sevDifficult: 'difficiles', sevVeryDifficult: 'très difficiles',
    noPackYet: 'Aucun pack chargé pour le moment.', noCacheApi: "Le stockage de cache n'est pas disponible dans ce navigateur.",
    cacheReady: 'prêt', cacheDownloading: 'téléchargement', cacheRefreshing: 'actualisation',
    cacheIncomplete: 'incomplet', cacheNotDownloaded: 'non téléchargé', cacheErrorStatus: 'erreur',
    cacheUnknown: 'inconnu',
    cpNoMedia: 'Aucun média/doc à mettre en cache', cpNoPack: 'Aucun pack chargé',
    cpCached: (c, total) => `${c}/${total} médias/docs en cache`,
    cpCachedFailed: (ok, total, failed) => `${ok}/${total} médias/docs en cache · ${failed} échec(s)`,
    cpInit: total => `0/${total} médias/docs`,
    cpClearing: 'Effacement du pack en cache', cpCleared: n => `${n} entrées de pack effacées`,
    cpFetchIndex: "Récupération de l'index des packs", cpFetchPack: 'Récupération du pack',
    cpFresh: extra => `Pack à jour chargé · ${extra}`, cpNotChecked: 'médias/docs non vérifiés',
    cpRefreshing: 'Actualisation des données…',
    cpUpdating: (ok, total, failed) => `Mise à jour ${ok}/${total} fichier(s)${failed ? ` · ${failed} échec(s)` : ''}`,
    cpUpdated: (ok, evicted, failed) => `${ok} fichier(s) mis à jour${evicted ? `, ${evicted} supprimé(s)` : ''}${failed ? `, ${failed} échec(s)` : ''}`,
    searchPlaceholder: 'Rechercher un terrain (nom ou code)', clearSearch: 'Effacer la recherche',
    searchResults: 'Résultats de recherche', noMatches: q => `Aucun terrain ne correspond à « ${q} ».`,
  },
  de: {
    settings: 'Einstellungen', refreshPack: 'Paket aktualisieren', done: 'Fertig',
    app: 'App', version: 'Version', status: 'Status',
    betaStatus: 'Beta — nicht zur primären Navigation',
    language: 'Sprache', langAuto: 'Automatisch (Gerät)',
    pack: 'Paket', selectedPack: 'Ausgewähltes Paket', name: 'Name', updated: 'Aktualisiert',
    fieldsCount: 'Felder', offline: 'Offline', progress: 'Fortschritt', noPackLoaded: 'Kein Paket geladen',
    downloadMedia: 'Medien & Dokumente laden / prüfen', reloadPack: 'Paket neu laden',
    exportCup: n => `CUP für SeeYou exportieren (${n} Felder)`,
    cupNote: 'Wegpunktdatei für SeeYou Navigator und andere Navi-Apps. Feld hier briefen, dann in SeeYou anfliegen.',
    nearestList: 'Nächstgelegene Felder', sort: 'Sortierung',
    sortGlide: 'Beste erforderliche Gleitzahl', sortDistance: 'Kürzeste Entfernung',
    safetyMargin: 'Sicherheits-Ankunftsreserve, m',
    useManualAlt: 'Manuelle Höhe (Bodentest)', manualAlt: 'Manuelle Höhe, m',
    manualAltNote: 'Manuelle Höhe nur für Bodentests. Im Flug ausschalten und die GPS-Höhe des Telefons verwenden.',
    hideC: 'C-Felder ausblenden', hideD: 'D-Felder ausblenden',
    cdNote: 'C- und D-Felder sind standardmäßig ausgeblendet. Sie sind schwierig und möglicherweise gefährlich — nur als letzte Notfalloption empfohlen.',
    colName: 'Name', colDist: 'Dist', colGlide: 'Gleit', colDiff: 'Diff',
    shown: 'Angezeigt', noFields: 'Keine Felder geladen.',
    waitingGps: 'Warte auf GPS. Standortzugriff erlauben.',
    airfield: 'Flugplatz', field: 'Feld', outlanding: 'Außenlandung',
    footerNote: 'Nicht zur primären Navigation. Nur Luftlinie/Gleitzahl: kein Wind, kein Sinken, keine Geländefreiheit, kein Luftraum.',
    updateBanner: '🔄 Neue Felddaten verfügbar.', update: 'Aktualisieren',
    sampleWarning: 'Nur Beispieldaten — dieses Paket nicht im Flug verwenden. Importer ausführen, um das echte Guide-des-Aires-Paket zu erstellen.',
    gpsError: e => `GPS-Fehler: ${e}.`,
    altMissingWarning: 'GPS-Höhe fehlt, daher kann die erforderliche Gleitzahl nicht berechnet werden. Für Bodentests eine manuelle Höhe in den Einstellungen angeben.',
    close: 'Schließen', bearing: 'Peilung', distance: 'Entfernung', reqGlide: 'Erf. Gleit',
    deltaSafe: 'Δsicher', elevation: 'Höhe', runway: 'Bahn', frequency: 'Frequenz',
    glideNotShown: r => `Gleitzahl nicht angezeigt: ${r}.`,
    notes: 'Notizen', noNotes: 'Keine Notizen.', mediaHeading: 'Fotos / Dokumente / VAC',
    noMedia: 'Keine Medien angehängt.', openPdf: 'PDF öffnen',
    source: 'Quelle', imported: 'importiert am', unknown: 'unbekannt',
    altMissing: 'fehlt', altManual: 'manuell',
    gpsOk: acc => `OK ±${acc} m`, gpsErr: 'Fehler',
    gpsIdle: 'inaktiv', gpsRequesting: 'anfordern', gpsUnavailable: 'nicht verfügbar',
    reasonGpsAlt: 'GPS-Höhe fehlt', reasonFieldElev: 'Feldhöhe fehlt',
    reasonBelowSafe: m => `${m} m unter sicherer Ankunft`,
    revealConfirm: (label, severity) => `Felder der Schwierigkeit ${label} sind ${severity} und möglicherweise gefährlich — nur als letzte Notfalloption, nicht empfohlen. Trotzdem in der Liste anzeigen?`,
    sevDifficult: 'schwierig', sevVeryDifficult: 'sehr schwierig',
    noPackYet: 'Noch kein Paket geladen.', noCacheApi: 'Cache-Speicher ist in diesem Browser nicht verfügbar.',
    cacheReady: 'bereit', cacheDownloading: 'lädt', cacheRefreshing: 'aktualisiert',
    cacheIncomplete: 'unvollständig', cacheNotDownloaded: 'nicht geladen', cacheErrorStatus: 'Fehler',
    cacheUnknown: 'unbekannt',
    cpNoMedia: 'Keine Medien/Dokumente zum Zwischenspeichern', cpNoPack: 'Kein Paket geladen',
    cpCached: (c, total) => `${c}/${total} Medien/Dokumente zwischengespeichert`,
    cpCachedFailed: (ok, total, failed) => `${ok}/${total} Medien/Dokumente zwischengespeichert · ${failed} fehlgeschlagen`,
    cpInit: total => `0/${total} Medien/Dokumente`,
    cpClearing: 'Zwischengespeichertes Paket wird gelöscht', cpCleared: n => `${n} zwischengespeicherte Paketeinträge gelöscht`,
    cpFetchIndex: 'Paketindex wird geladen', cpFetchPack: 'Paket wird geladen',
    cpFresh: extra => `Aktuelles Paket geladen · ${extra}`, cpNotChecked: 'Medien/Dokumente nicht geprüft',
    cpRefreshing: 'Felddaten werden aktualisiert…',
    cpUpdating: (ok, total, failed) => `Aktualisiere ${ok}/${total} Datei(en)${failed ? ` · ${failed} fehlgeschlagen` : ''}`,
    cpUpdated: (ok, evicted, failed) => `${ok} Datei(en) aktualisiert${evicted ? `, ${evicted} entfernt` : ''}${failed ? `, ${failed} fehlgeschlagen` : ''}`,
    searchPlaceholder: 'Feld suchen (Name oder Code)', clearSearch: 'Suche löschen',
    searchResults: 'Suchergebnisse', noMatches: q => `Keine Felder für „${q}“.`,
  },
};

// Resolve the active UI language: an explicit setting wins, otherwise follow the device.
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
const TOP_PICK_MAX_GLIDE = 20;

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
  view: 'main',
  searchQuery: '',
  computedRows: [],
  cacheStatus: 'unknown',
  cacheProgress: '',
  detailScrollTop: 0,
  dataUpdateAvailable: false,
};

const app = document.querySelector('#app');

init();

async function init() {
  render();
  registerServiceWorker();
  await loadPackIndex();
  await loadSelectedPack();
  startGps();
  render();
}

function loadSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    const settings = { ...DEFAULT_SETTINGS, ...(stored && typeof stored === 'object' ? stored : {}) };
    return Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map(key => [key, settings[key]]));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
}

async function loadPackIndex({ cacheMode = 'no-cache' } = {}) {
  try {
    const res = await fetch(PACK_INDEX_URL, { cache: cacheMode });
    if (!res.ok) throw new Error(`Pack index HTTP ${res.status}`);
    const index = await res.json();
    state.packs = Array.isArray(index) ? index : (Array.isArray(index.packs) ? index.packs : []);
    if (!state.packs.length) throw new Error('Pack index contained no packs');
  } catch (error) {
    console.error(error);
    state.packs = [{ id: 'fr-alps', name: 'France / Alps', manifestUrl: 'packs/fr-alps/manifest.json' }];
  }
}

async function loadSelectedPack({ cacheMode = 'no-cache' } = {}) {
  const pack = selectedPack();
  if (!pack) return;
  state.settings.packId = pack.id;
  try {
    const manifestUrl = manifestUrlForPack(pack);
    const manifestRes = await fetch(manifestUrl, { cache: cacheMode });
    if (!manifestRes.ok) throw new Error(`Manifest HTTP ${manifestRes.status}`);
    state.packManifest = await manifestRes.json();
    state.currentManifestUrl = manifestUrl;
    const fieldsUrl = new URL(state.packManifest.fieldsUrl || 'fields.json', manifestUrl).toString();
    const fieldsRes = await fetch(fieldsUrl, { cache: cacheMode });
    if (!fieldsRes.ok) throw new Error(`Fields HTTP ${fieldsRes.status}`);
    state.fields = await fieldsRes.json();
    if (state.selectedFieldId && !state.fields.some(field => field.id === state.selectedFieldId)) {
      state.selectedFieldId = null;
    }
    computeRows();
    state.cacheProgress = '';
    updateDataUpdateFlag(pack.id);
    await checkCacheStatus();
  } catch (error) {
    console.error(error);
    state.packManifest = null;
    state.currentManifestUrl = null;
    state.fields = [];
    state.cacheStatus = 'error';
    state.cacheProgress = error.message || String(error);
  }
}

function selectedPack() {
  return state.packs.find(p => p.id === state.settings.packId) || state.packs[0];
}

function manifestUrlForPack(pack) {
  return new URL(pack.manifestUrl || `packs/${pack.id}/manifest.json`, BASE_URL).toString();
}

async function reloadSelectedPack() {
  state.cacheStatus = 'refreshing';
  state.cacheProgress = t('cpClearing');
  render();

  try {
    const pack = selectedPack();
    if (pack) {
      const deleted = await clearPackCache(pack.id);
      state.cacheProgress = t('cpCleared', deleted);
      render();
    }

    state.cacheProgress = t('cpFetchIndex');
    render();
    await loadPackIndex({ cacheMode: 'reload' });

    state.cacheProgress = t('cpFetchPack');
    render();
    await loadSelectedPack({ cacheMode: 'reload' });

    if (state.cacheStatus !== 'error') {
      state.cacheProgress = t('cpFresh', state.cacheProgress || t('cpNotChecked'));
    }
  } catch (error) {
    console.error(error);
    state.cacheStatus = 'error';
    state.cacheProgress = error.message || String(error);
  }
}

function startGps() {
  if (gpsWatchId !== null && 'geolocation' in navigator) {
    navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId = null;
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

function activeAltitudeM() {
  if (state.settings.useManualAltitude) {
    const manual = Number(state.settings.manualAltitudeM);
    return Number.isFinite(manual) ? manual : null;
  }
  return state.position?.altitudeM ?? null;
}

function altitudeLabel() {
  const altitude = activeAltitudeM();
  if (altitude === null) return t('altMissing');
  return `${fmtM(altitude)}${state.settings.useManualAltitude ? ` ${t('altManual')}` : ''}`;
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
    if (state.settings.hideD && row.field.difficulty === 'D') return false;
    if (state.settings.hideC && row.field.difficulty === 'C') return false;
    return true;
  });
  rows.sort((a, b) => {
    if (state.settings.sortMode === 'glide') {
      if (a.requiredGlideRatio === null && b.requiredGlideRatio === null) return a.distanceM - b.distanceM;
      if (a.requiredGlideRatio === null) return 1;
      if (b.requiredGlideRatio === null) return -1;
      return a.requiredGlideRatio - b.requiredGlideRatio;
    }
    return a.distanceM - b.distanceM;
  });
  state.computedRows = rows;
}

function scheduleRender() {
  if (renderTimer !== null) return;
  renderTimer = window.setTimeout(() => {
    renderTimer = null;
    render();
  }, 1000);
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
          <button id="refreshPack" class="icon-button" title="${t('refreshPack')}" aria-label="${t('refreshPack')}">↻</button>
        </div>
        ${renderStatus()}
      </header>
      <main class="main">
        ${state.view === 'settings' ? renderSettingsPage() : renderMainPage()}
      </main>
      ${selected ? renderDetail(selected) : ''}
    </div>
  `;
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
  const pos = state.position;
  const altitude = activeAltitudeM();
  const age = pos ? `${Math.round((Date.now() - pos.timestamp) / 1000)} s` : '—';
  return `
    <div class="gps-strip">
      <span><strong>GPS</strong> ${escapeHtml(gpsLabel())}</span>
      <span><strong>Alt</strong> ${altitudeLabel()}</span>
      <span><strong>Fix</strong> ${age}</span>
      <span><strong>${t('shown')}</strong> ${state.computedRows.length}/${state.fields.length}</span>
    </div>
  `;
}

function gpsLabel() {
  if (state.gpsStatus === 'ok') return t('gpsOk', Math.round(state.position?.accuracyM || 0));
  if (state.gpsStatus === 'error') return t('gpsErr');
  const map = { idle: 'gpsIdle', requesting: 'gpsRequesting', unavailable: 'gpsUnavailable' };
  return map[state.gpsStatus] ? t(map[state.gpsStatus]) : state.gpsStatus;
}

function renderWarnings() {
  const items = [];
  if (state.packManifest?.isSample) items.push(escapeHtml(t('sampleWarning')));
  if (state.gpsStatus === 'error') items.push(escapeHtml(t('gpsError', state.gpsError)));
  if (state.position && state.position.altitudeM === null && !state.settings.useManualAltitude) items.push(escapeHtml(t('altMissingWarning')));
  if (!items.length) return '';
  return items.map(i => `<div class="warning">${i}</div>`).join('');
}

function renderMainPage() {
  return `
    ${renderSearchBox()}
    ${renderUpdateBanner()}
    ${renderWarnings()}
    ${renderFieldList()}
    <p class="footer-note">${escapeHtml(t('footerNote'))}</p>
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

function renderSettingsPage() {
  const packs = state.packs.map(p => `<option value="${p.id}" ${p.id === state.settings.packId ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('');
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

      <div class="settings-card">
        <h3>${t('app')}</h3>
        <label for="languageSelect">${t('language')}</label>
        <select id="languageSelect">${langOptions}</select>
        <dl class="meta-list">
          <div><dt>${t('version')}</dt><dd>${escapeHtml(APP_VERSION)}</dd></div>
          <div><dt>${t('status')}</dt><dd>${escapeHtml(t('betaStatus'))}</dd></div>
        </dl>
      </div>

      <div class="settings-card">
        <h3>${t('pack')}</h3>
        <label for="packSelect">${t('selectedPack')}</label>
        <select id="packSelect">${packs}</select>
        <dl class="meta-list">
          <div><dt>${t('name')}</dt><dd>${escapeHtml(manifest?.name || t('noPackLoaded'))}</dd></div>
          <div><dt>${t('version')}</dt><dd>${escapeHtml(manifest?.version || '—')}</dd></div>
          <div><dt>${t('updated')}</dt><dd>${escapeHtml(manifest?.updatedAt || manifest?.generatedAt || manifest?.source?.updatedAt || '—')}</dd></div>
          <div><dt>${t('fieldsCount')}</dt><dd>${state.fields.length}</dd></div>
          <div><dt>${t('offline')}</dt><dd>${escapeHtml(cacheStatusLabel(state.cacheStatus))}</dd></div>
          <div><dt>${t('progress')}</dt><dd>${escapeHtml(state.cacheProgress || '—')}</dd></div>
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
        <label for="sortMode">${t('sort')}</label>
        <select id="sortMode">
          <option value="glide" ${state.settings.sortMode === 'glide' ? 'selected' : ''}>${t('sortGlide')}</option>
          <option value="distance" ${state.settings.sortMode === 'distance' ? 'selected' : ''}>${t('sortDistance')}</option>
        </select>
        <label for="safetyMarginM">${t('safetyMargin')}</label>
        <input id="safetyMarginM" inputmode="numeric" type="number" min="0" step="50" value="${state.settings.safetyMarginM}" />
        <div class="checkbox-row">
          <input id="useManualAltitude" type="checkbox" ${state.settings.useManualAltitude ? 'checked' : ''} />
          <label for="useManualAltitude">${t('useManualAlt')}</label>
        </div>
        <label for="manualAltitudeM">${t('manualAlt')}</label>
        <input id="manualAltitudeM" inputmode="numeric" type="number" min="0" step="50" value="${state.settings.manualAltitudeM}" ${state.settings.useManualAltitude ? '' : 'disabled'} />
        <p class="settings-note">${escapeHtml(t('manualAltNote'))}</p>
        <div class="checkbox-row">
          <input id="hideC" type="checkbox" ${state.settings.hideC ? 'checked' : ''} />
          <label for="hideC">${t('hideC')}</label>
        </div>
        <div class="checkbox-row">
          <input id="hideD" type="checkbox" ${state.settings.hideD ? 'checked' : ''} />
          <label for="hideD">${t('hideD')}</label>
        </div>
        <p class="settings-note">${escapeHtml(t('cdNote'))}</p>
      </div>
    </section>
  `;
}


function difficultyLabel(field) {
  const value = String(field?.difficulty || field?.rawDifficulty || '').trim();
  const normalized = value.toLowerCase().replace(/[{}\s_-]+/g, '');
  if (['a', 'facile', 'easy', 'aerodrome'].includes(normalized)) return 'A';
  if (['b', 'normal', 'terrain'].includes(normalized)) return 'B';
  if (['c', 'difficile', 'hard'].includes(normalized)) return 'C';
  if (['d', 'tresdifficile', 'trèsdifficile', 'veryhard', 'verydifficult'].includes(normalized)) return 'D';
  if (['altiport', 'velisurface', 'vélisurface'].includes(normalized)) return value || '?';
  return value || '?';
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
      ${q ? `<button id="clearSearch" class="search-clear" title="${escapeHtml(t('clearSearch'))}" aria-label="${escapeHtml(t('clearSearch'))}">✕</button>` : ''}
    </div>
  `;
}

function renderFieldRow({ field, distanceM, requiredGlideRatio, glideReason }) {
  return `
    <button class="field-row" data-field-id="${field.id}" title="${escapeHtml(glideReason || '')}">
      <span class="field-main">
        <span class="field-name">${escapeHtml(shortFieldName(field.name))}</span>
        <span class="field-sub">${escapeHtml([field.code, field.kind === 'airfield' ? t('airfield') : t('field')].filter(Boolean).join(' · '))}</span>
      </span>
      <span class="field-distance">${Number.isFinite(distanceM) ? fmtKm(distanceM) : '—'}</span>
      <span class="field-glide ${requiredGlideRatio ? '' : 'missing'}">${requiredGlideRatio ? `${Math.round(requiredGlideRatio)}` : '—'}</span>
      <span class="badge ${difficultyBadgeClass(field)}">${escapeHtml(difficultyLabel(field))}</span>
    </button>
  `;
}

function renderFieldList() {
  if (!state.fields.length) return `<div class="warning">${escapeHtml(t('noFields'))}</div>`;
  const query = state.searchQuery.trim();
  if (query) {
    const rows = searchMatches(query);
    if (!rows.length) return `<div class="warning">${escapeHtml(t('noMatches', query))}</div>`;
    return `
      <section class="field-list" aria-label="${escapeHtml(t('searchResults'))}">
        <div class="field-list-head">
          <span>${t('colName')}</span><span>${t('colDist')}</span><span>${t('colGlide')}</span><span>${t('colDiff')}</span>
        </div>
        ${rows.map(renderFieldRow).join('')}
      </section>
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
  const media = (field.media || []).map(item => renderMediaItem(item)).join('') || `<p class="footer-note">${escapeHtml(t('noMedia'))}</p>`;
  const kindLabel = field.kind === 'airfield' ? t('airfield') : t('outlanding');
  return `
    <div class="detail-backdrop" id="detailBackdrop">
      <article class="detail" role="dialog" aria-modal="true">
        <button id="closeDetail">${t('close')}</button>
        <div class="detail-title-row">
          <h2>${escapeHtml(field.name)}</h2>
          <span class="badge detail-badge ${difficultyBadgeClass(field)}">${escapeHtml(difficultyLabel(field))}</span>
        </div>
        <div class="detail-meta">${escapeHtml([field.code, kindLabel, field.rawDifficulty].filter(Boolean).join(' · '))}</div>
        <div class="detail-grid">
          <div class="detail-card"><span class="status-label">${t('bearing')}</span><strong>${row ? fmtDeg(row.bearingDeg) : '—'}</strong></div>
          <div class="detail-card"><span class="status-label">${t('distance')}</span><strong>${row ? fmtKm(row.distanceM) : '—'}</strong></div>
          <div class="detail-card"><span class="status-label">${t('reqGlide')}</span><strong>${row?.requiredGlideRatio ? `${Math.round(row.requiredGlideRatio)}` : '—'}</strong></div>
          <div class="detail-card"><span class="status-label">${t('deltaSafe')}</span><strong>${row?.usableHeightM !== null && row ? fmtSignedM(row.usableHeightM) : '—'}</strong></div>
          <div class="detail-card"><span class="status-label">${t('elevation')}</span><strong>${field.elevationM !== null ? fmtM(field.elevationM) : '—'}</strong></div>
          <div class="detail-card"><span class="status-label">${t('runway')}</span><strong>${escapeHtml(formatRunwayDimensions(field))}</strong></div>
          <div class="detail-card"><span class="status-label">${t('frequency')}</span><strong>${escapeHtml(formatFrequency(field))}</strong></div>
        </div>
        ${glideNote}
        <h3>${t('notes')}</h3>
        <div class="notes">${escapeHtml(fieldNotes(field) || t('noNotes'))}</div>
        <h3>${t('mediaHeading')}</h3>
        <div class="media-grid">${media}</div>
        <p class="footer-note">${t('source')}: ${escapeHtml(field.source?.name || t('unknown'))} ${field.source?.importedAt ? `· ${t('imported')} ${escapeHtml(field.source.importedAt)}` : ''}</p>
      </article>
    </div>
  `;
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

function renderMediaItem(item) {
  const caption = item.caption || item.source || item.type;
  const mediaUrl = new URL(item.url, state.currentManifestUrl || BASE_URL).toString();
  if (item.type === 'pdf') {
    return `<div class="media-card"><iframe src="${mediaUrl}" title="${escapeHtml(caption)}"></iframe><div class="caption"><a href="${mediaUrl}" target="_blank" rel="noopener">${t('openPdf')}</a> · ${escapeHtml(caption)}</div></div>`;
  }
  return `<div class="media-card"><img src="${mediaUrl}" alt="${escapeHtml(caption)}" loading="lazy" /><div class="caption">${escapeHtml(caption)}</div></div>`;
}

function attachEvents() {
  document.querySelector('#fieldSearch')?.addEventListener('input', e => { state.searchQuery = e.target.value; render(); });
  document.querySelector('#clearSearch')?.addEventListener('click', () => {
    state.searchQuery = '';
    render();
    document.querySelector('#fieldSearch')?.focus();
  });
  document.querySelector('#settingsToggle')?.addEventListener('click', () => { state.view = state.view === 'settings' ? 'main' : 'settings'; render(); });
  document.querySelector('#closeSettings')?.addEventListener('click', () => { state.view = 'main'; render(); });
  document.querySelector('#refreshPack')?.addEventListener('click', async () => { await reloadSelectedPack(); render(); });
  document.querySelector('#reloadPackSettings')?.addEventListener('click', async () => { await reloadSelectedPack(); render(); });
  document.querySelector('#languageSelect')?.addEventListener('change', e => {
    state.settings.language = e.target.value;
    saveSettings();
    render();
  });
  document.querySelector('#packSelect')?.addEventListener('change', async e => {
    state.settings.packId = e.target.value;
    saveSettings();
    await loadSelectedPack();
    render();
  });
  document.querySelector('#sortMode')?.addEventListener('change', e => {
    state.settings.sortMode = e.target.value;
    saveSettings();
    render();
  });
  document.querySelector('#safetyMarginM')?.addEventListener('change', e => {
    state.settings.safetyMarginM = Number(e.target.value);
    saveSettings();
    render();
  });
  document.querySelector('#manualAltitudeM')?.addEventListener('change', e => {
    state.settings.manualAltitudeM = Number(e.target.value);
    saveSettings();
    render();
  });
  for (const id of ['hideC', 'hideD', 'useManualAltitude']) {
    document.querySelector(`#${id}`)?.addEventListener('change', e => {
      if ((id === 'hideC' || id === 'hideD') && !e.target.checked) {
        // Revealing difficult fields — make the pilot acknowledge the risk before showing them.
        const label = id === 'hideC' ? 'C' : 'D';
        const severity = label === 'D' ? t('sevVeryDifficult') : t('sevDifficult');
        const ok = confirm(t('revealConfirm', label, severity));
        if (!ok) {
          e.target.checked = true; // decline: leave them hidden
          return;
        }
      }
      state.settings[id] = e.target.checked;
      if (id === 'useManualAltitude') computeRows();
      saveSettings();
      render();
    });
  }
  document.querySelector('#downloadPack')?.addEventListener('click', downloadOfflinePack);
  document.querySelector('#exportCup')?.addEventListener('click', exportCup);
  document.querySelector('#syncDataBtn')?.addEventListener('click', () => {
    // Jump to Settings so the pilot watches the sync progress there, instead of the
    // banner appearing to do nothing (progress only renders on the settings page).
    state.view = 'settings';
    syncPackDelta();
  });
  document.querySelectorAll('[data-field-id]').forEach(row => row.addEventListener('click', () => {
    state.selectedFieldId = row.getAttribute('data-field-id');
    state.detailScrollTop = 0;
    render();
  }));
  document.querySelector('.detail')?.addEventListener('scroll', e => { state.detailScrollTop = e.currentTarget.scrollTop; }, { passive: true });
  document.querySelector('#closeDetail')?.addEventListener('click', () => { state.selectedFieldId = null; state.detailScrollTop = 0; render(); });
  document.querySelector('#detailBackdrop')?.addEventListener('click', e => {
    if (e.target.id === 'detailBackdrop') { state.selectedFieldId = null; state.detailScrollTop = 0; render(); }
  });
}

async function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register(new URL('service-worker.js', BASE_URL)); } catch (e) { console.warn(e); }
  }
}

async function clearPackCache(packId) {
  if (!('caches' in window) || !packId) return 0;
  const packRootUrl = new URL(`packs/${packId}/`, BASE_URL).toString();
  const cache = await caches.open(DATA_CACHE);
  let deleted = 0;
  for (const request of await cache.keys()) {
    if (request.url === PACK_INDEX_URL || request.url.startsWith(packRootUrl)) {
      if (await cache.delete(request)) deleted += 1;
    }
  }
  return deleted;
}

function buildOfflineMediaUrls() {
  const urls = new Set();
  if (state.packManifest && state.currentManifestUrl) {
    for (const field of state.fields) {
      for (const media of field.media || []) {
        if (media?.url) urls.add(new URL(media.url, state.currentManifestUrl).toString());
      }
    }
  }
  return Array.from(urls);
}

async function downloadOfflinePack() {
  if (!('caches' in window)) {
    alert(t('noCacheApi'));
    return;
  }

  const urls = buildOfflineMediaUrls();
  if (!urls.length) {
    state.cacheStatus = state.packManifest ? 'ready' : 'unknown';
    state.cacheProgress = state.packManifest ? t('cpNoMedia') : t('cpNoPack');
    render();
    return;
  }

  const cache = await caches.open(DATA_CACHE);
  state.cacheStatus = 'downloading';
  state.cacheProgress = t('cpInit', urls.length);
  render();

  let ok = 0;
  let failed = 0;
  for (let i = 0; i < urls.length; i += 1) {
    const url = urls[i];
    try {
      const response = await fetch(url, { cache: 'reload' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
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

    state.cacheProgress = t('cpCachedFailed', ok, urls.length, failed);
    render();
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  // Record the synced baseline so future data updates only fetch the delta.
  try {
    storeSyncedManifest(selectedPack()?.id, await fetchMediaManifest());
  } catch (error) {
    console.warn('Could not record synced media manifest', error);
  }

  state.cacheStatus = failed === 0 ? 'ready' : 'incomplete';
  state.cacheProgress = t('cpCachedFailed', ok, urls.length, failed);
  render();
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

function updateDataUpdateFlag(packId) {
  // Only prompt pilots who already downloaded a pack: a newer published version than the one
  // they last synced means their offline media/docs are stale.
  const synced = localStorage.getItem(syncedVersionKey(packId)) || '';
  const live = state.packManifest?.version || '';
  state.dataUpdateAvailable = Boolean(synced && live && synced !== live);
}

function mediaManifestUrl() {
  return new URL('media-manifest.json', state.currentManifestUrl || BASE_URL).toString();
}

async function fetchMediaManifest() {
  const res = await fetch(mediaManifestUrl(), { cache: 'reload' });
  if (!res.ok) throw new Error(`media-manifest HTTP ${res.status}`);
  return res.json();
}

function storeSyncedManifest(packId, manifest) {
  if (!packId || !manifest) return;
  try {
    localStorage.setItem(syncedManifestKey(packId), JSON.stringify(manifest));
    localStorage.setItem(syncedVersionKey(packId), manifest.version || '');
  } catch (error) {
    console.warn('Could not persist synced manifest', error);
  }
  state.dataUpdateAvailable = false;
}

function isPackMediaOrDocUrl(url) {
  return url.includes('/packs/') && (url.includes('/media/') || url.includes('/docs/'));
}

// Incremental data update: refresh field text, then download only the media/docs whose
// content hash changed (per media-manifest.json), and evict files no longer referenced.
async function syncPackDelta() {
  if (!('caches' in window)) {
    alert(t('noCacheApi'));
    return;
  }
  const packId = selectedPack()?.id;
  state.cacheStatus = 'downloading';
  state.cacheProgress = t('cpRefreshing');
  render();

  await loadSelectedPack({ cacheMode: 'reload' });

  let manifest;
  try {
    manifest = await fetchMediaManifest();
  } catch (error) {
    // Older pack without a hash manifest: fall back to a full verify/download.
    console.warn('No media manifest; full download fallback', error);
    await downloadOfflinePack();
    return;
  }

  const files = manifest.files || {};
  const stored = (() => { try { return JSON.parse(localStorage.getItem(syncedManifestKey(packId)) || '{}'); } catch { return {}; } })();
  const storedFiles = stored.files || {};
  const cache = await caches.open(DATA_CACHE);

  const referenced = new Set();
  for (const field of state.fields) {
    for (const media of field.media || []) {
      if (media?.url) referenced.add(media.url);
    }
  }

  // New/changed referenced files, plus any referenced file missing from the cache.
  const cachedUrls = new Set((await cache.keys()).map(request => request.url));
  const toDownload = [];
  for (const key of referenced) {
    const entry = files[key];
    if (!entry) continue;
    const abs = new URL(key, state.currentManifestUrl).toString();
    const changed = !storedFiles[key] || storedFiles[key].h !== entry.h;
    if (changed || !cachedUrls.has(abs)) toDownload.push(abs);
  }

  let ok = 0;
  let failed = 0;
  for (let i = 0; i < toDownload.length; i += 1) {
    const abs = toDownload[i];
    try {
      const res = await fetch(abs, { cache: 'reload' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await cache.put(abs, res.clone());
      ok += 1;
    } catch (error) {
      if (await cache.match(abs)) ok += 1; else failed += 1;
    }
    state.cacheProgress = t('cpUpdating', ok, toDownload.length, failed);
    render();
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  // Evict cached media/docs that the new pack no longer references.
  const referencedAbs = new Set([...referenced].map(key => new URL(key, state.currentManifestUrl).toString()));
  let evicted = 0;
  for (const request of await cache.keys()) {
    if (isPackMediaOrDocUrl(request.url) && !referencedAbs.has(request.url)) {
      if (await cache.delete(request)) evicted += 1;
    }
  }

  storeSyncedManifest(packId, manifest);
  state.cacheStatus = failed === 0 ? 'ready' : 'incomplete';
  state.cacheProgress = t('cpUpdated', ok, evicted, failed);
  render();
}

// --- SeeYou CUP export, generated in-app from the loaded fields (offline, always in sync) ---

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
// All localized structured-block labels, used only to strip those lines out of CUP prose.
const CUP_STRUCTURED_LABELS = [
  'Info', 'Surface', 'Direction', 'Slope', 'Visit', 'Modified', 'Feedback', 'Reported hazards',
  'Oberfläche', 'Oberflaeche', 'Richtung', 'Neigung', 'Besichtigung', 'Geändert', 'Geaendert', 'Rückmeldungen', 'Rueckmeldungen', 'Gemeldete Gefahren',
  'Pente', 'Visite', 'Modifié', 'Modifie', 'Retours', 'Dangers signalés', 'Dangers signales',
];
const escapeRegExp = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Pull a labelled value ("Surface: grass", "Direction: 07/25") out of the notes block. The
// streckenflug import writes these as their own lines; returns '' when no variant is present.
function cupNoteValue(notes, labels) {
  const alt = (Array.isArray(labels) ? labels : [labels]).map(escapeRegExp).join('|');
  const match = new RegExp(`^\\s*(?:${alt})\\s*:\\s*(.+)$`, 'im').exec(String(notes || ''));
  if (!match) return '';
  return match[1].split(/[.;\n]/)[0].trim().replace(/\s+/g, ' ').slice(0, 40);
}

// The Guide des Aires ("guide des vaches") free-text field description, kept alongside the
// structured summary. Strips the streckenflug labelled block (any language), OpenAIP/VAC import
// boilerplate, URLs, and a leading runway token so info already shown above (difficulty,
// direction…) is not duplicated. Only guide-sourced fields carry this prose; other sources stay
// compact. `notes` is the note already resolved to the export language.
function cupGuideNotes(field, notes) {
  if (!/Guide des Aires|planeur-net/i.test(field.source?.name || '')) return '';
  const labelAlt = CUP_STRUCTURED_LABELS.map(escapeRegExp).join('|');
  const text = String(notes || '')
    .replace(/^\s*streckenflug\.at source:.*$/gim, '')
    .replace(/^\s*(?:Landout Field|Airstrip|Airfield|Airport)\b.*$/gim, '')
    .replace(new RegExp(`^\\s*(?:${labelAlt})\\s*:.*$`, 'gim'), '')
    .replace(/^\s*-{2,}\s*$/gim, '')
    .replace(/Glider-relevant airfield imported from OpenAIP[^.]*\.?/gi, '')
    .replace(/Official aerodrome entry created from SIA VAC import\.?/gi, '')
    .replace(/Coordinates\/dimensions are from the airport source[^.]*\.?/gi, '')
    .replace(/Verify (?:current official AIP\/VAC data before use|the attached official VAC)\.?/gi, '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/^\s*(?:[NSEW]{1,2}\/[NSEW]{1,2}|\d{1,3}\/\d{1,3}|\d{2,3})\b\.?\s+/, '');
  return text.replace(/\s+/g, ' ').trim().slice(0, 240);
}

// Compact waypoint description: difficulty, frequency, length×width, surface, direction/pistes,
// then the Guide des Aires prose. The full field notes stay in the app; the CUP stays readable.
// Prose and structured values come from the note in the pilot's current language.
function cupDescription(field) {
  const notes = fieldNotes(field);
  const parts = [];
  if (field.difficulty && field.difficulty !== 'UNKNOWN') parts.push(`[${field.difficulty}]`);
  const freq = cupFrequency(field);
  if (freq) parts.push(`${freq} MHz`);
  const length = Number(field.lengthM);
  const width = Number(field.widthM);
  if (Number.isFinite(length) && length > 0 && Number.isFinite(width) && width > 0) {
    parts.push(`${Math.round(length)}×${Math.round(width)} m`);
  } else if (Number.isFinite(length) && length > 0) {
    parts.push(`${Math.round(length)} m`);
  }
  const surface = cupNoteValue(notes, CUP_LABELS.surface);
  if (surface) parts.push(surface);
  const direction = cupNoteValue(notes, CUP_LABELS.direction)
    || (Number.isFinite(field.runwayDirectionDeg) ? `${String(Math.round(field.runwayDirectionDeg)).padStart(3, '0')}°` : '');
  if (direction) parts.push(direction);
  const prose = cupGuideNotes(field, notes);
  if (prose) parts.push(prose);
  return parts.join(' · ');
}

function generateCupText() {
  // Style: 5 = airfield (solid surface), 3 = outlanding field.
  const rows = ['name,code,country,lat,lon,elev,style,rwdir,rwlen,freq,desc'];
  for (const field of state.fields) {
    if (!Number.isFinite(field.latitude) || !Number.isFinite(field.longitude)) continue;
    const name = String(field.name || field.code || 'field').replace(/^#?\d+\s+/, '').trim();
    const elev = Number.isFinite(field.elevationM) ? `${Math.round(field.elevationM)}m` : '';
    const rwdir = Number.isFinite(field.runwayDirectionDeg) ? Math.round(field.runwayDirectionDeg) : '';
    const rwlen = Number.isFinite(field.lengthM) && field.lengthM > 0 ? `${Math.round(field.lengthM)}m` : '';
    rows.push([
      cupQuote(name),
      cupQuote(field.code || ''),
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

async function exportCup() {
  if (!state.fields.length) { alert(t('noPackYet')); return; }
  const filename = `meet-the-cows-${selectedPack()?.id || 'pack'}-${resolveLang()}.cup`;
  const text = generateCupText();
  // Prefer the share sheet on phones (Save to Files, or open straight into SeeYou).
  try {
    const file = new File([text], filename, { type: 'text/plain' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: filename });
      return;
    }
  } catch (error) {
    if (error?.name === 'AbortError') return;
    console.warn('CUP share failed, falling back to download', error);
  }
  // Fallback: a direct file download (desktop, Android).
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
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

function fmtKm(m) { return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`; }
function fmtM(m) { return `${Math.round(m)} m`; }
function fmtSignedM(m) { return `${m >= 0 ? '+' : ''}${Math.round(m)} m`; }
function fmtDeg(d) { return `${Math.round(d).toString().padStart(3, '0')}°`; }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c])); }
