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

function parseTableToObjects(text) {
  const firstLine = String(text || '').split(/\r?\n/).find((line) => line.trim()) || '';
  const delimiter = (firstLine.match(/\t/g) || []).length > (firstLine.match(/,/g) || []).length ? '\t' : ',';
  if (delimiter === ',') return parseCsvToObjects(text);
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return { headers: [], records: [] };
  const headers = lines[0].split('\t').map((h) => h.trim());
  const records = lines.slice(1).map((line) => {
    const cells = line.split('\t');
    const obj = {};
    headers.forEach((h, i) => { obj[h] = clean(cells[i]); });
    return obj;
  });
  return { headers, records };
}

function mergeNote(existing, next) {
  const prior = clean(existing);
  const add = clean(next);
  if (!add) return prior;
  if (!prior) return add;
  if (prior.includes(add)) return prior;
  return `${prior} | ${add}`;
}

function addSignalOnce(accountId, kind, label, detail, source, confidence = 80) {
  const sigs = db.listSignals(accountId);
  const dupe = sigs.find((s) => s.kind === kind && s.label === label && clean(s.detail) === clean(detail) && s.source === source);
  if (dupe) return null;
  return db.addSignal(accountId, { kind, label, detail, source, confidence });
}

function addTechOnce(accountId, tool, source, confidence = 80) {
  const name = clean(tool).replace(/\s+/g, ' ');
  if (!name) return null;
  const dupe = db.listTech(accountId).find((t) => clean(t.tool).toLowerCase() === name.toLowerCase() && t.source === source);
  if (dupe) return null;
  return db.addTech(accountId, { tool: name, category: techCategory(name), source, confidence });
}

function techCategory(tool) {
  const s = clean(tool).toLowerCase();
  if (/pagerduty|opsgenie|victorops|xmatters|firehydrant|rootly|blameless|resolve|incident/.test(s)) return 'incident';
  if (/datadog|grafana|new relic|splunk|dynatrace|prometheus|sentry|honeycomb|cloudwatch|monitor|appdynamics|elk|kibana|sumo logic|logicmonitor|zabbix|nagios|telegraf|opentelemetry/.test(s)) return 'observability';
  if (/slack|teams|google chat|zoom/.test(s)) return 'chatops';
  if (/servicenow|jira service|jira|zendesk|remedy|ivanti/.test(s)) return 'itsm';
  if (/aws|azure|gcp|google cloud/.test(s)) return 'cloud';
  return 'other';
}

function splitList(value) {
  return clean(value).split(/[,;]\s*/).map((v) => v.trim()).filter(Boolean);
}

function mapSignalKind(signal, detail = '') {
  const s = `${signal} ${detail}`.toLowerCase();
  if (/new leader|leadership|new to/.test(s)) return 'new_to_role';
  if (/pagerduty|opsgenie|victorops|xmatters|firehydrant|rootly|blameless|incident stack/.test(s)) return 'incident_stack';
  if (/hiring|sre|devops|platform/.test(s)) return 'infra_scaling';
  if (/ai|automation|agentic/.test(s)) return 'ai_initiative';
  if (/evaluation|evaluating|tooling|migration|legacy/.test(s)) return 'eval';
  return 'source_priority';
}

function mapProspectTier(tier) {
  const s = clean(tier).toLowerCase();
  if (s.includes('buyer')) return 'department_head';
  if (s.includes('champion')) return 'manager';
  if (s.includes('end user')) return 'end_user';
  return '';
}

function inferDomain(row) {
  return db.normalizeDomain(row.Domain || row.domain || row['company domain'] || row.website || row.Website || '');
}

function ensureAccount({ name, domain, source, notes = '', incidentStack = '', pagerDuty = false }) {
  const { account, created } = db.upsertAccount({
    name: name || domain,
    website: domain || '',
    incident_stack: incidentStack,
    pagerduty_customer: pagerDuty ? 'yes' : undefined,
    notes,
  });
  const patch = {};
  const current = db.getAccount(account.id);
  const merged = mergeNote(current.notes, notes);
  if (merged !== current.notes) patch.notes = merged;
  if (!current.incident_stack && incidentStack) patch.incident_stack = incidentStack;
  if (pagerDuty && current.pagerduty_customer === 'unknown') patch.pagerduty_customer = 'yes';
  const updated = Object.keys(patch).length ? db.updateAccount(account.id, patch) : current;
  return { account: updated, created };
}

