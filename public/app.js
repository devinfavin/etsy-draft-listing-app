const PHOTOS_PAGE_SIZE = 100;

const state = {
  config: null,
  photos: [],
  photosPage: 0,
  folders: [],
  photoIndex: new Map(),
  selectedImages: [],
  generated: null,
  step: 1,
  currentRelDir: '',
  rootDir: '',
  draggingSelectedIndex: null,
  dragTargetInsertIndex: null,
  dragPreviewEl: null,
  shippingProfiles: [],
  readinessStates: [],
  autoTaxonomyId: null,
  autoTaxonomyLabel: null,
  serverOnline: false,
  appVersion: 'dev',
};

const STEP_COUNT = 5;
const STEP_TITLES = {
  1: 'Setup',
  2: 'Choose Photos',
  3: 'Item Details',
  4: 'Review AI Listing',
  5: 'Create Etsy Draft',
};

const $ = (id) => document.getElementById(id);
const THEME_STORAGE_KEY = 'etsy_listing_theme';
const THEME_ICON_LIGHT = '\u2600';
const THEME_ICON_DARK = '\u263d';
const MAX_AI_IMAGE_COUNT = 10;
const DEFAULT_STORE_KEYS = ['store_1', 'store_2'];

function getPreferredTheme() {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === 'dark' || saved === 'light') return saved;
  } catch {}
  return 'light';
}

function applyTheme(theme) {
  const next = theme === 'dark' ? 'dark' : 'light';
  document.body.setAttribute('data-theme', next);

  const isDark = next === 'dark';
  const icon = $('themeToggleIcon');
  const btn = $('themeToggleBtn');
  if (icon) icon.textContent = isDark ? THEME_ICON_DARK : THEME_ICON_LIGHT;
  const currentLabel = isDark ? 'Dark' : 'Light';
  const nextLabel = isDark ? 'Light' : 'Dark';
  if (btn) {
    btn.title = `${currentLabel} mode`;
    btn.setAttribute('aria-label', `Current theme: ${currentLabel}. Click to switch to ${nextLabel}.`);
  }
}

function toggleTheme() {
  const current = document.body.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {}
}

const DRAFT_STORAGE_KEY = 'etsy_listing_draft';
let shippingProfilesLoading = false;
let readinessStatesLoading = false;

const detailLog = [];

function log(msg, type = 'info') {
  const ts = new Date().toLocaleTimeString();
  const line = `[${ts}] ${msg}`;
  const el = $('log');
  el.textContent = `${line}\n${el.textContent}`.slice(0, 20000);
  detailLog.unshift({ ts, line, type });
  if (detailLog.length > 2000) detailLog.pop();
  console[type === 'error' ? 'error' : 'log'](msg);
}

function logTechnical(data) {
  if (!data) return;
  const ts = new Date().toLocaleTimeString();
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  detailLog.unshift({ ts, line: `[${ts}] [detail] ${text}`, type: 'detail' });
  if (detailLog.length > 2000) detailLog.pop();
  console.log('[detail]', text);
}

function getFullLog() {
  return [...detailLog].reverse().map((e) => e.line).join('\n');
}

