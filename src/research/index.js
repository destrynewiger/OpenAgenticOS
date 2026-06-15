// Research orchestrator. Runs the adapters for an account, writes clean,
// sourced artifacts to the DB, logs every step to the audit_log, recomputes the
// score, and refreshes the next-best-action. Honest by default: unknown stays
// unknown, gaps become explicit "missing_data" signals + tasks.
import * as db from '../models.js';
import { getConfig } from '../config.js';
import { classifyAndAddContact, rescoreAccount, detailView, missingResearch } from '../service.js';
import { researchAccount as sumbleResearch } from './sumble.js';
import { researchWeb } from './web.js';
import { generateAllForAccount } from '../callnotes.js';
import { generateProviderAccountBrief } from '../providers/accountBrief.js';

const WEB_SIGNAL_KINDS = ['outage', 'new_to_role', 'infra_scaling', 'ai_initiative', 'eval', 'filing_quote'];

function logResearch(event, payload = {}) {
  const safe = { ...payload };
  delete safe.key;
  delete safe.apiKey;
  console.log(`[research] ${event} ${JSON.stringify(safe)}`);
}

export async function runResearch(accountId, { cfg = getConfig(), withCallNotes = true, withAccountBrief = true, fetchFn } = {}) {
  const account = db.getAccount(accountId);
  if (!account) throw new Error('account not found');
  logResearch('research started', { account_id: accountId, account_name: account.name, domain: account.domain || account.website || '' });
  db.audit({ account_id: accountId, action: 'research_start', source: 'system', query: account.domain || account.name, result: 'begin', confidence: 100 });

  // ---- 1. Sumble: incident stack + team landscape ----
  try {
    const s = await sumbleResearch({ name: account.name, domain: account.domain, cfg });
    db.clearTech(accountId);
    for (const t of s.tech || []) db.addTech(accountId, { ...t, source: s.source, confidence: 70 });
    if (s.incidentStack && !account.incident_stack) db.updateAccount(accountId, { incident_stack: s.incidentStack });
    db.clearSignals(accountId, 'incident_stack');
    if ((s.tech || []).length || s.incidentStack) {
      db.addSignal(accountId, { kind: 'incident_stack', label: 'Incident stack detected', detail: s.incidentStack || (s.tech || []).map((t) => t.tool).join(', '), source: s.source, confidence: 70 });
    }
    let added = 0;
    for (const c of s.contacts || []) { classifyAndAddContact(accountId, { ...c, source: c.source || s.source }); added++; }
    db.audit({ account_id: accountId, action: 'sumble_research', source: s.source, result: `${(s.tech || []).length} tools, ${added} contacts — ${s.note}`, confidence: 70 });
  } catch (e) {
    db.audit({ account_id: accountId, action: 'sumble_research', source: 'sumble', result: 'failed', error: e.message });
  }

  // ---- 2. Web: customer status, status page, initiatives, quotes ----
  try {
    const w = await researchWeb({ name: account.name, domain: account.domain, cfg });
    const fresh = db.getAccount(accountId);

    const patch = {};
    if (fresh.rootly_customer === 'unknown' && w.rootlyCustomer && w.rootlyCustomer !== 'unknown') patch.rootly_customer = w.rootlyCustomer;
    if (fresh.pagerduty_customer === 'unknown' && w.pagerDutyCustomer && w.pagerDutyCustomer !== 'unknown') patch.pagerduty_customer = w.pagerDutyCustomer;
    if (w.pagerDutyCustomer === 'yes') {
      db.clearSignals(accountId, 'pagerduty_detected');
      db.addSignal(accountId, { kind: 'pagerduty_detected', label: 'PagerDuty in use', detail: 'Detected via research', source: w.source, confidence: 70 });
    }
    if ((w.tech || []).length) {
      for (const t of w.tech) db.addTech(accountId, { ...t, source: t.source || w.source, confidence: t.confidence || 65 });
      if (!fresh.incident_stack) patch.incident_stack = [...new Set((w.tech || []).map((t) => t.tool).filter(Boolean))].join(', ');
    }

    if ((w.tech || []).length) {
      const existingTools = new Set(db.listTech(accountId).map((t) => String(t.tool || '').toLowerCase()));
      const tools = [];
      for (const t of w.tech || []) {
        if (!t.tool || existingTools.has(String(t.tool).toLowerCase())) continue;
        existingTools.add(String(t.tool).toLowerCase());
        tools.push(t.tool);
        db.addTech(accountId, { ...t, source: t.source || w.source, confidence: t.confidence ?? 70 });
      }
      if (tools.length && !fresh.incident_stack) patch.incident_stack = tools.join(', ');
      if (tools.length) {
        db.clearSignals(accountId, 'incident_stack');
        db.addSignal(accountId, { kind: 'incident_stack', label: 'Incident stack detected', detail: tools.join(', '), source: w.source, confidence: 70 });
      }
    }

    if (w.statusPage && w.statusPage.url) {
      db.setStatusPage(accountId, { url: w.statusPage.url, provider: w.statusPage.provider, last_incident: w.statusPage.lastIncident || '', source: w.source });
      if (!fresh.status_page_url) { patch.status_page_url = w.statusPage.url; patch.status_page_provider = w.statusPage.provider; }
      db.clearSignals(accountId, 'status_page');
      db.addSignal(accountId, { kind: 'status_page', label: 'Public status page found', detail: `${w.statusPage.url} (${w.statusPage.provider}${w.statusPage.verified ? '' : ', unverified'})`, source: w.source, url: w.statusPage.url, confidence: w.statusPage.verified ? 85 : 60 });
      if (w.statusPage.hasActiveIncident) {
        db.addSignal(accountId, { kind: 'outage', label: 'Active incident on status page', detail: w.statusPage.lastIncident || '', source: w.source, url: w.statusPage.url, confidence: 80 });
      }
    }
    if (Object.keys(patch).length) db.updateAccount(accountId, patch);

    // Replace web-derived signal kinds, then add fresh ones.
    for (const k of WEB_SIGNAL_KINDS) db.clearSignals(accountId, k);
    for (const s of w.signals || []) db.addSignal(accountId, { kind: s.kind, label: s.label, detail: s.detail || '', source: s.source || w.source, url: s.url || '', confidence: s.confidence ?? 60 });

    db.clearQuotes(accountId);
    for (const q of w.quotes || []) {
      db.addQuote(accountId, q);
      db.addSignal(accountId, { kind: 'filing_quote', label: `Public quote: ${q.source_name}`, detail: q.quote.slice(0, 120), source: w.source, url: q.url || '', confidence: 60 });
    }

    db.audit({ account_id: accountId, action: 'web_research', source: w.source, result: `rootly=${w.rootlyCustomer}, pd=${w.pagerDutyCustomer}, ${(w.signals || []).length} signals, ${(w.quotes || []).length} quotes — ${w.note}`, confidence: 65 });
  } catch (e) {
    db.audit({ account_id: accountId, action: 'web_research', source: 'web', result: 'failed', error: e.message });
  }

  // ---- 3. Make gaps explicit ----
  const bundle = db.getAccountBundle(accountId);
  const gaps = missingResearch(bundle);
  db.clearSignals(accountId, 'missing_data');
  const openMissingTitles = [];
  for (const g of gaps) {
    db.addSignal(accountId, { kind: 'missing_data', label: g, source: 'system', confidence: 100 });
    const title = `Resolve: ${g}`;
    openMissingTitles.push(title);
    db.addTask(accountId, title, 'missing_data');
  }
  const closedMissingTasks = db.completeMissingTasksNotIn(accountId, openMissingTitles);

  // ---- 4. Score + next action ----
  const scored = rescoreAccount(accountId);

  // ---- 5. Call prep cards (one template card per mapped contact) ----
  if (withCallNotes) {
    try { generateAllForAccount(accountId); }
    catch (e) { db.audit({ account_id: accountId, action: 'generate_call_notes', source: 'system', result: 'failed', error: e.message }); }
  }

  if (withAccountBrief) {
    try {
      await generateProviderAccountBrief(accountId, { cfg, fetchFn });
    } catch (e) {
      logResearch('research save failed', { account_id: accountId, account_name: account.name, error: e.message });
      db.audit({ account_id: accountId, action: 'account_research_saved', source: 'providers', result: 'failed', error: e.message });
    }
  }

  db.audit({ account_id: accountId, action: 'research_done', source: 'system', result: `score ${scored.score} (${scored.band}); gaps: ${gaps.length}; stale gaps closed: ${closedMissingTasks}`, confidence: 100 });
  logResearch('research completed', { account_id: accountId, account_name: account.name, score: scored.score, band: scored.band });
  return detailView(accountId);
}

export async function runResearchBatch(accountIds, opts = {}) {
  const ids = accountIds && accountIds.length ? accountIds : db.listAccounts().map((a) => a.id);
  const results = [];
  for (const id of ids) {
    try { const d = await runResearch(id, opts); results.push({ id, ok: true, score: d.account.score, band: d.account.band }); }
    catch (e) { results.push({ id, ok: false, error: e.message }); }
  }
  return { count: results.length, results };
}
