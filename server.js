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
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');
const THUMB_CACHE_DIR = path.join(DATA_DIR, 'thumb-cache');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const TOKENS_FILE = path.join(DATA_DIR, 'etsy_tokens.json');
const OAUTH_PENDING_FILE = path.join(DATA_DIR, 'etsy_oauth_pending.json');
const ITEMS_FILE = path.join(DATA_DIR, 'items.json');

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(express.static(PUBLIC_DIR));

let configCache = null;
let taxonomyNodesCache = null;
let taxonomyNodesCachedAt = 0;
const TAXONOMY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const syncFolderResolveCache = {
  key: null,
  resolved: null,
  checkedAtMs: 0
};
const SYNC_FOLDER_CACHE_TTL_MS = 15_000;
const MAX_VISION_IMAGES = 10;
const MAX_VISION_TOTAL_BYTES = 30 * 1024 * 1024;
const MAX_VISION_IMAGE_BYTES = 6 * 1024 * 1024;
const VISION_IMAGE_SIZE = 1200;
const STORE_KEYS = ['store_1', 'store_2'];
const APP_VERSION = require('./package.json').version;
const SERVER_STARTED_AT = new Date().toISOString();
const thumbnailInflight = new Map();
let sharpLib = undefined;
let sharpMissingWarned = false;

ensureDataFiles();

function ensureDataFiles() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(THUMB_CACHE_DIR)) fs.mkdirSync(THUMB_CACHE_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_FILE)) writeJson(CONFIG_FILE, defaultConfig());
  if (!fs.existsSync(ITEMS_FILE)) writeJson(ITEMS_FILE, []);
}

function defaultEtsyListingDefaults() {
  return {
    quantity: 1,
    who_made: 'someone_else',
    when_made: '',
    taxonomy_id: '',
    shipping_profile_id: '',
    readiness_state_id: '',
    is_supply: false,
    price_currency_note: 'Etsy API expects price in your shop currency; confirm your API field expectations in your account.'
  };
}

function defaultStoreForIndex(index) {
  return {
    key: STORE_KEYS[index] || `store_${index + 1}`,
    label: `Store ${index + 1}`,
    shopId: '',
    lastFolder: '',
    defaults: defaultEtsyListingDefaults()
  };
}

function normalizeStoreEntry(rawStore, index, legacyEtsy = null) {
  const fallback = defaultStoreForIndex(index);
  const source = rawStore && typeof rawStore === 'object' ? rawStore : {};
  const legacyEnabled = !rawStore && legacyEtsy && index === 0;
  const legacyDefaults = legacyEnabled ? (legacyEtsy.defaults || {}) : {};
  const legacyShopId = legacyEnabled ? (legacyEtsy.shopId || '') : '';

  return {
    key: String(source.key || fallback.key),
    label: String(source.label || fallback.label).trim() || fallback.label,
    shopId: String(source.shopId || legacyShopId || '').trim(),
    lastFolder: String(source.lastFolder || '').trim(),
    defaults: {
      ...fallback.defaults,
      ...legacyDefaults,
      ...(source.defaults || {})
    }
  };
}

function normalizeEtsyConfig(rawEtsy) {
  const src = rawEtsy && typeof rawEtsy === 'object' ? rawEtsy : {};
  const incomingStores = Array.isArray(src.stores) ? src.stores : [];
  const stores = STORE_KEYS.map((_, index) => normalizeStoreEntry(incomingStores[index], index, src));

  const keys = new Set(stores.map((s) => s.key));
  const activeStoreKey = keys.has(src.activeStoreKey) ? src.activeStoreKey : stores[0].key;
  return { activeStoreKey, stores };
}

function getStoreByKeyFromConfig(cfg, storeKey) {
  const etsy = normalizeEtsyConfig(cfg?.etsy);
  const wanted = String(storeKey || etsy.activeStoreKey || '').trim();
  return etsy.stores.find((s) => s.key === wanted) || etsy.stores[0];
}