function addImportedAccountBrief(accountId, row, source) {
  const research = clean(row['Research (2025 Report)']);
  if (!research) return null;
  const tech = splitList(row['Tech Stack']);
  const hiring = clean(row['Hiring Teams (Open Role Counts)']);
  const signals = [
    clean(row.Signal),
    clean(row['Job Post Age']) ? `Job post age: ${clean(row['Job Post Age'])}` : '',
    hiring ? `Hiring: ${hiring}` : '',
  ].filter(Boolean);
  return db.addAccountBrief(accountId, {
    company_overview: research,
    incident_stack: tech.length ? tech.join(', ') : clean(row['Tech Stack']),
    recent_signals: signals,
    relevant_people: [clean(row['Hiring Leads/Managers']), clean(row['New to Leadership Roles'])].filter(Boolean),
    why_care: research,
    outbound_angle: clean(row.Signal) ? `Lead with ${clean(row.Signal).toLowerCase()} and verified incident/reliability tooling from the research pack.` : 'Lead with the imported reliability research and verify current priorities live.',
    call_prep_notes: [research, hiring].filter(Boolean).join(' '),
    sources: [{ provider: source, label: 'Imported 2025 account research report' }],
    provider_status: [{ provider: source, status: 'connected', note: 'Local imported research pack' }],
    generated_by: 'imported_research_pack',
  });
}

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

