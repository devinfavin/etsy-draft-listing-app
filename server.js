require('dotenv').config();
const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const TOKENS_FILE = path.join(DATA_DIR, 'etsy_tokens.json');
const OAUTH_PENDING_FILE = path.join(DATA_DIR, 'etsy_oauth_pending.json');
const ITEMS_FILE = path.join(DATA_DIR, 'items.json');

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(express.static(PUBLIC_DIR));

let configCache = null;
const syncFolderResolveCache = {
  key: null,
  resolved: null,
  checkedAtMs: 0
};
const SYNC_FOLDER_CACHE_TTL_MS = 15_000;

ensureDataFiles();

function ensureDataFiles() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_FILE)) writeJson(CONFIG_FILE, defaultConfig());
  if (!fs.existsSync(ITEMS_FILE)) writeJson(ITEMS_FILE, []);
}

function defaultConfig() {
  return {
    syncFolder: process.env.SYNC_FOLDER || '',
    openai: {
      model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
      includeImagesInPrompt: false,
      maxImagesForVision: 4
    },
    etsy: {
      shopId: '',
      defaults: {
        quantity: 1,
        who_made: 'someone_else',
        when_made: 'before_2000',
        taxonomy_id: '',
        shipping_profile_id: '',
        readiness_state_id: '',
        is_supply: false,
        price_currency_note: 'Etsy API expects price in your shop currency; confirm your API field expectations in your account.'
      }
    },
    listingPolicyText: 'Please look closely at the pictures as they provide the best description. I only ship to the USA. In the majority of cases the product will ship the next business day; weekend sales will ship out on Monday unless it is a holiday. All items are packaged with care, and I try to use mostly recycled packing supplies to help reduce my carbon footprint.'
  };
}

function safeNowIso() {
  return new Date().toISOString();
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    console.error(`Failed to read JSON ${file}:`, err);
    return fallback;
  }
}

