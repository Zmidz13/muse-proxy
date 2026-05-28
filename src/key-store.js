const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const STORE_DIR = process.env.MUSE_HOME || path.join(os.homedir(), '.musespark');
const STORE_FILE = path.join(STORE_DIR, 'keys.json');

function ensureStore() {
  if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
  if (!fs.existsSync(STORE_FILE)) {
    fs.writeFileSync(STORE_FILE, JSON.stringify({ keys: [] }, null, 2), 'utf8');
  }
}

function readStore() {
  ensureStore();
  try {
    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.keys)) return { keys: [] };
    return parsed;
  } catch {
    return { keys: [] };
  }
}

function writeStore(store) {
  ensureStore();
  fs.writeFileSync(STORE_FILE, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

function hashKey(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex');
}

function createKey(name = 'default') {
  const store = readStore();
  const id = crypto.randomUUID().slice(0, 12);
  const secret = crypto.randomBytes(24).toString('base64url');
  const apiKey = `muse_${secret}`;
  const rec = {
    id,
    name,
    prefix: apiKey.slice(0, 12),
    hash: hashKey(apiKey),
    createdAt: new Date().toISOString(),
    lastUsedAt: null
  };
  store.keys.push(rec);
  writeStore(store);
  return { apiKey, record: rec };
}

function listKeys() {
  return readStore().keys.map((k) => ({
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    createdAt: k.createdAt,
    lastUsedAt: k.lastUsedAt
  }));
}

function deleteKey(idOrPrefix) {
  const store = readStore();
  const before = store.keys.length;
  store.keys = store.keys.filter((k) => k.id !== idOrPrefix && k.prefix !== idOrPrefix);
  const removed = before - store.keys.length;
  if (removed > 0) writeStore(store);
  return removed;
}

function validateApiKey(rawApiKey) {
  const store = readStore();
  if (!store.keys.length) return { ok: false, reason: 'no_keys' };
  const hashed = hashKey(rawApiKey);
  const found = store.keys.find((k) => k.hash === hashed);
  if (!found) return { ok: false, reason: 'invalid' };
  return { ok: true, key: found };
}

function touchKeyUsage(keyId) {
  const store = readStore();
  const key = store.keys.find((k) => k.id === keyId);
  if (!key) return;
  key.lastUsedAt = new Date().toISOString();
  writeStore(store);
}

function getStoreFilePath() {
  return STORE_FILE;
}

module.exports = {
  createKey,
  listKeys,
  deleteKey,
  validateApiKey,
  touchKeyUsage,
  getStoreFilePath
};
