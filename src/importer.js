// CSV import → accounts (+ optional inline contacts). Flexible header mapping so
// a list pulled from anywhere (Apollo, Sumble, a spreadsheet) just works.
import { parseCsvToObjects } from './csv.js';
import * as db from './models.js';
import { classifyAndAddContact, rescoreAccount } from './service.js';

const FIELD_ALIASES = {
  name: ['company', 'company_name', 'account', 'account_name', 'name', 'organization', 'org'],
  website: ['website', 'url', 'domain', 'company_domain', 'web'],
  rootly_customer: ['rootly_customer', 'rootly', 'is_rootly_customer', 'rootly_status'],
  pagerduty_customer: ['pagerduty_customer', 'pagerduty', 'pd', 'uses_pagerduty', 'pagerduty_status'],
  incident_stack: ['incident_stack', 'stack', 'tech_stack', 'tools'],
  status_page_url: ['status_page', 'status_page_url', 'statuspage', 'status_url'],
  notes: ['notes', 'note', 'account_notes', 'comment'],
  // optional inline contact
  contact_name: ['contact_name', 'full_name', 'name_contact'],
  first_name: ['first_name', 'firstname', 'first'],
  last_name: ['last_name', 'lastname', 'last'],
  title: ['title', 'job_title', 'role'],
  email: ['email', 'email_address'],
  phone: ['phone', 'mobile', 'phone_number', 'mobile_number', 'direct_phone'],
  linkedin: ['linkedin', 'linkedin_url', 'li'],
};

function mapRow(record) {
  const lower = {};
  for (const [k, v] of Object.entries(record)) lower[k.trim().toLowerCase()] = v;
  const out = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    for (const a of aliases) {
      if (lower[a] !== undefined && lower[a] !== '') { out[field] = lower[a]; break; }
    }
  }
  return out;
}

// Returns { added, updated, contacts, accountIds, errors }.
export function importAccountsCsv(text, { source = 'csv-import' } = {}) {
  const { records } = parseCsvToObjects(text);
  let added = 0, updated = 0, contacts = 0;
  const accountIds = [];
  const errors = [];

  for (const rec of records) {
    const m = mapRow(rec);
    if (!m.name && !m.website) { errors.push('row skipped: no company name or website'); continue; }
    const name = m.name || m.website;
    try {
      const { account, created } = db.upsertAccount({
        name,
        website: m.website || '',
        rootly_customer: m.rootly_customer,
        pagerduty_customer: m.pagerduty_customer,
        incident_stack: m.incident_stack,
        status_page_url: m.status_page_url,
        notes: m.notes,
      });
      created ? added++ : updated++;
      accountIds.push(account.id);

      // Inline contact if the row carries person fields.
      const cname = m.contact_name || [m.first_name, m.last_name].filter(Boolean).join(' ').trim();
      if (cname || m.email) {
        classifyAndAddContact(account.id, {
          name: cname,
          title: m.title || '',
          email: m.email || '',
          phone: m.phone || '',
          linkedin: m.linkedin || '',
          source,
        });
        contacts++;
      }
      rescoreAccount(account.id);
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
    }
  }

  db.audit({
    action: 'import_accounts_csv',
    source,
    result: `added ${added}, updated ${updated}, contacts ${contacts}, rows ${records.length}`,
    confidence: 100,
  });
  return { added, updated, contacts, accountIds, total: db.listAccounts().length, errors };
}

// Contacts-only CSV (e.g. Apollo people pull). Matches contacts to an existing
// account by company/domain; creates the account if missing.
export function importContactsCsv(text, { source = 'contacts-csv' } = {}) {
  const { records } = parseCsvToObjects(text);
  let added = 0;
  const accountIds = new Set();
  const errors = [];
  for (const rec of records) {
    const m = mapRow(rec);
    const company = m.name || m.website;
    const cname = m.contact_name || [m.first_name, m.last_name].filter(Boolean).join(' ').trim();
    if (!company) { errors.push('row skipped: no company'); continue; }
    if (!cname && !m.email) { errors.push(`${company}: row skipped, no contact`); continue; }
    try {
      const { account } = db.upsertAccount({ name: company, website: m.website || '' });
      classifyAndAddContact(account.id, {
        name: cname, title: m.title || '', email: m.email || '',
        phone: m.phone || '', linkedin: m.linkedin || '', source,
      });
      added++;
      accountIds.add(account.id);
    } catch (e) { errors.push(`${company}: ${e.message}`); }
  }
  for (const id of accountIds) rescoreAccount(id);
  db.audit({ action: 'import_contacts_csv', source, result: `contacts ${added}, accounts ${accountIds.size}`, confidence: 100 });
  return { added, accounts: accountIds.size, errors };
}