function writeJson(file, data) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const payload = JSON.stringify(data, null, 2);
  const tmpFile = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`
  );

  try {
    fs.writeFileSync(tmpFile, payload, 'utf8');
    fs.renameSync(tmpFile, file);
  } finally {
    if (fs.existsSync(tmpFile)) {
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  }
}

function getConfig() {
  if (configCache) return configCache;
  const cfg = readJson(CONFIG_FILE, defaultConfig());
  configCache = {
    ...defaultConfig(),
    ...cfg,
    openai: { ...defaultConfig().openai, ...(cfg.openai || {}) },
    etsy: {
      ...defaultConfig().etsy,
      ...(cfg.etsy || {}),
      defaults: { ...defaultConfig().etsy.defaults, ...((cfg.etsy || {}).defaults || {}) }
    }
  };
  return configCache;
}

function saveConfig(nextCfg) {
  const merged = {
    ...defaultConfig(),
    ...(nextCfg || {}),
    openai: { ...defaultConfig().openai, ...((nextCfg || {}).openai || {}) },
    etsy: {
      ...defaultConfig().etsy,
      ...((nextCfg || {}).etsy || {}),
      defaults: { ...defaultConfig().etsy.defaults, ...(((nextCfg || {}).etsy || {}).defaults || {}) }
    }
  };

  writeJson(CONFIG_FILE, merged);
  configCache = merged;
  const currentFolder = String(merged.syncFolder || '').trim();
  if (syncFolderResolveCache.key !== currentFolder) {
    syncFolderResolveCache.key = null;
    syncFolderResolveCache.resolved = null;
    syncFolderResolveCache.checkedAtMs = 0;
  }
  return merged;
}

function sanitizeForClientConfig(cfg) {
  return cfg;
}

function errorResponse(res, status, message, details) {
  res.status(status).json({ ok: false, error: message, details });
}

function resolveSyncFolder(cfg) {
  const folder = cfg.syncFolder?.trim();
  if (!folder) throw new Error('Sync folder not set. Save a sync folder path in Settings first.');

  const now = Date.now();
  if (
    syncFolderResolveCache.key === folder &&
    syncFolderResolveCache.resolved &&
    now - syncFolderResolveCache.checkedAtMs < SYNC_FOLDER_CACHE_TTL_MS
  ) {
    return syncFolderResolveCache.resolved;
  }

  if (!fs.existsSync(folder)) throw new Error(`Sync folder does not exist: ${folder}`);
  if (!fs.statSync(folder).isDirectory()) throw new Error(`Sync folder is not a directory: ${folder}`);
  const resolved = path.resolve(folder);
  syncFolderResolveCache.key = folder;
  syncFolderResolveCache.resolved = resolved;
  syncFolderResolveCache.checkedAtMs = now;
  return resolved;
}

function isImageFile(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  return ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif'].includes(ext);
}

async function walkImages(rootDir, maxCount = 500) {
  const out = [];
  async function walk(dir) {
    if (out.length >= maxCount) return;
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      console.warn('Unable to read dir', dir, err.message);
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxCount) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && isImageFile(entry.name)) {
        try {
          const st = await fsp.stat(full);
          out.push({ full, mtimeMs: st.mtimeMs, size: st.size });
        } catch {}
      }
    }
  }
  await walk(rootDir);
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, maxCount);
}

function safeResolveDirUnder(rootDir, relDir) {
  const rel = String(relDir || '').trim();
  const resolvedRoot = path.resolve(rootDir);
  const normalizedRel = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  const full = path.resolve(resolvedRoot, normalizedRel || '.');
  const relative = path.relative(resolvedRoot, full);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Invalid folder path');
  }
  return full;
}

function normalizeRelPath(rel) {
  const trimmed = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!trimmed || trimmed === '.') return '';
  return trimmed.replace(/\/+$/, '');
}

function safeResolveUnder(rootDir, relPath) {
  const rel = String(relPath || '').trim();
  if (!rel) throw new Error('Invalid file path');

  const resolvedRoot = path.resolve(rootDir);
  const normalizedRel = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  const full = path.resolve(resolvedRoot, normalizedRel);
  const relative = path.relative(resolvedRoot, full);

  // Robust containment check: reject parent traversal and absolute escapes.
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Invalid file path');
  }
  return full;
}

function guessMime(fullPath) {
  const ext = path.extname(fullPath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.heic') return 'image/heic';
  if (ext === '.heif') return 'image/heif';
  return 'application/octet-stream';
}

function loadTokens() {
  return readJson(TOKENS_FILE, null);
}
function saveTokens(t) {
  writeJson(TOKENS_FILE, t);
}

function xApiKeyHeaderValue() {
  const x = process.env.ETSY_X_API_KEY?.trim();
  if (!x) throw new Error('ETSY_X_API_KEY is not set in .env');
  return x;
}
function etsyClientId() {
  const x = process.env.ETSY_CLIENT_ID?.trim();
  if (!x) throw new Error('ETSY_CLIENT_ID is not set in .env');
  return x;
}
function etsyRedirectUri() {
  const x = process.env.ETSY_REDIRECT_URI?.trim();
  if (!x) throw new Error('ETSY_REDIRECT_URI is not set in .env');
  return x;
}
function appBaseUrl() {
  return (process.env.APP_BASE_URL || `http://localhost:${PORT}`).trim();
}

async function openFolderPicker(initialDirectory) {
  if (process.platform !== 'win32') {
    throw new Error('Native folder picker is only implemented for Windows in this app.');
  }

  const initialDir = String(initialDirectory || '').trim();
  const initialDirEscaped = initialDir.replace(/'/g, "''");
  const psScript = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$dialog = New-Object System.Windows.Forms.OpenFileDialog',
    '$dialog.Title = "Select your photo folder"',
    '$dialog.Filter = "Folders|*.folder"',
    '$dialog.CheckFileExists = $false',
    '$dialog.CheckPathExists = $true',
    '$dialog.ValidateNames = $false',
    '$dialog.FileName = "Select Folder"',
    `$initial = '${initialDirEscaped}'`,
    'if ($initial -and (Test-Path -LiteralPath $initial -PathType Container)) { $dialog.InitialDirectory = $initial }',
    '$result = $dialog.ShowDialog()',
    '$raw = $dialog.FileName',
    '$chosen = ""',
    'if ($result -eq [System.Windows.Forms.DialogResult]::OK) {',
    '  if ($raw -and (Test-Path -LiteralPath $raw -PathType Container)) {',
    '    $chosen = $raw',
    '  } else {',
    '    $chosen = [System.IO.Path]::GetDirectoryName($raw)',
    '  }',
    '  if ($chosen) { Write-Output $chosen }',
    '}'
  ].join('; ');

  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    psScript
  ]);

  const selected = String(stdout || '').trim();
  return selected || null;
}