function defaultConfig() {
  return {
    syncFolder: process.env.SYNC_FOLDER || '',
    claude: {
      model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
      includeImagesInPrompt: true,
      maxImagesForVision: MAX_VISION_IMAGES
    },
    etsy: normalizeEtsyConfig({}),
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

function getEnvClaudeModel() {
  const model = String(process.env.CLAUDE_MODEL || '').trim();
  return model || '';
}

function applyEnvConfigOverrides(cfg) {
  const envModel = getEnvClaudeModel();
  if (!envModel) return cfg;
  return {
    ...cfg,
    claude: {
      ...(cfg.claude || {}),
      model: envModel
    }
  };
}

function getConfig() {
  if (configCache) {
    configCache = applyEnvConfigOverrides(configCache);
    return configCache;
  }
  const defaults = defaultConfig();
  const cfg = readJson(CONFIG_FILE, defaults);
  const merged = {
    ...defaults,
    ...cfg,
    claude: { ...defaults.claude, ...(cfg.claude || {}) },
    etsy: normalizeEtsyConfig(cfg.etsy || defaults.etsy)
  };
  configCache = applyEnvConfigOverrides(merged);
  return configCache;
}

function saveConfig(nextCfg) {
  const defaults = defaultConfig();
  const merged = {
    ...defaults,
    ...(nextCfg || {}),
    claude: { ...defaults.claude, ...((nextCfg || {}).claude || {}) },
    etsy: normalizeEtsyConfig((nextCfg || {}).etsy || defaults.etsy)
  };

  writeJson(CONFIG_FILE, merged);
  configCache = applyEnvConfigOverrides(merged);
  const currentFolder = String(merged.syncFolder || '').trim();
  if (syncFolderResolveCache.key !== currentFolder) {
    syncFolderResolveCache.key = null;
    syncFolderResolveCache.resolved = null;
    syncFolderResolveCache.checkedAtMs = 0;
  }
  return configCache;
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

function getSharpLib() {
  if (sharpLib !== undefined) return sharpLib;
  try {
    // Optional dependency: if unavailable, we gracefully fall back to original files.
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    sharpLib = require('sharp');
  } catch {
    sharpLib = null;
    if (!sharpMissingWarned) {
      console.warn('sharp is not installed; /api/photo-thumb will fall back to original files. Run: npm install');
      sharpMissingWarned = true;
    }
  }
  return sharpLib;
}

function parseThumbSize(input) {
  const n = Number(input);
  if (!Number.isFinite(n)) return 220;
  return Math.max(96, Math.min(Math.round(n), 640));
}

function thumbnailCacheKey({ fullPath, mtimeMs, size, thumbSize }) {
  return crypto
    .createHash('sha1')
    .update(`${fullPath}\n${mtimeMs}\n${size}\n${thumbSize}`)
    .digest('hex');
}

async function fileExistsAsync(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function generateOrGetThumbnail({ fullPath, stat, thumbSize }) {
  const key = thumbnailCacheKey({
    fullPath,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    thumbSize
  });
  const outFile = path.join(THUMB_CACHE_DIR, `${key}.webp`);
  if (await fileExistsAsync(outFile)) return outFile;

  const existing = thumbnailInflight.get(key);
  if (existing) return existing;

  const sharp = getSharpLib();
  if (!sharp) throw new Error('sharp not installed');

  const work = (async () => {
    const tmpFile = `${outFile}.${process.pid}.${Date.now()}.tmp`;
    try {
      await sharp(fullPath)
        .rotate()
        .resize(thumbSize, thumbSize, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 78 })
        .toFile(tmpFile);

      try {
        await fsp.rename(tmpFile, outFile);
      } catch (err) {
        if (err && err.code === 'EEXIST' && (await fileExistsAsync(outFile))) {
          await fsp.unlink(tmpFile).catch(() => {});
        } else {
          throw err;
        }
      }
      return outFile;
    } finally {
      await fsp.unlink(tmpFile).catch(() => {});
      thumbnailInflight.delete(key);
    }
  })();

  thumbnailInflight.set(key, work);
  return work;
}

async function loadVisionImageBuffer(fullPath) {
  let st;
  try {
    st = await fsp.stat(fullPath);
  } catch {
    throw new Error(`Vision image not found: ${path.basename(fullPath)}`);
  }
  if (!st.isFile()) throw new Error(`Vision image is not a file: ${path.basename(fullPath)}`);

  try {
    const thumbFile = await generateOrGetThumbnail({
      fullPath,
      stat: st,
      thumbSize: VISION_IMAGE_SIZE
    });
    const buf = await fsp.readFile(thumbFile);
    return { buf, mime: 'image/webp' };
  } catch {
    const buf = await fsp.readFile(fullPath);
    return { buf, mime: guessMime(fullPath) };
  }
}

function normalizeTokenStore(raw) {
  if (!raw || typeof raw !== 'object') return {};
  if (raw.access_token) {
    // Legacy single-token format migration.
    const cfg = getConfig();
    const active = getStoreByKeyFromConfig(cfg, cfg.etsy?.activeStoreKey);
    return { [active.key]: raw };
  }
  return { ...raw };
}

function loadTokens(storeKey = null) {
  const raw = readJson(TOKENS_FILE, {});
  const byStore = normalizeTokenStore(raw);
  if (!storeKey) return byStore;
  return byStore[String(storeKey)] || null;
}

function saveTokens(storeKey, tokenPayload) {
  if (!storeKey) throw new Error('storeKey is required when saving Etsy tokens');
  const byStore = loadTokens();
  byStore[String(storeKey)] = tokenPayload;
  writeJson(TOKENS_FILE, byStore);
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

const tokenRefreshLocks = new Map();

async function getValidEtsyAccessToken(storeKey) {
  const key = String(storeKey || '').trim();
  if (!key) throw new Error('Store key is required for Etsy API access.');

  let tokens = loadTokens(key);
  if (!tokens?.access_token) throw new Error('Etsy is not connected. Use Connect Etsy first.');

  const now = Date.now();
  const expiresAt = Number(tokens.expires_at || 0);
  if (expiresAt && now < expiresAt - 60_000) {
    return tokens.access_token;
  }
  if (!tokens.refresh_token) throw new Error('Etsy refresh token missing; reconnect Etsy.');

  // If a refresh is already in progress for this store, wait for it rather than racing.
  const inflight = tokenRefreshLocks.get(key);
  if (inflight) return inflight;

  const refreshWork = (async () => {
    const refreshed = await etsyTokenRequest({
      grant_type: 'refresh_token',
      client_id: etsyClientId(),
      refresh_token: tokens.refresh_token
    });
    const next = {
      ...tokens,
      ...refreshed,
      obtained_at: safeNowIso(),
      expires_at: Date.now() + ((Number(refreshed.expires_in) || 3600) * 1000)
    };
    saveTokens(key, next);
    return next.access_token;
  })();

  tokenRefreshLocks.set(key, refreshWork);
  try {
    return await refreshWork;
  } finally {
    tokenRefreshLocks.delete(key);
  }
}

function getClaudeKey() {
  const k = process.env.ANTHROPIC_API_KEY?.trim();
  if (!k) throw new Error('ANTHROPIC_API_KEY is not set in .env');
  return k;
}

function listingOutputSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'short_blurb', 'description', 'condition_note', 'bullet_specs', 'tags', 'image_alt_text', 'etsy_materials', 'etsy_colors'],
    properties: {
      title: { type: 'string', minLength: 20, maxLength: 140 },
      short_blurb: { type: 'string', minLength: 12, maxLength: 220 },
      description: { type: 'string', minLength: 80, maxLength: 6000 },
      condition_note: { type: 'string', minLength: 8, maxLength: 320 },
      bullet_specs: { type: 'array', minItems: 3, maxItems: 10, items: { type: 'string', minLength: 2, maxLength: 120 } },
      tags: { type: 'array', minItems: 8, maxItems: 13, items: { type: 'string', minLength: 2, maxLength: 20 } },
      image_alt_text: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 8, maxLength: 180 } },
      etsy_materials: { type: 'array', maxItems: 13, items: { type: 'string', minLength: 2, maxLength: 30 } },
      etsy_colors: { type: 'array', maxItems: 6, items: { type: 'string', minLength: 2, maxLength: 24 } },
      taxonomy_hint: { type: 'string', maxLength: 80 }
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


function normalizeWhitespace(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeMultilineText(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function clampByWordBoundary(text, maxLen) {
  const value = String(text || '');
  if (value.length <= maxLen) return value;
  const clipped = value.slice(0, maxLen);
  const lastSpace = clipped.lastIndexOf(' ');
  if (lastSpace >= Math.floor(maxLen * 0.6)) return clipped.slice(0, lastSpace).trim();
  return clipped.trim();
}

function cleanTitleForEtsy(rawTitle) {
  const normalized = normalizeWhitespace(rawTitle)
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s*[-|,:;/]+\s*$/g, '')
    .trim();
  if (!normalized) return '';
  return clampByWordBoundary(normalized, 140).replace(/\s*[-|,:;/]+\s*$/g, '').trim();
}

function normalizeTagForEtsy(rawTag) {
  const normalized = normalizeWhitespace(rawTag)
    .toLowerCase()
    .replace(/[_|/]+/g, ' ')
    .replace(/[^\w\s&'-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return '';
  return clampByWordBoundary(normalized, 20);
}

function normalizeStringArray(items, { maxItems = 50, maxLen = 120, lowerCase = false } = {}) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(items) ? items : []) {
    let text = normalizeWhitespace(raw);
    if (!text) continue;
    text = clampByWordBoundary(text, maxLen);
    if (lowerCase) text = text.toLowerCase();
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

function deriveTagCandidatesFromIntake(intake) {
  const type = normalizeWhitespace(intake?.type);
  const out = [
    type,
    'gift idea',
    'home decor'
  ];
  return out.filter(Boolean);
}

function normalizeTagsForEtsy(tags, intake) {
  const out = [];
  const seen = new Set();
  const allCandidates = [
    ...(Array.isArray(tags) ? tags : []),
    ...deriveTagCandidatesFromIntake(intake)
  ];

  for (const raw of allCandidates) {
    const normalized = normalizeTagForEtsy(raw);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= 13) break;
  }

  if (!out.length) out.push('used item');
  return out;
}

function looksLikePolicyParagraph(paragraph) {
  const raw = String(paragraph || '');
  if (!raw.trim()) return false;
  if (/shipping\s*&\s*polic/i.test(raw)) return true;

  const normalized = normalizeTextForMatch(raw);
  const policySignals = [
    'ship', 'shipping', 'usa', 'business day', 'monday', 'holiday',
    'packaged', 'recycled', 'carbon footprint', 'policy', 'return'
  ];
  let score = 0;
  for (const signal of policySignals) {
    if (normalized.includes(signal)) score += 1;
  }
  return score >= 2;
}

function stripPolicyLikeParagraphs(description) {
  const normalized = normalizeMultilineText(description);
  if (!normalized) return '';
  return normalized
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .filter((paragraph) => !looksLikePolicyParagraph(paragraph))
    .join('\n\n')
    .trim();
}

function normalizeGeneratedListing({ generated, intake, cfg, imageCount }) {
  const titleFallback = normalizeWhitespace(intake?.type) || 'Vintage item';
  const title = cleanTitleForEtsy(generated?.title || titleFallback);
  const shortBlurb = clampByWordBoundary(normalizeWhitespace(generated?.short_blurb), 220);
  const conditionNote = clampByWordBoundary(
    normalizeWhitespace(generated?.condition_note || 'Pre-owned condition. See photos for details.'),
    320
  );

  const bulletSpecs = normalizeStringArray(generated?.bullet_specs, { maxItems: 10, maxLen: 120 });

  const descriptionCore = stripPolicyLikeParagraphs(generated?.description || '');
  let description = descriptionCore;
  if (!description) {
    const opening = shortBlurb || clampByWordBoundary(`Pre-owned ${intake?.type || 'item'} ready for resale.`, 160);
    const specsBlock = bulletSpecs.length ? `Specifications:\n- ${bulletSpecs.join('\n- ')}` : '';
    const conditionBlock = conditionNote ? `Condition:\n${conditionNote}` : '';
    description = [opening, specsBlock, conditionBlock].filter(Boolean).join('\n\n').trim();
  }

  const policy = normalizeMultilineText(cfg?.listingPolicyText);
  if (policy && !containsNormalizedText(description, policy)) {
    description = `${description}\n\n${policy}`;
  }

  const tags = normalizeTagsForEtsy(generated?.tags, intake);
  const materials = normalizeStringArray(generated?.etsy_materials, { maxItems: 13, maxLen: 30 });
  const colors = normalizeStringArray(generated?.etsy_colors, { maxItems: 6, maxLen: 24 });

  const desiredAltCount = Math.max(1, Math.min(Number(imageCount || 1), 20));
  const altText = normalizeStringArray(generated?.image_alt_text, { maxItems: desiredAltCount, maxLen: 180 });
  while (altText.length < desiredAltCount) {
    const n = altText.length + 1;
    altText.push(clampByWordBoundary(`Photo ${n} of ${title || intake?.type || 'item listing'}`, 180));
  }

  return {
    title,
    short_blurb: shortBlurb || clampByWordBoundary(`Pre-owned ${intake?.type || 'item'} listing`, 220),
    description: normalizeMultilineText(description),
    condition_note: conditionNote,
    bullet_specs: bulletSpecs,
    tags,
    image_alt_text: altText,
    etsy_materials: materials,
    etsy_colors: colors
  };
}

function buildGeneratePrompt({ intake, cfg, selectedImages, includeImages }) {
  void cfg;
  const safe = (v) => (v == null ? '' : String(v));
  const lines = [
    'Create an Etsy-ready listing using the seller intake plus the photos.',
    'Read the photos carefully for material, color, pattern, shape, capacity hints, markings/stamps, and any visible wear.',
    'Do not invent details that are not visible in the photos or stated in the seller intake.',
    'If a detail is unknown, omit it.',
    'Return valid JSON matching the provided schema exactly.',
    'No markdown. No prose outside JSON.',
    'Do not include shipping/policy/returns text in description.',
    '',
    'Tone target:',
    '- Buyer-friendly, warm, and engaging while still factual and resale-appropriate.',
    '- Match the actual style of the item shown in the photos. Use merchandising adjectives (vintage, modern, minimalist, boho, industrial, etc.) ONLY when clearly supported by what you can see; do not default to any one aesthetic.',
    '- Do not exaggerate condition or make unsupported claims.',
    '',
    'Output requirements:',
    '- Title: 90-130 characters preferred, hard max 140, keyword-first, clear and factual.',
    '- Description structure (in one field):',
    '  Paragraph 1: engaging hook + what the item is + standout visual details from the photos.',
    '  Paragraph 2: practical use + lifestyle/decor/gift context when supported.',
    '  Paragraph 3: condition/transparency + exactly what is included in the sale.',
    '- Keep all 3 paragraphs concise and readable.',
    '- bullet_specs array: concrete observable attributes (material, color, capacity, pattern, dimensions if visibly inferable, markings).',
    '- condition_note: concise factual sentence describing condition based on the photos and any seller-noted flaws.',
    '- Tags: provide 13 SEO-friendly Etsy tag phrases, each <= 20 characters, no duplicates.',
    '- taxonomy_hint: the core product-type noun only — what the item IS, not what it is made of or flavored with. Examples: "mug", "planter", "brooch", "serving bowl", "throw pillow". One or two words max. No materials, colors, or brand modifiers.',
    '- Keep text natural, warm, and readable for buyers without hype.',
    '- If quantity is more than 1, clearly call out the set size in title and description.',
    includeImages
      ? '- Photos are the primary source of visual facts. Reflect what you see; flag visible wear in condition_note.'
      : '- Images are not available in this run, so rely only on the seller intake.',
    '',
    'Seller intake:',
    `What it is: ${safe(intake.type)}`,
    `Quantity: ${safe(intake.quantity)}`,
    `Price (USD): ${safe(intake.price)}`,
    `Anything the photos don't show: ${safe(intake.notes) || '(none — rely on photos)'}`,
    '',
    `Number of selected images: ${selectedImages.length}`,
    includeImages
      ? 'Context note: selected listing photos are provided to the model for visual reference.'
      : 'Context note: images are not provided to the model in this run.',
    '',
    'Voice reference (match this register, do not copy the words):',
    '- Lead with the strongest visible detail: pattern, material, color, scale.',
    '- Prefer specific nouns over generic adjectives. "Stoneware bud vase with cobalt drip glaze" beats "BEAUTIFUL UNIQUE VASE".',
    '- Add a sentence about typical use or where it fits in a home only if it follows from what is shown.',
    '- Close paragraph 3 with concrete condition info (chips, fading, scratches, wear) drawn from the photos.'
  ];
  return lines.join('\n');
}

async function callClaudeForListing({ intake, selectedImages, includeImages, cfg, rootDir, storeKey }) {
  const model = getEnvClaudeModel() || cfg.claude?.model || 'claude-sonnet-4-6';
  const prompt = buildGeneratePrompt({ intake, cfg, selectedImages, includeImages });

  const content = [];
  let visionImagesUsed = 0;

  if (includeImages) {
    const maxImages = Number(cfg.claude?.maxImagesForVision) || MAX_VISION_IMAGES;
    if (selectedImages.length > maxImages) {
      throw new Error(`Image analysis supports up to ${maxImages} photos per listing. Reduce selected photos to ${maxImages} or fewer.`);
    }
    let totalBytes = 0;
    for (const relPath of selectedImages) {
      const full = safeResolveUnder(rootDir, relPath);
      const { buf, mime } = await loadVisionImageBuffer(full);
      if (buf.length > MAX_VISION_IMAGE_BYTES) {
        throw new Error(
          `A selected photo is too large for AI image analysis (${path.basename(full)}).`
        );
      }
      if (totalBytes + buf.length > MAX_VISION_TOTAL_BYTES) {
        throw new Error(
          `Selected photos are too large for AI image analysis (${selectedImages.length} photos). Try smaller photos or fewer high-resolution images.`
        );
      }
      totalBytes += buf.length;
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: mime,
          data: buf.toString('base64')
        }
      });
      visionImagesUsed += 1;
    }
  }

  content.push({ type: 'text', text: prompt });

  const body = {
    model,
    max_tokens: 4096,
    tools: [
      {
        name: 'listing_output',
        description: 'Return the structured Etsy listing data.',
        input_schema: listingOutputSchema()
      }
    ],
    tool_choice: { type: 'tool', name: 'listing_output' },
    messages: [{ role: 'user', content }]
  };

  const MAX_RETRIES = 2;
  const RETRY_DELAY_MS = 3000;
  let json;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      console.log(`Claude overloaded — retrying (attempt ${attempt}/${MAX_RETRIES}) after ${RETRY_DELAY_MS}ms...`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': getClaudeKey(),
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });

    const rawText = await resp.text();
    try { json = JSON.parse(rawText); } catch {
      throw new Error(`Claude returned non-JSON response: ${rawText.slice(0, 500)}`);
    }

    if (!resp.ok) {
      const errorType = json?.error?.type || '';
      if (errorType === 'overloaded_error' && attempt < MAX_RETRIES) continue;
      const msg = json?.error?.message || `Claude API request failed (${resp.status})`;
      const err = new Error(msg);
      err.claudeErrorType = errorType;
      err.details = json;
      throw err;
    }

    break;
  }

  const toolUseBlock = (json.content || []).find((b) => b.type === 'tool_use' && b.name === 'listing_output');
  if (!toolUseBlock) {
    const err = new Error('Claude did not return a tool_use block with listing_output');
    err.details = json;
    throw err;
  }

  const normalized = normalizeGeneratedListing({
    generated: toolUseBlock.input,
    intake,
    cfg,
    imageCount: selectedImages.length
  });

  let autoTaxonomyId = null;
  let autoTaxonomyLabel = null;
  const taxonomyHint = toolUseBlock.input?.taxonomy_hint || intake?.type || '';
  if (taxonomyHint && storeKey) {
    try {
      const nodes = await fetchFlatTaxonomyNodes(storeKey);
      const match = bestTaxonomyMatch(nodes, taxonomyHint);
      if (match) {
        autoTaxonomyId = match.id;
        autoTaxonomyLabel = match.name;
      }
    } catch {
      // Taxonomy lookup is optional; ignore if Etsy not connected
    }
  }

  return { parsed: normalized, raw: json, visionImagesUsed, autoTaxonomyId, autoTaxonomyLabel };
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

