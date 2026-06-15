// Sumble adapter — incident stack + team landscape.
//
// Design: a single async interface researchAccount({name, domain}) that returns
// a normalized shape. Real Sumble access likely needs browser automation or an
// API; that path is intentionally a STUB (no hardcoded creds — reads
// SUMBLE_EMAIL / SUMBLE_PASSWORD from env via config). Today it resolves from
// local fixtures so the dashboard is fully usable offline. Hermes can later
// implement `liveLookup` behind the same interface without touching callers.
import { getConfig } from '../config.js';
import { fixtureFor } from './fixtures.js';

// Returns { source, incidentStack, tech: [...], contacts: [...], note }
export async function researchAccount({ name, domain, cfg = getConfig() } = {}) {
  const fx = fixtureFor(domain);

  if (cfg.flags.browserResearch && cfg.sumble.email) {
    try {
      const live = await liveLookup({ name, domain, cfg });
      if (live) return { source: 'sumble', ...live, note: 'live Sumble lookup' };
    } catch (e) {
      // fall through to fixture/empty; caller audits the error
      return fallback(fx, `Sumble live lookup failed: ${e.message}`);
    }
  }
  return fallback(fx, cfg.flags.browserResearch ? 'Sumble creds missing — using local data' : 'browser research disabled — using local data');
}

function fallback(fx, note) {
  if (!fx) return { source: 'fixture', incidentStack: '', tech: [], contacts: [], note: 'no Sumble data found — needs research' };
  return {
    source: 'fixture',
    incidentStack: fx.incident_stack || '',
    tech: fx.tech || [],
    contacts: fx.contacts || [],
    note,
  };
}

// STUB. Wire real Sumble here (browser automation or API). Must use
// cfg.sumble.email / cfg.sumble.password (already env-driven). Never hardcode.
async function liveLookup({ name, domain, cfg }) {
  throw new Error('liveLookup not implemented — set ENABLE_BROWSER_RESEARCH and implement sumble.liveLookup');
}
