const APP_VERSION = '0.3.14-beta';
const CACHE_NAME = 'meet-the-cows-0.3.14-beta';
const BASE_URL = new URL('..', import.meta.url);
const PACK_INDEX_URL = new URL('packs/packs.json', BASE_URL).toString();
const SETTINGS_KEY = 'mtc-settings-v2';

/** @typedef {{ id:string, kind?:'outlanding'|'airfield', name:string, code?:string, country?:string, latitude:number, longitude:number, elevationM:number|null, difficulty:string, rawDifficulty?:string, lengthM:number|null, widthM:number|null, runwayDirectionDeg:number|null, frequency?:string, radio?:string, frequencies?:Array<{type?:string,mhz?:number,description?:string,source?:string}>, notes:string, source?:object, media:Array<{type:string,url:string,thumbnailUrl?:string,caption?:string,source?:string,updatedAt?:string}> }} Field */

const DEFAULT_SETTINGS = {
  packId: 'fr-alps',
  safetyMarginM: 250,
  hideC: false,
  hideD: true,
  sortMode: 'glide',
  demoMode: false,
  useManualAltitude: false,
  manualAltitudeM: 2500,
};

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
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
}

async function loadPackIndex() {
  try {
    const res = await fetch(PACK_INDEX_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`Pack index HTTP ${res.status}`);
    const index = await res.json();
    state.packs = Array.isArray(index) ? index : (Array.isArray(index.packs) ? index.packs : []);
    if (!state.packs.length) throw new Error('Pack index contained no packs');
  } catch (error) {
    console.error(error);
    state.packs = [{ id: 'fr-alps', name: 'France / Alps', manifestUrl: 'packs/fr-alps/manifest.json' }];
  }
}

