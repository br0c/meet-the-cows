const APP_VERSION = '0.7.5-beta';
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
  packIds: ['alps-west', 'alps-east'],
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
    fieldsLoaded: 'Fields', noFields: 'No fields loaded.',
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
    dlSaving: 'Saving offline', dlFailed: 'failed',
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
    whatsNew: 'What’s new', updatedTo: v => `🆕 Updated to ${v}`,
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
    fieldsLoaded: 'Terrains', noFields: 'Aucun terrain chargé.',
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
    dlSaving: 'Enregistrement hors ligne', dlFailed: 'échec(s)',
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
    whatsNew: 'Nouveautés', updatedTo: v => `🆕 Mise à jour ${v}`,
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
    fieldsLoaded: 'Felder', noFields: 'Keine Felder geladen.',
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
    dlSaving: 'Offline speichern', dlFailed: 'fehlgeschlagen',
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
    whatsNew: 'Neuigkeiten', updatedTo: v => `🆕 Aktualisiert auf ${v}`,
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
  contribFor: null,
  showNewField: false,
  showBugReport: false,
  releaseNotes: [],
  showReleaseNotes: false,
  updateNoteAvailable: false,
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
  activePacks: [],
};

const app = document.querySelector('#app');

init();

async function init() {
  render();
  registerServiceWorker();
  initReleaseNotes();
  await loadPackIndex();
  await loadSelectedPacks();
  startGps();
  render();
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
  return chosen.length ? chosen : (state.packs[0] ? [state.packs[0].id] : []);
}

function activePacks() {
  return activePackIds().map(id => state.packs.find(p => p.id === id)).filter(Boolean);
}

function selectedPack() {  // legacy single-pack callers use the first active pack
  return activePacks()[0] || state.packs[0];
}

function manifestUrlForPack(pack) {
  return new URL(pack.manifestUrl || `packs/${pack.id}/manifest.json`, BASE_URL).toString();
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
    render();
  }, 1000);
}

function updateStatusStrip() {
  const el = document.querySelector('#statusArea');
  if (el) el.innerHTML = renderStatus();
}

function renderOfflineBar() {
  const s = state.offlineSync;
  if (!s) return '';
  const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
  const failed = s.failed ? ` · ${s.failed} ${t('dlFailed')}` : '';
  return `
    <div class="offline-bar" role="status" aria-live="polite">
      <div class="offline-bar-track"><div class="offline-bar-fill" id="offlineBarFill" style="width:${pct}%"></div></div>
      <div class="offline-bar-label" id="offlineBarLabel">${escapeHtml(t('dlSaving'))} · ${pct}%${failed}</div>
    </div>`;
}