function createPkcePair() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function etsyTokenRequest(bodyParams) {
  const body = new URLSearchParams(bodyParams);
  const resp = await fetch('https://api.etsy.com/v3/public/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!resp.ok) {
    const err = new Error('Etsy token request failed');
    err.details = json;
    err.status = resp.status;
    throw err;
  }
  return json;
}

async function getValidEtsyAccessToken() {
  let tokens = loadTokens();
  if (!tokens?.access_token) throw new Error('Etsy is not connected. Use Connect Etsy first.');

  const now = Date.now();
  const expiresAt = Number(tokens.expires_at || 0);
  if (expiresAt && now < expiresAt - 60_000) {
    return tokens.access_token;
  }
  if (!tokens.refresh_token) throw new Error('Etsy refresh token missing; reconnect Etsy.');

  const refreshed = await etsyTokenRequest({
    grant_type: 'refresh_token',
    client_id: etsyClientId(),
    refresh_token: tokens.refresh_token
  });

  tokens = {
    ...tokens,
    ...refreshed,
    obtained_at: safeNowIso(),
    expires_at: Date.now() + ((Number(refreshed.expires_in) || 3600) * 1000)
  };
  saveTokens(tokens);
  return tokens.access_token;
}

function getOpenAiKey() {
  const k = process.env.OPENAI_API_KEY?.trim();
  if (!k) throw new Error('OPENAI_API_KEY is not set in .env');
  return k;
}

function listingOutputSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'short_blurb', 'description', 'condition_note', 'bullet_specs', 'tags', 'image_alt_text', 'etsy_materials', 'etsy_colors'],
    properties: {
      title: { type: 'string' },
      short_blurb: { type: 'string' },
      description: { type: 'string' },
      condition_note: { type: 'string' },
      bullet_specs: { type: 'array', items: { type: 'string' } },
      tags: { type: 'array', items: { type: 'string' } },
      image_alt_text: { type: 'array', items: { type: 'string' } },
      etsy_materials: { type: 'array', items: { type: 'string' } },
      etsy_colors: { type: 'array', items: { type: 'string' } }
    }
  };
}

