import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from '../config.js';
import { googleAdcStatus, hasGoogleAdcConfig } from './googleAuth.js';

const KEY_FILE = process.env.PROVIDER_KEYS_FILE || path.join(DATA_DIR, 'provider-keys.json');
const PROVIDERS = new Set(['sumble', 'commonRoom', 'gemini', 'amplemarket', 'apollo']);

const ENV_KEYS = {
  sumble: (cfg) => cfg.sumble?.apiKey || '',
  commonRoom: (cfg) => cfg.commonRoom?.apiKey || '',
  gemini: (cfg) => cfg.llm?.geminiKey || cfg.llm?.googleKey || '',
  amplemarket: (cfg) => cfg.amplemarketKey || '',
  apollo: (cfg) => cfg.apolloKey || '',
};

function readStore() {
  try {
    if (!fs.existsSync(KEY_FILE)) return {};
    return JSON.parse(fs.readFileSync(KEY_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

function writeStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(KEY_FILE, JSON.stringify(store, null, 2));
  try { fs.chmodSync(KEY_FILE, 0o600); } catch {}
}

export function providerNames() { return [...PROVIDERS]; }

export function getProviderKey(provider, cfg = getConfig()) {
  if (!PROVIDERS.has(provider)) return '';
  const stored = readStore()[provider]?.key || '';
  return stored || ENV_KEYS[provider]?.(cfg) || '';
}

export function saveProviderKey(provider, key) {
  if (!PROVIDERS.has(provider)) throw new Error('unknown provider');
  const store = readStore();
  const clean = String(key || '').trim();
  if (!clean) delete store[provider];
  else store[provider] = { ...(store[provider] || {}), key: clean, saved_at: new Date().toISOString() };
  writeStore(store);
  return providerStatus(provider);
}

export function saveProviderTest(provider, test) {
  if (!PROVIDERS.has(provider)) throw new Error('unknown provider');
  const store = readStore();
  store[provider] = { ...(store[provider] || {}), last_test: sanitizeTest(test) };
  writeStore(store);
  return providerStatus(provider);
}

function sanitizeTest(test = {}) {
  const status = ['connected', 'missing'].includes(test.status) ? test.status : 'error';
  return {
    status,
    message: String(test.message || '').slice(0, 240),
    checked_at: new Date().toISOString(),
  };
}

export function providerStatus(provider, cfg = getConfig()) {
  if (!PROVIDERS.has(provider)) throw new Error('unknown provider');
  const row = readStore()[provider] || {};
  const hasDashboardKey = !!row.key;
  const hasEnvKey = !!ENV_KEYS[provider]?.(cfg);
  if (provider === 'gemini' && !hasDashboardKey && !hasEnvKey && hasGoogleAdcConfig(cfg)) {
    const adc = googleAdcStatus(cfg);
    const last = row.last_test || null;
    if (last?.status === 'connected') return { provider, status: 'connected', source: 'google-adc', message: last.message || 'Connected via Google ADC', checked_at: last.checked_at || '' };
    if (last?.status === 'missing') return { provider, status: 'missing', source: 'google-adc', message: last.message || adc.message, checked_at: last.checked_at || '' };
    if (last?.status === 'error') return { provider, status: 'error', source: 'google-adc', message: last.message || 'Last ADC test failed', checked_at: last.checked_at || '' };
    return { provider, ...adc };
  }
  if (!hasDashboardKey && !hasEnvKey) {
    if (provider === 'gemini') return { provider, ...googleAdcStatus(cfg) };
    return { provider, status: 'missing', source: 'none', message: 'No key saved' };
  }
  const source = hasDashboardKey ? 'dashboard' : 'env';
  const last = row.last_test || null;
  if (last?.status === 'connected') return { provider, status: 'connected', source, message: last.message || 'Connected', checked_at: last.checked_at || '' };
  if (last?.status === 'missing') return { provider, status: 'missing', source, message: last.message || 'Credential missing', checked_at: last.checked_at || '' };
  if (last?.status === 'error') return { provider, status: 'error', source, message: last.message || 'Last test failed', checked_at: last.checked_at || '' };
  return { provider, status: 'missing', source, message: 'Key present; not tested yet' };
}

export function allProviderStatuses(cfg = getConfig()) {
  return providerNames().map((p) => providerStatus(p, cfg));
}
