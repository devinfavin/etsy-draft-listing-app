const state = {
  config: null,
  photos: [],
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

function log(msg, type = 'info') {
  const ts = new Date().toLocaleTimeString();
  const line = `[${ts}] ${msg}`;
  const el = $('log');
  el.textContent = `${line}\n${el.textContent}`.slice(0, 20000);
  console[type === 'error' ? 'error' : 'log'](msg);
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

function setBadge(id, text) {
  $(id).textContent = text;
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

  updateStep5Summary();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function loadFormFromConfig(cfg) {
  $('syncFolder').value = cfg.syncFolder || '';
  $('openaiModel').value = cfg.openai?.model || '';
  $('etsyShopId').value = cfg.etsy?.shopId || '';

  const d = cfg.etsy?.defaults || {};
  $('dQuantity').value = d.quantity ?? 1;
  $('dWhoMade').value = d.who_made || 'someone_else';
  $('dWhenMade').value = d.when_made || '';
  $('dTaxonomyId').value = d.taxonomy_id || '';
  $('dShippingProfileId').value = d.shipping_profile_id || '';
  $('dReadinessStateId').value = d.readiness_state_id || '';
  $('listingPolicyText').value = cfg.listingPolicyText || '';
  updateShopSummary();
}

function collectConfigFromForm() {
  return {
    syncFolder: $('syncFolder').value.trim(),
    openai: {
      model: $('openaiModel').value.trim() || 'gpt-4.1-mini',
      includeImagesInPrompt: false,
    },
    etsy: {
      shopId: $('etsyShopId').value.trim(),
      defaults: {
        quantity: Number($('dQuantity').value || 1),
        who_made: $('dWhoMade').value,
        when_made: $('dWhenMade').value.trim(),
        taxonomy_id: $('dTaxonomyId').value.trim(),
        shipping_profile_id: $('dShippingProfileId').value.trim(),
        readiness_state_id: $('dReadinessStateId').value.trim(),
      },
    },
    listingPolicyText: $('listingPolicyText').value.trim(),
  };
}

function collectIntake() {
  return {
    type: $('f_type').value.trim(),
    brand: $('f_brand').value.trim(),
    titleHint: $('f_titleHint').value.trim(),
    capacity: $('f_capacity').value.trim(),
    material: $('f_material').value.trim(),
    microwaveSafe: $('f_microwaveSafe').value,
    dishwasherSafe: $('f_dishwasherSafe').value,
    dimensions: $('f_dimensions').value.trim(),
    weight: $('f_weight').value.trim(),
    patternStyleColor: $('f_patternStyleColor').value.trim(),
    conditionSummary: $('f_conditionSummary').value.trim(),
    defects: $('f_defects').value.trim(),
    markings: $('f_markings').value.trim(),
    era: $('f_era').value.trim(),
    quantity: Number($('f_quantity').value || 1),
    price: $('f_price').value.trim(),
    notes: $('f_notes').value.trim(),
  };
}

function setGeneratedOutput(out) {
  state.generated = out;
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

function updateStep5Summary() {
  $('summaryPhotoCount').textContent = String(state.selectedImages.length);
  $('summaryPrice').textContent = $('f_price').value.trim() || '-';
}

function validateStep1() {
  if (!$('syncFolder').value.trim()) {
    alert('Please enter the photo folder path.');
    $('syncFolder').focus();
    return false;
  }
  return true;
}

function updateShopSummary() {
  const shopId = $('etsyShopId').value.trim();
  $('shopSummary').textContent = shopId
    ? `Store: Etsy shop ID ${shopId}`
    : 'Store: not set yet (configure in advanced settings below)';
}

function validateStep2() {
  if (!state.selectedImages.length) {
    alert('Select at least one photo to continue.');
    return false;
  }
  return true;
}

function validateStep3() {
  if (!$('f_type').value.trim()) {
    alert('Please enter an item type.');
    $('f_type').focus();
    return false;
  }
  if (!$('f_price').value.trim()) {
    alert('Please enter a price.');
    $('f_price').focus();
    return false;
  }
  return true;
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

function renderBrowserItems() {
  const grid = $('photoGrid');
  grid.innerHTML = '';
  const frag = document.createDocumentFragment();

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
  for (const photo of state.photos) {
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
      badge.className = 'select-index';
      badge.textContent = String(selectedIndex);
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
    const previewUrl = meta?.previewUrl || `/api/photo?relPath=${encodeURIComponent(relPath)}`;

    const card = document.createElement('div');
    card.className = 'selected-thumb';
    card.draggable = true;
    card.innerHTML = `
      <img src="${previewUrl}" alt="Selected photo ${idx + 1}" loading="lazy" />
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

    for (const photo of state.photos) {
      state.photoIndex.set(photo.relPath, photo);
    }

    setFolderPathDisplay();
    renderFolderBreadcrumbs();
    renderBrowserItems();
    renderSelectedStrip();
  } catch (err) {
    log(`Failed to load folder contents: ${err.message}`, 'error');
    if (err.details) log(JSON.stringify(err.details, null, 2), 'error');
    alert(`Could not load folder contents: ${err.message}`);
  }
}

async function loadHealth() {
  try {
    await api('/api/health');
    setBadge('healthBadge', 'Server: online');
  } catch (err) {
    setBadge('healthBadge', 'Server: offline');
    log(`Health check failed: ${err.message}`, 'error');
  }
}

async function loadConfig() {
  const res = await api('/api/config');
  state.config = res.config;
  loadFormFromConfig(res.config);
  log('Loaded setup');
}

async function saveConfig() {
  try {
    const config = collectConfigFromForm();
    const res = await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({ config }),
    });
    state.config = res.config;
    log('Saved setup');
  } catch (err) {
    log(`Save setup failed: ${err.message}`, 'error');
    alert(`Could not save setup: ${err.message}`);
    throw err;
  }
}

async function refreshEtsyStatus() {
  try {
    const res = await api('/api/etsy/status');
    setBadge('etsyBadge', res.connected ? 'Etsy: connected' : 'Etsy: not connected');
  } catch (err) {
    setBadge('etsyBadge', 'Etsy: status error');
    log(`Etsy status error: ${err.message}`, 'error');
  }
}

async function generateListing() {
  try {
    if (!validateStep3()) return;
    if (!validateStep2()) return;

    $('generateBtn').disabled = true;
    log('Generating listing with AI...');

    const payload = {
      intake: collectIntake(),
      selectedImages: state.selectedImages,
    };

    const res = await api('/api/generate-listing', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    setGeneratedOutput(res.generated);
    log('AI listing generated');
    setStep(4);
  } catch (err) {
    log(`Generate failed: ${err.message}`, 'error');
    if (err.details) log(JSON.stringify(err.details, null, 2), 'error');
    alert(`Generate failed: ${err.message}`);
  } finally {
    $('generateBtn').disabled = false;
  }
}

async function createEtsyDraft() {
  try {
    const generated = collectGeneratedOutput();
    if (!generated.title || !generated.description) {
      throw new Error('Title and description are required before creating the Etsy draft.');
    }

    $('createEtsyDraftBtn').disabled = true;
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

    $('etsyResult').textContent = `Draft created successfully. Listing ID: ${res.listingId}\nReview it in Etsy Seller before publishing.`;
    log(`Etsy draft created. listingId=${res.listingId}`);
    await refreshEtsyStatus();
  } catch (err) {
    $('etsyResult').textContent = `Error: ${err.message}`;
    log(`Etsy draft failed: ${err.message}`, 'error');
    if (err.details) log(JSON.stringify(err.details, null, 2), 'error');
    alert(`Etsy draft failed: ${err.message}`);
  } finally {
    $('createEtsyDraftBtn').disabled = false;
  }
}

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function copyText(text, label) {
  navigator.clipboard.writeText(text || '').then(() => {
    log(`Copied ${label}`);
  }).catch((err) => {
    log(`Copy failed (${label}): ${err.message}`, 'error');
  });
}

async function saveSetupAndContinue() {
  if (!validateStep1()) return;
  try {
    await saveConfig();
    state.photoIndex = new Map();
    state.selectedImages = [];
    await loadFolderContents('');
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

function attachEvents() {
  $('saveConfigBtn').addEventListener('click', () => {
    saveConfig().catch(() => {});
  });

  $('browseSyncFolderBtn').addEventListener('click', browseSyncFolder);
  $('connectEtsyBtn').addEventListener('click', () => {
    window.open('/auth/etsy/start', '_blank', 'noopener');
  });

  $('toStep2Btn').addEventListener('click', saveSetupAndContinue);
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
      alert('Please make sure title and description are filled in.');
      return;
    }
    setStep(5);
  });

  $('refreshFolderBtn').addEventListener('click', () => {
    loadFolderContents(state.currentRelDir);
  });
  $('folderUpBtn').addEventListener('click', goUpFolder);
  $('clearSelectionBtn').addEventListener('click', clearSelection);
  $('selectedStrip').addEventListener('dragover', handleSelectedStripDragOver);
  $('selectedStrip').addEventListener('drop', handleSelectedStripDrop);

  $('generateBtn').addEventListener('click', generateListing);
  $('createEtsyDraftBtn').addEventListener('click', createEtsyDraft);

  $('copyDescriptionBtn').addEventListener('click', () => copyText($('o_description').value, 'description'));
  $('copyTitleBtn').addEventListener('click', () => copyText($('o_title').value, 'title'));

  $('f_price').addEventListener('input', updateStep5Summary);
  $('etsyShopId').addEventListener('input', updateShopSummary);
}

async function init() {
  attachEvents();
  setStep(1);

  await loadHealth();
  await loadConfig();
  await refreshEtsyStatus();
  updateStep5Summary();
}

init().catch((err) => {
  log(`Startup error: ${err.message}`, 'error');
});