// Update the floating download bar in place (no full re-render), so the field list, search box
// and keyboard stay put while media downloads in the background.
function updateOfflineBar() {
  const s = state.offlineSync;
  if (!s) return;
  const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
  const fill = document.querySelector('#offlineBarFill');
  const label = document.querySelector('#offlineBarLabel');
  if (fill) fill.style.width = pct + '%';
  if (label) label.textContent = `${t('dlSaving')} · ${pct}%${s.failed ? ` · ${s.failed} ${t('dlFailed')}` : ''}`;
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
      <main class="main">
        ${state.view === 'settings' ? renderSettingsPage() : renderMainPage()}
      </main>
      ${selected ? renderDetail(selected) : ''}
      ${state.contribFor ? renderContribute(state.fields.find(f => f.id === state.contribFor)) : ''}
      ${renderNewField()}
      ${state.showReleaseNotes ? renderReleaseNotes() : ''}
      ${renderBugReport()}
      ${renderOfflineBar()}
    </div>
  `;
  // Lock background scroll while an overlay is open, so scrolling a short bottom-sheet doesn't
  // fall through to the list behind it.
  document.body.classList.toggle('modal-open', !!(selected || state.contribFor || state.showNewField || state.showReleaseNotes || state.showBugReport));
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
    ${renderReleaseBanner()}
    ${renderUpdateBanner()}
    ${renderWarnings()}
    <div id="fieldListArea">${renderFieldList()}</div>
    <p class="footer-note">${escapeHtml(t('footerNote'))}</p>
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

function renderSettingsPage() {
  const activeIds = new Set(activePackIds());
  // Hidden packs (e.g. the transitional whole-Alps alias kept for old cached shells) stay
  // resolvable but are not offered in the picker.
  const packList = state.packs.filter(p => !p.hidden).map(p => {
    const count = typeof p.fieldsCount === 'number' ? `${p.fieldsCount} ${t('fieldsWord')}` : '';
    return `<label class="pack-option">
        <input type="checkbox" class="packCheck" value="${escapeHtml(p.id)}" ${activeIds.has(p.id) ? 'checked' : ''} />
        <span class="pack-name">${escapeHtml(packName(p))}</span>
        <span class="pack-meta">${escapeHtml(count)}</span>
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

      <div class="settings-card">
        <h3>${t('app')}</h3>
        <label for="languageSelect">${t('language')}</label>
        <select id="languageSelect">${langOptions}</select>
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
      <button id="clearSearch" class="search-clear" ${q ? '' : 'hidden'} title="${escapeHtml(t('clearSearch'))}" aria-label="${escapeHtml(t('clearSearch'))}">✕</button>
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
        <div class="button-row single">
          <button id="openContribute" class="primary contribute-btn">📷 ${t('contribute')}</button>
        </div>
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

function renderMediaItem(item, base) {
  const caption = item.caption || item.source || item.type;
  const mediaUrl = new URL(item.url, base || state.currentManifestUrl || BASE_URL).toString();
  if (item.type === 'pdf') {
    return `<div class="media-card"><iframe src="${mediaUrl}" title="${escapeHtml(caption)}"></iframe><div class="caption"><a href="${mediaUrl}" target="_blank" rel="noopener">${t('openPdf')}</a> · ${escapeHtml(caption)}</div></div>`;
  }
  return `<div class="media-card"><img src="${mediaUrl}" alt="${escapeHtml(caption)}" loading="lazy" /><div class="caption">${escapeHtml(caption)}</div></div>`;
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
        <div class="detail-meta">${escapeHtml([shortFieldName(field.name), field.code].filter(Boolean).join(' · '))}</div>
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
  document.querySelector('#whatsNewLink')?.addEventListener('click', e => { e.preventDefault(); openReleaseNotes(); });
  document.querySelector('#closeNotes')?.addEventListener('click', () => { state.showReleaseNotes = false; render(); });
  document.querySelector('#notesBackdrop')?.addEventListener('click', e => {
    if (e.target.id === 'notesBackdrop') { state.showReleaseNotes = false; render(); }
  });
  document.querySelector('#settingsToggle')?.addEventListener('click', () => { state.view = state.view === 'settings' ? 'main' : 'settings'; render(); });
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
  attachFieldRowEvents(document);
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

// Every media/doc URL the current selection references, mapped to the file size the build
// stamped on it (0 when a pack predates the bytes stamp — those are only presence-checked).
function buildOfflineMediaTargets() {
  const targets = new Map();
  for (const field of state.fields) {
    const base = field._base || state.currentManifestUrl;
    if (!base) continue;
    for (const media of field.media || []) {
      if (!media?.url) continue;
      const url = new URL(media.url, base).toString();
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
  const cachedUrls = new Set((await cache.keys()).map(request => request.url));
  const toFetch = [];
  let kept = 0;
  for (const [url, expectedBytes] of targets) {
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
    state.offlineSync = { done: 0, total: toFetch.length, failed: 0 };
    render();  // once: shows the floating bar; per-file updates below are in place (no re-render)
    for (let i = 0; i < toFetch.length; i += 1) {
      const url = toFetch[i];
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

      state.offlineSync = { done: i + 1, total: toFetch.length, failed };
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
      if (isPackMediaOrDocUrl(request.url) && !referenced.has(request.url)) {
        await cache.delete(request);
      }
    }
  } catch (error) {
    console.warn('Stale-media eviction skipped', error);
  }
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
const escapeRegExp = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Pull a labelled value ("Surface: grass", "Direction: 07/25") out of the notes block. The
// streckenflug import writes these as their own lines; returns '' when no variant is present.
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
  const ids = activePackIds();
  const packLabel = ids.length === 1 ? ids[0] : 'selection';
  const filename = `meet-the-cows-${packLabel}-${resolveLang()}.cup`;
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
