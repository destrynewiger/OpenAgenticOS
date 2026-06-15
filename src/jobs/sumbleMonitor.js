// Scheduled provider monitor. Refreshes stale /
// new watchlist accounts via the existing provider research (enrichment +
// people + rescore + brief), diffs newly-detected incident tooling into a
// signal, ensures every callable contact has a deterministic call card, then
// rebuilds the dial-ready queue and syncs the Google Sheet.
//
// Run: `npm run monitor`  (or `node --experimental-sqlite src/jobs/sumbleMonitor.js`)
import { pathToFileURL } from 'node:url';
import { getConfig } from '../config.js';
import { connect } from '../db.js';
import * as db from '../models.js';
import { getProviderKey } from '../providers/keyStore.js';
import { generateProviderAccountBrief } from '../providers/accountBrief.js';
import { generateAllForAccount } from '../callnotes.js';
import { accountResearchStatus } from '../service.js';
import { buildQueue } from '../callQueue.js';
import { syncDialSheet } from '../integrations/googleSheet.js';

const num = (v, d) => (v === undefined || v === '' || isNaN(Number(v)) ? d : Number(v));
const INCIDENT_TOOL_RE = /pagerduty|opsgenie|victorops|incident|statuspage|status page|datadog|grafana|new relic|splunk|servicenow/;

function watchlistDomains() {
  return String(process.env.WATCHLIST_DOMAINS || '').split(',').map((s) => s.trim()).filter(Boolean);
}
function incidentTools(accountId) {
  return new Set(db.listTech(accountId).map((t) => String(t.tool || '').toLowerCase()).filter(Boolean));
}

export async function runMonitor({ cfg = getConfig(), limit = num(process.env.MONITOR_MAX_ACCOUNTS, 25) } = {}) {
  const now = new Date();
  const sumbleKey = getProviderKey('sumble', cfg);
  db.audit({ action: 'sumble_monitor_start', source: 'sumble', result: sumbleKey ? 'sumble key present' : 'no sumble key (fallback research)', confidence: 100 });

  // 1. Ensure watchlist domains exist as accounts.
  let created = 0;
  const existingByDomain = new Set(db.listAccounts().map((a) => a.domain).filter(Boolean));
  for (const domain of watchlistDomains()) {
    if (!existingByDomain.has(db.normalizeDomain(domain))) { db.createAccount({ name: domain, website: domain }); created++; }
  }

  // 2. Refresh stale / never-researched workable accounts, capped.
  const candidates = db.listAccounts()
    .filter((a) => a.rootly_customer !== 'yes' && !a.do_not_contact && a.status !== 'already_worked')
    .filter((a) => accountResearchStatus(db.getAccountBundle(a.id), { now }).needsResearch)
    .slice(0, limit);

  let researched = 0, briefs = 0, newSignals = 0;
  for (const a of candidates) {
    const before = incidentTools(a.id);
    try {
      await generateProviderAccountBrief(a.id, { cfg }); // enrich + people + brief + rescore
      briefs++;
    } catch (e) {
      db.audit({ account_id: a.id, action: 'sumble_monitor_enrich_failed', source: 'sumble', error: e.message });
      continue;
    }
    // Genuine diff: incident tools newly detected since last run → one signal.
    const fresh = [...incidentTools(a.id)].filter((t) => !before.has(t) && INCIDENT_TOOL_RE.test(t));
    if (fresh.length && !db.hasSignal(a.id, 'incident_stack')) {
      db.addSignal(a.id, { kind: 'incident_stack', label: 'Incident tooling detected', detail: `Sumble: ${fresh.join(', ')}`, source: 'sumble', confidence: 80 });
      newSignals++;
    }
    generateAllForAccount(a.id); // deterministic call-card floor for cockpit/sheet
    researched++;
  }

  // 3. Rebuild the dial queue and sync the sheet.
  const queue = buildQueue();
  let sheet;
  try { sheet = await syncDialSheet({ cfg }); }
  catch (e) { sheet = { error: e.message }; }

  const summary = { created, researched, briefs, newSignals, queued: queue.queued, accounts: queue.accounts, sheet };
  db.audit({ action: 'sumble_monitor_done', source: 'sumble', result: JSON.stringify(summary), confidence: 100 });
  return summary;
}

// CLI entry.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  connect();
  runMonitor()
    .then((s) => { console.log('[sumble-monitor]', JSON.stringify(s, null, 2)); process.exit(0); })
    .catch((e) => { console.error('[sumble-monitor] failed:', e); process.exit(1); });
}