export function importResearchPack({ accountResearchText = '', peopleText = '', outreachText = '', source = 'research_pack_2026_06_15' } = {}) {
  let created = 0, updated = 0, contacts = 0, signals = 0, tech = 0, callLogs = 0, tasks = 0, briefs = 0;
  const accountIds = new Set();

  for (const row of parseTableToObjects(accountResearchText).records) {
    const name = clean(row['Account Name']);
    if (!name) continue;
    const domain = inferDomain(row);
    const stack = splitList(row['Tech Stack']);
    const incidentStack = stack.filter((t) => techCategory(t) !== 'other').join(', ');
    const pagerDuty = /pagerduty/i.test(`${row.Signal || ''} ${row['Research (2025 Report)'] || ''} ${row['Tech Stack'] || ''}`);
    const note = [
      `Research pack signal: ${clean(row.Signal)}`,
      clean(row['Research (2025 Report)']),
      clean(row['Employee Count']) ? `Employees: ${clean(row['Employee Count'])}` : '',
      clean(row.Score) ? `Source score: ${clean(row.Score)}` : '',
    ].filter(Boolean).join(' | ');
    const { account, created: isNew } = ensureAccount({ name, domain, source, notes: note, incidentStack, pagerDuty });
    isNew ? created++ : updated++;
    accountIds.add(account.id);

    addSignalOnce(account.id, 'research_pack', 'Imported account research', clean(row['Research (2025 Report)']), source, 95) && signals++;
    addSignalOnce(account.id, mapSignalKind(row.Signal, row['Research (2025 Report)']), clean(row.Signal || 'Imported signal'), clean(row['Research (2025 Report)']), source, 88) && signals++;
    if (pagerDuty) addSignalOnce(account.id, 'pagerduty_detected', 'PagerDuty mentioned in imported research', clean(row['Research (2025 Report)']), source, 88) && signals++;
    if (clean(row['Job Post Age']) || clean(row['Hiring Teams (Open Role Counts)'])) {
      addSignalOnce(account.id, 'infra_scaling', 'Hiring / platform signal', `${clean(row['Job Post Age'])} ${clean(row['Hiring Teams (Open Role Counts)'])}`.trim(), source, 80) && signals++;
    }
    for (const t of stack) if (addTechOnce(account.id, t, source, 82)) tech++;
    if (clean(row['Teams Using Technologies'])) {
      addSignalOnce(account.id, 'incident_stack', 'Teams using reliability tools', clean(row['Teams Using Technologies']), source, 76) && signals++;
    }
    for (const person of splitList(row['Hiring Leads/Managers'])) {
      const m = person.match(/^(.*?)\s*\((.*?)\)$/);
      classifyAndAddContact(account.id, { name: clean(m?.[1] || person), title: clean(m?.[2] || ''), source, confidence: 62 });
      contacts++;
    }
    for (const person of splitList(row['New to Leadership Roles'])) {
      const m = person.match(/^(.*?)\s*\((.*?)\)$/);
      classifyAndAddContact(account.id, { name: clean(m?.[1] || person), title: clean(m?.[2] || ''), source, confidence: 65 });
      addSignalOnce(account.id, 'new_to_role', 'New to leadership role', person, source, 82) && signals++;
      contacts++;
    }
    if (clean(row['Research (2025 Report)'])) {
      db.addQuote(account.id, {
        quote: clean(row['Research (2025 Report)']),
        source_name: source,
        source_date: '2025 report',
        interpretation: clean(row.Signal) || 'Imported account research signal',
      });
    }
    addImportedAccountBrief(account.id, row, source);
    briefs++;
  }

  for (const row of parseTableToObjects(peopleText).records) {
    const org = clean(row.Organization);
    const name = clean(row.Name);
    if (!org || !name) continue;
    const { account, created: isNew } = ensureAccount({
      name: org,
      source,
      notes: `Imported role research: ${name} — ${clean(row.Role)} (${clean(row.Location)}${clean(row.Country) ? ', ' + clean(row.Country) : ''})`,
    });
    isNew ? created++ : updated++;
    accountIds.add(account.id);
    classifyAndAddContact(account.id, {
      name,
      title: clean(row.Role),
      persona_level: mapProspectTier(clean(row.Level)) || '',
      persona_role: clean(row['Job function'] || row.Matched),
      source: `${source}:role_research`,
      confidence: 68,
    });
    contacts++;
    const kind = mapSignalKind(row.Matched, row.Role);
    addSignalOnce(account.id, kind, clean(row.Matched || row['Job function'] || 'Role match'), `${name}: ${clean(row.Role)}. Start date: ${clean(row['Start Date']) || 'unknown'}. Location: ${clean(row.Location)}`, `${source}:role_research`, 78) && signals++;
  }

  for (const row of parseTableToObjects(outreachText).records) {
    const name = clean(row.Name);
    const accountName = clean(row.Account);
    if (!accountName) continue;
    const stack = splitList(row['Tech Stack']);
    const pagerDuty = /pagerduty/i.test(`${row.Signal || ''} ${row['Tech Stack'] || ''}`);
    const { account, created: isNew } = ensureAccount({
      name: accountName,
      source,
      notes: [clean(row.Angle), clean(row.Signal) ? `Signal: ${clean(row.Signal)}` : '', clean(row['company size']) ? `Company size: ${clean(row['company size'])}` : ''].filter(Boolean).join(' | '),
      incidentStack: stack.join(', '),
      pagerDuty,
    });
    isNew ? created++ : updated++;
    accountIds.add(account.id);
    for (const t of stack) if (addTechOnce(account.id, t, `${source}:outreach_history`, 86)) tech++;
    addSignalOnce(account.id, 'outreach_history', 'Outreach history imported', `${clean(row.Signal)} ${clean(row.Angle)}`.trim(), `${source}:outreach_history`, 92) && signals++;
    if (pagerDuty) addSignalOnce(account.id, 'pagerduty_detected', 'PagerDuty in outreach export', clean(row.Signal), `${source}:outreach_history`, 90) && signals++;
    if (clean(row.incident_account_stage)) addSignalOnce(account.id, 'sales_accepted', clean(row.incident_account_stage), 'Imported incident account stage', `${source}:outreach_history`, 80) && signals++;

    let contact = null;
    if (name || clean(row.email)) {
      contact = classifyAndAddContact(account.id, {
        name,
        title: clean(row['Prospect tier']),
        email: clean(row.email),
        phone: clean(row.number),
        linkedin: clean(row.linkedin),
        persona_level: mapProspectTier(row['Prospect tier']),
        source: `${source}:outreach_history`,
        confidence: clean(row.email) || clean(row.number) ? 92 : 72,
      });
      contacts++;
      addSignalOnce(account.id, 'call_ready', 'Callable imported contact', `${name} ${clean(row.number) ? 'phone present' : ''} ${clean(row.email) ? 'email present' : ''}`.trim(), `${source}:outreach_history`, 90) && signals++;
    }
    const outcome = clean(row.TRELLUS_Last_Call_Outcome);
    const note = clean(row.TRELLUS_Call_Notes);
    if ((outcome || note) && contact) {
      const exists = db.listCallLog(account.id).find((l) => l.contact_id === contact.id && l.outcome === (outcome || 'imported') && clean(l.note) === note);
      if (!exists) {
        db.addCallLog(account.id, contact.id, { outcome: outcome || 'imported', note });
        callLogs++;
      }
    }
    if (/follow up required/i.test(outcome) || note) {
      db.addTask(account.id, `Follow up with ${name || accountName}: ${note || outcome}`, 'follow_up');
      tasks++;
    }
    if (contact && (clean(row.number) || clean(row.email))) db.updateAccount(account.id, { status: 'ready_to_call' });
  }

  for (const id of accountIds) rescoreAccount(id);
  db.audit({
    action: 'import_research_pack',
    source,
    result: `accounts ${accountIds.size}, created ${created}, updated ${updated}, contacts ${contacts}, signals ${signals}, tech ${tech}, call_logs ${callLogs}, tasks ${tasks}, briefs ${briefs}`,
    confidence: 100,
  });
  return { accounts: accountIds.size, created, updated, contacts, signals, tech, callLogs, tasks, briefs, total: db.listAccounts().length };
}