function normalizeTextForMatch(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function containsNormalizedText(haystack, needle) {
  const h = normalizeTextForMatch(haystack);
  const n = normalizeTextForMatch(needle);
  return Boolean(n) && h.includes(n);
}

function buildGeneratePrompt({ intake, cfg, selectedImages }) {
  const safe = (v) => (v == null ? '' : String(v));
  const lines = [
    'Create an Etsy-ready listing for a used item. Be accurate and conservative. Do not invent details.',
    'If a detail is unknown, say unknown or omit the claim.',
    'Keep tone clear, helpful, and resale-appropriate.',
    'Return JSON matching the schema exactly.',
    'Important: Do not include generic shipping/policy boilerplate in the description. The app appends seller policy text separately after generation.',
    '',
    'Seller policy text managed by app (for reference only, do not repeat it in description):',
    safe(cfg.listingPolicyText),
    '',
    'Item intake:',
    `Category/type: ${safe(intake.type)}`,
    `Brand: ${safe(intake.brand)}`,
    `Title hint: ${safe(intake.titleHint)}`,
    `Capacity: ${safe(intake.capacity)}`,
    `Material: ${safe(intake.material)}`,
    `Microwave safe: ${safe(intake.microwaveSafe)}`,
    `Dishwasher safe: ${safe(intake.dishwasherSafe)}`,
    `Dimensions: ${safe(intake.dimensions)}`,
    `Weight: ${safe(intake.weight)}`,
    `Pattern/style/color: ${safe(intake.patternStyleColor)}`,
    `Condition summary: ${safe(intake.conditionSummary)}`,
    `Condition defects: ${safe(intake.defects)}`,
    `Markings/stamps: ${safe(intake.markings)}`,
    `Era/approx age: ${safe(intake.era)}`,
    `Quantity: ${safe(intake.quantity)}`,
    `Price: ${safe(intake.price)}`,
    `Additional notes: ${safe(intake.notes)}`,
    '',
    `Number of selected images: ${selectedImages.length}`,
    'Create title within Etsy-friendly length (aim ~100-140 chars max, front-load keywords).',
    'Description should include a brief opening paragraph, bullet-like specs (but also return bullet_specs array), and condition paragraph.',
    'Condition note should be concise and factual.',
    'Tags should be short keyword phrases suitable for marketplace listing fields.'
  ];
  return lines.join('\n');
}

async function callOpenAIForListing({ intake, selectedImages, includeImages, cfg, rootDir }) {
  const model = cfg.openai?.model || process.env.OPENAI_MODEL || 'gpt-4.1-mini';
  const prompt = buildGeneratePrompt({ intake, cfg, selectedImages });

  const content = [{ type: 'input_text', text: prompt }];

  if (includeImages) {
    const maxImages = Math.max(1, Math.min(Number(cfg.openai?.maxImagesForVision || 4), 8));
    let totalBytes = 0;
    for (const relPath of selectedImages.slice(0, maxImages)) {
      const full = safeResolveUnder(rootDir, relPath);
      const buf = await fsp.readFile(full);
      totalBytes += buf.length;
      if (totalBytes > 8 * 1024 * 1024) {
        throw new Error('Selected images too large for vision prompt in this MVP (over ~8MB combined). Use fewer/smaller images or disable image analysis.');
      }
      const mime = guessMime(full);
      content.push({
        type: 'input_image',
        image_url: `data:${mime};base64,${buf.toString('base64')}`
      });
    }
  }

  const body = {
    model,
    input: [
      {
        role: 'user',
        content
      }
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'listing_output',
        strict: true,
        schema: listingOutputSchema()
      }
    }
  };

  const resp = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getOpenAiKey()}`
    },
    body: JSON.stringify(body)
  });

  const rawText = await resp.text();
  let json;
  try { json = JSON.parse(rawText); } catch {
    throw new Error(`OpenAI returned non-JSON response: ${rawText.slice(0, 500)}`);
  }

  if (!resp.ok) {
    const msg = json?.error?.message || 'OpenAI request failed';
    const err = new Error(msg);
    err.details = json;
    throw err;
  }

  const outputText = json.output_text || extractOpenAiOutputText(json) || '';
  let parsed;
  try {
    parsed = JSON.parse(outputText);
  } catch (e) {
    const err = new Error('Failed to parse structured OpenAI output as JSON');
    err.details = { outputText, response: json };
    throw err;
  }

  // append policy text once to description if not present
  const policy = cfg.listingPolicyText?.trim();
  if (policy && parsed.description && !containsNormalizedText(parsed.description, policy)) {
    parsed.description = `${String(parsed.description).trim()}\n\n${policy}`;
  }
  return { parsed, raw: json };
}

function extractOpenAiOutputText(respJson) {
  try {
    const items = respJson.output || [];
    let text = '';
    for (const item of items) {
      for (const c of item.content || []) {
        if (c.type === 'output_text' && typeof c.text === 'string') text += c.text;
      }
    }
    return text;
  } catch {
    return '';
  }
}

function loadItems() {
  return readJson(ITEMS_FILE, []);
}
function saveItems(items) {
  writeJson(ITEMS_FILE, items);
}

function recordItem(entry) {
  const items = loadItems();
  items.unshift(entry);
  saveItems(items.slice(0, 5000));
  return entry;
}

async function etsyApiFetch(url, { method = 'GET', headers = {}, body } = {}) {
  const accessToken = await getValidEtsyAccessToken();
  const mergedHeaders = {
    Authorization: `Bearer ${accessToken}`,
    'x-api-key': xApiKeyHeaderValue(),
    ...headers
  };
  const resp = await fetch(url, { method, headers: mergedHeaders, body });
  const txt = await resp.text();
  let json;
  try { json = JSON.parse(txt); } catch { json = { raw: txt }; }
  if (!resp.ok) {
    const err = new Error(`Etsy API request failed (${resp.status})`);
    err.status = resp.status;
    err.details = json;
    throw err;
  }
  return json;
}

function coercePriceString(priceInput) {
  // Etsy docs examples often show form-encoded "price" as string; some shops interpret whole/decimal based on endpoint.
  // We preserve user-entered numeric string and only normalize commas/whitespace.
  const raw = String(priceInput ?? '').trim();
  if (!raw) return '';
  return raw.replace(/\$/g, '').replace(/,/g, '');
}

function buildEtsyDraftBody({ intake, generated, cfg }) {
  const d = cfg.etsy.defaults || {};
  const params = new URLSearchParams();
  const title = (generated?.title || intake.titleHint || `${intake.brand || ''} ${intake.type || 'Item'}`).trim();
  const description = (generated?.description || '').trim() || 'Used item. See photos and item details.';
  const quantity = String(intake.quantity || d.quantity || 1);
  const price = coercePriceString(intake.price);
  if (!price) throw new Error('Price is required before creating Etsy draft.');

  const requiredMap = {
    quantity,
    title,
    description,
    price,
    who_made: d.who_made,
    when_made: d.when_made,
    taxonomy_id: d.taxonomy_id,
    shipping_profile_id: d.shipping_profile_id,
    readiness_state_id: d.readiness_state_id
  };

  for (const [k, v] of Object.entries(requiredMap)) {
    if (v == null || String(v).trim() === '') {
      throw new Error(`Missing Etsy required field: ${k}. Set it in Settings.`);
    }
    params.append(k, String(v));
  }

  params.append('state', 'draft');
  params.append('is_supply', String(Boolean(d.is_supply)));

  if (generated?.etsy_materials?.length) {
    params.append('materials', generated.etsy_materials.slice(0, 13).join(','));
  }
  if (generated?.tags?.length) {
    // Etsy tags are usually managed via separate fields; this example stores as comma-delimited if endpoint accepts it.
    params.append('tags', generated.tags.slice(0, 13).join(','));
  }

  return params;
}

function extractEtsyListingId(createResp) {
  return (
    createResp?.listing_id ||
    createResp?.results?.[0]?.listing_id ||
    createResp?.results?.[0]?.listing?.listing_id ||
    createResp?.listing?.listing_id ||
    null
  );
}

async function uploadEtsyListingImage({ shopId, listingId, fullImagePath, rank }) {
  const form = new FormData();
  const buf = await fsp.readFile(fullImagePath);
  const mime = guessMime(fullImagePath);
  const filename = path.basename(fullImagePath);
  form.append('image', new Blob([buf], { type: mime }), filename);
  if (Number.isFinite(rank)) form.append('rank', String(rank));

  return etsyApiFetch(`https://api.etsy.com/v3/application/shops/${shopId}/listings/${listingId}/images`, {
    method: 'POST',
    body: form
  });
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: safeNowIso() });
});

