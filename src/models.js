// Data-access layer over the SQLite schema. Every dashboard read/write goes
// through here. Plain functions, positional ? params, rows hydrated to JS.
import { getDb, nowIso } from './db.js';

const run = (sql, args = []) => {
  const r = getDb().prepare(sql).run(...args);
  return { changes: Number(r.changes), id: Number(r.lastInsertRowid) };
};
const get = (sql, args = []) => getDb().prepare(sql).get(...args) || null;
const all = (sql, args = []) => getDb().prepare(sql).all(...args);

const CUSTOMER = (v) => {
  const s = String(v ?? '').trim().toLowerCase();
  if (['yes', 'y', 'true', '1', 'customer'].includes(s)) return 'yes';
  if (['no', 'n', 'false', '0', 'prospect'].includes(s)) return 'no';
  return 'unknown';
};

// Strip protocol/path → bare host, lowercased. "" if nothing usable.
export function normalizeDomain(input) {
  if (!input) return '';
  let s = String(input).trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '');
  s = s.split('/')[0].split('?')[0].split('#')[0];
  return s.includes('.') ? s : '';
}

function hydrateAccount(row) {
  if (!row) return null;
  return {
    ...row,
    do_not_contact: !!row.do_not_contact,
    score_reasons: row.score_reasons ? safeJson(row.score_reasons) : [],
  };
}
const safeJson = (s) => { try { return JSON.parse(s); } catch { return []; } };