const clean = (v) => String(v ?? '').trim();

function addImportedCallNote(accountId, contactId, row) {
  const first = clean(row.first_name) || clean(row.full_name).split(/\s+/)[0] || 'there';
  const company = clean(row.company || row.account || row.company_name);
  db.addCallNote(accountId, contactId, {
    why_person: `${clean(row.title) || 'Mapped contact'} from imported prospecting list.`,
    likely_pain: 'Needs discovery. Do not assume current incident stack, PagerDuty usage, or outage history until researched.',
    opening_line: clean(row.call_opener || row.call_script) || `Hi ${first}, curious how ${company || 'your team'} handles incident response and on-call today.`,
    rootly_angle: 'This seller helps teams coordinate incident response, on-call, stakeholder comms, and follow-up work without inventing their current stack.',
    good_question: 'How does incident response work today after the first alert fires, and where does coordination slow down?',
    likely_objection: 'We already have tools for this / not a priority right now.',
    best_response: 'Totally fair. I am not assuming replacement. I am trying to understand where coordination, comms, and follow-up still create manual work.',
    next_step: clean(row.recommended_next_step || row.apollo_task || row.apollo_instruction) || 'Call first, then LinkedIn/Apollo follow-up if no answer.',
    generated_by: 'imported',
  });
}

function addSignal(accountId, kind, label, detail, source, confidence = 80) {
  db.addSignal(accountId, { kind, label, detail, source, confidence });
}

function findAccountByDomainOrName(domain, name) {
  if (domain) {
    const hit = db.listAccounts({ q: domain }).find((a) => a.domain === domain);
    if (hit) return hit;
  }
  if (name) {
    const n = name.toLowerCase();
    return db.listAccounts({ q: name }).find((a) => a.name.toLowerCase() === n) || null;
  }
  return null;
}