async function buildSupportBundle() {
  const lines = [];
  const now = new Date();
  lines.push('=== Etsy Draft Listing Assistant — Support Log ===');
  lines.push(`Generated: ${now.toISOString()} (${now.toLocaleString()})`);
  lines.push('');

  let info = null;
  try {
    info = await api('/api/support-info');
  } catch (err) {
    lines.push(`!! Could not fetch /api/support-info: ${err.message}`);
    lines.push('');
  }

  if (info) {
    lines.push('--- App / Runtime ---');
    lines.push(`App version:        ${info.app.version}`);
    lines.push(`Node.js:            ${info.app.nodeVersion}`);
    lines.push(`Electron:           ${info.app.electronVersion || '(none — running outside Electron)'}`);
    lines.push(`Platform:           ${info.app.platform} ${info.app.arch}`);
    lines.push(`Server started:     ${info.app.startedAt}`);
    lines.push('');

    lines.push('--- Environment ---');
    lines.push(`Data dir:           ${info.env.dataDir}`);
    lines.push(`Env file:           ${info.env.envFile}`);
    lines.push(`Port:               ${info.env.port}`);
    lines.push(`APP_BASE_URL:       ${info.env.appBaseUrl || '(unset)'}`);
    lines.push(`ETSY_REDIRECT_URI:  ${info.env.etsyRedirectUri || '(unset)'}`);
    lines.push(`CLAUDE_MODEL (env): ${info.env.claudeModel || '(unset)'}`);
    if (info.env.missingEnvKeys.length) {
      lines.push(`Missing env keys:   ${info.env.missingEnvKeys.join(', ')}`);
    } else {
      lines.push('Missing env keys:   none');
    }
    lines.push('');

    lines.push('--- Config ---');
    lines.push(`Sync folder:        ${info.config.syncFolder || '(not set)'}`);
    if (info.config.syncFolderStatus) {
      const s = info.config.syncFolderStatus;
      const status = s.exists
        ? `OK → ${s.resolved}`
        : `ERROR: ${s.error || 'not accessible'}`;
      lines.push(`Sync folder status: ${status}`);
    }
    lines.push(`Policy text len:    ${info.config.listingPolicyTextLength} chars`);
    lines.push(`Active store:       ${info.config.activeStoreKey}`);
    lines.push(`Claude model:       ${info.config.claudeModel}`);
    lines.push(`Send images to AI:  ${info.config.claudeIncludeImages}`);
    lines.push(`Max vision images:  ${info.config.claudeMaxImages}`);
    lines.push('');

    lines.push('--- File presence ---');
    for (const [name, f] of Object.entries(info.files || {})) {
      lines.push(`${name.padEnd(18)} ${f.exists ? 'present' : 'MISSING'}  ${f.path}`);
    }
    lines.push('');

    lines.push('--- Stores ---');
    for (const s of info.stores) {
      lines.push(`[${s.key}] ${s.label}`);
      lines.push(`  Shop ID:           ${s.shopId || '(none)'}`);
      lines.push(`  Connected:         ${s.connected ? 'yes' : 'no'}`);
      if (s.connected) {
        const exp = s.tokenExpiresAt ? new Date(s.tokenExpiresAt).toISOString() : 'unknown';
        lines.push(`  Token expires:     ${exp}`);
        lines.push(`  Scopes:            ${s.scopes || 'unknown'}`);
        lines.push(`  User ID:           ${s.userIdHint || '(unknown)'}`);
      }
      lines.push(`  Last folder:       ${s.lastFolder || '(none)'}`);
      const d = s.defaults;
      lines.push(`  Defaults:          when_made=${d.when_made || '-'}  taxonomy=${d.taxonomy_id || '-'}  shipping=${d.shipping_profile_id || '-'}  readiness=${d.readiness_state_id || '-'}  who_made=${d.who_made || '-'}  qty=${d.quantity ?? '-'}`);
    }
    lines.push('');
  }

  lines.push('--- Wizard state (client) ---');
  lines.push(`Current step:           ${state.step}`);
  lines.push(`Active store key:       ${getActiveStoreKey()}`);
  lines.push(`Selected photos:        ${state.selectedImages.length}`);
  lines.push(`Generated listing:      ${state.generated ? `present (title: "${(state.generated.title || '').slice(0, 80)}")` : 'none'}`);
  lines.push(`AI taxonomy match:      ${state.autoTaxonomyId ? `${state.autoTaxonomyId} (${state.autoTaxonomyLabel || 'no label'})` : '(not matched)'}`);
  lines.push(`Shipping profiles:      ${state.shippingProfiles.length} loaded`);
  lines.push(`Readiness states:       ${state.readinessStates.length} loaded`);
  lines.push(`Current rel dir:        ${state.currentRelDir || '(root)'}`);
  lines.push(`Server online:          ${state.serverOnline}`);
  lines.push('');

  lines.push('--- Browser / window ---');
  lines.push(`User agent:        ${navigator.userAgent}`);
  lines.push(`Window size:       ${window.innerWidth}x${window.innerHeight}`);
  lines.push(`Locale:            ${navigator.language}`);
  try {
    lines.push(`Timezone:          ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
  } catch {}
  lines.push(`Theme:             ${document.body.getAttribute('data-theme') || 'light'}`);
  lines.push('');

  lines.push('--- Activity log (last 200 entries, oldest first) ---');
  const recent = detailLog.slice(0, 200).reverse();
  if (!recent.length) {
    lines.push('(empty)');
  } else {
    for (const entry of recent) lines.push(entry.line);
  }

  return lines.join('\n');
}

async function api(url, options = {}) {
  const resp = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });

  const text = await resp.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { ok: false, error: text || 'Non-JSON response' };
  }

  if (!resp.ok || json.ok === false) {
    const message = json.error || `Request failed (${resp.status})`;
    const err = new Error(message);
    err.details = json.details;
    throw err;
  }
  return json;
}

function setConnectionStatus(kind, text) {
  const pill = $('connectionPill');
  const dot = $('connectionDot');
  const txt = $('connectionText');
  if (txt) txt.textContent = text;
  if (pill) {
    pill.classList.remove('connection-ok', 'connection-warn', 'connection-error', 'connection-pending');
    pill.classList.add(`connection-${kind}`);
    pill.setAttribute('aria-label',
      kind === 'ok' ? `${text} — click for options` :
      kind === 'warn' ? `${text} — click to connect` :
      kind === 'error' ? `${text}` :
      'Checking connection');
    pill.setAttribute('aria-expanded', 'false');
  }
  if (dot) {
    dot.classList.remove('ok', 'warn', 'error', 'pending');
    dot.classList.add(kind);
  }
  if (kind !== 'ok') closeConnectionMenu();
  updateConnectionMenu();
}

function updateConnectionMenu() {
  const btn = $('disconnectStoreBtn');
  if (!btn) return;
  const label = getActiveStore()?.label || 'store';
  btn.textContent = `Disconnect ${label}`;
}

function toggleConnectionMenu() {
  const menu = $('connectionMenu');
  const pill = $('connectionPill');
  if (!menu) return;
  const willOpen = menu.classList.contains('hidden');
  menu.classList.toggle('hidden');
  if (pill) pill.setAttribute('aria-expanded', String(willOpen));
}

function closeConnectionMenu() {
  const menu = $('connectionMenu');
  const pill = $('connectionPill');
  if (menu && !menu.classList.contains('hidden')) menu.classList.add('hidden');
  if (pill) pill.setAttribute('aria-expanded', 'false');
}

function getDefaultStoreTemplate(index) {
  return {
    key: DEFAULT_STORE_KEYS[index] || `store_${index + 1}`,
    label: `Store ${index + 1}`,
    shopId: '',
    lastFolder: '',
    defaults: {
      quantity: 1,
      who_made: 'someone_else',
      when_made: '',
      taxonomy_id: '',
      shipping_profile_id: '',
      readiness_state_id: '',
    },
  };
}

function normalizeClientConfig(cfg = {}) {
  const base = cfg || {};
  const etsy = base.etsy || {};
  const legacyDefaults = etsy.defaults || {};
  const legacyShopId = etsy.shopId || '';
  const incomingStores = Array.isArray(etsy.stores) ? etsy.stores : [];

  const stores = DEFAULT_STORE_KEYS.map((key, index) => {
    const incoming = incomingStores[index] || {};
    const fallback = getDefaultStoreTemplate(index);
    const useLegacy = !incomingStores.length && index === 0;
    return {
      key: String(incoming.key || key),
      label: String(incoming.label || fallback.label || '').trim() || fallback.label,
      shopId: String(useLegacy ? (incoming.shopId || legacyShopId) : (incoming.shopId || '')).trim(),
      lastFolder: String(incoming.lastFolder || '').trim(),
      defaults: {
        ...fallback.defaults,
        ...(useLegacy ? legacyDefaults : {}),
        ...(incoming.defaults || {}),
      },
    };
  });

  const storeKeys = new Set(stores.map((s) => s.key));
  const activeStoreKey = storeKeys.has(etsy.activeStoreKey) ? etsy.activeStoreKey : stores[0].key;

  return {
    ...base,
    claude: {
      model: base.claude?.model || '',
      includeImagesInPrompt: base.claude?.includeImagesInPrompt !== false,
    },
    etsy: {
      activeStoreKey,
      stores,
    },
  };
}

function getActiveStoreKey() {
  return $('activeStoreSelect')?.value
    || state.config?.etsy?.activeStoreKey
    || state.config?.etsy?.stores?.[0]?.key
    || DEFAULT_STORE_KEYS[0];
}

function getStoreByKey(key) {
  const cfg = normalizeClientConfig(state.config || {});
  return cfg.etsy.stores.find((s) => s.key === key) || cfg.etsy.stores[0];
}

function getActiveStore() {
  return getStoreByKey(getActiveStoreKey());
}

function renderStoreSwitcher() {
  const select = $('activeStoreSelect');
  if (!select) return;
  const cfg = normalizeClientConfig(state.config || {});
  select.innerHTML = '';
  for (const store of cfg.etsy.stores) {
    const opt = document.createElement('option');
    opt.value = store.key;
    opt.textContent = store.label || store.key;
    select.appendChild(opt);
  }
  select.value = cfg.etsy.activeStoreKey;
}

function loadActiveStoreIntoForm() {
  const store = getActiveStore();
  if (!store) return;
  populateReadinessStateDropdowns(state.readinessStates);
  populateShippingProfileDropdowns(state.shippingProfiles);
  updateShopSummary();
}

function persistActiveStoreFormIntoStateConfig() {
  if (!state.config) return;
  const cfg = normalizeClientConfig(state.config);
  cfg.etsy.activeStoreKey = getActiveStoreKey();
  state.config = cfg;
}

function normalizeRelPath(relPath) {
  const raw = String(relPath || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!raw || raw === '.') return '';
  return raw.replace(/\/+$/, '');
}

function setStep(step) {
  state.step = Math.min(Math.max(step, 1), STEP_COUNT);

  for (let i = 1; i <= STEP_COUNT; i += 1) {
    const panel = $(`step${i}`);
    if (!panel) continue;
    panel.classList.toggle('hidden', i !== state.step);
  }

  $('progressCurrent').textContent = String(state.step);
  $('progressTotal').textContent = String(STEP_COUNT);
  $('stepTitle').textContent = STEP_TITLES[state.step] || '';
  $('progressFill').style.width = `${(state.step / STEP_COUNT) * 100}%`;
  $('progressBar').setAttribute('aria-valuenow', String(state.step));

  updateStoreSwitcherLock();
  updateStep5Summary();
  if (state.step === 3) updateStep3ForExisting();
  if (state.step === 4) {
    updateTaxonomyDisplay();
    showTaxonomyDisplay();
  }
  if (state.step === 5) renderStep5MissingFields();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function updateStoreSwitcherLock() {
  const select = $('activeStoreSelect');
  if (!select) return;
  const locked = state.step !== 1;
  select.disabled = locked;
  select.title = locked ? 'Return to Step 1 to switch stores' : '';
  const wrap = select.closest('.store-switch');
  if (wrap) wrap.classList.toggle('locked', locked);
}

function loadFormFromConfig(cfg) {
  const normalized = normalizeClientConfig(cfg);
  state.config = normalized;

  if ($('syncFolder')) $('syncFolder').value = normalized.syncFolder || '';
  if ($('listingPolicyText')) $('listingPolicyText').value = normalized.listingPolicyText || '';
  renderStoreSwitcher();
  loadActiveStoreIntoForm();
}

function collectConfigFromForm() {
  persistActiveStoreFormIntoStateConfig();
  const cfg = normalizeClientConfig(state.config || {});
  return {
    syncFolder: $('syncFolder').value.trim(),
    claude: {
      model: state.config?.claude?.model || 'claude-sonnet-4-6',
      includeImagesInPrompt: true,
    },
    etsy: cfg.etsy,
    listingPolicyText: $('listingPolicyText').value.trim(),
  };
}

function collectIntake() {
  return {
    type: $('f_type').value.trim(),
    whenMade: $('f_whenMade').value,
    quantity: Number($('f_quantity').value || 1),
    price: $('f_price').value.trim(),
    notes: $('f_notes').value.trim(),
    shippingProfileId: $('f_shippingProfileId').value.trim(),
    readinessStateId: $('f_readinessStateId').value.trim(),
    taxonomyId: state.autoTaxonomyId || '',
  };
}

function setGeneratedOutput(out) {
  state.generated = out;
  if (out) saveGeneratedToStorage(out);
  $('o_title').value = out?.title || '';
  $('o_short_blurb').value = out?.short_blurb || '';
  $('o_condition_note').value = out?.condition_note || '';
  $('o_description').value = out?.description || '';
  $('o_bullet_specs').value = Array.isArray(out?.bullet_specs) ? out.bullet_specs.join('\n') : '';
  $('o_tags').value = Array.isArray(out?.tags) ? out.tags.join(', ') : '';
  $('o_materials').value = Array.isArray(out?.etsy_materials) ? out.etsy_materials.join(', ') : '';
  $('o_colors').value = Array.isArray(out?.etsy_colors) ? out.etsy_colors.join(', ') : '';
  $('o_alt_text').value = Array.isArray(out?.image_alt_text) ? out.image_alt_text.join('\n') : '';
}

function collectGeneratedOutput() {
  return {
    title: $('o_title').value.trim(),
    short_blurb: $('o_short_blurb').value.trim(),
    condition_note: $('o_condition_note').value.trim(),
    description: $('o_description').value.trim(),
    bullet_specs: $('o_bullet_specs').value.split(/\n+/).map((s) => s.trim()).filter(Boolean),
    tags: $('o_tags').value.split(',').map((s) => s.trim()).filter(Boolean),
    etsy_materials: $('o_materials').value.split(',').map((s) => s.trim()).filter(Boolean),
    etsy_colors: $('o_colors').value.split(',').map((s) => s.trim()).filter(Boolean),
    image_alt_text: $('o_alt_text').value.split(/\n+/).map((s) => s.trim()).filter(Boolean),
  };
}

function saveGeneratedToStorage(out) {
  try { localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(out)); } catch {}
}

function loadGeneratedFromStorage() {
  try { return JSON.parse(localStorage.getItem(DRAFT_STORAGE_KEY) || 'null'); } catch { return null; }
}

function clearGeneratedFromStorage() {
  try { localStorage.removeItem(DRAFT_STORAGE_KEY); } catch {}
}

function resetStep3Form() {
  $('f_type').value = '';
  $('f_price').value = '';
  $('f_quantity').value = '1';
  $('f_whenMade').value = '';
  $('f_readinessStateId').value = '';
  $('f_shippingProfileId').value = '';
  $('f_notes').value = '';
  for (const errId of ['f_typeError','f_priceError','f_quantityError','f_whenMadeError','f_readinessStateIdError','f_shippingProfileIdError']) {
    showFieldError(errId, '');
  }
}

function resetForNewListing() {
  state.generated = null;
  state.selectedImages = [];
  state.autoTaxonomyId = null;
  state.autoTaxonomyLabel = null;
  clearGeneratedFromStorage();
  resetStep3Form();
  renderSelectedStrip();
  renderBrowserItems();
  updateStep3ForExisting();
  $('etsyResult').textContent = '';
  $('postDraftRow').classList.add('hidden');
  $('o_title').value = '';
  $('o_description').value = '';
  $('o_tags').value = '';
  $('o_short_blurb').value = '';
  $('o_condition_note').value = '';
  $('o_bullet_specs').value = '';
  $('o_materials').value = '';
  $('o_colors').value = '';
  $('o_alt_text').value = '';
  updateTaxonomyDisplay();
  showTaxonomyDisplay();
}

function updateStep5Summary() {
  $('summaryPhotoCount').textContent = String(state.selectedImages.length);
  $('summaryPrice').textContent = $('f_price').value.trim() ? `$${$('f_price').value.trim()}` : '-';
  const title = $('o_title')?.value?.trim();
  $('summaryTitle').textContent = title || '-';
  const store = getActiveStore();
  $('summaryStore').textContent = store?.label || '-';

  const eraEl = $('summaryEra');
  if (eraEl) {
    const era = $('f_whenMade')?.value || store?.defaults?.when_made || '';
    eraEl.textContent = era ? humanizeEnum(era) : '-';
  }

  const shippingEl = $('summaryShipping');
  if (shippingEl) {
    const shipId = $('f_shippingProfileId')?.value || store?.defaults?.shipping_profile_id || '';
    const match = state.shippingProfiles.find((p) => String(p.id) === String(shipId));
    shippingEl.textContent = match?.title || (shipId ? `#${shipId}` : '-');
  }

  const readinessEl = $('summaryReadiness');
  if (readinessEl) {
    const readyId = $('f_readinessStateId')?.value || store?.defaults?.readiness_state_id || '';
    const match = state.readinessStates.find((s) => String(s.id) === String(readyId));
    readinessEl.textContent = match?.label || (readyId ? `#${readyId}` : '-');
  }

  const catEl = $('summaryCategory');
  const catRow = catEl?.parentElement;
  if (catEl && catRow) {
    if (state.autoTaxonomyLabel) {
      catEl.textContent = state.autoTaxonomyLabel;
      catRow.classList.remove('hidden');
    } else {
      catRow.classList.add('hidden');
    }
  }
}

function humanizeEnum(value) {
  return String(value || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function updateTaxonomyDisplay() {
  const label = $('taxonomyDisplayLabel');
  if (!label) return;
  if (state.autoTaxonomyId && state.autoTaxonomyLabel) {
    label.textContent = `${state.autoTaxonomyLabel} (#${state.autoTaxonomyId})`;
    label.classList.remove('muted-text');
  } else if (state.autoTaxonomyId) {
    label.textContent = `Category #${state.autoTaxonomyId}`;
    label.classList.remove('muted-text');
  } else {
    label.textContent = 'No category selected yet';
    label.classList.add('muted-text');
  }
}

function showTaxonomyDisplay() {
  $('taxonomyDisplay').classList.remove('hidden');
  $('taxonomySearch').classList.add('hidden');
  $('taxonomyResults').classList.add('hidden');
}

function showTaxonomySearch() {
  $('taxonomyDisplay').classList.add('hidden');
  $('taxonomySearch').classList.remove('hidden');
  const input = $('taxonomySearchInput');
  if (input) {
    input.value = '';
    setTimeout(() => input.focus(), 50);
  }
  $('taxonomyResults').innerHTML = '';
  $('taxonomyResults').classList.add('hidden');
}

let taxonomySearchTimer = null;
let taxonomySearchRequestId = 0;

function onTaxonomySearchInput() {
  if (taxonomySearchTimer) clearTimeout(taxonomySearchTimer);
  const q = $('taxonomySearchInput').value.trim();
  taxonomySearchTimer = setTimeout(() => runTaxonomySearch(q), 220);
}

async function runTaxonomySearch(query) {
  const resultsEl = $('taxonomyResults');
  if (!query || query.length < 2) {
    resultsEl.innerHTML = '';
    resultsEl.classList.add('hidden');
    return;
  }
  const myRequestId = ++taxonomySearchRequestId;
  try {
    const res = await api(`/api/etsy/taxonomy-search?q=${encodeURIComponent(query)}`);
    if (myRequestId !== taxonomySearchRequestId) return;
    renderTaxonomyResults(res.matches || []);
  } catch (err) {
    if (myRequestId !== taxonomySearchRequestId) return;
    resultsEl.innerHTML = `<div class="taxonomy-result-empty">${escapeHtml(err.message)}</div>`;
    resultsEl.classList.remove('hidden');
  }
}

function renderTaxonomyResults(matches) {
  const resultsEl = $('taxonomyResults');
  resultsEl.innerHTML = '';
  if (!matches.length) {
    resultsEl.innerHTML = '<div class="taxonomy-result-empty">No matching categories. Try a different keyword.</div>';
    resultsEl.classList.remove('hidden');
    return;
  }
  for (const m of matches) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'taxonomy-result';
    btn.innerHTML = `<span class="taxonomy-result-name">${escapeHtml(m.name)}</span><span class="taxonomy-result-id">#${escapeHtml(String(m.id))}</span>`;
    btn.addEventListener('click', () => selectTaxonomy(m));
    resultsEl.appendChild(btn);
  }
  resultsEl.classList.remove('hidden');
}

function selectTaxonomy(match) {
  state.autoTaxonomyId = String(match.id);
  state.autoTaxonomyLabel = match.name;
  updateTaxonomyDisplay();
  showTaxonomyDisplay();
  $('taxonomySearchInput').value = '';
  log(`Etsy category set to "${match.name}" (#${match.id})`);
  updateStep5Summary();
}

function showFieldError(errorId, message) {
  const el = $(errorId);
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('hidden', !message);
}

function validateStep1() {
  if (!$('syncFolder').value.trim()) {
    showFieldError('syncFolderError', 'Please enter the photo folder path.');
    $('syncFolder').focus();
    return false;
  }
  showFieldError('syncFolderError', '');
  return true;
}

function updateShopSummary() {
  const activeStore = getActiveStore();
  const label = activeStore?.label || 'Store';
  const shopId = activeStore?.shopId || '';
  const summary = $('activeStoreSummary');
  if (summary) {
    summary.textContent = shopId
      ? `Active store: ${label}`
      : `Active store: ${label} — connect Etsy from the top corner to finish setup.`;
  }
}

function validateStep2() {
  if (!state.selectedImages.length) {
    showFieldError('step2SelectionError', 'Select at least one photo to continue.');
    return false;
  }
  showFieldError('step2SelectionError', '');
  return true;
}

function validateStep3() {
  let valid = true;
  let firstInvalid = null;
  const check = (id, errorId, message, predicate) => {
    const el = $(id);
    if (predicate(el)) {
      showFieldError(errorId, '');
    } else {
      showFieldError(errorId, message);
      valid = false;
      firstInvalid = firstInvalid || el;
    }
  };

  check('f_type', 'f_typeError', 'Please describe what this item is.',
    (el) => Boolean(el.value.trim()));
  check('f_price', 'f_priceError', 'Price is required.',
    (el) => Boolean(el.value.trim()));
  check('f_quantity', 'f_quantityError', 'Quantity is required.',
    (el) => Number(el.value) >= 1);
  check('f_whenMade', 'f_whenMadeError', 'Pick an era so Etsy will accept the listing.',
    (el) => Boolean(el.value.trim()));
  check('f_readinessStateId', 'f_readinessStateIdError',
    state.readinessStates.length ? 'Pick a readiness state.' : 'Connect Etsy first to load readiness states.',
    (el) => Boolean(el.value.trim()));
  check('f_shippingProfileId', 'f_shippingProfileIdError',
    state.shippingProfiles.length ? 'Pick a shipping profile.' : 'Connect Etsy first to load shipping profiles.',
    (el) => Boolean(el.value.trim()));

  if (firstInvalid) firstInvalid.focus();
  return valid;
}

function setFolderPathDisplay() {
  const absolute = state.currentRelDir
    ? `${state.rootDir}\\${state.currentRelDir.replace(/\//g, '\\')}`
    : state.rootDir;
  $('folderPath').textContent = absolute || '(no folder selected)';
  $('folderUpBtn').disabled = !state.currentRelDir;
}

function renderFolderBreadcrumbs() {
  const container = $('folderBreadcrumbs');
  container.innerHTML = '';

  const rootBtn = document.createElement('button');
  rootBtn.type = 'button';
  rootBtn.className = 'crumb-btn';
  rootBtn.textContent = 'Root';
  rootBtn.onclick = () => loadFolderContents('');
  container.appendChild(rootBtn);

  const parts = state.currentRelDir ? state.currentRelDir.split('/').filter(Boolean) : [];
  let acc = '';
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'crumb-btn';
    btn.textContent = part;
    const relDir = acc;
    btn.onclick = () => loadFolderContents(relDir);
    container.appendChild(btn);
  }
}

function renderBrowserItems(appendPage = false) {
  const grid = $('photoGrid');
  if (!appendPage) grid.innerHTML = '';
  const frag = document.createDocumentFragment();
  const visiblePhotos = state.photos.slice(0, (state.photosPage + 1) * PHOTOS_PAGE_SIZE);
  const hasMore = state.photos.length > visiblePhotos.length;
  const loadMoreRow = $('loadMoreRow');
  if (loadMoreRow) {
    loadMoreRow.classList.toggle('hidden', !hasMore);
    const countEl = $('loadMoreCount');
    if (countEl) countEl.textContent = hasMore ? `Showing ${visiblePhotos.length} of ${state.photos.length}` : '';
  }

  if (!state.folders.length && !state.photos.length) {
    const empty = document.createElement('div');
    empty.className = 'folder-empty';
    empty.textContent = 'No folders or photos in this location.';
    frag.appendChild(empty);
    grid.appendChild(frag);
    return;
  }

  for (const folder of state.folders) {
    const item = document.createElement('div');
    item.className = 'browser-item folder';
    item.innerHTML = `
      <div class="folder-icon"><span class="tab"></span><span class="body"></span></div>
      <div class="name">${escapeHtml(folder.name)}</div>
    `;
    item.onclick = () => loadFolderContents(folder.relDir);
    frag.appendChild(item);
  }

  const selectedIndexByPath = new Map();
  state.selectedImages.forEach((relPath, idx) => selectedIndexByPath.set(relPath, idx + 1));
  for (const photo of visiblePhotos) {
    const selectedIndex = selectedIndexByPath.get(photo.relPath) || null;
    const isSelected = Boolean(selectedIndex);

    const item = document.createElement('div');
    item.className = `browser-item image${isSelected ? ' selected' : ''}`;
    item.innerHTML = `
      <div class="thumb"><img src="${photo.previewUrl}" alt="Photo" loading="lazy" /></div>
      <div class="name">${escapeHtml(photo.name)}</div>
    `;

    if (isSelected) {
      const badge = document.createElement('div');
      badge.className = selectedIndex === 1 ? 'select-index cover' : 'select-index';
      badge.textContent = selectedIndex === 1 ? 'COVER' : String(selectedIndex);
      item.appendChild(badge);
    }

    item.onclick = () => toggleSelect(photo.relPath, photo);
    frag.appendChild(item);
  }

  grid.appendChild(frag);
}

function reorderSelectedByInsert(fromIdx, insertIdx) {
  if (!Number.isInteger(fromIdx) || !Number.isInteger(insertIdx)) return;
  if (fromIdx < 0 || fromIdx >= state.selectedImages.length) return;
  const boundedInsert = Math.max(0, Math.min(insertIdx, state.selectedImages.length));
  const [item] = state.selectedImages.splice(fromIdx, 1);
  const target = boundedInsert > fromIdx ? boundedInsert - 1 : boundedInsert;
  state.selectedImages.splice(target, 0, item);
  renderSelectedStrip();
  renderBrowserItems();
}

function clearDropHints(container) {
  for (const el of container.querySelectorAll('.selected-thumb')) {
    el.classList.remove('drop-before', 'drop-after');
  }
}

function removeDragPreview() {
  if (state.dragPreviewEl && state.dragPreviewEl.parentNode) {
    state.dragPreviewEl.parentNode.removeChild(state.dragPreviewEl);
  }
  state.dragPreviewEl = null;
}

function createDragPreview(card) {
  removeDragPreview();
  const clone = card.cloneNode(true);
  clone.classList.add('drag-preview');
  clone.style.width = `${card.offsetWidth}px`;
  clone.style.height = `${card.offsetHeight}px`;
  clone.style.position = 'fixed';
  clone.style.top = '-1000px';
  clone.style.left = '-1000px';
  clone.style.pointerEvents = 'none';
  clone.style.margin = '0';
  const removeBtn = clone.querySelector('.remove-btn');
  if (removeBtn) removeBtn.remove();
  document.body.appendChild(clone);
  state.dragPreviewEl = clone;
  return clone;
}

function renderSelectedStrip() {
  const container = $('selectedStrip');
  container.innerHTML = '';
  container.classList.remove('drag-active');
  state.dragTargetInsertIndex = null;
  const warning = $('photoLimitWarning');
  if (warning) warning.classList.toggle('hidden', state.selectedImages.length <= MAX_AI_IMAGE_COUNT);
  const frag = document.createDocumentFragment();

  if (!state.selectedImages.length) {
    const empty = document.createElement('div');
    empty.className = 'folder-empty';
    empty.textContent = 'No selected photos yet.';
    frag.appendChild(empty);
    container.appendChild(frag);
    updateStep5Summary();
    return;
  }

  state.selectedImages.forEach((relPath, idx) => {
    const meta = state.photoIndex.get(relPath);
    const previewUrl = meta?.previewUrl || `/api/photo-thumb?relPath=${encodeURIComponent(relPath)}&size=220`;

    const card = document.createElement('div');
    card.className = 'selected-thumb';
    card.draggable = true;
    const coverBadge = idx === 0 ? '<div class="cover-pill">COVER</div>' : '';
    card.innerHTML = `
      <img src="${previewUrl}" alt="Selected photo ${idx + 1}" loading="lazy" />
      ${coverBadge}
      <button type="button" class="remove-btn">Remove</button>
    `;

    card.addEventListener('dragstart', (e) => {
      state.draggingSelectedIndex = idx;
      state.dragTargetInsertIndex = idx;
      card.classList.add('dragging');
      container.classList.add('drag-active');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(idx));
      const preview = createDragPreview(card);
      e.dataTransfer.setDragImage(preview, preview.offsetWidth / 2, preview.offsetHeight / 2);
    });

    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (!Number.isInteger(state.draggingSelectedIndex)) return;
      if (state.draggingSelectedIndex === idx) {
        clearDropHints(container);
        state.dragTargetInsertIndex = idx;
        return;
      }
      const rect = card.getBoundingClientRect();
      const placeAfter = e.clientX > rect.left + rect.width / 2;
      state.dragTargetInsertIndex = idx + (placeAfter ? 1 : 0);
      clearDropHints(container);
      card.classList.add(placeAfter ? 'drop-after' : 'drop-before');
    });

    card.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!Number.isInteger(state.draggingSelectedIndex)) return;
      const insertIdx = Number.isInteger(state.dragTargetInsertIndex) ? state.dragTargetInsertIndex : idx;
      reorderSelectedByInsert(state.draggingSelectedIndex, insertIdx);
      state.draggingSelectedIndex = null;
      state.dragTargetInsertIndex = null;
      clearDropHints(container);
      container.classList.remove('drag-active');
      removeDragPreview();
    });

    card.addEventListener('dragend', () => {
      state.draggingSelectedIndex = null;
      state.dragTargetInsertIndex = null;
      card.classList.remove('dragging');
      clearDropHints(container);
      container.classList.remove('drag-active');
      removeDragPreview();
    });

    card.querySelector('.remove-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSelect(relPath);
    });

    frag.appendChild(card);
  });
  container.appendChild(frag);

  updateStep5Summary();
}

