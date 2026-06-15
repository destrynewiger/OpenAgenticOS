import * as db from '../models.js';
import { classifyAndAddContact, rescoreAccount } from '../service.js';
import { getConfig } from '../config.js';
import { getProviderKey } from './keyStore.js';
import { researchWithSumble } from './sumble.js';
import { researchWithCommonRoom } from './commonRoom.js';
import { summarizeWithGemini } from './gemini.js';
import { researchWithAmplemarket } from './amplemarket.js';

function logResearch(event, payload = {}) {
  const safe = { ...payload };
  delete safe.key;
  delete safe.apiKey;
  console.log(`[research] ${event} ${JSON.stringify(safe)}`);
}

function sentence(v, fallback = '') {
  return String(v || fallback).replace(/\s+/g, ' ').trim();
}

function providerStatus(result) {
  if (!result?.used) return { provider: result?.provider || 'unknown', status: 'missing', message: 'No key provided' };
  if (result.error) return { provider: result.provider, status: 'error', message: result.error };
  return { provider: result.provider, status: 'connected', message: 'Used in this brief' };
}

function sellerProduct(cfg = getConfig()) {
  const company = String(cfg.seller?.company || '').trim();
  return company && !/^your company$/i.test(company) ? company : 'your product';
}

function mergeBrief(account, bundle, results, geminiResult, cfg = getConfig()) {
  const seller = sellerProduct(cfg);
  const sumble = results.find((r) => r.provider === 'sumble');
  const common = results.find((r) => r.provider === 'commonRoom');
  const amplemarket = results.find((r) => r.provider === 'amplemarket');
  const gemini = geminiResult?.data || {};

  const people = [
    ...(sumble?.data?.people || []),
    ...(bundle.contacts || []).map((c) => ({
      name: c.name, title: c.title, linkedin: c.linkedin, email: c.email, source_url: '', source: c.source || 'dashboard',
    })),
    ...(common?.data?.members || []).map((m) => ({
      name: m.name, title: m.title, linkedin: '', email: '', source_url: m.url, source: 'commonRoom',
      activity: m.last_active || m.activities_count ? `activity=${m.activities_count || 'unknown'}, last=${m.last_active || 'unknown'}` : '',
    })),
    ...(amplemarket?.data?.people || []).map((p) => ({
      name: p.name, title: p.title, linkedin: p.linkedin, email: p.email, phone: p.phone, source_url: p.source_url, source: 'amplemarket',
      activity: p.last_contacted_at ? `last_contacted=${p.last_contacted_at}` : '',
    })),
  ].filter((p) => p.name).slice(0, 12);

  const stack = [
    ...(sumble?.data?.incident_stack || []),
    ...(bundle.tech || []).map((t) => t.tool),
    account.incident_stack || '',
  ].filter(Boolean);
  const uniqueStack = [...new Set(stack.map((s) => sentence(s)).filter(Boolean))];

  const recentSignals = [
    ...(bundle.signals || []).filter((s) => s.kind !== 'missing_data').slice(0, 8).map((s) => ({
      label: s.label, detail: s.detail || '', source: s.source || 'dashboard', url: s.url || '',
    })),
    ...(common?.data?.signals || []).map((s) => ({ ...s, source: 'commonRoom' })),
    ...(amplemarket?.data?.signals || []).map((s) => ({ ...s, source: 'amplemarket' })),
    ...(amplemarket?.data?.sequences || []).slice(0, 3).map((s) => ({
      label: `Amplemarket sequence available: ${s.name || s.id}`,
      detail: `status=${s.status || 'unknown'}${s.owner ? `; owner=${s.owner}` : ''}`,
      source: 'amplemarket',
      url: '',
    })),
  ].slice(0, 12);

  let sources = [
    ...(sumble?.data?.sources || []),
    ...(common?.data?.sources || []),
    ...(amplemarket?.data?.sources || []),
    ...(geminiResult?.used ? [{ provider: 'gemini', label: 'LLM summary', url: '' }] : []),
    ...(bundle.statusPage?.url ? [{ provider: bundle.statusPage.source || 'web', label: 'Status page', url: bundle.statusPage.url }] : []),
  ];
  if (!sources.length) sources = [{ provider: 'web', label: 'Built-in/public fallback research', url: '' }];

  const overview = sentence(
    gemini.company_overview,
    `${account.name} is in the GTM queue with priority ${account.score} (${account.band}). Current customer/prospect status is ${account.rootly_customer}; PagerDuty status is ${account.pagerduty_customer}.`,
  );
  const whyCare = sentence(
    gemini.why_care,
    uniqueStack.length
      ? `${account.name} may care about ${seller} because incident response spans ${uniqueStack.slice(0, 5).join(', ')} and needs verification against current workflow.`
      : `${account.name} may care about ${seller} if incident coordination, on-call load, stakeholder comms, or follow-up tracking are manual today. Incident stack still needs verification.`,
  );
  const outbound = sentence(
    gemini.outbound_angle,
    `Lead with a discovery-first angle: ask how ${account.name} coordinates work after an alert fires, then map escalation, comms, retros, and follow-up ownership.`,
  );
  const prep = sentence(
    gemini.call_prep_notes,
    `Do not assume customer status, PagerDuty usage, outage history, or stack. Verify these first, then decide call vs sequence.`,
  );

  return {
    company_overview: overview,
    incident_stack: uniqueStack.join(', ') || 'unknown',
    recent_signals: recentSignals,
    relevant_people: people,
    why_care: whyCare,
    outbound_angle: outbound,
    call_prep_notes: prep,
    sources,
    provider_status: [...results.map(providerStatus), providerStatus(geminiResult || { provider: 'gemini', used: false })],
    generated_by: geminiResult?.used && !geminiResult.error ? 'gemini+providers' : 'providers',
  };
}