async function etsyApiFetch(url, { method = 'GET', headers = {}, body, storeKey } = {}) {
  const accessToken = await getValidEtsyAccessToken(storeKey);
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
    console.error(`Etsy API error (${resp.status}):`, JSON.stringify(json));
    const err = new Error(`Etsy API request failed (${resp.status})`);
    err.status = resp.status;
    err.details = json;
    throw err;
  }
  return json;
}

function flattenTaxonomyNodes(nodes) {
  const out = [];
  for (const n of (nodes || [])) {
    const isLeaf = !n.children || n.children.length === 0;
    out.push({ id: n.id, name: n.name, isLeaf });
    if (n.children && n.children.length) out.push(...flattenTaxonomyNodes(n.children));
  }
  return out;
}

async function fetchFlatTaxonomyNodes(storeKey) {
  const now = Date.now();
  if (taxonomyNodesCache && now - taxonomyNodesCachedAt < TAXONOMY_CACHE_TTL_MS) {
    return taxonomyNodesCache;
  }
  const resp = await etsyApiFetch(
    'https://api.etsy.com/v3/application/seller-taxonomy/nodes',
    { storeKey }
  );
  taxonomyNodesCache = flattenTaxonomyNodes(resp.results || []);
  taxonomyNodesCachedAt = now;
  return taxonomyNodesCache;
}