async function loadSelectedPack() {
  const pack = state.packs.find(p => p.id === state.settings.packId) || state.packs[0];
  if (!pack) return;
  state.settings.packId = pack.id;
  try {
    const manifestUrl = new URL(pack.manifestUrl || `packs/${pack.id}/manifest.json`, BASE_URL).toString();
    const manifestRes = await fetch(manifestUrl, { cache: 'no-cache' });
    if (!manifestRes.ok) throw new Error(`Manifest HTTP ${manifestRes.status}`);
    state.packManifest = await manifestRes.json();
    state.currentManifestUrl = manifestUrl;
    const fieldsUrl = new URL(state.packManifest.fieldsUrl || 'fields.json', manifestUrl).toString();
    const fieldsRes = await fetch(fieldsUrl, { cache: 'no-cache' });
    if (!fieldsRes.ok) throw new Error(`Fields HTTP ${fieldsRes.status}`);
    state.fields = await fieldsRes.json();
    state.cacheProgress = '';
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

function startGps() {
  if (gpsWatchId !== null && 'geolocation' in navigator) {
    navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId = null;
  }
  if (state.settings.demoMode) {
    state.position = demoPosition();
    state.gpsStatus = 'demo';
    computeRows();
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

function demoPosition() {
  return {
    latitude: 44.392,
    longitude: 6.64,
    altitudeM: 2600,
    accuracyM: 5,
    altitudeAccuracyM: 30,
    timestamp: Date.now(),
  };
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
  if (state.gpsStatus === 'demo') return 'DEMO';
  if (state.gpsStatus === 'error') return `Error`;
  return state.gpsStatus;
}

function renderWarnings() {
  const items = [];
  if (state.packManifest?.isSample) items.push('Sample data only — do not use this pack in flight. Run the importer to build the real Guide des Aires pack.');
  if (state.gpsStatus === 'error') items.push(`GPS error: ${escapeHtml(state.gpsError)}. Use demo mode only for testing.`);
  if (state.position && state.position.altitudeM === null && !state.settings.useManualAltitude) items.push('GPS altitude is missing, so required glide ratio cannot be computed. Add a manual altitude in Settings for ground testing.');
  if (!items.length) return '';
  return items.map(i => `<div class="warning">${i}</div>`).join('');
}

function renderMainPage() {
  return `
    ${renderWarnings()}
    ${renderFieldList()}
    <p class="footer-note">Not for primary navigation. Straight-line distance/glide only: no wind, sink, terrain clearance or airspace.</p>
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
        <div class="checkbox-row">
          <input id="demoMode" type="checkbox" ${state.settings.demoMode ? 'checked' : ''} />
          <label for="demoMode">Demo near Ubaye</label>
        </div>
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

function renderFieldList() {
  if (!state.fields.length) return '<div class="warning">No fields loaded.</div>';
  if (!state.position) return '<div class="warning">Waiting for GPS. Enable location permission, or turn on demo mode in Settings.</div>';
  const rows = state.computedRows.slice(0, 120).map(({ field, distanceM, requiredGlideRatio, glideReason }) => `
    <button class="field-row" data-field-id="${field.id}" title="${escapeHtml(glideReason || '')}">
      <span class="field-main">
        <span class="field-name">${escapeHtml(shortFieldName(field.name))}</span>
        <span class="field-sub">${escapeHtml([field.code, field.kind === 'airfield' ? 'Airfield' : 'Field'].filter(Boolean).join(' · '))}</span>
      </span>
      <span class="field-distance">${fmtKm(distanceM)}</span>
      <span class="field-glide ${requiredGlideRatio ? '' : 'missing'}">${requiredGlideRatio ? `${Math.round(requiredGlideRatio)}` : '—'}</span>
      <span class="badge ${difficultyBadgeClass(field)}">${escapeHtml(difficultyLabel(field))}</span>
    </button>
  `).join('');
  return `
    <section class="field-list" aria-label="Nearest landing fields">
      <div class="field-list-head">
        <span>Name</span><span>Dist</span><span>Glide</span><span>Diff</span>
      </div>
      ${rows}
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
        <h2>${escapeHtml(field.name)}</h2>
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
  if (field.radio) return field.radio;
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
  document.querySelector('#refreshPack')?.addEventListener('click', async () => { await loadSelectedPack(); render(); });
  document.querySelector('#reloadPackSettings')?.addEventListener('click', async () => { await loadSelectedPack(); render(); });
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
  for (const id of ['hideC', 'hideD', 'demoMode', 'useManualAltitude']) {
    document.querySelector(`#${id}`)?.addEventListener('change', e => {
      state.settings[id] = e.target.checked;
      if (id === 'useManualAltitude') computeRows();
      if (id === 'demoMode') {
        if (e.target.checked) {
          state.position = demoPosition();
          state.gpsStatus = 'demo';
        } else {
          state.position = null;
          state.gpsStatus = 'idle';
        }
        startGps();
      }
      saveSettings();
      render();
    });
  }
  document.querySelector('#downloadPack')?.addEventListener('click', downloadOfflinePack);
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

  const cache = await caches.open(CACHE_NAME);
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

  state.cacheStatus = failed === 0 ? 'ready' : 'incomplete';
  state.cacheProgress = `${ok}/${urls.length} media/docs cached · ${failed} failed`;
  render();
}

async function checkCacheStatus() {
  if (!('caches' in window) || !state.packManifest || !state.currentManifestUrl) {
    state.cacheStatus = 'unknown';
    return;
  }
  const cache = await caches.open(CACHE_NAME);
  const urls = buildOfflineMediaUrls();
  if (!urls.length) {
    state.cacheStatus = 'ready';
    state.cacheProgress = 'No media/docs to cache';
    return;
  }

  let cached = 0;
  for (const url of urls) {
    if (await cache.match(url)) cached += 1;
  }
  state.cacheStatus = cached === urls.length ? 'ready' : cached > 0 ? 'incomplete' : 'not downloaded';
  state.cacheProgress = `${cached}/${urls.length} media/docs cached`;
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