function handleSelectedStripDragOver(e) {
  if (!Number.isInteger(state.draggingSelectedIndex)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const container = e.currentTarget;
  const onCard = e.target && e.target.closest && e.target.closest('.selected-thumb');
  if (!onCard) {
    clearDropHints(container);
    state.dragTargetInsertIndex = state.selectedImages.length;
  }
}

function handleSelectedStripDrop(e) {
  if (!Number.isInteger(state.draggingSelectedIndex)) return;
  e.preventDefault();
  const container = e.currentTarget;
  const insertIdx = Number.isInteger(state.dragTargetInsertIndex)
    ? state.dragTargetInsertIndex
    : state.selectedImages.length;
  reorderSelectedByInsert(state.draggingSelectedIndex, insertIdx);
  state.draggingSelectedIndex = null;
  state.dragTargetInsertIndex = null;
  clearDropHints(container);
  container.classList.remove('drag-active');
  removeDragPreview();
}

function toggleSelect(relPath, photoMeta) {
  const rel = normalizeRelPath(relPath);
  if (!rel) return;

  if (photoMeta?.previewUrl) {
    state.photoIndex.set(rel, photoMeta);
  }

  const i = state.selectedImages.indexOf(rel);
  if (i >= 0) {
    state.selectedImages.splice(i, 1);
  } else {
    state.selectedImages.push(rel);
  }

  renderSelectedStrip();
  renderBrowserItems();
}

function clearSelection() {
  if (!state.selectedImages.length) return;
  state.selectedImages = [];
  renderSelectedStrip();
  renderBrowserItems();
}

async function loadFolderContents(relDir = state.currentRelDir) {
  const normalizedRelDir = normalizeRelPath(relDir);
  try {
    const res = await api(`/api/folder-contents?relDir=${encodeURIComponent(normalizedRelDir)}`);
    state.currentRelDir = normalizeRelPath(res.relDir || '');
    state.rootDir = String(res.root || '');
    state.folders = Array.isArray(res.folders) ? res.folders : [];
    state.photos = Array.isArray(res.images) ? res.images : [];
    state.photosPage = 0;

    const nextPhotoIndex = new Map();
    for (const relPath of state.selectedImages) {
      const existing = state.photoIndex.get(relPath);
      if (existing) nextPhotoIndex.set(relPath, existing);
    }
    for (const photo of state.photos) {
      nextPhotoIndex.set(photo.relPath, photo);
    }
    state.photoIndex = nextPhotoIndex;

    setFolderPathDisplay();
    renderFolderBreadcrumbs();
    renderBrowserItems();
    renderSelectedStrip();
    rememberCurrentFolder();
  } catch (err) {
    log(`Failed to load folder contents: ${err.message}`, 'error');
    if (err.details) log(JSON.stringify(err.details, null, 2), 'error');
    alert(`Could not load folder contents: ${err.message}`);
  }
}

function rememberCurrentFolder() {
  if (!state.config) return;
  const activeKey = getActiveStoreKey();
  const cfg = normalizeClientConfig(state.config);
  let changed = false;
  cfg.etsy.stores = cfg.etsy.stores.map((store) => {
    if (store.key !== activeKey) return store;
    if (store.lastFolder === state.currentRelDir) return store;
    changed = true;
    return { ...store, lastFolder: state.currentRelDir || '' };
  });
  if (!changed) return;
  state.config = cfg;
  scheduleAutoSave();
}

async function loadHealth() {
  try {
    const res = await api('/api/health');
    state.serverOnline = true;
    state.appVersion = res.appVersion || 'dev';
    renderSetupBanner(res);
    initVersionChip();
  } catch (err) {
    state.serverOnline = false;
    setConnectionStatus('error', 'Server offline');
    log(`Health check failed: ${err.message}`, 'error');
  }
}

let lastUpdaterStatus = null;
let versionChipResetTimer = null;
let versionChipUnsubscribe = null;

function initVersionChip() {
  const btn = $('appVersionBtn');
  const label = $('appVersionLabel');
  if (!btn || !label) return;
  label.textContent = `v${state.appVersion}`;
  btn.classList.remove('hidden');

  if (!window.appUpdater) {
    btn.disabled = true;
    btn.title = `v${state.appVersion} — auto-update is only available in the installed app.`;
    return;
  }

  btn.title = `v${state.appVersion} — click to check for updates`;
  btn.addEventListener('click', onVersionChipClick);
  if (versionChipUnsubscribe) versionChipUnsubscribe();
  versionChipUnsubscribe = window.appUpdater.onState(handleUpdaterState);
}

async function onVersionChipClick() {
  const btn = $('appVersionBtn');
  if (!window.appUpdater) return;
  if (btn.classList.contains('ready')) {
    await window.appUpdater.install();
    return;
  }
  if (btn.classList.contains('checking') || btn.classList.contains('downloading')) {
    return; // already in progress
  }
  await window.appUpdater.check();
}

function handleUpdaterState(stateObj) {
  if (!stateObj) return;
  applyUpdaterStateToChip(stateObj);
  if (stateObj.status !== lastUpdaterStatus) {
    logUpdaterTransition(stateObj);
    lastUpdaterStatus = stateObj.status;
  }
}

function applyUpdaterStateToChip(s) {
  const btn = $('appVersionBtn');
  const label = $('appVersionLabel');
  if (!btn || !label) return;

  if (versionChipResetTimer) {
    clearTimeout(versionChipResetTimer);
    versionChipResetTimer = null;
  }
  btn.classList.remove('checking', 'downloading', 'ready', 'latest-confirmed', 'error');
  btn.disabled = false;

  const current = state.appVersion || s.currentVersion || 'dev';
  switch (s.status) {
    case 'checking':
      label.textContent = 'Checking…';
      btn.classList.add('checking');
      btn.title = 'Checking for updates';
      break;
    case 'downloading':
      label.textContent = s.percent
        ? `Downloading ${s.latestVersion || ''} · ${s.percent}%`
        : `Downloading ${s.latestVersion || ''}`;
      btn.classList.add('downloading');
      btn.title = 'Update downloading in the background';
      break;
    case 'ready':
      label.textContent = `Update ${s.latestVersion} ready`;
      btn.classList.add('ready');
      btn.title = `Click to install update ${s.latestVersion} and restart`;
      break;
    case 'latest':
      label.textContent = `v${current} ✓`;
      btn.classList.add('latest-confirmed');
      btn.title = `You are on the latest version (${current})`;
      versionChipResetTimer = setTimeout(() => {
        if (lastUpdaterStatus === 'latest') resetChipToIdle();
      }, 3500);
      break;
    case 'error':
      label.textContent = `v${current} · check failed`;
      btn.classList.add('error');
      btn.title = s.error || 'Update check failed';
      versionChipResetTimer = setTimeout(() => {
        if (lastUpdaterStatus === 'error') resetChipToIdle();
      }, 5000);
      break;
    case 'unsupported':
      label.textContent = `v${current}`;
      btn.disabled = true;
      btn.title = 'Auto-update is not available in this build (running in dev mode).';
      break;
    case 'idle':
    default:
      label.textContent = `v${current}`;
      btn.title = `v${current} — click to check for updates`;
  }
}

function resetChipToIdle() {
  const btn = $('appVersionBtn');
  const label = $('appVersionLabel');
  if (!btn || !label) return;
  btn.classList.remove('checking', 'downloading', 'ready', 'latest-confirmed', 'error');
  label.textContent = `v${state.appVersion || 'dev'}`;
  btn.title = `v${state.appVersion || 'dev'} — click to check for updates`;
  lastUpdaterStatus = 'idle';
}

function logUpdaterTransition(s) {
  switch (s.status) {
    case 'checking':
      log('Checking for app updates…');
      break;
    case 'downloading':
      log(`Update available: downloading ${s.latestVersion || '(new version)'} in the background…`);
      break;
    case 'ready':
      log(`Update ${s.latestVersion} downloaded — click the version chip to install and restart.`);
      break;
    case 'latest':
      log(`App is on the latest version (${s.latestVersion || state.appVersion}).`);
      break;
    case 'error':
      log(`Update check failed: ${s.error || 'unknown error'}`, 'error');
      break;
  }
}

function renderSetupBanner({ missingEnvKeys, envFile } = {}) {
  const banner = $('setupBanner');
  const msg = $('setupBannerMessage');
  const pathEl = $('setupBannerPathLabel');
  if (!banner || !msg || !pathEl) return;
  if (Array.isArray(missingEnvKeys) && missingEnvKeys.length) {
    msg.textContent = `Missing required keys (${missingEnvKeys.join(', ')}). Add them to your .env file and restart the app.`;
    pathEl.textContent = envFile ? `Config file: ${envFile}` : '';
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

async function loadConfig() {
  const res = await api('/api/config');
  state.config = normalizeClientConfig(res.config);
  loadFormFromConfig(state.config);
  log('Loaded settings');
}

let autoSaveTimer = null;
let autoSaveInflight = null;

function scheduleAutoSave() {
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    autoSaveTimer = null;
    autoSaveConfig().catch(() => {});
  }, 700);
}

async function autoSaveConfig() {
  if (autoSaveInflight) {
    await autoSaveInflight;
  }
  const work = (async () => {
    try {
      const config = collectConfigFromForm();
      const res = await api('/api/config', {
        method: 'POST',
        body: JSON.stringify({ config }),
      });
      state.config = normalizeClientConfig(res.config);
    } catch (err) {
      log(`Settings auto-save failed: ${err.message}`, 'error');
      throw err;
    }
  })();
  autoSaveInflight = work;
  try { await work; } finally {
    if (autoSaveInflight === work) autoSaveInflight = null;
  }
}

async function flushAutoSave() {
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
    await autoSaveConfig();
  } else if (autoSaveInflight) {
    await autoSaveInflight;
  }
}