// ---------------- accounts ----------------
export function createAccount(a) {
  const ts = nowIso();
  const domain = a.domain ? normalizeDomain(a.domain) : normalizeDomain(a.website);
  const { id } = run(
    `INSERT INTO accounts (name, domain, website, rootly_customer, pagerduty_customer,
       incident_stack, status_page_url, status_page_provider, notes, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      a.name, domain || null, a.website || '', CUSTOMER(a.rootly_customer),
      CUSTOMER(a.pagerduty_customer), a.incident_stack || '', a.status_page_url || '',
      a.status_page_provider || '', a.notes || '', ts, ts,
    ],
  );
  return getAccount(id);
}

// Insert or fill-in-blanks merge by domain (falls back to exact name).
// Never clobbers operator-set status / notes / do_not_contact.
export function upsertAccount(a) {
  const domain = a.domain ? normalizeDomain(a.domain) : normalizeDomain(a.website);
  let existing = null;
  if (domain) existing = get(`SELECT * FROM accounts WHERE domain = ?`, [domain]);
  if (!existing) existing = get(`SELECT * FROM accounts WHERE lower(name) = lower(?)`, [a.name]);
  if (!existing) return { account: createAccount(a), created: true };

  const patch = {};
  if (!existing.website && a.website) patch.website = a.website;
  if (!existing.domain && domain) patch.domain = domain;
  if (!existing.incident_stack && a.incident_stack) patch.incident_stack = a.incident_stack;
  if (!existing.status_page_url && a.status_page_url) patch.status_page_url = a.status_page_url;
  if (existing.rootly_customer === 'unknown' && a.rootly_customer) patch.rootly_customer = CUSTOMER(a.rootly_customer);
  if (existing.pagerduty_customer === 'unknown' && a.pagerduty_customer) patch.pagerduty_customer = CUSTOMER(a.pagerduty_customer);
  if (Object.keys(patch).length) updateAccount(existing.id, patch);
  return { account: getAccount(existing.id), created: false };
}

export function getAccount(id) {
  return hydrateAccount(get(`SELECT * FROM accounts WHERE id = ?`, [id]));
}

export function updateAccount(id, patch) {
  const cols = [];
  const args = [];
  const allowed = [
    'name', 'domain', 'website', 'rootly_customer', 'pagerduty_customer', 'incident_stack',
    'status_page_url', 'status_page_provider', 'score', 'band', 'status', 'do_not_contact',
    'next_action', 'score_reasons', 'notes',
  ];
  for (const k of allowed) {
    if (k in patch) {
      cols.push(`${k} = ?`);
      let v = patch[k];
      if (k === 'do_not_contact') v = v ? 1 : 0;
      if (k === 'score_reasons' && Array.isArray(v)) v = JSON.stringify(v);
      if (k === 'rootly_customer' || k === 'pagerduty_customer') v = CUSTOMER(v);
      args.push(v);
    }
  }
  if (!cols.length) return getAccount(id);
  cols.push(`updated_at = ?`);
  args.push(nowIso(), id);
  run(`UPDATE accounts SET ${cols.join(', ')} WHERE id = ?`, args);
  return getAccount(id);
}

export function deleteAccount(id) {
  return run(`DELETE FROM accounts WHERE id = ?`, [id]).changes;
}

export function listAccounts(filter = {}) {
  const where = [];
  const args = [];
  if (filter.band) { where.push(`a.band = ?`); args.push(filter.band); }
  if (filter.status) { where.push(`a.status = ?`); args.push(filter.status); }
  if (typeof filter.minScore === 'number') { where.push(`a.score >= ?`); args.push(filter.minScore); }
  if (filter.pagerduty) where.push(`a.pagerduty_customer = 'yes'`);
  if (filter.hasStatusPage) where.push(`a.status_page_url IS NOT NULL AND a.status_page_url <> ''`);
  if (filter.q) {
    where.push(`(lower(a.name) LIKE ? OR lower(a.domain) LIKE ? OR lower(a.incident_stack) LIKE ?)`);
    const q = `%${String(filter.q).toLowerCase()}%`;
    args.push(q, q, q);
  }
  if (filter.signalKind) {
    where.push(`EXISTS (SELECT 1 FROM signals s WHERE s.account_id = a.id AND s.kind = ?)`);
    args.push(filter.signalKind);
  }
  if (filter.tech) {
    where.push(`EXISTS (SELECT 1 FROM tech_stack t WHERE t.account_id = a.id AND lower(t.tool) LIKE ?)`);
    args.push(`%${String(filter.tech).toLowerCase()}%`);
  }
  if (filter.persona) {
    where.push(`EXISTS (SELECT 1 FROM contacts c WHERE c.account_id = a.id AND c.persona_level = ?)`);
    args.push(filter.persona);
  }
  const sql = `SELECT a.* FROM accounts a
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY a.score DESC, a.name ASC`;
  return all(sql, args).map(hydrateAccount);
}

// ---------------- contacts ----------------
export function addContact(accountId, c) {
  const ts = nowIso();
  const { id } = run(
    `INSERT INTO contacts (account_id, name, title, email, phone, linkedin,
       persona_level, persona_role, source, confidence, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [accountId, c.name || '', c.title || '', c.email || '', c.phone || '', c.linkedin || '',
     c.persona_level || '', c.persona_role || '', c.source || '', c.confidence ?? 50, ts, ts],
  );
  return getContact(id);
}
export function getContact(id) { return get(`SELECT * FROM contacts WHERE id = ?`, [id]); }
export function listContacts(accountId) {
  return all(`SELECT * FROM contacts WHERE account_id = ? ORDER BY confidence DESC, id ASC`, [accountId]);
}
export function listAllContacts() {
  return all(`SELECT c.*, a.name AS account_name, a.domain AS account_domain
              FROM contacts c JOIN accounts a ON a.id = c.account_id
              ORDER BY a.score DESC, c.confidence DESC`);
}
export function updateContact(id, patch) {
  const allowed = ['name', 'title', 'email', 'phone', 'linkedin', 'persona_level', 'persona_role', 'source', 'confidence'];
  const cols = [], args = [];
  for (const k of allowed) if (k in patch) { cols.push(`${k} = ?`); args.push(patch[k]); }
  if (!cols.length) return getContact(id);
  cols.push(`updated_at = ?`); args.push(nowIso(), id);
  run(`UPDATE contacts SET ${cols.join(', ')} WHERE id = ?`, args);
  return getContact(id);
}

// Dedupe-aware insert (by name+title within an account).
export function upsertContact(accountId, c) {
  const existing = get(
    `SELECT * FROM contacts WHERE account_id = ? AND lower(name) = lower(?) AND lower(title) = lower(?)`,
    [accountId, c.name || '', c.title || ''],
  );
  if (existing) {
    const patch = {};
    for (const f of ['email', 'phone', 'linkedin']) if (!existing[f] && c[f]) patch[f] = c[f];
    if (Object.keys(patch).length) return updateContact(existing.id, patch);
    return existing;
  }
  return addContact(accountId, c);
}

// ---------------- signals ----------------
export function addSignal(accountId, s) {
  const { id } = run(
    `INSERT INTO signals (account_id, kind, label, detail, source, url, confidence, detected_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [accountId, s.kind, s.label, s.detail || '', s.source || '', s.url || '', s.confidence ?? 50, nowIso()],
  );
  return get(`SELECT * FROM signals WHERE id = ?`, [id]);
}
export function listSignals(accountId) {
  return all(`SELECT * FROM signals WHERE account_id = ? ORDER BY detected_at DESC, id DESC`, [accountId]);
}
export function listRecentSignals(limit = 25) {
  return all(`SELECT s.*, a.name AS account_name FROM signals s
              JOIN accounts a ON a.id = s.account_id
              ORDER BY s.detected_at DESC, s.id DESC LIMIT ?`, [limit]);
}
export function hasSignal(accountId, kind) {
  return !!get(`SELECT 1 FROM signals WHERE account_id = ? AND kind = ? LIMIT 1`, [accountId, kind]);
}
export function listSignalsByKind(kind, limit = 30) {
  return all(`SELECT s.*, a.name AS account_name FROM signals s
              JOIN accounts a ON a.id = s.account_id
              WHERE s.kind = ? ORDER BY s.detected_at DESC, s.id DESC LIMIT ?`, [kind, limit]);
}
// Replace all signals of a kind for an account (used on re-research).
export function clearSignals(accountId, kind) {
  if (kind) return run(`DELETE FROM signals WHERE account_id = ? AND kind = ?`, [accountId, kind]).changes;
  return run(`DELETE FROM signals WHERE account_id = ?`, [accountId]).changes;
}

// ---------------- tech_stack ----------------
export function addTech(accountId, t) {
  const { id } = run(
    `INSERT INTO tech_stack (account_id, tool, category, source, confidence, created_at)
     VALUES (?,?,?,?,?,?)`,
    [accountId, t.tool, t.category || 'other', t.source || '', t.confidence ?? 50, nowIso()],
  );
  return get(`SELECT * FROM tech_stack WHERE id = ?`, [id]);
}
export function listTech(accountId) {
  return all(`SELECT * FROM tech_stack WHERE account_id = ? ORDER BY id ASC`, [accountId]);
}
export function clearTech(accountId) { return run(`DELETE FROM tech_stack WHERE account_id = ?`, [accountId]).changes; }

// ---------------- status_pages ----------------
export function setStatusPage(accountId, sp) {
  run(`DELETE FROM status_pages WHERE account_id = ?`, [accountId]);
  const { id } = run(
    `INSERT INTO status_pages (account_id, url, provider, last_incident, source, checked_at)
     VALUES (?,?,?,?,?,?)`,
    [accountId, sp.url || '', sp.provider || 'unknown', sp.last_incident || '', sp.source || '', nowIso()],
  );
  return get(`SELECT * FROM status_pages WHERE id = ?`, [id]);
}
export function getStatusPage(accountId) {
  return get(`SELECT * FROM status_pages WHERE account_id = ? ORDER BY id DESC LIMIT 1`, [accountId]);
}

// ---------------- research_quotes ----------------
export function addQuote(accountId, q) {
  const { id } = run(
    `INSERT INTO research_quotes (account_id, quote, source_name, source_date, url, interpretation, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    [accountId, q.quote, q.source_name || '', q.source_date || '', q.url || '', q.interpretation || '', nowIso()],
  );
  return get(`SELECT * FROM research_quotes WHERE id = ?`, [id]);
}
export function listQuotes(accountId) {
  return all(`SELECT * FROM research_quotes WHERE account_id = ? ORDER BY id DESC`, [accountId]);
}
export function clearQuotes(accountId) { return run(`DELETE FROM research_quotes WHERE account_id = ?`, [accountId]).changes; }

// ---------------- call_notes ----------------
export function addCallNote(accountId, contactId, note) {
  if (contactId) run(`DELETE FROM call_notes WHERE contact_id = ?`, [contactId]);
  const { id } = run(
    `INSERT INTO call_notes (account_id, contact_id, why_person, likely_pain, opening_line,
       rootly_angle, good_question, likely_objection, best_response, next_step, generated_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [accountId, contactId || null, note.why_person, note.likely_pain, note.opening_line,
     note.rootly_angle, note.good_question, note.likely_objection, note.best_response,
     note.next_step, note.generated_by || 'template', nowIso()],
  );
  return get(`SELECT * FROM call_notes WHERE id = ?`, [id]);
}
export function listCallNotes(accountId) {
  return all(`SELECT * FROM call_notes WHERE account_id = ? ORDER BY id DESC`, [accountId]);
}
export function clearCallNotes(accountId) { return run(`DELETE FROM call_notes WHERE account_id = ?`, [accountId]).changes; }

// ---------------- research_briefs ----------------
function hydrateResearchBrief(row) {
  if (!row) return null;
  return {
    ...row,
    questions_to_ask: row.questions_json ? safeJson(row.questions_json) : [],
    source_snapshot: row.source_snapshot ? safeJson(row.source_snapshot) : null,
  };
}
export function addResearchBrief(accountId, contactId, brief) {
  if (contactId) run(`DELETE FROM research_briefs WHERE contact_id = ?`, [contactId]);
  else run(`DELETE FROM research_briefs WHERE account_id = ? AND contact_id IS NULL`, [accountId]);
  const { id } = run(
    `INSERT INTO research_briefs (account_id, contact_id, likely_pain, questions_json, linkedin_touch,
       email_draft, prompt_version, generated_by, model, source_snapshot, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      accountId, contactId || null, brief.likely_pain || '',
      JSON.stringify(brief.questions_to_ask || []), brief.linkedin_touch || '',
      brief.email_draft || '', brief.prompt_version || 'research-brief-v1',
      brief.generated_by || 'template', brief.model || '',
      JSON.stringify(brief.source_snapshot || null), nowIso(),
    ],
  );
  return hydrateResearchBrief(get(`SELECT * FROM research_briefs WHERE id = ?`, [id]));
}
export function listResearchBriefs(accountId) {
  return all(`SELECT * FROM research_briefs WHERE account_id = ? ORDER BY id DESC`, [accountId]).map(hydrateResearchBrief);
}
export function latestResearchBrief(accountId, contactId) {
  const row = contactId
    ? get(`SELECT * FROM research_briefs WHERE account_id = ? AND contact_id = ? ORDER BY id DESC LIMIT 1`, [accountId, contactId])
    : get(`SELECT * FROM research_briefs WHERE account_id = ? ORDER BY id DESC LIMIT 1`, [accountId]);
  return hydrateResearchBrief(row);
}

// ---------------- account_briefs ----------------
function hydrateAccountBrief(row) {
  if (!row) return null;
  return {
    ...row,
    recent_signals: row.recent_signals_json ? safeJson(row.recent_signals_json) : [],
    relevant_people: row.people_json ? safeJson(row.people_json) : [],
    sources: row.sources_json ? safeJson(row.sources_json) : [],
    provider_status: row.provider_status_json ? safeJson(row.provider_status_json) : [],
  };
}
export function addAccountBrief(accountId, brief) {
  run(`DELETE FROM account_briefs WHERE account_id = ?`, [accountId]);
  const { id } = run(
    `INSERT INTO account_briefs (account_id, company_overview, incident_stack, recent_signals_json,
       people_json, why_care, outbound_angle, call_prep_notes, sources_json, provider_status_json,
       generated_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      accountId,
      brief.company_overview || '',
      brief.incident_stack || '',
      JSON.stringify(brief.recent_signals || []),
      JSON.stringify(brief.relevant_people || []),
      brief.why_care || '',
      brief.outbound_angle || '',
      brief.call_prep_notes || '',
      JSON.stringify(brief.sources || []),
      JSON.stringify(brief.provider_status || []),
      brief.generated_by || 'system',
      nowIso(),
    ],
  );
  return hydrateAccountBrief(get(`SELECT * FROM account_briefs WHERE id = ?`, [id]));
}
export function latestAccountBrief(accountId) {
  return hydrateAccountBrief(get(`SELECT * FROM account_briefs WHERE account_id = ? ORDER BY id DESC LIMIT 1`, [accountId]));
}

// ---------------- tasks ----------------
export function addTask(accountId, title, kind = 'next_action') {
  // Avoid piling identical open tasks.
  const dupe = get(`SELECT id FROM tasks WHERE account_id IS ? AND title = ? AND status = 'open'`, [accountId || null, title]);
  if (dupe) return get(`SELECT * FROM tasks WHERE id = ?`, [dupe.id]);
  const { id } = run(`INSERT INTO tasks (account_id, title, kind, status, created_at) VALUES (?,?,?, 'open', ?)`,
    [accountId || null, title, kind, nowIso()]);
  return get(`SELECT * FROM tasks WHERE id = ?`, [id]);
}
export function listTasks(filter = {}) {
  const where = [];
  const args = [];
  if (filter.status) { where.push(`t.status = ?`); args.push(filter.status); }
  if (filter.accountId) { where.push(`t.account_id = ?`); args.push(filter.accountId); }
  return all(`SELECT t.*, a.name AS account_name FROM tasks t
              LEFT JOIN accounts a ON a.id = t.account_id
              ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
              ORDER BY t.status ASC, t.id DESC`, args);
}
export function completeTask(id) {
  run(`UPDATE tasks SET status = 'done', done_at = ? WHERE id = ?`, [nowIso(), id]);
  return get(`SELECT * FROM tasks WHERE id = ?`, [id]);
}
export function completeMissingTasksNotIn(accountId, openTitles = []) {
  const rows = listTasks({ accountId }).filter((t) => t.kind === 'missing_data' && t.status === 'open');
  const keep = new Set(openTitles);
  let closed = 0;
  for (const t of rows) {
    if (!keep.has(t.title)) {
      completeTask(t.id);
      closed++;
    }
  }
  return closed;
}

// ---------------- sequence_exports ----------------
export function recordExport(target, filePath, accountCount, contactCount, notes = '') {
  const { id } = run(
    `INSERT INTO sequence_exports (target, file_path, account_count, contact_count, notes, created_at)
     VALUES (?,?,?,?,?,?)`,
    [target, filePath || '', accountCount, contactCount, notes, nowIso()],
  );
  return get(`SELECT * FROM sequence_exports WHERE id = ?`, [id]);
}
export function listExports() { return all(`SELECT * FROM sequence_exports ORDER BY id DESC LIMIT 50`); }

export function recordAccountExport(exportId, accountId, target, contactCount) {
  const { id } = run(
    `INSERT INTO account_exports (export_id, account_id, target, contact_count, created_at)
     VALUES (?,?,?,?,?)`,
    [exportId, accountId, target, contactCount, nowIso()],
  );
  return get(`SELECT * FROM account_exports WHERE id = ?`, [id]);
}
export function listAccountExports(accountId) {
  return all(`SELECT ae.*, se.file_path
              FROM account_exports ae
              LEFT JOIN sequence_exports se ON se.id = ae.export_id
              WHERE ae.account_id = ?
              ORDER BY ae.id DESC`, [accountId]);
}
export function latestAccountExports(accountId) {
  const rows = listAccountExports(accountId);
  const out = {};
  for (const row of rows) {
    if (!out[row.target]) out[row.target] = row;
  }
  return out;
}
export function latestExportsByAccount() {
  const rows = all(`SELECT ae.*, a.name AS account_name, se.file_path
                    FROM account_exports ae
                    JOIN accounts a ON a.id = ae.account_id
                    LEFT JOIN sequence_exports se ON se.id = ae.export_id
                    ORDER BY ae.id DESC`);
  const out = new Map();
  for (const row of rows) {
    const cur = out.get(row.account_id) || {};
    if (!cur[row.target]) cur[row.target] = row;
    out.set(row.account_id, cur);
  }
  return out;
}

// ---------------- audit_log ----------------
export function audit(entry) {
  const { id } = run(
    `INSERT INTO audit_log (account_id, action, query, source, result, confidence, error, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [entry.account_id || null, entry.action, entry.query || '', entry.source || 'system',
     entry.result || '', entry.confidence ?? null, entry.error || '', nowIso()],
  );
  return get(`SELECT * FROM audit_log WHERE id = ?`, [id]);
}
export function listAudit(accountId, limit = 100) {
  if (accountId) return all(`SELECT * FROM audit_log WHERE account_id = ? ORDER BY id DESC LIMIT ?`, [accountId, limit]);
  return all(`SELECT al.*, a.name AS account_name FROM audit_log al
              LEFT JOIN accounts a ON a.id = al.account_id
              ORDER BY al.id DESC LIMIT ?`, [limit]);
}

// ---------------- call_queue ----------------
// Source of truth for the dial-ready queue (Google Sheet + call cockpit).
// replaceQueue() fully rebuilds it from the builder's ordered rows.
export function replaceQueue(rows = []) {
  run(`DELETE FROM call_queue`);
  const ts = nowIso();
  let inserted = 0;
  for (const r of rows) {
    run(
      `INSERT INTO call_queue (account_id, contact_id, rank, status, why_now, sheet_row, queued_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [r.account_id, r.contact_id || null, r.rank ?? inserted, r.status || 'queued',
       r.why_now || '', r.sheet_row ?? null, ts, ts, ts],
    );
    inserted++;
  }
  return { count: inserted };
}
export function listQueue(filter = {}) {
  const where = [];
  const args = [];
  if (filter.status) { where.push(`q.status = ?`); args.push(filter.status); }
  return all(
    `SELECT q.*,
            a.name AS account_name, a.domain AS account_domain, a.score AS account_score,
            a.band AS account_band, a.incident_stack AS account_incident_stack,
            c.name AS contact_name, c.title AS contact_title, c.email AS contact_email,
            c.phone AS contact_phone, c.linkedin AS contact_linkedin,
            c.persona_level AS contact_persona_level, c.persona_role AS contact_persona_role
     FROM call_queue q
     JOIN accounts a ON a.id = q.account_id
     LEFT JOIN contacts c ON c.id = q.contact_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY q.rank ASC, q.id ASC`,
    args,
  );
}
export function getQueueItem(id) { return get(`SELECT * FROM call_queue WHERE id = ?`, [id]); }
export function setQueueStatus(id, status, outcome) {
  const sets = [`status = ?`, `updated_at = ?`];
  const args = [status, nowIso()];
  if (outcome !== undefined) { sets.push(`outcome = ?`); args.push(outcome || ''); }
  if (status === 'dialed' || status === 'connected') { sets.push(`last_dialed_at = ?`); args.push(nowIso()); }
  args.push(id);
  run(`UPDATE call_queue SET ${sets.join(', ')} WHERE id = ?`, args);
  return getQueueItem(id);
}
export function setQueueSheetRow(id, row) {
  run(`UPDATE call_queue SET sheet_row = ?, updated_at = ? WHERE id = ?`, [row, nowIso(), id]);
}
export function getQueueByContact(contactId) {
  return get(`SELECT * FROM call_queue WHERE contact_id = ? ORDER BY id DESC LIMIT 1`, [contactId]);
}

// ---------------- call_log (outcomes logged back to the account) ----------------
export function addCallLog(accountId, contactId, { outcome, note = '', queue_id = null } = {}) {
  const { id } = run(
    `INSERT INTO call_log (account_id, contact_id, queue_id, outcome, note, created_at)
     VALUES (?,?,?,?,?,?)`,
    [accountId, contactId || null, queue_id || null, outcome, note || '', nowIso()],
  );
  return get(`SELECT * FROM call_log WHERE id = ?`, [id]);
}
export function listCallLog(accountId) {
  return all(`SELECT cl.*, c.name AS contact_name FROM call_log cl
              LEFT JOIN contacts c ON c.id = cl.contact_id
              WHERE cl.account_id = ? ORDER BY cl.id DESC`, [accountId]);
}
export function listRecentCallLog(limit = 50) {
  return all(`SELECT cl.*, a.name AS account_name, c.name AS contact_name FROM call_log cl
              JOIN accounts a ON a.id = cl.account_id
              LEFT JOIN contacts c ON c.id = cl.contact_id
              ORDER BY cl.id DESC LIMIT ?`, [limit]);
}

// Contact lookup for the cockpit. Phone is the most stable key from the dialer;
// fall back to email / linkedin / name. Joins the account for brief context.
const CONTACT_JOIN = `SELECT c.*, a.name AS account_name, a.domain AS account_domain
  FROM contacts c JOIN accounts a ON a.id = c.account_id`;
function digits(s) { return String(s || '').replace(/\D/g, ''); }
export function findContactByPhone(phone) {
  const d = digits(phone);
  if (d.length < 7) return null;
  const tail = d.slice(-10); // match on last 10 digits to ignore country/format
  const rows = all(`${CONTACT_JOIN} WHERE c.phone IS NOT NULL AND c.phone <> ''`);
  return rows.find((c) => digits(c.phone).slice(-10) === tail) || null;
}
export function findContactByEmail(email) {
  if (!email) return null;
  return get(`${CONTACT_JOIN} WHERE lower(c.email) = lower(?) LIMIT 1`, [String(email).trim()]);
}
export function findContactByLinkedin(linkedin) {
  if (!linkedin) return null;
  const slug = String(linkedin).toLowerCase().replace(/\/+$/, '');
  return all(`${CONTACT_JOIN} WHERE c.linkedin IS NOT NULL AND c.linkedin <> ''`)
    .find((c) => String(c.linkedin).toLowerCase().replace(/\/+$/, '') === slug) || null;
}
export function findContactByName(name, accountName) {
  if (!name) return null;
  if (accountName) {
    const hit = get(`${CONTACT_JOIN} WHERE lower(c.name) = lower(?) AND lower(a.name) = lower(?) LIMIT 1`, [name, accountName]);
    if (hit) return hit;
  }
  return get(`${CONTACT_JOIN} WHERE lower(c.name) = lower(?) ORDER BY c.confidence DESC LIMIT 1`, [name]);
}

// ---------------- stats ----------------
export function stats() {
  const c = (sql, args = []) => Number(get(sql, args)?.c ?? 0);
  return {
    total: c(`SELECT COUNT(*) c FROM accounts`),
    workToday: c(`SELECT COUNT(*) c FROM accounts WHERE band = 'work_today'`),
    readyToSequence: c(`SELECT COUNT(*) c FROM accounts WHERE status = 'ready_to_sequence'`),
    needsResearch: c(`SELECT COUNT(*) c FROM accounts WHERE status = 'research_needed'`),
    blocked: c(`SELECT COUNT(*) c FROM accounts WHERE band = 'blocked' OR status = 'blocked'`),
    contacts: c(`SELECT COUNT(*) c FROM contacts`),
    byBand: Object.fromEntries(all(`SELECT band, COUNT(*) c FROM accounts GROUP BY band`).map((r) => [r.band, Number(r.c)])),
  };
}

// Pull everything attached to an account in one shot (detail page / call notes).
export function getAccountBundle(id) {
  const account = getAccount(id);
  if (!account) return null;
  return {
    account,
    contacts: listContacts(id),
    signals: listSignals(id),
    tech: listTech(id),
    statusPage: getStatusPage(id),
    quotes: listQuotes(id),
    callNotes: listCallNotes(id),
    researchBriefs: listResearchBriefs(id),
    latestAccountBrief: latestAccountBrief(id),
    callLog: listCallLog(id),
    tasks: listTasks({ accountId: id }),
    exports: listAccountExports(id),
    latestExports: latestAccountExports(id),
    audit: listAudit(id, 50),
  };
}