function bestTaxonomyMatch(nodes, hint) {
  if (!hint || !nodes.length) return null;
  const normalized = String(hint).toLowerCase().replace(/[^\w\s]/g, ' ').trim();
  const words = normalized.split(/\s+/).filter((w) => w.length > 2);
  if (!words.length) return null;

  let best = null;
  let bestScore = -1;

  for (const node of nodes) {
    const name = node.name.toLowerCase();
    let score = 0;
    for (const word of words) {
      if (name.includes(word)) score += word.length;
    }
    if (name === normalized) score += 100;
    if (node.isLeaf) score += 3;
    if (score > bestScore) {
      bestScore = score;
      best = node;
    }
  }

  return bestScore > 3 ? best : null;
}

function coercePriceString(priceInput) {
  // Etsy docs examples often show form-encoded "price" as string; some shops interpret whole/decimal based on endpoint.
  // We preserve user-entered numeric string and only normalize commas/whitespace.
  const raw = String(priceInput ?? '').trim();
  if (!raw) return '';
  return raw.replace(/\$/g, '').replace(/,/g, '');
}

function buildEtsyDraftBody({ intake, generated, cfg }) {
  const activeStore = getStoreByKeyFromConfig(cfg, cfg.etsy?.activeStoreKey);
  const d = cfg.etsy?.defaults || activeStore.defaults || {};
  const params = new URLSearchParams();
  const rawTitle = generated?.title || intake.type || 'Vintage item';
  const title = cleanTitleForEtsy(rawTitle);
  const description = normalizeMultilineText(generated?.description || '') || 'Used item. See photos and item details.';
  const quantity = String(intake.quantity || d.quantity || 1);
  const price = coercePriceString(intake.price);
  if (!price) throw new Error('Price is required before creating Etsy draft.');

  const shippingProfileId = String(intake.shippingProfileId || '').trim() || String(d.shipping_profile_id || '').trim();
  const when_made = String(intake.whenMade || d.when_made || '').trim();
  const readiness_state_id = String(intake.readinessStateId || d.readiness_state_id || '').trim();
  const taxonomy_id = String(intake.taxonomyId || d.taxonomy_id || '').trim();

  const requiredMap = {
    quantity,
    title,
    description,
    price,
    who_made: d.who_made || 'someone_else',
    when_made,
    taxonomy_id,
    shipping_profile_id: shippingProfileId,
    readiness_state_id,
  };

  for (const [k, v] of Object.entries(requiredMap)) {
    if (v == null || String(v).trim() === '') {
      throw new Error(`Missing Etsy required field: ${k}.`);
    }
    params.append(k, String(v));
  }

  params.append('state', 'draft');
  params.append('is_supply', String(Boolean(d.is_supply)));

  if (generated?.etsy_materials?.length) {
    params.append('materials', generated.etsy_materials.slice(0, 13).join(','));
  }
  const tags = normalizeTagsForEtsy(generated?.tags, intake);
  if (tags.length) {
    params.append('tags', tags.slice(0, 13).join(','));
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

async function uploadEtsyListingImage({ shopId, listingId, fullImagePath, rank, storeKey }) {
  const form = new FormData();
  const buf = await fsp.readFile(fullImagePath);
  const mime = guessMime(fullImagePath);
  const filename = path.basename(fullImagePath);
  form.append('image', new Blob([buf], { type: mime }), filename);
  if (Number.isFinite(rank)) form.append('rank', String(rank));

  return etsyApiFetch(`https://api.etsy.com/v3/application/shops/${shopId}/listings/${listingId}/images`, {
    method: 'POST',
    body: form,
    storeKey
  });
}

function missingRequiredEnvKeys() {
  const required = ['ANTHROPIC_API_KEY', 'ETSY_CLIENT_ID', 'ETSY_X_API_KEY', 'ETSY_REDIRECT_URI'];
  return required.filter((k) => !String(process.env[k] || '').trim());
}

function envFilePathHint() {
  if (process.env.ENV_FILE_PATH) return process.env.ENV_FILE_PATH;
  return path.join(path.dirname(DATA_DIR), '.env');
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    time: safeNowIso(),
    appVersion: APP_VERSION,
    missingEnvKeys: missingRequiredEnvKeys(),
    dataDir: DATA_DIR,
    envFile: envFilePathHint()
  });
});