async function refreshEtsyStatus() {
  if (!state.serverOnline) {
    setConnectionStatus('error', 'Server offline');
    return;
  }
  try {
    const storeKey = getActiveStoreKey();
    const res = await api(`/api/etsy/status?storeKey=${encodeURIComponent(storeKey)}`);
    const label = res.storeLabel || getActiveStore()?.label || 'Store';
    if (res.connected) {
      setConnectionStatus('ok', `Connected to ${label}`);
    } else {
      setConnectionStatus('warn', `Connect ${label}`);
    }
  } catch (err) {
    setConnectionStatus('error', 'Etsy status error');
    log(`Etsy status error: ${err.message}`, 'error');
  }
}

async function generateListing() {
  try {
    if (!validateStep3()) return;
    if (!validateStep2()) return;
    if (state.selectedImages.length > MAX_AI_IMAGE_COUNT) {
      alert(`Claude image analysis supports up to ${MAX_AI_IMAGE_COUNT} photos. Please reduce your selection.`);
      return;
    }

    const genBtn = $('generateBtn');
    genBtn.disabled = true;
    genBtn.textContent = 'Generating…';
    log(`Generating listing with AI (sending ${state.selectedImages.length} selected photo(s) to Claude)...`);

    const payload = {
      intake: collectIntake(),
      selectedImages: state.selectedImages,
      includeImagesInAi: state.config?.claude?.includeImagesInPrompt !== false,
    };

    const res = await api('/api/generate-listing', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    setGeneratedOutput(res.generated);
    const imageCount = Number(res.aiImageCount || 0);
    if (imageCount > 0) {
      log(`AI listing generated (Claude analyzed ${imageCount} photo${imageCount === 1 ? '' : 's'}).`);
    } else {
      log('AI listing generated (Claude did not analyze photos for this run).');
    }

    if (res.autoTaxonomyId) {
      state.autoTaxonomyId = String(res.autoTaxonomyId);
      state.autoTaxonomyLabel = res.autoTaxonomyLabel || '';
      log(`AI matched Etsy category: "${state.autoTaxonomyLabel}" (#${state.autoTaxonomyId})`);
    } else {
      state.autoTaxonomyId = null;
      state.autoTaxonomyLabel = null;
    }
    updateTaxonomyDisplay();

    setStep(4);
  } catch (err) {
    const friendly = friendlyErrorMessage(err);
    log(`Listing generation failed: ${friendly}`, 'error');
    logErrorDetails(err);
    alert(`Listing generation failed:\n\n${friendly}`);
  } finally {
    const genBtn = $('generateBtn');
    genBtn.disabled = false;
    updateStep3ForExisting();
  }
}

async function createEtsyDraft() {
  try {
    const generated = collectGeneratedOutput();
    if (!generated.title || !generated.description) {
      throw new Error('Title and description are required before creating the Etsy draft.');
    }

    const overrides = collectStep5Overrides();
    if (overrides) {
      try {
        await applyStep5Overrides(overrides);
      } catch (err) {
        alert(`Could not save missing settings: ${err.message}`);
        return;
      }
    }

    const draftBtn = $('createEtsyDraftBtn');
    draftBtn.disabled = true;
    draftBtn.textContent = 'Creating draft…';
    $('etsyResult').textContent = 'Creating Etsy draft and uploading photos...';
    log('Creating Etsy draft...');

    const res = await api('/api/etsy/create-draft', {
      method: 'POST',
      body: JSON.stringify({
        intake: collectIntake(),
        generated,
        selectedImages: state.selectedImages,
      }),
    });

    const storeLabel = res?.etsy?.storeLabel || getActiveStore()?.label || 'Selected store';
    $('etsyResult').textContent = `Draft created successfully in ${storeLabel}. Listing ID: ${res.listingId}\nReview it in Etsy Seller before publishing.`;
    log(`Etsy draft created. listingId=${res.listingId}`);
    clearGeneratedFromStorage();
    $('postDraftRow').classList.remove('hidden');
    await refreshEtsyStatus();
  } catch (err) {
    const friendly = friendlyErrorMessage(err);
    $('etsyResult').textContent = `Error: ${friendly}`;
    log(`Etsy draft failed: ${friendly}`, 'error');
    logErrorDetails(err);
    alert(`Etsy draft failed:\n\n${friendly}`);
  } finally {
    const draftBtn = $('createEtsyDraftBtn');
    draftBtn.disabled = false;
    draftBtn.textContent = 'Create Etsy Draft (Unpublished)';
  }
}

function friendlyErrorMessage(err) {
  const msg = String(err.message || '');
  const details = err.details || {};
  const type = details.claudeErrorType || details.error?.type || '';

  if (type === 'overloaded_error' || msg.toLowerCase().includes('overloaded')) {
    return 'The AI service is temporarily busy. Please wait a moment and try again.';
  }
  if (type === 'rate_limit_error' || msg.toLowerCase().includes('rate limit')) {
    return 'Rate limit reached. Please wait a minute before trying again.';
  }
  if (type === 'authentication_error' || msg.includes('ANTHROPIC_API_KEY')) {
    return 'Invalid or missing API key. Check your ANTHROPIC_API_KEY in .env and restart the server.';
  }
  if (msg.includes('Etsy API request failed')) {
    let etsyDetail = '';
    if (Array.isArray(details)) {
      etsyDetail = details.map((e) => e.message || e.type || '').filter(Boolean).join('; ');
    } else {
      etsyDetail = details.error_description || details.message || details.error || '';
    }
    return etsyDetail ? `Etsy rejected the request: ${etsyDetail}` : msg;
  }
  return msg;
}

function logErrorDetails(err) {
  if (err.details) logTechnical(err.details);
}

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function saveLog() {
  try {
    const text = await buildSupportBundle();
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `etsy-support-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    log(`Support log saved to file (${text.length.toLocaleString()} chars).`);
  } catch (err) {
    log(`Save log failed: ${err.message}`, 'error');
    alert(`Could not save log: ${err.message}`);
  }
}

function copyText(text, label) {
  navigator.clipboard.writeText(text || '').then(() => {
    log(`Copied ${label}`);
  }).catch((err) => {
    log(`Copy failed (${label}): ${err.message}`, 'error');
  });
}

async function continueToPhotos() {
  if (!validateStep1()) return;
  const prevFolder = String(state.config?.syncFolder || '').trim();
  const newFolder = String($('syncFolder').value || '').trim();
  try {
    await flushAutoSave();
    const folderChanged = prevFolder !== newFolder;
    if (folderChanged) {
      state.photoIndex = new Map();
      state.selectedImages = [];
    }
    const fallbackRelDir = state.currentRelDir || getActiveStore()?.lastFolder || '';
    await loadFolderContents(folderChanged ? '' : fallbackRelDir);
    setStep(2);
  } catch (err) {
    alert(`Could not continue: ${err.message}`);
  }
}

async function browseSyncFolder() {
  try {
    const current = $('syncFolder').value.trim();
    const res = await api('/api/browse-folder', {
      method: 'POST',
      body: JSON.stringify({ initialDirectory: current }),
    });
    if (res.cancelled) return;
    if (res.folder) {
      $('syncFolder').value = res.folder;
      scheduleAutoSave();
      showFieldError('syncFolderError', '');
      log(`Selected folder: ${res.folder}`);
    }
  } catch (err) {
    log(`Browse folder failed: ${err.message}`, 'error');
    alert(`Could not open folder picker: ${err.message}`);
  }
}

function goUpFolder() {
  if (!state.currentRelDir) return;
  const parts = state.currentRelDir.split('/').filter(Boolean);
  parts.pop();
  const parent = parts.join('/');
  loadFolderContents(parent);
}

function updateStep3ForExisting() {
  const notice = $('existingListingNotice');
  const useBtn = $('useExistingBtn');
  const genBtn = $('generateBtn');
  const hasExisting = Boolean(state.generated);
  if (notice) notice.classList.toggle('hidden', !hasExisting);
  if (useBtn) useBtn.classList.toggle('hidden', !hasExisting);
  if (genBtn) genBtn.textContent = hasExisting ? 'Regenerate' : 'Generate Listing';
}

function populateStep5ShippingSelect() {
  const sel = $('s5ShippingProfileId');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">Select...</option>';
  for (const p of state.shippingProfiles) {
    const opt = document.createElement('option');
    opt.value = String(p.id);
    opt.textContent = p.title;
    sel.appendChild(opt);
  }
  sel.value = current || '';
}

function renderStep5MissingFields() {
  const store = getActiveStore();
  const d = store?.defaults || {};
  const section = $('step5MissingFields');
  if (!section) return;

  const intakeShipping = String($('f_shippingProfileId')?.value || '').trim();
  const intakeReadiness = String($('f_readinessStateId')?.value || '').trim();
  const intakeWhenMade = String($('f_whenMade')?.value || '').trim();

  const whenMadeMissing = !intakeWhenMade && !String(d.when_made || '').trim();
  const taxonomyMissing = !state.autoTaxonomyId && !String(d.taxonomy_id || '').trim();
  const shippingMissing = !intakeShipping && !String(d.shipping_profile_id || '').trim();
  const readinessMissing = !intakeReadiness && !String(d.readiness_state_id || '').trim();

  const checks = [
    { wrapId: 's5WhenMadeWrap', missing: whenMadeMissing },
    { wrapId: 's5TaxonomyWrap', missing: taxonomyMissing },
    { wrapId: 's5ShippingWrap', missing: shippingMissing },
    { wrapId: 's5ReadinessWrap', missing: readinessMissing },
  ];

  const anyMissing = checks.some((c) => c.missing);
  section.classList.toggle('hidden', !anyMissing);
  for (const c of checks) {
    const el = $(c.wrapId);
    if (el) el.classList.toggle('hidden', !c.missing);
  }

  if (shippingMissing) {
    if (state.shippingProfiles.length > 0) {
      populateStep5ShippingSelect();
    } else {
      fetchShippingProfiles({ silent: true }).then((ok) => {
        if (ok && state.step === 5) populateStep5ShippingSelect();
      });
    }
  }

  if (readinessMissing) {
    if (state.readinessStates.length > 0) {
      populateStep5ReadinessSelect();
    } else {
      fetchReadinessStates({ silent: true }).then((ok) => {
        if (ok && state.step === 5) populateStep5ReadinessSelect();
      });
    }
  }
}

function collectStep5Overrides() {
  const section = $('step5MissingFields');
  if (!section || section.classList.contains('hidden')) return null;
  const overrides = {};
  const pairs = [
    ['s5WhenMadeWrap', () => $('s5WhenMade').value.trim(), 'when_made'],
    ['s5TaxonomyWrap', () => $('s5TaxonomyId').value.trim(), 'taxonomy_id'],
    ['s5ShippingWrap', () => $('s5ShippingProfileId').value.trim(), 'shipping_profile_id'],
    ['s5ReadinessWrap', () => $('s5ReadinessStateId').value.trim(), 'readiness_state_id'],
  ];
  for (const [wrapId, getValue, key] of pairs) {
    const wrap = $(wrapId);
    if (wrap && !wrap.classList.contains('hidden')) {
      const v = getValue();
      if (v) overrides[key] = v;
    }
  }
  return Object.keys(overrides).length ? overrides : null;
}

async function applyStep5Overrides(overrides) {
  const cfg = normalizeClientConfig(state.config || {});
  const activeKey = getActiveStoreKey();
  cfg.etsy.stores = cfg.etsy.stores.map((store) => {
    if (store.key !== activeKey) return store;
    return { ...store, defaults: { ...store.defaults, ...overrides } };
  });
  const res = await api('/api/config', {
    method: 'POST',
    body: JSON.stringify({ config: cfg }),
  });
  state.config = normalizeClientConfig(res.config);
  log('Missing settings saved to store configuration.');
}

function populateShippingProfileDropdowns(profiles) {
  const overrideSel = $('f_shippingProfileId');
  if (!overrideSel) return;
  const current = overrideSel.value;
  overrideSel.innerHTML = '';
  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = profiles.length ? 'Select a shipping profile…' : '— connect Etsy to load —';
  overrideSel.appendChild(blank);
  for (const p of profiles) {
    const opt = document.createElement('option');
    opt.value = String(p.id);
    opt.textContent = p.title;
    overrideSel.appendChild(opt);
  }
  overrideSel.value = current || '';
}

function populateReadinessStateDropdowns(states) {
  const overrideSel = $('f_readinessStateId');
  if (!overrideSel) return;
  const current = overrideSel.value;
  overrideSel.innerHTML = '';
  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = states.length ? 'Select a readiness state…' : '— connect Etsy to load —';
  overrideSel.appendChild(blank);
  for (const s of states) {
    const opt = document.createElement('option');
    opt.value = String(s.id);
    opt.textContent = s.label;
    overrideSel.appendChild(opt);
  }
  overrideSel.value = current || '';
}

function populateStep5ReadinessSelect() {
  const sel = $('s5ReadinessStateId');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">Select...</option>';
  for (const s of state.readinessStates) {
    const opt = document.createElement('option');
    opt.value = String(s.id);
    opt.textContent = s.label;
    sel.appendChild(opt);
  }
  sel.value = current || '';
}

async function fetchReadinessStates({ silent = false } = {}) {
  if (readinessStatesLoading) return false;
  readinessStatesLoading = true;
  const storeKey = getActiveStoreKey();
  try {
    const res = await api(`/api/etsy/readiness-states?storeKey=${encodeURIComponent(storeKey)}`);
    state.readinessStates = res.states || [];
    const currentDefault = getActiveStore()?.defaults?.readiness_state_id || '';
    populateReadinessStateDropdowns(state.readinessStates, currentDefault);
    if (!silent) log(`Loaded ${state.readinessStates.length} readiness state(s).`);
    return true;
  } catch (err) {
    log(`Could not load readiness states: ${err.message}`, silent ? 'info' : 'error');
    return false;
  } finally {
    readinessStatesLoading = false;
  }
}

async function fetchShippingProfiles({ silent = false } = {}) {
  if (shippingProfilesLoading) return false;
  shippingProfilesLoading = true;
  const storeKey = getActiveStoreKey();
  try {
    const res = await api(`/api/etsy/shipping-profiles?storeKey=${encodeURIComponent(storeKey)}`);
    state.shippingProfiles = res.profiles || [];
    const currentDefault = getActiveStore()?.defaults?.shipping_profile_id || '';
    populateShippingProfileDropdowns(state.shippingProfiles, currentDefault);
    if (!silent) log(`Loaded ${state.shippingProfiles.length} shipping profile(s).`);
    return true;
  } catch (err) {
    log(`Could not load shipping profiles: ${err.message}`, silent ? 'info' : 'error');
    return false;
  } finally {
    shippingProfilesLoading = false;
  }
}

function attachEvents() {
  // Step 1 — auto-save inputs (debounced)
  for (const id of ['syncFolder', 'listingPolicyText']) {
    const el = $(id);
    if (el) el.addEventListener('input', scheduleAutoSave);
  }

  $('browseSyncFolderBtn').addEventListener('click', browseSyncFolder);
  $('startNewListingBtn').addEventListener('click', () => { resetForNewListing(); setStep(1); });
  $('taxonomyChangeBtn').addEventListener('click', () => {
    showTaxonomySearch();
  });
  $('taxonomyCancelBtn').addEventListener('click', () => {
    showTaxonomyDisplay();
    $('taxonomySearchInput').value = '';
    $('taxonomyResults').innerHTML = '';
    $('taxonomyResults').classList.add('hidden');
  });
  $('taxonomySearchInput').addEventListener('input', onTaxonomySearchInput);
  $('taxonomySearchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      showTaxonomyDisplay();
      $('taxonomySearchInput').value = '';
      $('taxonomyResults').innerHTML = '';
      $('taxonomyResults').classList.add('hidden');
    }
  });
  $('useExistingBtn').addEventListener('click', () => setStep(4));

  $('connectionPill').addEventListener('click', (e) => {
    e.stopPropagation();
    const pill = $('connectionPill');
    if (pill.classList.contains('connection-warn') || pill.classList.contains('connection-error')) {
      closeConnectionMenu();
      const storeKey = getActiveStoreKey();
      window.open(`/auth/etsy/start?storeKey=${encodeURIComponent(storeKey)}`, '_blank', 'noopener');
    } else if (pill.classList.contains('connection-ok')) {
      toggleConnectionMenu();
    }
  });

  $('refreshShopInfoBtn').addEventListener('click', async (e) => {
    e.stopPropagation();
    closeConnectionMenu();
    try {
      const res = await api('/api/etsy/refresh-shop-info', {
        method: 'POST',
        body: JSON.stringify({ storeKey: getActiveStoreKey() }),
      });
      const name = res?.shopInfo?.shopName || '(no name returned)';
      const id = res?.shopInfo?.shopId || '(no id)';
      log(`Shop info refreshed: ${name} (#${id})`);
      await refreshConfigAndStatus();
    } catch (err) {
      log(`Refresh shop info failed: ${err.message}`, 'error');
      logErrorDetails(err);
      alert(`Could not refresh shop info: ${err.message}`);
    }
  });

  $('disconnectStoreBtn').addEventListener('click', async (e) => {
    e.stopPropagation();
    closeConnectionMenu();
    const store = getActiveStore();
    const label = store?.label || 'this store';
    if (!confirm(`Disconnect ${label} from Etsy?\n\nYou'll need to reconnect via Etsy OAuth to use it again. Your photo folder selection will be preserved.`)) {
      return;
    }
    try {
      await api('/api/etsy/disconnect', {
        method: 'POST',
        body: JSON.stringify({ storeKey: getActiveStoreKey() }),
      });
      state.shippingProfiles = [];
      state.readinessStates = [];
      log(`Disconnected ${label} from Etsy.`);
      await refreshConfigAndStatus();
    } catch (err) {
      log(`Disconnect failed: ${err.message}`, 'error');
      alert(`Could not disconnect: ${err.message}`);
    }
  });

  document.addEventListener('click', (e) => {
    const wrap = document.querySelector('.connection-pill-wrap');
    if (!wrap || !wrap.contains(e.target)) {
      closeConnectionMenu();
    }
  });

  $('activeStoreSelect').addEventListener('change', () => {
    if (!state.config) return;
    persistActiveStoreFormIntoStateConfig();
    state.config.etsy.activeStoreKey = getActiveStoreKey();
    state.currentRelDir = getActiveStore()?.lastFolder || '';
    state.selectedImages = [];
    state.photoIndex = new Map();
    loadActiveStoreIntoForm();
    autoSaveConfig().then(refreshEtsyStatus).catch(() => {});
    fetchShippingProfiles({ silent: true }).catch(() => {});
    fetchReadinessStates({ silent: true }).catch(() => {});
  });

  $('toStep2Btn').addEventListener('click', continueToPhotos);
  $('backToStep1Btn').addEventListener('click', () => setStep(1));
  $('toStep3Btn').addEventListener('click', () => {
    if (validateStep2()) setStep(3);
  });

  $('backToStep2Btn').addEventListener('click', () => setStep(2));
  $('backToStep3Btn').addEventListener('click', () => setStep(3));
  $('backToStep4Btn').addEventListener('click', () => setStep(4));

  $('toStep5Btn').addEventListener('click', () => {
    const generated = collectGeneratedOutput();
    if (!generated.title || !generated.description) {
      log('Cannot proceed: title and description are required.', 'error');
      return;
    }
    setStep(5);
  });

  $('refreshFolderBtn').addEventListener('click', () => {
    loadFolderContents(state.currentRelDir);
  });
  $('loadMorePhotosBtn').addEventListener('click', () => {
    state.photosPage += 1;
    renderBrowserItems(true);
  });
  $('folderUpBtn').addEventListener('click', goUpFolder);
  $('clearSelectionBtn').addEventListener('click', clearSelection);
  $('selectedStrip').addEventListener('dragover', handleSelectedStripDragOver);
  $('selectedStrip').addEventListener('drop', handleSelectedStripDrop);

  $('generateBtn').addEventListener('click', generateListing);
  $('createEtsyDraftBtn').addEventListener('click', createEtsyDraft);
  $('themeToggleBtn').addEventListener('click', toggleTheme);

  $('copyDescriptionBtn').addEventListener('click', () => copyText($('o_description').value, 'description'));
  $('copyTitleBtn').addEventListener('click', () => copyText($('o_title').value, 'title'));

  $('copyLogBtn').addEventListener('click', async () => {
    const btn = $('copyLogBtn');
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Building support log…';
    try {
      const bundle = await buildSupportBundle();
      await navigator.clipboard.writeText(bundle);
      log(`Support log copied (${bundle.length.toLocaleString()} chars). Paste it into your support email.`);
    } catch (err) {
      log(`Copy support log failed: ${err.message}`, 'error');
      alert(`Could not copy support log: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  });
  $('saveLogBtn').addEventListener('click', saveLog);

  $('f_price').addEventListener('input', updateStep5Summary);
  $('f_whenMade').addEventListener('change', updateStep5Summary);
  $('f_shippingProfileId').addEventListener('change', updateStep5Summary);
  $('f_readinessStateId').addEventListener('change', updateStep5Summary);

  window.addEventListener('focus', refreshConfigAndStatus);
}

async function refreshConfigAndStatus() {
  if (!state.serverOnline) return;
  loadHealth().catch(() => {});
  try {
    const res = await api('/api/config');
    state.config = normalizeClientConfig(res.config);
    loadFormFromConfig(state.config);
  } catch {}
  refreshEtsyStatus().catch(() => {});
  fetchShippingProfiles({ silent: true }).catch(() => {});
  fetchReadinessStates({ silent: true }).catch(() => {});
}

async function init() {
  applyTheme(getPreferredTheme());
  setConnectionStatus('pending', 'Checking…');
  attachEvents();
  setStep(1);

  await loadHealth();
  await loadConfig();
  await refreshEtsyStatus();
  fetchShippingProfiles({ silent: true }).catch(() => {});
  fetchReadinessStates({ silent: true }).catch(() => {});

  const savedDraft = loadGeneratedFromStorage();
  if (savedDraft) {
    state.generated = savedDraft;
    setGeneratedOutput(savedDraft);
    log('Restored unsaved draft from previous session. Go to Step 4 to review it.');
  }

  updateTaxonomyDisplay();
  updateStep5Summary();
}

init().catch((err) => {
  log(`Startup error: ${err.message}`, 'error');
});