app.get('/api/config', (_req, res) => {
  res.json({ ok: true, config: sanitizeForClientConfig(getConfig()) });
});

app.post('/api/config', (req, res) => {
  try {
    const current = getConfig();
    const incoming = req.body?.config;
    if (!incoming || typeof incoming !== 'object') return errorResponse(res, 400, 'Invalid config payload');
    const next = {
      ...current,
      ...incoming,
      openai: { ...current.openai, ...(incoming.openai || {}) },
      etsy: {
        ...current.etsy,
        ...(incoming.etsy || {}),
        defaults: { ...current.etsy.defaults, ...((incoming.etsy || {}).defaults || {}) }
      }
    };
    const saved = saveConfig(next);
    res.json({ ok: true, config: sanitizeForClientConfig(saved) });
  } catch (err) {
    errorResponse(res, 500, err.message);
  }
});

app.post('/api/browse-folder', async (req, res) => {
  try {
    const folder = await openFolderPicker(req.body?.initialDirectory);
    res.json({ ok: true, folder, cancelled: !folder });
  } catch (err) {
    errorResponse(res, 400, err.message);
  }
});

app.get('/api/folder-contents', async (req, res) => {
  try {
    const cfg = getConfig();
    const root = resolveSyncFolder(cfg);
    const relDir = normalizeRelPath(req.query.relDir || '');
    const fullDir = safeResolveDirUnder(root, relDir);
    if (!fs.existsSync(fullDir)) return errorResponse(res, 404, 'Folder not found');
    if (!fs.statSync(fullDir).isDirectory()) return errorResponse(res, 400, 'Selected path is not a folder');

    const entries = await fsp.readdir(fullDir, { withFileTypes: true });
    const folders = [];
    const imageEntries = [];

    for (const entry of entries) {
      const full = path.join(fullDir, entry.name);
      if (entry.isDirectory()) {
        const childRel = normalizeRelPath(path.relative(root, full));
        folders.push({ name: entry.name, relDir: childRel });
        continue;
      }
      if (entry.isFile() && isImageFile(entry.name)) {
        imageEntries.push({ name: entry.name, full });
      }
    }

    const images = (await Promise.all(
      imageEntries.map(async (img) => {
        try {
          const st = await fsp.stat(img.full);
          const relPath = normalizeRelPath(path.relative(root, img.full));
          return {
            relPath,
            name: img.name,
            size: st.size,
            mtimeMs: st.mtimeMs,
            previewUrl: `/api/photo?relPath=${encodeURIComponent(relPath)}`
          };
        } catch {
          return null;
        }
      })
    )).filter(Boolean);

    folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    images.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const parentRelDir = relDir ? normalizeRelPath(path.dirname(relDir)) : null;
    res.json({
      ok: true,
      root,
      relDir,
      parentRelDir,
      folders,
      images
    });
  } catch (err) {
    errorResponse(res, 400, err.message);
  }
});