app.get('/api/support-info', (_req, res) => {
  try {
    const cfg = getConfig();
    const stores = (cfg.etsy?.stores || []).map((s) => {
      const tokens = loadTokens(s.key) || {};
      const userIdHint = extractEtsyUserIdFromTokens(tokens);
      const d = s.defaults || {};
      return {
        key: s.key,
        label: s.label,
        shopId: s.shopId || null,
        lastFolder: s.lastFolder || null,
        connected: Boolean(tokens.access_token),
        tokenExpiresAt: tokens.expires_at || null,
        scopes: tokens.scope || tokens.scopes || null,
        userIdHint,
        defaults: {
          quantity: d.quantity ?? null,
          who_made: d.who_made || null,
          when_made: d.when_made || null,
          taxonomy_id: d.taxonomy_id || null,
          shipping_profile_id: d.shipping_profile_id || null,
          readiness_state_id: d.readiness_state_id || null,
        }
      };
    });

    let syncFolderStatus = null;
    try {
      const root = resolveSyncFolder(cfg);
      const stats = fs.existsSync(root) && fs.statSync(root).isDirectory();
      syncFolderStatus = { resolved: root, exists: stats, error: null };
    } catch (err) {
      syncFolderStatus = { resolved: null, exists: false, error: err.message };
    }

    const fileChecks = {
      configFile: { path: CONFIG_FILE, exists: fs.existsSync(CONFIG_FILE) },
      tokensFile: { path: TOKENS_FILE, exists: fs.existsSync(TOKENS_FILE) },
      envFile: { path: envFilePathHint(), exists: fs.existsSync(envFilePathHint()) },
      itemsFile: { path: ITEMS_FILE, exists: fs.existsSync(ITEMS_FILE) },
      thumbCacheDir: { path: THUMB_CACHE_DIR, exists: fs.existsSync(THUMB_CACHE_DIR) }
    };

    res.json({
      ok: true,
      time: safeNowIso(),
      app: {
        name: 'Etsy Draft Listing Assistant',
        version: APP_VERSION,
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        electronVersion: process.versions.electron || null,
        startedAt: SERVER_STARTED_AT
      },
      env: {
        missingEnvKeys: missingRequiredEnvKeys(),
        dataDir: DATA_DIR,
        envFile: envFilePathHint(),
        port: PORT,
        appBaseUrl: process.env.APP_BASE_URL || null,
        etsyRedirectUri: process.env.ETSY_REDIRECT_URI || null,
        claudeModel: process.env.CLAUDE_MODEL || null
      },
      config: {
        syncFolder: cfg.syncFolder || null,
        syncFolderStatus,
        listingPolicyTextLength: (cfg.listingPolicyText || '').length,
        activeStoreKey: cfg.etsy?.activeStoreKey || null,
        claudeModel: cfg.claude?.model || null,
        claudeIncludeImages: cfg.claude?.includeImagesInPrompt !== false,
        claudeMaxImages: cfg.claude?.maxImagesForVision || null
      },
      files: fileChecks,
      stores
    });
  } catch (err) {
    errorResponse(res, 500, err.message);
  }
});