// Import account/contact outputs produced by a sequencing or enrichment workflow.
// This is intentionally source-backed: it marks call-readiness and imported
// priority, but leaves customer/PagerDuty/status-page/stack facts unknown until
// research verifies them.
export function importRealGtm({ callListText, warmListText = '', source = 'real_gtm_import', removeExamples = false } = {}) {
  if (!callListText) throw new Error('callListText required');
  if (removeExamples) {
    for (const r of db.listAccounts().filter((a) => String(a.domain || '').endsWith('.example'))) db.deleteAccount(r.id);
  }

  let created = 0, updated = 0, contacts = 0, signals = 0, tasks = 0, warmAccounts = 0;
  const accountIds = new Set();
  const rows = parseCsvToObjects(callListText).records;

  for (const row of rows) {
    const company = clean(row.company || row.account || row.company_name);
    const domain = db.normalizeDomain(row.domain || row.company_domain || row.company_website || row.website);
    if (!company && !domain) continue;

    const { account, created: isNew } = db.upsertAccount({
      name: company || domain,
      website: domain || '',
      rootly_customer: 'unknown',
      pagerduty_customer: 'unknown',
      notes: [
        clean(row.why_now || row.why_prioritized) ? `Imported why now: ${clean(row.why_now || row.why_prioritized)}` : '',
        clean(row.rep_route) ? `Route: ${clean(row.rep_route)}` : '',
        clean(row.company_size) ? `Company size: ${clean(row.company_size)}` : '',
        `Source: ${clean(row.source) || source}`,
      ].filter(Boolean).join(' | '),
    });
    isNew ? created++ : updated++;
    accountIds.add(account.id);

    const importedScore = Number(row.priority_score || 0);
    const priorityLabel = clean(row.priority_band || row.tag || (importedScore >= 120 ? 'Top imported call-list tier' : 'Imported call-list priority'));
    addSignal(account.id, 'source_priority', priorityLabel, `${importedScore ? `Imported priority score ${importedScore}. ` : ''}${clean(row.why_now || row.why_prioritized)}`, clean(row.source) || source, 90);
    signals++;
    if (importedScore >= 120) {
      addSignal(account.id, 'source_work_today', 'Top imported call-list tier', `Top imported tier; priority score ${importedScore}`, clean(row.source) || source, 88);
      signals++;
    }
    addSignal(account.id, 'call_ready', 'Callable imported contact', [
      clean(row.email_status),
      clean(row.phone || row.phone_numbers) ? 'phone present' : '',
      clean(row.linkedin_url) ? 'LinkedIn present' : '',
    ].filter(Boolean).join('; '), clean(row.source) || source, 85);
    signals++;
    if (/sales accepted/i.test(clean(row.current_stage || row.account_stage))) {
      addSignal(account.id, 'sales_accepted', 'Sales Accepted in source export', clean(row.current_stage || row.account_stage), clean(row.source) || source, 80);
      signals++;
    }

    const fullName = clean(row.full_name) || [clean(row.first_name), clean(row.last_name)].filter(Boolean).join(' ');
    const contact = classifyAndAddContact(account.id, {
      name: fullName,
      title: clean(row.title),
      email: clean(row.email),
      phone: clean(row.phone || row.phone_numbers || row.all_phone_numbers),
      linkedin: clean(row.linkedin_url),
      source: clean(row.source) || source,
      confidence: clean(row.email_status).toLowerCase() === 'verified' ? 90 : 70,
    });
    contacts++;
    addImportedCallNote(account.id, contact.id, row);

    const next = clean(row.recommended_next_step || row.apollo_task || row.apollo_instruction) || 'Call first, then LinkedIn/Apollo follow-up.';
    db.addTask(account.id, next, 'next_action');
    tasks++;
    db.updateAccount(account.id, { status: 'ready_to_call', next_action: next });
  }

  if (warmListText) {
    for (const row of parseCsvToObjects(warmListText).records) {
      const accountName = clean(row.account);
      if (!accountName) continue;
      const { account, created: isNew } = db.upsertAccount({
        name: accountName,
        website: '',
        rootly_customer: 'unknown',
        pagerduty_customer: 'unknown',
        notes: [
          clean(row.why),
          clean(row.pagerduty_or_funding_workflow) ? `Workflow: ${clean(row.pagerduty_or_funding_workflow)}` : '',
        ].filter(Boolean).join(' | '),
      });
      isNew ? created++ : updated++;
      accountIds.add(account.id);
      warmAccounts++;
      addSignal(account.id, 'warm_account', clean(row.priority || 'Warm account'), clean(row.why), 'sf_warm_account_strategy', 90);
      addSignal(account.id, 'source_priority', 'SF warm account strategy', clean(row.first_action), 'sf_warm_account_strategy', 85);
      signals += 2;
      const known = clean(row.known_contact);
      if (known) {
        classifyAndAddContact(account.id, { name: known, title: '', source: 'sf_warm_account_strategy', confidence: 55 });
        contacts++;
      }
      if (clean(row.first_action)) {
        db.addTask(account.id, clean(row.first_action), 'next_action');
        tasks++;
      }
      db.updateAccount(account.id, { status: 'ready_to_call', next_action: clean(row.first_action) || 'Manual research + call/LinkedIn warm contact.' });
    }
  }

  for (const id of accountIds) rescoreAccount(id);
  db.audit({ action: 'real_data_import', source, result: `created ${created}, updated ${updated}, contacts ${contacts}, signals ${signals}, tasks ${tasks}, warm ${warmAccounts}`, confidence: 100 });
  return { rows: rows.length, created, updated, contacts, signals, tasks, warmAccounts, accountIds: [...accountIds], total: db.listAccounts().length };
}
