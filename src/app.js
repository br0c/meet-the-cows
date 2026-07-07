const APP_VERSION = '0.4.5-beta';
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
  safetyMarginM: 250,
  hideC: true,
  hideD: true,
  sortMode: 'glide',
  useManualAltitude: false,
  manualAltitudeM: 2500,
};

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
  state.cacheProgress = 'Clearing cached pack';
  render();

  try {
    const pack = selectedPack();
    if (pack) {
      const deleted = await clearPackCache(pack.id);
      state.cacheProgress = `Cleared ${deleted} cached pack entries`;
      render();
    }

    state.cacheProgress = 'Fetching fresh pack index';
    render();
    await loadPackIndex({ cacheMode: 'reload' });

    state.cacheProgress = 'Fetching fresh pack';
    render();
    await loadSelectedPack({ cacheMode: 'reload' });

    if (state.cacheStatus !== 'error') {
      state.cacheProgress = `Fresh pack loaded · ${state.cacheProgress || 'media/docs not checked'}`;
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
  if (altitude === null) return 'missing';
  return `${fmtM(altitude)}${state.settings.useManualAltitude ? ' manual' : ''}`;
}

function computeRows() {
  if (!state.position) {
    state.computedRows = [];
    return;
  }
  const altitudeM = activeAltitudeM();
  const safetyMarginM = Number(state.settings.safetyMarginM) || 0;
  let rows = state.fields.map(field => {
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
        ? 'GPS altitude missing'
        : fieldElevationM === null
          ? 'Field elevation missing'
          : `Below safe arrival by ${Math.abs(Math.round(usableHeightM))} m`;
    return { field, distanceM, bearingDeg, usableHeightM, requiredGlideRatio, glideReason };
  });
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
  computeRows();
  const selected = state.fields.find(f => f.id === state.selectedFieldId);
  app.innerHTML = `
    <div class="app-shell">
      <header class="header compact-header">
        <div class="title-row">
          <button id="settingsToggle" class="icon-button" title="Settings" aria-label="Settings">⚙</button>
          <h1>🐄 Meet the Cows</h1>
          <button id="refreshPack" class="icon-button" title="Refresh pack" aria-label="Refresh pack">↻</button>
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
      <span><strong>Shown</strong> ${state.computedRows.length}/${state.fields.length}</span>
    </div>
  `;
}

function gpsLabel() {
  if (state.gpsStatus === 'ok') return `OK ±${Math.round(state.position?.accuracyM || 0)}m`;
  if (state.gpsStatus === 'error') return `Error`;
  return state.gpsStatus;
}

function renderWarnings() {
  const items = [];
  if (state.packManifest?.isSample) items.push('Sample data only — do not use this pack in flight. Run the importer to build the real Guide des Aires pack.');
  if (state.gpsStatus === 'error') items.push(`GPS error: ${escapeHtml(state.gpsError)}.`);
  if (state.position && state.position.altitudeM === null && !state.settings.useManualAltitude) items.push('GPS altitude is missing, so required glide ratio cannot be computed. Add a manual altitude in Settings for ground testing.');
  if (!items.length) return '';
  return items.map(i => `<div class="warning">${i}</div>`).join('');
}

function renderMainPage() {
  return `
    ${renderUpdateBanner()}
    ${renderWarnings()}
    ${renderFieldList()}
    <p class="footer-note">Not for primary navigation. Straight-line distance/glide only: no wind, sink, terrain clearance or airspace.</p>
  `;
}

function renderUpdateBanner() {
  if (!state.dataUpdateAvailable) return '';
  return `
    <div class="update-banner">
      <span>🔄 New field data available.</span>
      <button id="syncDataBtn" class="primary">Update</button>
    </div>
  `;
}

function renderSettingsPage() {
  const packs = state.packs.map(p => `<option value="${p.id}" ${p.id === state.settings.packId ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('');
  const manifest = state.packManifest;
  return `
    <section class="settings-page">
      <div class="settings-head">
        <h2>Settings</h2>
        <button id="closeSettings">Done</button>
      </div>

      <div class="settings-card">
        <h3>App</h3>
        <dl class="meta-list">
          <div><dt>Version</dt><dd>${escapeHtml(APP_VERSION)}</dd></div>
          <div><dt>Status</dt><dd>Beta — not for primary navigation</dd></div>
        </dl>
      </div>

      <div class="settings-card">
        <h3>Pack</h3>
        <label for="packSelect">Selected pack</label>
        <select id="packSelect">${packs}</select>
        <dl class="meta-list">
          <div><dt>Name</dt><dd>${escapeHtml(manifest?.name || 'No pack loaded')}</dd></div>
          <div><dt>Version</dt><dd>${escapeHtml(manifest?.version || '—')}</dd></div>
          <div><dt>Updated</dt><dd>${escapeHtml(manifest?.updatedAt || manifest?.generatedAt || manifest?.source?.updatedAt || '—')}</dd></div>
          <div><dt>Fields</dt><dd>${state.fields.length}</dd></div>
          <div><dt>Offline</dt><dd>${escapeHtml(state.cacheStatus)}</dd></div>
          <div><dt>Progress</dt><dd>${escapeHtml(state.cacheProgress || '—')}</dd></div>
        </dl>
        <div class="button-row">
          <button class="primary" id="downloadPack">Download / verify media & docs</button>
          <button id="reloadPackSettings">Reload pack</button>
        </div>
        <div class="button-row single">
          <button id="exportCup">Export CUP for SeeYou (${state.fields.length} fields)</button>
        </div>
        <p class="settings-note">Waypoint file for SeeYou Navigator and other nav apps. Brief a field here, then navigate to it in SeeYou.</p>
      </div>

      <div class="settings-card">
        <h3>Nearest list</h3>
        <label for="sortMode">Sort</label>
        <select id="sortMode">
          <option value="glide" ${state.settings.sortMode === 'glide' ? 'selected' : ''}>Best glide ratio</option>
          <option value="distance" ${state.settings.sortMode === 'distance' ? 'selected' : ''}>Nearest distance</option>
        </select>
        <label for="safetyMarginM">Safety arrival margin, m</label>
        <input id="safetyMarginM" inputmode="numeric" type="number" min="0" step="50" value="${state.settings.safetyMarginM}" />
        <div class="checkbox-row">
          <input id="useManualAltitude" type="checkbox" ${state.settings.useManualAltitude ? 'checked' : ''} />
          <label for="useManualAltitude">Use manual altitude for testing</label>
        </div>
        <label for="manualAltitudeM">Manual altitude, m</label>
        <input id="manualAltitudeM" inputmode="numeric" type="number" min="0" step="50" value="${state.settings.manualAltitudeM}" ${state.settings.useManualAltitude ? '' : 'disabled'} />
        <p class="settings-note">Manual altitude is only for ground testing. In flight, leave it off and use iPhone GPS altitude.</p>
        <div class="checkbox-row">
          <input id="hideC" type="checkbox" ${state.settings.hideC ? 'checked' : ''} />
          <label for="hideC">Hide C fields</label>
        </div>
        <div class="checkbox-row">
          <input id="hideD" type="checkbox" ${state.settings.hideD ? 'checked' : ''} />
          <label for="hideD">Hide D fields</label>
        </div>
        <p class="settings-note">C and D fields are hidden by default. They are difficult and possibly dangerous — recommended only as last-resort emergency options.</p>
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

function renderFieldRow({ field, distanceM, requiredGlideRatio, glideReason }) {
  return `
    <button class="field-row" data-field-id="${field.id}" title="${escapeHtml(glideReason || '')}">
      <span class="field-main">
        <span class="field-name">${escapeHtml(shortFieldName(field.name))}</span>
        <span class="field-sub">${escapeHtml([field.code, field.kind === 'airfield' ? 'Airfield' : 'Field'].filter(Boolean).join(' · '))}</span>
      </span>
      <span class="field-distance">${fmtKm(distanceM)}</span>
      <span class="field-glide ${requiredGlideRatio ? '' : 'missing'}">${requiredGlideRatio ? `${Math.round(requiredGlideRatio)}` : '—'}</span>
      <span class="badge ${difficultyBadgeClass(field)}">${escapeHtml(difficultyLabel(field))}</span>
    </button>
  `;
}

function renderFieldList() {
  if (!state.fields.length) return '<div class="warning">No fields loaded.</div>';
  if (!state.position) return '<div class="warning">Waiting for GPS. Enable location permission.</div>';
  const picks = topPickRows();
  const pickIds = new Set(picks.map(row => row.field.id));
  const rest = state.computedRows.filter(row => !pickIds.has(row.field.id)).slice(0, 120);
  return `
    <section class="field-list" aria-label="Nearest landing fields">
      <div class="field-list-head">
        <span>Name</span><span>Dist</span><span>Glide</span><span>Diff</span>
      </div>
      ${picks.map(renderFieldRow).join('')}
      ${picks.length && rest.length ? '<div class="top-picks-divider" role="separator"></div>' : ''}
      ${rest.map(renderFieldRow).join('')}
    </section>
  `;
}

function renderDetail(field) {
  const row = state.computedRows.find(r => r.field.id === field.id);
  const glideNote = row?.glideReason ? `<p class="inline-note">Glide not shown: ${escapeHtml(row.glideReason)}.</p>` : '';
  const media = (field.media || []).map(item => renderMediaItem(item)).join('') || '<p class="footer-note">No media attached.</p>';
  return `
    <div class="detail-backdrop" id="detailBackdrop">
      <article class="detail" role="dialog" aria-modal="true">
        <button id="closeDetail">Close</button>
        <div class="detail-title-row">
          <h2>${escapeHtml(field.name)}</h2>
          <span class="badge detail-badge ${difficultyBadgeClass(field)}">${escapeHtml(difficultyLabel(field))}</span>
        </div>
        <div class="detail-meta">${escapeHtml([field.code, field.kind === 'airfield' ? 'Airfield' : 'Outlanding', field.rawDifficulty].filter(Boolean).join(' · '))}</div>
        <div class="detail-grid">
          <div class="detail-card"><span class="status-label">Bearing</span><strong>${row ? fmtDeg(row.bearingDeg) : '—'}</strong></div>
          <div class="detail-card"><span class="status-label">Distance</span><strong>${row ? fmtKm(row.distanceM) : '—'}</strong></div>
          <div class="detail-card"><span class="status-label">Req glide</span><strong>${row?.requiredGlideRatio ? `${Math.round(row.requiredGlideRatio)}` : '—'}</strong></div>
          <div class="detail-card"><span class="status-label">Δsafe</span><strong>${row?.usableHeightM !== null && row ? fmtSignedM(row.usableHeightM) : '—'}</strong></div>
          <div class="detail-card"><span class="status-label">Elevation</span><strong>${field.elevationM !== null ? fmtM(field.elevationM) : '—'}</strong></div>
          <div class="detail-card"><span class="status-label">Runway</span><strong>${escapeHtml(formatRunwayDimensions(field))}</strong></div>
          <div class="detail-card"><span class="status-label">Frequency</span><strong>${escapeHtml(formatFrequency(field))}</strong></div>
        </div>
        ${glideNote}
        <h3>Notes</h3>
        <div class="notes">${escapeHtml(field.notes || 'No notes.')}</div>
        <h3>Photos / docs / VAC</h3>
        <div class="media-grid">${media}</div>
        <p class="footer-note">Source: ${escapeHtml(field.source?.name || 'unknown')} ${field.source?.importedAt ? `· imported ${escapeHtml(field.source.importedAt)}` : ''}</p>
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
    return `<div class="media-card"><iframe src="${mediaUrl}" title="${escapeHtml(caption)}"></iframe><div class="caption"><a href="${mediaUrl}" target="_blank" rel="noopener">Open PDF</a> · ${escapeHtml(caption)}</div></div>`;
  }
  return `<div class="media-card"><img src="${mediaUrl}" alt="${escapeHtml(caption)}" loading="lazy" /><div class="caption">${escapeHtml(caption)}</div></div>`;
}

function attachEvents() {
  document.querySelector('#settingsToggle')?.addEventListener('click', () => { state.view = state.view === 'settings' ? 'main' : 'settings'; render(); });
  document.querySelector('#closeSettings')?.addEventListener('click', () => { state.view = 'main'; render(); });
  document.querySelector('#refreshPack')?.addEventListener('click', async () => { await reloadSelectedPack(); render(); });
  document.querySelector('#reloadPackSettings')?.addEventListener('click', async () => { await reloadSelectedPack(); render(); });
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
        const severity = label === 'D' ? 'very difficult' : 'difficult';
        const ok = confirm(`Difficulty ${label} fields are ${severity} and possibly dangerous — last-resort emergency options only, not recommended. Show them in the nearest list anyway?`);
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
    alert('Cache Storage is not available in this browser.');
    return;
  }

  const urls = buildOfflineMediaUrls();
  if (!urls.length) {
    state.cacheStatus = state.packManifest ? 'ready' : 'unknown';
    state.cacheProgress = state.packManifest ? 'No media/docs to cache' : 'No pack loaded';
    render();
    return;
  }

  const cache = await caches.open(DATA_CACHE);
  state.cacheStatus = 'downloading';
  state.cacheProgress = `0/${urls.length} media/docs`;
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

    state.cacheProgress = `${ok}/${urls.length} media/docs cached · ${failed} failed`;
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
  state.cacheProgress = `${ok}/${urls.length} media/docs cached · ${failed} failed`;
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
    state.cacheProgress = 'No media/docs to cache';
    return;
  }

  // One keys() call instead of one match() round-trip per file (~1500 on a full pack).
  const cachedUrls = new Set((await cache.keys()).map(request => request.url));
  let cached = 0;
  for (const url of urls) {
    if (cachedUrls.has(url)) cached += 1;
  }
  state.cacheStatus = cached === urls.length ? 'ready' : cached > 0 ? 'incomplete' : 'not downloaded';
  state.cacheProgress = `${cached}/${urls.length} media/docs cached`;
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
    alert('Cache Storage is not available in this browser.');
    return;
  }
  const packId = selectedPack()?.id;
  state.cacheStatus = 'downloading';
  state.cacheProgress = 'Refreshing field data…';
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
    state.cacheProgress = `Updating ${ok}/${toDownload.length} file(s)${failed ? ` · ${failed} failed` : ''}`;
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
  state.cacheProgress = `Updated ${ok} file(s)${evicted ? `, removed ${evicted}` : ''}${failed ? `, ${failed} failed` : ''}`;
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

// Pull a labelled value ("Surface: grass", "Direction: 07/25") out of the notes block. The
// streckenflug import writes these as their own lines; returns '' when the label is absent.
function cupNoteValue(notes, label) {
  const match = new RegExp(`^\\s*${label}\\s*:\\s*(.+)$`, 'im').exec(String(notes || ''));
  if (!match) return '';
  return match[1].split(/[.;\n]/)[0].trim().replace(/\s+/g, ' ').slice(0, 40);
}

// The Guide des Aires ("guide des vaches") free-text field description, kept alongside the
// structured summary. Strips the streckenflug labelled block, OpenAIP/VAC import boilerplate,
// URLs, and a leading runway token so info already shown above (difficulty, direction…) is not
// duplicated. Only guide-sourced fields carry this prose; streckenflug fields stay compact.
function cupGuideNotes(field) {
  if (!/Guide des Aires|planeur-net/i.test(field.source?.name || '')) return '';
  const text = String(field.notes || '')
    .replace(/^\s*streckenflug\.at source:.*$/gim, '')
    .replace(/^\s*(?:Landout Field|Airstrip|Airfield|Airport)\b.*$/gim, '')
    .replace(/^\s*(?:Info|Surface|Direction|Slope|Visit|Modified|Feedback|Reported hazards)\s*:.*$/gim, '')
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
function cupDescription(field) {
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
  const surface = cupNoteValue(field.notes, 'Surface');
  if (surface) parts.push(surface);
  const direction = cupNoteValue(field.notes, 'Direction')
    || (Number.isFinite(field.runwayDirectionDeg) ? `${String(Math.round(field.runwayDirectionDeg)).padStart(3, '0')}°` : '');
  if (direction) parts.push(direction);
  const prose = cupGuideNotes(field);
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
  if (!state.fields.length) { alert('No pack loaded yet.'); return; }
  const filename = `meet-the-cows-${selectedPack()?.id || 'pack'}.cup`;
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