app.get('/api/config', (_req, res) => {
  res.json({ ok: true, config: sanitizeForClientConfig(getConfig()) });
});

app.post('/api/config', (req, res) => {
  try {
    const current = getConfig();
    const incoming = req.body?.config;
    if (!incoming || typeof incoming !== 'object') return errorResponse(res, 400, 'Invalid config payload');
    const incomingEtsy = incoming.etsy && typeof incoming.etsy === 'object' ? incoming.etsy : {};
    const next = {
      ...current,
      ...incoming,
      claude: { ...current.claude, ...(incoming.claude || {}) },
      etsy: {
        activeStoreKey: incomingEtsy.activeStoreKey || current.etsy.activeStoreKey,
        stores: Array.isArray(incomingEtsy.stores) ? incomingEtsy.stores : current.etsy.stores
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
            previewUrl: `/api/photo-thumb?relPath=${encodeURIComponent(relPath)}&size=220`
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
        previewUrl: `/api/photo-thumb?relPath=${encodeURIComponent(relPath)}&size=220`
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
    res.set('Cache-Control', 'private, max-age=300');
    res.sendFile(full, (err) => {
      if (!err || res.headersSent) return;
      if (err.code === 'ENOENT') return errorResponse(res, 404, 'File not found');
      return errorResponse(res, 500, 'Failed to read image file');
    });
  } catch (err) {
    errorResponse(res, 400, err.message);
  }
});

app.get('/api/photo-thumb', async (req, res) => {
  try {
    const relPath = String(req.query.relPath || '');
    if (!relPath) return errorResponse(res, 400, 'relPath is required');
    const thumbSize = parseThumbSize(req.query.size);
    const root = resolveSyncFolder(getConfig());
    const full = safeResolveUnder(root, relPath);

    let st;
    try {
      st = await fsp.stat(full);
    } catch {
      return errorResponse(res, 404, 'File not found');
    }
    if (!st.isFile()) return errorResponse(res, 404, 'File not found');

    try {
      const thumbFile = await generateOrGetThumbnail({ fullPath: full, stat: st, thumbSize });
      res.type('image/webp');
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      return res.sendFile(thumbFile, (err) => {
        if (!err || res.headersSent) return;
        return errorResponse(res, 500, 'Failed to read thumbnail file');
      });
    } catch {
      // If thumbnailing is unavailable (e.g. sharp missing), fall back to original file.
      res.set('Cache-Control', 'private, max-age=300');
      return res.sendFile(full, (err) => {
        if (!err || res.headersSent) return;
        if (err.code === 'ENOENT') return errorResponse(res, 404, 'File not found');
        return errorResponse(res, 500, 'Failed to read image file');
      });
    }
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
    const includeImages = Boolean(req.body?.includeImagesInAi ?? cfg.claude.includeImagesInPrompt);
    const activeStore = getStoreByKeyFromConfig(cfg, cfg.etsy?.activeStoreKey);

    // validate image paths first
    for (const rel of selectedImages) safeResolveUnder(root, rel);

    const { parsed, raw, visionImagesUsed, autoTaxonomyId, autoTaxonomyLabel } = await callClaudeForListing({
      intake,
      selectedImages,
      includeImages,
      cfg,
      rootDir: root,
      storeKey: activeStore.key
    });

    const record = recordItem({
      id: crypto.randomUUID(),
      createdAt: safeNowIso(),
      status: 'generated',
      intake,
      selectedImages,
      generated: parsed,
      meta: {
        claudeModel: cfg.claude.model,
        includeImagesInAi: includeImages,
        aiImageCount: visionImagesUsed,
        claudeId: raw.id || null
      }
    });

    res.json({ ok: true, generated: parsed, itemId: record.id, aiImageCount: visionImagesUsed, autoTaxonomyId: autoTaxonomyId || null, autoTaxonomyLabel: autoTaxonomyLabel || null });
  } catch (err) {
    errorResponse(res, err.status || 500, err.message, { claudeErrorType: err.claudeErrorType || null, ...(err.details || {}) });
  }
});

app.get('/api/items', (_req, res) => {
  const items = loadItems();
  res.json({ ok: true, items: items.slice(0, 100) });
});

app.get('/api/etsy/shipping-profiles', async (req, res) => {
  try {
    const cfg = getConfig();
    const storeKey = String(req.query.storeKey || '').trim() || cfg.etsy?.activeStoreKey;
    const store = getStoreByKeyFromConfig(cfg, storeKey);
    if (!store.shopId) return errorResponse(res, 400, 'Shop ID is not set for this store. Add it in Settings first.');

    const resp = await etsyApiFetch(
      `https://api.etsy.com/v3/application/shops/${store.shopId}/shipping-profiles`,
      { storeKey: store.key }
    );

    const profiles = (resp.results || []).map((p) => ({
      id: p.shipping_profile_id,
      title: p.title
    }));

    res.json({ ok: true, profiles });
  } catch (err) {
    errorResponse(res, err.status || 500, err.message, err.details || null);
  }
});

app.get('/api/etsy/taxonomy-search', async (req, res) => {
  try {
    const cfg = getConfig();
    const storeKey = String(req.query.storeKey || '').trim() || cfg.etsy?.activeStoreKey;
    const store = getStoreByKeyFromConfig(cfg, storeKey);
    const q = String(req.query.q || '').trim().toLowerCase();
    if (!q) return errorResponse(res, 400, 'q parameter is required');

    const all = await fetchFlatTaxonomyNodes(store.key);
    const matches = all
      .filter((n) => n.name.toLowerCase().includes(q))
      .sort((a, b) => {
        // Leaf nodes (most specific) first — Etsy typically wants leaf taxonomy IDs.
        if (a.isLeaf !== b.isLeaf) return a.isLeaf ? -1 : 1;
        const aExact = a.name.toLowerCase() === q;
        const bExact = b.name.toLowerCase() === q;
        if (aExact !== bExact) return aExact ? -1 : 1;
        const aStarts = a.name.toLowerCase().startsWith(q);
        const bStarts = b.name.toLowerCase().startsWith(q);
        if (aStarts !== bStarts) return aStarts ? -1 : 1;
        return a.name.length - b.name.length;
      })
      .slice(0, 20);
    res.json({ ok: true, matches });
  } catch (err) {
    errorResponse(res, err.status || 500, err.message, err.details || null);
  }
});

function prefetchTaxonomyInBackground(storeKey) {
  if (!storeKey) return;
  fetchFlatTaxonomyNodes(storeKey).catch((err) => {
    console.warn(`Taxonomy prefetch failed for ${storeKey}:`, err.message);
  });
}

app.get('/api/etsy/readiness-states', async (req, res) => {
  try {
    const cfg = getConfig();
    const storeKey = String(req.query.storeKey || '').trim() || cfg.etsy?.activeStoreKey;
    const store = getStoreByKeyFromConfig(cfg, storeKey);
    if (!store.shopId) return errorResponse(res, 400, 'Shop ID is not set for this store. Add it in Settings first.');

    const resp = await etsyApiFetch(
      `https://api.etsy.com/v3/application/shops/${store.shopId}/readiness-state-definitions`,
      { storeKey: store.key }
    );

    const states = (resp.results || []).map((p) => ({
      id: p.readiness_state_id,
      label: p.readiness_state === 'ready_to_ship'
        ? `Ready to ship — ${p.processing_days_display_label}`
        : `Made to order — ${p.processing_days_display_label}`,
      readiness_state: p.readiness_state
    }));

    res.json({ ok: true, states });
  } catch (err) {
    errorResponse(res, err.status || 500, err.message, err.details || null);
  }
});

app.post('/api/etsy/refresh-shop-info', async (req, res) => {
  try {
    const cfg = getConfig();
    const storeKey = String(req.body?.storeKey || '').trim() || cfg.etsy?.activeStoreKey;
    const store = getStoreByKeyFromConfig(cfg, storeKey);
    if (!store) return errorResponse(res, 404, `Unknown storeKey: ${storeKey}`);

    const accessToken = await getValidEtsyAccessToken(store.key);
    const tokens = loadTokens(store.key) || {};
    const userId = extractEtsyUserIdFromTokens(tokens);
    if (!userId) {
      return errorResponse(res, 400, 'Could not derive Etsy user_id from saved tokens. Try disconnecting and reconnecting.');
    }

    const shopInfo = await fetchEtsyShopInfo({ accessToken, userId });
    if (!shopInfo || !shopInfo.shopId) {
      return errorResponse(res, 502, 'Etsy returned no shop info for this user. Make sure your Etsy account has an active shop.');
    }

    applyShopInfoToStore(store.key, shopInfo);
    prefetchTaxonomyInBackground(store.key);
    res.json({ ok: true, shopInfo, config: sanitizeForClientConfig(getConfig()) });
  } catch (err) {
    errorResponse(res, err.status || 500, err.message, err.details || null);
  }
});

app.post('/api/etsy/disconnect', (req, res) => {
  try {
    const storeKey = String(req.body?.storeKey || '').trim();
    if (!storeKey) return errorResponse(res, 400, 'storeKey is required');

    const cfg = getConfig();
    const target = (cfg.etsy?.stores || []).find((s) => s.key === storeKey);
    if (!target) return errorResponse(res, 404, `Unknown storeKey: ${storeKey}`);

    // Clear tokens for this store.
    const allTokens = loadTokens();
    if (allTokens[storeKey]) {
      delete allTokens[storeKey];
      writeJson(TOKENS_FILE, allTokens);
    }

    // Reset Etsy-derived fields; keep lastFolder so reconnecting picks up where we left off.
    const fallbackIndex = STORE_KEYS.indexOf(storeKey);
    const fallbackLabel = `Store ${(fallbackIndex >= 0 ? fallbackIndex : 0) + 1}`;
    const stores = (cfg.etsy?.stores || []).map((s) => {
      if (s.key !== storeKey) return s;
      return {
        key: s.key,
        label: fallbackLabel,
        shopId: '',
        lastFolder: s.lastFolder || '',
        defaults: defaultEtsyListingDefaults()
      };
    });

    const saved = saveConfig({
      ...cfg,
      etsy: { ...cfg.etsy, stores }
    });

    res.json({ ok: true, config: sanitizeForClientConfig(saved) });
  } catch (err) {
    errorResponse(res, 500, err.message);
  }
});

app.get('/api/etsy/status', (_req, res) => {
  try {
    const cfg = getConfig();
    const requestedStoreKey = String(_req.query.storeKey || '').trim() || cfg.etsy?.activeStoreKey;
    const store = getStoreByKeyFromConfig(cfg, requestedStoreKey);
    const t = loadTokens(store.key);
    res.json({
      ok: true,
      connected: Boolean(t?.access_token),
      tokenExpiresAt: t?.expires_at || null,
      scopes: t?.scope || t?.scopes || null,
      userIdHint: extractEtsyUserIdFromTokens(t),
      storeKey: store.key,
      storeLabel: store.label,
      shopId: store.shopId || null,
      activeStoreKey: cfg.etsy?.activeStoreKey || store.key
    });
  } catch (err) {
    errorResponse(res, 500, err.message);
  }
});

app.get('/auth/etsy/start', (_req, res) => {
  try {
    const cfg = getConfig();
    const requestedStoreKey = String(_req.query.storeKey || '').trim() || cfg.etsy?.activeStoreKey;
    const store = getStoreByKeyFromConfig(cfg, requestedStoreKey);
    const state = crypto.randomBytes(18).toString('hex');
    const { verifier, challenge } = createPkcePair();
    const pending = {
      state,
      verifier,
      storeKey: store.key,
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

function extractEtsyUserIdFromTokens(tokens) {
  if (!tokens) return null;
  // Etsy occasionally returns a separate user_id field; try that first.
  const explicit = String(tokens.user_id || '').split('.')[0];
  if (explicit) return explicit;
  // Otherwise extract from the access_token, which is formatted as <user_id>.<secret>.
  const fromToken = String(tokens.access_token || '').split('.')[0];
  return fromToken || null;
}

async function fetchEtsyShopInfo({ accessToken, userId }) {
  if (!userId) return null;
  const resp = await fetch(`https://api.etsy.com/v3/application/users/${encodeURIComponent(userId)}/shops`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'x-api-key': xApiKeyHeaderValue()
    }
  });
  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch { return null; }
  if (!resp.ok) {
    console.warn(`Etsy shop info fetch failed (${resp.status}):`, text.slice(0, 200));
    return null;
  }
  // Endpoint may return a flat shop object or a wrapper with results[].
  const shop = Array.isArray(json?.results) ? json.results[0] : json;
  if (!shop) return null;
  return {
    shopId: shop.shop_id != null ? String(shop.shop_id) : '',
    shopName: shop.shop_name ? String(shop.shop_name) : ''
  };
}

function applyShopInfoToStore(storeKey, shopInfo) {
  if (!shopInfo || !shopInfo.shopId) return;
  const cfg = getConfig();
  const stores = (cfg.etsy?.stores || []).map((s) => {
    if (s.key !== storeKey) return s;
    return {
      ...s,
      shopId: shopInfo.shopId,
      label: shopInfo.shopName || s.label
    };
  });
  saveConfig({
    ...cfg,
    etsy: {
      ...cfg.etsy,
      stores
    }
  });
}

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
    const cfg = getConfig();
    const store = getStoreByKeyFromConfig(cfg, pending.storeKey || cfg.etsy?.activeStoreKey);
    saveTokens(store.key, toSave);
    if (fs.existsSync(OAUTH_PENDING_FILE)) fs.unlinkSync(OAUTH_PENDING_FILE);

    // Etsy returns access tokens formatted as "<numeric_user_id>.<random>" and may or may not
    // include a separate user_id field. Try both.
    const userId = extractEtsyUserIdFromTokens(toSave);
    let shopInfo = null;
    try {
      shopInfo = await fetchEtsyShopInfo({ accessToken: token.access_token, userId });
      if (shopInfo) applyShopInfoToStore(store.key, shopInfo);
    } catch (shopErr) {
      console.warn('Could not auto-populate shop info:', shopErr.message);
    }
    // Warm the taxonomy cache in the background so the user's first category search is instant.
    prefetchTaxonomyInBackground(store.key);

    const finalStore = getStoreByKeyFromConfig(getConfig(), store.key);
    const displayName = finalStore.label || store.label || store.key;
    const shopIdLine = finalStore.shopId
      ? `<p>Shop ID detected: <code>${escapeHtml(finalStore.shopId)}</code></p>`
      : '<p>(Shop ID could not be auto-detected; check the Activity log if drafts fail.)</p>';

    res.send(`<!doctype html><html><body style="font-family: system-ui; padding: 24px;">
      <h2>Etsy connected successfully</h2>
      <p>Connected store: <strong>${escapeHtml(displayName)}</strong></p>
      ${shopIdLine}
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
    const activeStore = getStoreByKeyFromConfig(cfg, cfg.etsy?.activeStoreKey);
    const shopId = String(activeStore?.shopId || '').trim();
    if (!shopId) return errorResponse(res, 400, 'Etsy shopId is required in Settings');

    const intake = req.body?.intake || {};
    const generated = req.body?.generated || {};
    const selectedImages = Array.isArray(req.body?.selectedImages) ? req.body.selectedImages : [];
    if (!selectedImages.length) return errorResponse(res, 400, 'No images selected');

    const createCfg = {
      ...cfg,
      etsy: {
        ...cfg.etsy,
        defaults: activeStore.defaults || {}
      }
    };

    const createBody = buildEtsyDraftBody({ intake, generated, cfg: createCfg });
    const createResp = await etsyApiFetch(`https://api.etsy.com/v3/application/shops/${shopId}/listings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: createBody,
      storeKey: activeStore.key
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
      const resp = await uploadEtsyListingImage({
        shopId,
        listingId,
        fullImagePath: full,
        rank,
        storeKey: activeStore.key
      });
      uploadResults.push({ relPath, rank, response: resp });
      rank += 1;
    }

    const etsyRecord = {
      listingId,
      storeKey: activeStore.key,
      storeLabel: activeStore.label,
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

const ready = new Promise((resolve, reject) => {
  const server = app.listen(PORT, () => {
    console.log(`Etsy Draft Listing App running at ${appBaseUrl()}`);
    const missing = missingRequiredEnvKeys();
    if (missing.length) {
      console.warn(`Missing required env keys: ${missing.join(', ')}. Edit your .env file to enable full functionality.`);
    }
    resolve({ server, port: PORT });
  });
  server.on('error', (err) => {
    console.error(`Failed to start server on port ${PORT}:`, err.message);
    reject(err);
  });
});

module.exports = { ready, app };

