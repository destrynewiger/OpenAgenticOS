// CSV exports for Apollo (upload) and Amplemarket (sequencing). Pure row
// mappers (testable with plain objects) + assembly helpers that pull from the DB.
import { stringifyCsv } from './csv.js';
import * as db from './models.js';
import { BANDS } from './scoring.js';
import fs from 'node:fs';
import path from 'node:path';
import { EXPORT_DIR } from './config.js';

function splitName(name) {
  const parts = String(name || '').trim().split(/\s+/);
  if (parts.length <= 1) return { first: parts[0] || '', last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

const SEQUENCE_REC = {
  work_today: 'Call + same-day personalized email (high priority)',
  sequence_week: 'Multi-touch sequence this week (call → email → LinkedIn)',
  research_more: 'Light nurture — finish research before heavy outreach',
  low: 'Low priority — monitor for new signals',
  blocked: 'Do not sequence',
};

// ---- Apollo upload shape ----
export const APOLLO_HEADERS = [
  'company', 'website', 'first_name', 'last_name', 'title', 'email', 'phone',
  'linkedin', 'persona_level', 'priority_score', 'account_notes',
  'call_opener', 'sequence_recommendation', 'operator_disposition',
];

export function toApolloRows(leads) {
  return leads.map((l) => {
    const { first, last } = splitName(l.contact.name);
    return {
      company: l.account.name || '',
      website: l.account.website || '',
      first_name: first,
      last_name: last,
      title: l.contact.title || '',
      email: l.contact.email || '',
      phone: l.contact.phone || '',
      linkedin: l.contact.linkedin || '',
      persona_level: l.contact.persona_level || '',
      priority_score: l.account.score ?? '',
      account_notes: accountNotes(l.account),
      call_opener: (l.callNote && l.callNote.opening_line) || '',
      sequence_recommendation: SEQUENCE_REC[l.account.band] || '',
      operator_disposition: l.disposition || '',
    };
  });
}

// ---- Amplemarket sequencing shape ----
export const AMPLEMARKET_HEADERS = [
  'account', 'contact', 'email', 'phone', 'title', 'personalization',
  'pain_point', 'why_now', 'recommended_sequence', 'operator_disposition', 'source',
];

export function toAmplemarketRows(leads) {
  return leads.map((l) => ({
    account: l.account.name || '',
    contact: l.contact.name || '',
    email: l.contact.email || '',
    phone: l.contact.phone || '',
    title: l.contact.title || '',
    personalization: (l.callNote && l.callNote.opening_line) || '',
    pain_point: (l.callNote && l.callNote.likely_pain) || '',
    why_now: l.whyNow || '',
    recommended_sequence: SEQUENCE_REC[l.account.band] || '',
    operator_disposition: l.disposition || '',
    source: l.contact.source || '',
  }));
}

function accountNotes(a) {
  const bits = [];
  if (a.incident_stack) bits.push(`Stack: ${a.incident_stack}`);
  if (a.pagerduty_customer === 'yes') bits.push('PagerDuty detected');
  if (a.notes) bits.push(a.notes);
  bits.push(`Priority: ${BANDS[a.band]?.label || a.band} (${a.score})`);
  return bits.join(' | ');
}

// ---- assembly from the DB ----
// One row per (account, contact). If an account has no contacts, it is skipped
// (you sequence people, not logos) but reported back.
export function assembleLeads(accountIds) {
  const ids = accountIds && accountIds.length ? accountIds : db.listAccounts().map((a) => a.id);
  const leads = [];
  const skipped = [];
  for (const id of ids) {
    const account = db.getAccount(id);
    if (!account) continue;
    const contacts = db.listContacts(id);
    if (!contacts.length) { skipped.push(account.name); continue; }
    const notes = db.listCallNotes(id);
    const signals = db.listSignals(id);
    const whyNow = bestWhyNow(account, signals);
    const disposition = sequenceDisposition(account, signals);
    for (const contact of contacts) {
      const callNote = notes.find((n) => n.contact_id === contact.id) || notes.find((n) => !n.contact_id) || null;
      leads.push({ account, contact, callNote, whyNow, disposition });
    }
  }
  return { leads, skipped };
}

// Pick the most compelling "why now" line from signals (sourced only).
export function bestWhyNow(account, signals) {
  const priority = [
    'outage', 'new_to_role', 'infra_scaling', 'ai_initiative', 'eval', 'filing_quote',
    'pagerduty_detected', 'warm_account', 'source_work_today', 'source_priority',
    'historical_booked_meeting', 'prior_thread_ready_task', 'sf_warm_task',
    'sales_accepted', 'call_ready', 'apollo_presence', 'amplemarket_presence',
  ];
  for (const kind of priority) {
    const s = signals.find((x) => x.kind === kind);
    if (s) return s.label + (s.detail ? ` — ${s.detail}` : '');
  }
  if (account.pagerduty_customer === 'yes') return 'Running PagerDuty today — displacement opportunity';
  return '';
}

export function sequenceDisposition(account, signals) {
  if (account.rootly_customer === 'yes') return 'skip: confirmed customer';
  const activeTool = signals.find((s) =>
    (s.kind === 'amplemarket_activity' || s.kind === 'apollo_presence' || s.kind === 'amplemarket_presence') &&
    /active|sequence|last.?contact|removed from/i.test(`${s.label} ${s.detail}`));
  if (activeTool) return 'call today; review active sequence before adding to another sequence';
  if (account.status === 'ready_to_sequence') return 'sequence-ready; export ok';
  if (account.status === 'ready_to_call') return 'call-first; export for review only';
  return 'research before sequencing';
}

export function buildApolloCsv(accountIds) {
  const { leads, skipped } = assembleLeads(accountIds);
  return { csv: stringifyCsv(toApolloRows(leads), APOLLO_HEADERS), count: leads.length, skipped, leads };
}
export function buildAmplemarketCsv(accountIds) {
  const { leads, skipped } = assembleLeads(accountIds);
  return { csv: stringifyCsv(toAmplemarketRows(leads), AMPLEMARKET_HEADERS), count: leads.length, skipped, leads };
}

// Write a CSV to data/exports and log it in sequence_exports + audit.
export function writeExport(target, accountIds) {
  const built = target === 'apollo' ? buildApolloCsv(accountIds) : buildAmplemarketCsv(accountIds);
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(EXPORT_DIR, `${target}_${stamp}.csv`);
  fs.writeFileSync(file, built.csv);
  const ids = accountIds && accountIds.length ? accountIds : db.listAccounts().map((a) => a.id);
  const accounts = new Set(ids).size;
  const exportRow = db.recordExport(target, file, accounts - built.skipped.length, built.count,
    built.skipped.length ? `skipped (no contacts): ${built.skipped.join(', ')}` : '');
  const counts = new Map();
  for (const lead of built.leads || []) {
    counts.set(lead.account.id, (counts.get(lead.account.id) || 0) + 1);
  }
  for (const [accountId, contactCount] of counts) {
    db.recordAccountExport(exportRow.id, accountId, target, contactCount);
    db.audit({ account_id: accountId, action: `exported_to_${target}`, source: target, result: `${contactCount} contact rows`, confidence: 100 });
  }
  db.audit({ action: `export_${target}`, source: target, result: `${built.count} rows → ${path.basename(file)}`, confidence: 100 });
  const { leads, ...rest } = built;
  return { ...rest, file };
}