export async function generateProviderAccountBrief(accountId, { cfg = getConfig(), fetchFn } = {}) {
  const bundle = db.getAccountBundle(accountId);
  if (!bundle) throw new Error('account not found');
  const account = bundle.account;
  const keys = {
    sumble: getProviderKey('sumble', cfg),
    commonRoom: getProviderKey('commonRoom', cfg),
    gemini: getProviderKey('gemini', cfg),
    amplemarket: getProviderKey('amplemarket', cfg),
  };
  const providersAvailable = Object.entries(keys).filter(([, key]) => !!key).map(([provider]) => provider);
  logResearch('providers available', {
    account_id: accountId,
    account_name: account.name,
    providers: providersAvailable.length ? providersAvailable : ['public-fallback'],
  });
  db.audit({
    account_id: accountId,
    action: 'research_providers_available',
    source: 'providers',
    result: providersAvailable.join(', ') || 'none — using built-in/public fallback',
    confidence: 100,
  });
  const results = [];
  results.push(await researchWithSumble(account, keys.sumble, { fetchFn }));
  results.push(await researchWithCommonRoom(account, bundle.contacts || [], keys.commonRoom, { fetchFn }));
  results.push(await researchWithAmplemarket(account, bundle.contacts || [], keys.amplemarket, { fetchFn }));
  const geminiResult = await summarizeWithGemini(keys.gemini, account, results, { fetchFn, cfg });
  for (const result of [...results, geminiResult]) {
    const provider = result?.provider || 'unknown';
    if (!result?.used) {
      logResearch('provider missing', { account_id: accountId, account_name: account.name, provider });
      db.audit({ account_id: accountId, action: 'research_provider_missing', source: provider, result: 'missing key', confidence: 100 });
    } else if (result.error) {
      logResearch('provider failure', { account_id: accountId, account_name: account.name, provider, error: result.error });
      db.audit({ account_id: accountId, action: 'research_provider_failure', source: provider, result: 'failed', error: result.error });
    } else {
      logResearch('provider success', { account_id: accountId, account_name: account.name, provider });
      db.audit({ account_id: accountId, action: 'research_provider_success', source: provider, result: 'ok', confidence: 80 });
    }
  }
  const brief = mergeBrief(account, bundle, results, geminiResult, cfg);

  const sumbleTech = results.find((r) => r.provider === 'sumble' && !r.error)?.data?.technologies || [];
  if (sumbleTech.length) {
    db.clearTech(accountId);
    for (const t of sumbleTech) {
      db.addTech(accountId, {
        tool: t.name,
        category: t.category || 'incident',
        source: 'sumble',
        confidence: t.confidence ?? 80,
      });
    }
  }
  if (results.find((r) => r.provider === 'sumble' && !r.error)?.data?.incident_stack?.length && !account.incident_stack) {
    db.updateAccount(accountId, { incident_stack: brief.incident_stack });
  }
  for (const p of results.find((r) => r.provider === 'sumble')?.data?.people || []) {
    classifyAndAddContact(accountId, {
      name: p.name, title: p.title, linkedin: p.linkedin, source: 'sumble', confidence: 78,
    });
  }
  for (const s of results.find((r) => r.provider === 'commonRoom')?.data?.signals || []) {
    db.addSignal(accountId, {
      kind: 'common_room_activity',
      label: s.label,
      detail: s.detail || '',
      source: 'commonRoom',
      url: s.url || '',
      confidence: 72,
    });
  }
  for (const p of results.find((r) => r.provider === 'amplemarket')?.data?.people || []) {
    classifyAndAddContact(accountId, {
      name: p.name, title: p.title, email: p.email, phone: p.phone, linkedin: p.linkedin,
      source: 'amplemarket', confidence: 82,
    });
  }
  for (const s of results.find((r) => r.provider === 'amplemarket')?.data?.signals || []) {
    db.addSignal(accountId, {
      kind: 'amplemarket_activity',
      label: s.label,
      detail: s.detail || '',
      source: 'amplemarket',
      url: s.url || '',
      confidence: 74,
    });
  }

  const saved = db.addAccountBrief(accountId, brief);
  rescoreAccount(accountId);
  logResearch('research saved', { account_id: accountId, account_name: account.name, account_brief_id: saved.id });
  db.audit({
    account_id: accountId,
    action: 'account_research_saved',
    source: 'providers',
    result: `account_brief ${saved.id}`,
    confidence: 100,
  });
  db.audit({
    account_id: accountId,
    action: 'generate_provider_account_brief',
    source: 'providers',
    result: saved.provider_status.map((s) => `${s.provider}:${s.status}`).join(', '),
    confidence: 80,
  });
  return saved;
}
