import * as db from './models.js';
import { getConfig } from './config.js';
import { getProviderKey } from './providers/keyStore.js';
import { searchAccountByDomain as searchApollo, updateAccountNotes as updateApollo } from './providers/apollo.js';
import { searchAccountByDomain as searchAmplemarket, updateAccountNotes as updateAmplemarket } from './providers/amplemarket.js';
import { syncBriefToApolloBrowser, syncBriefToAmplemarketBrowser } from './providers/browserSync.js';

function formatBriefNote(brief, account) {
  const lines = [
    `Account Brief — ${account.name} (${new Date().toISOString().slice(0, 10)})`,
    '',
    `Overview: ${brief.company_overview || 'n/a'}`,
    `Why care: ${brief.why_care || 'n/a'}`,
    `Outbound angle: ${brief.outbound_angle || 'n/a'}`,
    `Call prep: ${brief.call_prep_notes || 'n/a'}`,
    `Stack: ${brief.incident_stack || 'n/a'}`,
  ];
  const signals = (brief.recent_signals || []).slice(0, 6).map((s) => `  • ${s.label}${s.detail ? ': ' + s.detail : ''}`);
  if (signals.length) lines.push('', 'Recent signals:', ...signals);
  return lines.join('\n');
}

function lastSyncAudit(accountId, provider) {
  const rows = db.listAudit(accountId, 10).filter((a) => a.action === `sync_brief_to_${provider}`);
  return rows[0] || null;
}

export async function syncBriefToCrm(accountId, { cfg = getConfig(), brief = null, fetchFn = fetch, method = 'api' } = {}) {
  const account = db.getAccount(accountId);
  if (!account) throw new Error('account not found');
  const b = brief || db.getAccountBundle(accountId)?.latestAccountBrief;
  if (!b) throw new Error('no account brief to sync');

  const note = formatBriefNote(b, account);
  const domain = account.domain || account.website;
  const results = { apollo: null, amplemarket: null };

  // Apollo
  if (cfg.flags.apolloPush) {
    try {
      const key = getProviderKey('apollo', cfg);
      if (!key && method === 'api') throw new Error('Apollo key missing');

      const last = lastSyncAudit(accountId, 'apollo');
      if (last && last.result === note.slice(0, 200)) {
        results.apollo = { ok: true, idempotent: true, provider: 'apollo', message: 'Already synced (audit match)' };
      } else if (method === 'browser' || !key) {
        // Browser automation fallback when API key is missing or method is browser
        const apolloId = account.apollo_company_id || null;
        results.apollo = await syncBriefToApolloBrowser({ companyId: apolloId, domain, briefText: note });
        db.audit({ account_id: accountId, action: 'sync_brief_to_apollo', source: 'apollo', result: results.apollo.ok ? 'browser-ok' : 'browser-failed', error: results.apollo.error || null, confidence: 100 });
      } else {
        const remote = await searchApollo(domain, key, { fetchFn });
        if (!remote?.id) throw new Error(`Apollo account not found for domain ${domain}`);
        const patch = await updateApollo(remote.id, note, key, { fetchFn });
        results.apollo = { ok: true, provider: 'apollo', apolloAccountId: remote.id, ...patch };
        db.audit({ account_id: accountId, action: 'sync_brief_to_apollo', source: 'apollo', result: note.slice(0, 200), confidence: 100 });
      }
    } catch (e) {
      results.apollo = { ok: false, provider: 'apollo', error: e.message };
      db.audit({ account_id: accountId, action: 'sync_brief_to_apollo', source: 'apollo', result: 'failed', error: e.message });
    }
  } else {
    results.apollo = { ok: false, dryRun: true, provider: 'apollo', message: 'ENABLE_APOLLO_PUSH=false — dry-run. Would send:\n' + note.slice(0, 600) };
    db.audit({ account_id: accountId, action: 'sync_brief_to_apollo', source: 'apollo', result: 'dry-run', confidence: 100 });
  }

  // Amplemarket
  if (cfg.flags.amplemarketPush) {
    try {
      const key = getProviderKey('amplemarket', cfg);
      if (!key && method === 'api') throw new Error('Amplemarket key missing');

      const last = lastSyncAudit(accountId, 'amplemarket');
      if (last && last.result === note.slice(0, 200)) {
        results.amplemarket = { ok: true, idempotent: true, provider: 'amplemarket', message: 'Already synced (audit match)' };
      } else if (method === 'browser' || !key) {
        // Browser automation fallback when API key is missing or method is browser
        const ampleId = account.amplemarket_company_id || null;
        results.amplemarket = await syncBriefToAmplemarketBrowser({ companyId: ampleId, domain, briefText: note });
        db.audit({ account_id: accountId, action: 'sync_brief_to_amplemarket', source: 'amplemarket', result: results.amplemarket.ok ? 'browser-ok' : 'browser-failed', error: results.amplemarket.error || null, confidence: 100 });
      } else {
        const remote = await searchAmplemarket(domain, key, { fetchFn });
        if (!remote) throw new Error(`Amplemarket account not found for domain ${domain}`);
        const patch = await updateAmplemarket(remote.id, note, key, { fetchFn });
        results.amplemarket = { ok: patch.ok, dryRun: patch.dryRun, provider: 'amplemarket', ...patch };
        db.audit({ account_id: accountId, action: 'sync_brief_to_amplemarket', source: 'amplemarket', result: patch.ok ? 'ok' : (patch.dryRun ? 'dry-run' : 'failed'), error: patch.error || null, confidence: 100 });
      }
    } catch (e) {
      results.amplemarket = { ok: false, provider: 'amplemarket', error: e.message };
      db.audit({ account_id: accountId, action: 'sync_brief_to_amplemarket', source: 'amplemarket', result: 'failed', error: e.message });
    }
  } else {
    results.amplemarket = { ok: false, dryRun: true, provider: 'amplemarket', message: 'ENABLE_AMPLEMARKET_PUSH=false — dry-run. Would send:\n' + note.slice(0, 600) };
    db.audit({ account_id: accountId, action: 'sync_brief_to_amplemarket', source: 'amplemarket', result: 'dry-run', confidence: 100 });
  }

  return results;
}
