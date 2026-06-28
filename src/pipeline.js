// Full-auto GTM pipeline. Chains the existing stages end-to-end with NO human in
// the loop: source → research → score → personalized opener → export/queue → send.
// Everything reuses code that already works; this file is just the glue + the gate.
//
// Safety model (matches the rest of this app): sending is OFF unless BOTH
//   - ENABLE_AMPLEMARKET_PUSH=true  (cfg.flags.amplemarketPush), and
//   - --send is passed with a --sequence <id>
// Otherwise the run is a dry-run: it produces scored leads, LLM openers, the
// Amplemarket CSV, and a LinkedIn hand-off file — but sends nothing. Eyeball the
// first batch, then flip the flag to go live.
import fs from 'node:fs';
import path from 'node:path';
import * as db from './models.js';
import { getConfig, EXPORT_DIR } from './config.js';
import { runResearch } from './research/index.js';
import { generateAndSave } from './callnotes.js';
import { writeExport } from './exporter.js';
import { BANDS } from './scoring.js';
import { searchPeopleByIcp, addLeadToSequence } from './providers/amplemarket.js';
import { getProviderKey } from './providers/keyStore.js';

const TOP_BANDS = new Set(['work_today', 'sequence_week']);

export async function runPipeline(opts = {}) {
  const cfg = opts.cfg || getConfig();
  const limit = Number(opts.limit) || 25;
  const log = (m) => console.log(`[pipeline] ${m}`);
  const summary = { sourced: 0, researched: 0, openers: 0, inflight: 0, reviewFile: '', exportFile: '', linkedinFile: '', sent: 0, queued: 0, sendErrors: [], mode: 'dry-run' };

  // ---- 1. SOURCE (optional net-new from one ICP search) ----
  let targetIds = (opts.accountIds && opts.accountIds.length) ? [...opts.accountIds] : [];
  if (opts.icp) {
    const key = getProviderKey('amplemarket', cfg);
    if (!key) throw new Error('no Amplemarket key — set it in the dashboard or AMPLEMARKET_API_KEY');
    log(`sourcing ICP: ${JSON.stringify(opts.icp)}`);
    const people = await searchPeopleByIcp(opts.icp, key);
    for (const p of people.slice(0, limit)) {
      if (!p.company_name && !p.company_domain) continue;
      const { account } = db.upsertAccount({ name: p.company_name || p.company_domain, domain: p.company_domain, website: p.company_domain ? `https://${p.company_domain}` : '' });
      db.upsertContact(account.id, { name: p.name, title: p.title, email: p.email, phone: p.phone, linkedin: p.linkedin, location: p.location || '', source: 'amplemarket-icp', confidence: 55 });
      if (!targetIds.includes(account.id)) targetIds.push(account.id);
    }
    summary.sourced = people.length;
    log(`sourced ${people.length} people → ${targetIds.length} accounts`);
  }

  // No explicit targets and no source → operate on existing workable accounts.
  if (!targetIds.length) {
    targetIds = db.listAccounts().filter((a) => !a.do_not_contact && a.band !== 'blocked').map((a) => a.id).slice(0, limit);
  }

  // ---- 2 + 3. RESEARCH + SCORE (research recomputes the score) ----
  for (const id of targetIds) {
    try { await runResearch(id, { cfg }); summary.researched++; }
    catch (e) { log(`research failed for ${id}: ${e.message}`); }
  }

  // ---- pick the workable top band, freshly scored, with a reachable contact ----
  const candidates = targetIds
    .map((id) => db.getAccount(id))
    .filter((a) => a && TOP_BANDS.has(a.band) && !a.do_not_contact)
    .filter((a) => db.listContacts(a.id).some((c) => c.email || c.linkedin));

  // ---- COLLABORATION GUARD: never touch an account you're already working ----
  // Split into fresh (safe to add to a new sequence) and in-flight (already in an
  // Amplemarket sequence / already contacted / already worked) — the latter are
  // left alone and surfaced for review, never re-sequenced.
  const top = [], inflight = [];
  for (const a of candidates) {
    const reason = inFlightReason(a);
    if (reason) inflight.push({ account: a.name, score: a.score, reason }); else top.push(a);
  }
  summary.inflight = inflight.length;
  if (inflight.length) {
    summary.reviewFile = writeJson('review_in_flight', inflight);
    log(`${inflight.length} already in flight → left alone (review_in_flight)`);
  }
  log(`${top.length} fresh top-band accounts (of ${candidates.length} workable)`);

  // ---- 4. PERSONALIZED OPENER (only for fresh accounts we'd actually sequence) ----
  for (const a of top) {
    try { await generateAndSave(a.id, { useLlm: true, cfg }); summary.openers++; }
    catch (e) { log(`opener failed for ${a.name}: ${e.message}`); }
  }

  if (!top.length) { log('nothing fresh to work this run.'); printSummary(summary); return summary; }

  // ---- 5. EXPORT (Amplemarket-ready CSV — always produced) ----
  const export_ = writeExport('amplemarket', top.map((a) => a.id));
  summary.exportFile = export_.file;
  log(`exported ${export_.count} rows → ${path.basename(export_.file)}`);

  // ---- 6. LINKEDIN HAND-OFF (file the Luey runner consumes; never sent from here) ----
  summary.linkedinFile = writeLinkedinQueue(top);
  if (summary.linkedinFile) log(`linkedin queue → ${path.basename(summary.linkedinFile)}`);

  // ---- 7. SEND (gated; default dry-run; fresh-only by construction) ----
  const pushOn = cfg.flags.amplemarketPush;
  if (opts.send && pushOn && opts.sequenceId) {
    summary.mode = 'LIVE';
    const key = getProviderKey('amplemarket', cfg);
    for (const a of top) {
      const lead = db.listContacts(a.id).find((c) => c.email);
      if (!lead) { summary.queued++; continue; }
      const note = db.listCallNotes(a.id)[0] || {};
      try {
        await addLeadToSequence({ sequenceId: opts.sequenceId, person: { ...lead, company_name: a.name }, fields: { personalization: note.opening_line || '' } }, key);
        summary.sent++;
        db.audit({ account_id: a.id, action: 'amplemarket_send', source: 'pipeline', result: `added ${lead.email} to seq ${opts.sequenceId}`, confidence: 100 });
      } catch (e) { summary.sendErrors.push(`${a.name}: ${e.message}`); }
    }
    log(`LIVE: sent ${summary.sent}, errors ${summary.sendErrors.length}`);
  } else {
    summary.queued = top.length;
    const why = !opts.send ? 'no --send' : !pushOn ? 'ENABLE_AMPLEMARKET_PUSH=false' : 'no --sequence';
    log(`dry-run (${why}): ${summary.queued} leads queued, nothing sent`);
  }

  printSummary(summary);
  return summary;
}

