const state = {
  config: null,
  photos: [],
  selectedImages: [],
  generated: null,
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
  try { json = JSON.parse(text); } catch { json = { ok: false, error: text || 'Non-JSON response' }; }
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

function fmtBytes(bytes) {
  if (!bytes && bytes !== 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtDate(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleString();
}

function loadFormFromConfig(cfg) {
  $('syncFolder').value = cfg.syncFolder || '';
  $('openaiModel').value = cfg.openai?.model || '';
  $('etsyShopId').value = cfg.etsy?.shopId || '';
  $('maxImagesForVision').value = cfg.openai?.maxImagesForVision || 4;
  $('includeImagesInAi').checked = !!cfg.openai?.includeImagesInPrompt;

  const d = cfg.etsy?.defaults || {};
  $('dQuantity').value = d.quantity ?? 1;
  $('dWhoMade').value = d.who_made || 'someone_else';
  $('dWhenMade').value = d.when_made || '';
  $('dTaxonomyId').value = d.taxonomy_id || '';
  $('dShippingProfileId').value = d.shipping_profile_id || '';
  $('dReadinessStateId').value = d.readiness_state_id || '';
  $('listingPolicyText').value = cfg.listingPolicyText || '';
}

function collectConfigFromForm() {
  return {
    syncFolder: $('syncFolder').value.trim(),
    openai: {
      model: $('openaiModel').value.trim(),
      includeImagesInPrompt: $('includeImagesInAi').checked,
      maxImagesForVision: Number($('maxImagesForVision').value || 4),
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
      }
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
    bullet_specs: $('o_bullet_specs').value.split(/\n+/).map(s => s.trim()).filter(Boolean),
    tags: $('o_tags').value.split(',').map(s => s.trim()).filter(Boolean),
    etsy_materials: $('o_materials').value.split(',').map(s => s.trim()).filter(Boolean),
    etsy_colors: $('o_colors').value.split(',').map(s => s.trim()).filter(Boolean),
    image_alt_text: $('o_alt_text').value.split(/\n+/).map(s => s.trim()).filter(Boolean),
  };
}

function renderPhotos() {
  const grid = $('photoGrid');
  const q = $('photoSearch').value.trim().toLowerCase();
  const selectedSet = new Set(state.selectedImages);
  const filtered = state.photos.filter(p => !q || p.name.toLowerCase().includes(q) || p.relPath.toLowerCase().includes(q));

  grid.innerHTML = '';
  for (const photo of filtered) {
    const card = document.createElement('div');
    card.className = 'photo-card';
    const isSelected = selectedSet.has(photo.relPath);
    card.innerHTML = `
      <img src="${photo.previewUrl}" alt="${escapeHtml(photo.name)}" loading="lazy" />
      <div class="meta">
        <div class="file-name" title="${escapeHtml(photo.relPath)}">${escapeHtml(photo.name)}</div>
        <div class="file-sub">${fmtBytes(photo.size)} · ${fmtDate(photo.mtimeMs)}</div>
        <button class="${isSelected ? 'secondary' : ''}" data-rel="${encodeURIComponent(photo.relPath)}">${isSelected ? 'Selected' : 'Select'}</button>
      </div>
    `;
    card.querySelector('button').addEventListener('click', () => toggleSelect(photo.relPath));
    grid.appendChild(card);
  }
}

function renderSelected() {
  const container = $('selectedList');
  container.innerHTML = '';
  const byPath = new Map(state.photos.map(p => [p.relPath, p]));

  state.selectedImages.forEach((relPath, idx) => {
    const p = byPath.get(relPath);
    const row = document.createElement('div');
    row.className = 'selected-item';
    row.innerHTML = `
      <img src="${p ? p.previewUrl : ''}" alt="preview" />
      <div>
        <div class="file-name">${escapeHtml(relPath)}</div>
        <div class="file-sub">Order ${idx + 1}</div>
      </div>
      <div class="selected-actions"></div>
    `;
    const actions = row.querySelector('.selected-actions');

    const upBtn = document.createElement('button');
    upBtn.textContent = '↑';
    upBtn.className = 'secondary';
    upBtn.disabled = idx === 0;
    upBtn.onclick = () => moveSelected(idx, idx - 1);

    const downBtn = document.createElement('button');
    downBtn.textContent = '↓';
    downBtn.className = 'secondary';
    downBtn.disabled = idx === state.selectedImages.length - 1;
    downBtn.onclick = () => moveSelected(idx, idx + 1);

    const removeBtn = document.createElement('button');
    removeBtn.textContent = 'Remove';
    removeBtn.className = 'danger';
    removeBtn.onclick = () => toggleSelect(relPath);

    actions.append(upBtn, downBtn, removeBtn);
    container.appendChild(row);
  });
}

function toggleSelect(relPath) {
  const i = state.selectedImages.indexOf(relPath);
  if (i >= 0) {
    state.selectedImages.splice(i, 1);
  } else {
    state.selectedImages.push(relPath);
  }
  renderSelected();
  renderPhotos();
}

function moveSelected(fromIdx, toIdx) {
  if (toIdx < 0 || toIdx >= state.selectedImages.length) return;
  const [item] = state.selectedImages.splice(fromIdx, 1);
  state.selectedImages.splice(toIdx, 0, item);
  renderSelected();
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
  log('Loaded config');
}

async function saveConfig() {
  const config = collectConfigFromForm();
  const res = await api('/api/config', {
    method: 'POST',
    body: JSON.stringify({ config }),
  });
  state.config = res.config;
  log('Saved settings');
}

async function refreshPhotos() {
  try {
    await saveConfig();
    const res = await api('/api/photos');
    state.photos = res.images;
    // Drop selections that no longer exist
    const validSet = new Set(state.photos.map(p => p.relPath));
    state.selectedImages = state.selectedImages.filter(x => validSet.has(x));
    renderPhotos();
    renderSelected();
    log(`Loaded ${res.count} photos from sync folder`);
  } catch (err) {
    log(`Failed to refresh photos: ${err.message}`, 'error');
    if (err.details) log(JSON.stringify(err.details, null, 2), 'error');
  }
}

async function refreshEtsyStatus() {
  try {
    const res = await api('/api/etsy/status');
    if (res.connected) {
      setBadge('etsyBadge', `Etsy: connected`);
    } else {
      setBadge('etsyBadge', 'Etsy: not connected');
    }
  } catch (err) {
    setBadge('etsyBadge', 'Etsy: status error');
    log(`Etsy status error: ${err.message}`, 'error');
  }
}

async function generateListing() {
  try {
    if (!state.selectedImages.length) throw new Error('Select at least 1 image first.');
    await saveConfig();
    const payload = {
      intake: collectIntake(),
      selectedImages: state.selectedImages,
      includeImagesInAi: $('includeImagesInAi').checked,
    };
    $('generateBtn').disabled = true;
    log('Generating listing with AI...');
    const res = await api('/api/generate-listing', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    setGeneratedOutput(res.generated);
    log('AI listing generated successfully');
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
    if (!state.selectedImages.length) throw new Error('Select at least 1 image first.');
    const generated = collectGeneratedOutput();
    if (!generated.title || !generated.description) {
      throw new Error('Generate (or fill in) title and description before creating Etsy draft.');
    }
    await saveConfig();
    $('createEtsyDraftBtn').disabled = true;
    $('etsyResult').textContent = 'Creating Etsy draft and uploading images...';
    log('Creating Etsy draft...');

    const res = await api('/api/etsy/create-draft', {
      method: 'POST',
      body: JSON.stringify({
        intake: collectIntake(),
        generated,
        selectedImages: state.selectedImages,
      }),
    });

    const listingId = res.listingId;
    $('etsyResult').textContent = `Draft created successfully. Listing ID: ${listingId}\nReview it in your Etsy Seller dashboard before publishing.`;
    log(`Etsy draft created. listingId=${listingId}`);
    await refreshEtsyStatus();
  } catch (err) {
    $('etsyResult').textContent = `Error: ${err.message}`;
    log(`Etsy draft creation failed: ${err.message}`, 'error');
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

function attachEvents() {
  $('saveConfigBtn').addEventListener('click', saveConfig);
  $('refreshPhotosBtn').addEventListener('click', refreshPhotos);
  $('connectEtsyBtn').addEventListener('click', () => {
    window.open('/auth/etsy/start', '_blank', 'noopener');
  });
  $('generateBtn').addEventListener('click', generateListing);
  $('createEtsyDraftBtn').addEventListener('click', createEtsyDraft);
  $('photoSearch').addEventListener('input', renderPhotos);
  $('copyDescriptionBtn').addEventListener('click', () => copyText($('o_description').value, 'description'));
  $('copyTitleBtn').addEventListener('click', () => copyText($('o_title').value, 'title'));
}

async function init() {
  attachEvents();
  await loadHealth();
  await loadConfig();
  await refreshEtsyStatus();
  await refreshPhotos();
}

init().catch((err) => {
  log(`Startup error: ${err.message}`, 'error');
});