app.get('/api/photos', async (_req, res) => {
  try {
    const cfg = getConfig();
    const root = resolveSyncFolder(cfg);
    const files = await walkImages(root, 600);
    const images = files.map((f) => {
      const relPath = path.relative(root, f.full).replace(/\\/g, '/');
      return {
        relPath,
        name: path.basename(f.full),
        mtimeMs: f.mtimeMs,
        size: f.size,
        previewUrl: `/api/photo?relPath=${encodeURIComponent(relPath)}`
      };
    });
    res.json({ ok: true, root, count: images.length, images });
  } catch (err) {
    errorResponse(res, 400, err.message);
  }
});

app.get('/api/photo', (req, res) => {
  try {
    const relPath = String(req.query.relPath || '');
    if (!relPath) return errorResponse(res, 400, 'relPath is required');
    const root = resolveSyncFolder(getConfig());
    const full = safeResolveUnder(root, relPath);
    res.sendFile(full, (err) => {
      if (!err || res.headersSent) return;
      if (err.code === 'ENOENT') return errorResponse(res, 404, 'File not found');
      return errorResponse(res, 500, 'Failed to read image file');
    });
  } catch (err) {
    errorResponse(res, 400, err.message);
  }
});

app.post('/api/generate-listing', async (req, res) => {
  try {
    const cfg = getConfig();
    const root = resolveSyncFolder(cfg);
    const intake = req.body?.intake || {};
    const selectedImages = Array.isArray(req.body?.selectedImages) ? req.body.selectedImages : [];
    if (!selectedImages.length) return errorResponse(res, 400, 'Select at least 1 image');
    const includeImages = Boolean(req.body?.includeImagesInAi ?? cfg.openai.includeImagesInPrompt);

    // validate image paths first
    for (const rel of selectedImages) safeResolveUnder(root, rel);

    const { parsed, raw } = await callOpenAIForListing({
      intake,
      selectedImages,
      includeImages,
      cfg,
      rootDir: root
    });

    const record = recordItem({
      id: crypto.randomUUID(),
      createdAt: safeNowIso(),
      status: 'generated',
      intake,
      selectedImages,
      generated: parsed,
      meta: {
        openaiModel: cfg.openai.model,
        includeImagesInAi: includeImages,
        openaiResponseId: raw.id || null
      }
    });

    res.json({ ok: true, generated: parsed, itemId: record.id });
  } catch (err) {
    errorResponse(res, 500, err.message, err.details || null);
  }
});

app.get('/api/items', (_req, res) => {
  const items = loadItems();
  res.json({ ok: true, items: items.slice(0, 100) });
});

app.get('/api/etsy/status', (_req, res) => {
  try {
    const t = loadTokens();
    res.json({
      ok: true,
      connected: Boolean(t?.access_token),
      tokenExpiresAt: t?.expires_at || null,
      scopes: t?.scope || t?.scopes || null,
      userIdHint: t?.user_id || null
    });
  } catch (err) {
    errorResponse(res, 500, err.message);
  }
});