// Is this account already in your active outreach? If so, leave it alone.
// Hard skips + the real in-flight signal (research writes kind 'amplemarket_activity'
// when a contact has a last_contacted date or live sequence activity).
const ACTIVE_RE = /last_contacted=(?!unknown|$)|recent_activity=(?!unknown|$)|sequence/i;
export function inFlightReason(a) {
  if (a.do_not_contact) return 'do_not_contact';
  if (a.status === 'already_worked') return 'already_worked';
  if (a.rootly_customer === 'yes' || a.band === 'blocked') return 'customer/blocked';
  const active = db.listSignals(a.id).find(
    (s) => (s.kind === 'amplemarket_activity' || s.kind === 'apollo_presence' || s.kind === 'amplemarket_presence')
      && ACTIVE_RE.test(`${s.label} ${s.detail}`),
  );
  return active ? 'active in Amplemarket' : '';
}

function writeJson(prefix, rows) {
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  const file = path.join(EXPORT_DIR, `${prefix}_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(rows, null, 2));
  return file;
}

function writeLinkedinQueue(accounts) {
  const rows = [];
  for (const a of accounts) {
    const c = db.listContacts(a.id).find((x) => x.linkedin);
    if (!c) continue;
    const note = db.listCallNotes(a.id)[0] || {};
    rows.push({ account: a.name, name: c.name, title: c.title, linkedin: c.linkedin, score: a.score, band: a.band, opener: note.opening_line || '', why_now: a.next_action || '' });
  }
  if (!rows.length) return '';
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  const file = path.join(EXPORT_DIR, `linkedin_queue_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(rows, null, 2));
  return file;
}

function printSummary(s) {
  console.log('\n=== pipeline summary ===');
  console.log(`  mode:        ${s.mode}`);
  console.log(`  sourced:     ${s.sourced} people`);
  console.log(`  researched:  ${s.researched} accounts`);
  console.log(`  in-flight:   ${s.inflight} (left alone${s.reviewFile ? ' → ' + path.basename(s.reviewFile) : ''})`);
  console.log(`  openers:     ${s.openers}`);
  console.log(`  export:      ${s.exportFile ? path.basename(s.exportFile) : '—'}`);
  console.log(`  linkedin:    ${s.linkedinFile ? path.basename(s.linkedinFile) : '—'}`);
  console.log(`  sent:        ${s.sent}   queued: ${s.queued}`);
  if (s.sendErrors.length) console.log(`  send errors: ${s.sendErrors.join(' | ')}`);
  console.log('');
}