app.get('/auth/etsy/start', (_req, res) => {
  try {
    const state = crypto.randomBytes(18).toString('hex');
    const { verifier, challenge } = createPkcePair();
    const pending = {
      state,
      verifier,
      createdAt: safeNowIso()
    };
    writeJson(OAUTH_PENDING_FILE, pending);

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: etsyClientId(),
      redirect_uri: etsyRedirectUri(),
      scope: 'listings_r listings_w shops_r',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256'
    });

    res.redirect(`https://www.etsy.com/oauth/connect?${params.toString()}`);
  } catch (err) {
    res.status(500).send(`<pre>Failed to start Etsy OAuth:\n${escapeHtml(err.message)}</pre>`);
  }
});

app.get('/auth/etsy/callback', async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;
    if (error) {
      return res.status(400).send(`<pre>Etsy OAuth error: ${escapeHtml(String(error))}\n${escapeHtml(String(error_description || ''))}</pre>`);
    }
    if (!code || !state) {
      return res.status(400).send('<pre>Missing code/state from Etsy callback.</pre>');
    }
    const pending = readJson(OAUTH_PENDING_FILE, null);
    if (!pending?.state || pending.state !== String(state)) {
      return res.status(400).send('<pre>Invalid OAuth state. Start the Etsy connect flow again.</pre>');
    }

    const token = await etsyTokenRequest({
      grant_type: 'authorization_code',
      client_id: etsyClientId(),
      redirect_uri: etsyRedirectUri(),
      code: String(code),
      code_verifier: pending.verifier
    });

    const toSave = {
      ...token,
      obtained_at: safeNowIso(),
      expires_at: Date.now() + ((Number(token.expires_in) || 3600) * 1000)
    };
    saveTokens(toSave);
    if (fs.existsSync(OAUTH_PENDING_FILE)) fs.unlinkSync(OAUTH_PENDING_FILE);

    res.send(`<!doctype html><html><body style="font-family: system-ui; padding: 24px;">
      <h2>Etsy connected successfully</h2>
      <p>You can close this tab and return to the app.</p>
      <p><a href="${appBaseUrl()}">Return to app</a></p>
    </body></html>`);
  } catch (err) {
    const details = err.details ? `\n\n${JSON.stringify(err.details, null, 2)}` : '';
    res.status(err.status || 500).send(`<pre>Etsy OAuth callback failed:\n${escapeHtml(err.message + details)}</pre>`);
  }
});

app.post('/api/etsy/create-draft', async (req, res) => {
  try {
    const cfg = getConfig();
    const root = resolveSyncFolder(cfg);
    const shopId = String(cfg.etsy?.shopId || '').trim();
    if (!shopId) return errorResponse(res, 400, 'Etsy shopId is required in Settings');

    const intake = req.body?.intake || {};
    const generated = req.body?.generated || {};
    const selectedImages = Array.isArray(req.body?.selectedImages) ? req.body.selectedImages : [];
    if (!selectedImages.length) return errorResponse(res, 400, 'No images selected');

    const createBody = buildEtsyDraftBody({ intake, generated, cfg });
    const createResp = await etsyApiFetch(`https://api.etsy.com/v3/application/shops/${shopId}/listings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: createBody
    });

    const listingId = extractEtsyListingId(createResp);
    if (!listingId) {
      const err = new Error('Etsy draft created but listing_id was not found in response');
      err.details = createResp;
      throw err;
    }

    const uploadResults = [];
    let rank = 1;
    for (const relPath of selectedImages) {
      const full = safeResolveUnder(root, relPath);
      const resp = await uploadEtsyListingImage({ shopId, listingId, fullImagePath: full, rank });
      uploadResults.push({ relPath, rank, response: resp });
      rank += 1;
    }

    const etsyRecord = {
      listingId,
      shopId,
      createdAt: safeNowIso(),
      createResp,
      uploadResults
    };

    const itemRecord = recordItem({
      id: crypto.randomUUID(),
      createdAt: safeNowIso(),
      status: 'etsy_draft_created',
      intake,
      selectedImages,
      generated,
      etsy: etsyRecord
    });

    res.json({
      ok: true,
      listingId,
      itemId: itemRecord.id,
      etsy: etsyRecord,
      note: 'Draft created. Review in Etsy Seller dashboard before publishing.'
    });
  } catch (err) {
    errorResponse(res, err.status || 500, err.message, err.details || null);
  }
});

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

app.listen(PORT, () => {
  console.log(`Etsy Draft Listing App running at ${appBaseUrl()}`);
});
