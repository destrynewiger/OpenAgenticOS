import { fetchJson, safeError } from './http.js';

const BASE = 'https://api.amplemarket.com';

function auth(key) {
  return { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
}

export async function testAmplemarket(key, { fetchFn } = {}) {
  if (!key) return { status: 'missing', message: 'No Amplemarket key provided' };
  try {
    const data = await fetchJson(`${BASE}/sequences?page[size]=1`, { headers: auth(key), fetchFn });
    const count = Array.isArray(data.sequences) ? data.sequences.length : 0;
    return { status: 'connected', message: `Connected; ${count ? 'sequences accessible' : 'no sequences returned'}` };
  } catch (e) {
    return { status: 'error', message: safeError(e) };
  }
}

export async function researchWithAmplemarket(account, contacts, key, { fetchFn } = {}) {
  if (!key) return { provider: 'amplemarket', used: false, error: 'missing key', data: null };
  const out = { provider: 'amplemarket', used: true, error: '', data: { people: [], signals: [], sequences: [], sources: [] } };
  try {
    const seq = await fetchJson(`${BASE}/sequences?page[size]=10`, { headers: auth(key), fetchFn });
    out.data.sequences = (seq.sequences || []).map((s) => ({
      id: s.id,
      name: s.name,
      status: s.status,
      owner: s.created_by_user_email || '',
      updated_at: s.updated_at || '',
    }));
    out.data.sources.push({ provider: 'amplemarket', label: 'Sequences', url: 'https://api.amplemarket.com/sequences' });

    const contactLookups = [];
    for (const c of contacts.slice(0, 8)) {
      if (c.email) contactLookups.push(fetchContactByEmail(c.email, key, fetchFn));
      else contactLookups.push(findPerson({ contact: c, account }, key, fetchFn));
    }
    const settled = await Promise.all(contactLookups.map((p) => p.catch((e) => ({ error: safeError(e) }))));
    for (const item of settled) {
      if (!item || item.error) continue;
      const person = normalizePerson(item);
      if (person.name) out.data.people.push(person);
      if (item.last_contacted_at || (item.recent_activity || []).length) {
        out.data.signals.push({
          label: `${person.name || item.email || 'Contact'} has Amplemarket activity`,
          detail: `last_contacted=${item.last_contacted_at || 'unknown'}; recent_activity=${(item.recent_activity || []).slice(0, 2).map((a) => a.event_type || a.sequence_name).filter(Boolean).join(', ') || 'unknown'}`,
          url: '',
        });
      }
    }
    out.data.sources.push({ provider: 'amplemarket', label: 'People / contacts lookup', url: 'https://api.amplemarket.com/people/find' });

    if (!out.data.people.length && account.domain) {
      const searched = await searchPeople(account, key, fetchFn);
      out.data.people.push(...searched);
      if (searched.length) out.data.sources.push({ provider: 'amplemarket', label: 'People search', url: 'https://api.amplemarket.com/people/search' });
    }
  } catch (e) {
    out.error = safeError(e);
  }
  return out;
}

async function fetchContactByEmail(email, key, fetchFn) {
  try {
    return await fetchJson(`${BASE}/contacts/email/${encodeURIComponent(email)}`, { headers: auth(key), fetchFn });
  } catch {
    return findPerson({ contact: { email }, account: {} }, key, fetchFn);
  }
}

async function findPerson({ contact, account }, key, fetchFn) {
  const params = new URLSearchParams();
  if (contact.linkedin) params.set('linkedin_url', contact.linkedin);
  if (contact.email) params.set('email', contact.email);
  if (contact.name) params.set('name', contact.name);
  if (contact.title) params.set('title', contact.title);
  if (account.domain) params.set('company_domain', account.domain);
  if (account.name) params.set('company_name', account.name);
  return fetchJson(`${BASE}/people/find?${params}`, { headers: auth(key), fetchFn });
}

async function searchPeople(account, key, fetchFn) {
  const body = {
    company_domains: [account.domain].filter(Boolean),
    company_names: [account.name].filter(Boolean),
    person_departments: ['Engineering', 'Information Technology'],
    person_seniorities: ['VP', 'Director', 'Manager', 'Head'],
    page: { size: 8 },
  };
  const data = await fetchJson(`${BASE}/people/search`, {
    method: 'POST',
    headers: auth(key),
    body,
    fetchFn,
  });
  const rows = data.people || data.results || data.data || [];
  return rows.map(normalizePerson).filter((p) => p.name).slice(0, 8);
}

// Single-contact location lookup via /people/find (email/linkedin). Returns a
// location string or '' on any miss. Used by the backfill CLI.
export async function enrichPersonLocation({ email, linkedin, name, domain } = {}, key, { fetchFn } = {}) {
  if (!key || !(email || linkedin)) return '';
  try {
    const params = new URLSearchParams();
    if (linkedin) params.set('linkedin_url', linkedin);
    if (email) params.set('email', email);
    if (name) params.set('name', name);
    if (domain) params.set('company_domain', domain);
    const data = await fetchJson(`${BASE}/people/find?${params}`, { headers: auth(key), fetchFn });
    const p = data?.person || data?.people?.[0] || data || {};
    return p.location || [p.city, p.state, p.country].filter(Boolean).join(', ') || '';
  } catch {
    return '';
  }
}

// Company size enrichment by domain — verified GET /companies/find?domain=
// (https://docs.amplemarket.com/api-reference/companies-enrichment/single-company-enrichment).
// Returns { employees:int|null, size:str, name:str } or null on any failure.
export async function enrichCompanyByDomain(domain, key, { fetchFn } = {}) {
  if (!key || !domain) return null;
  try {
    const data = await fetchJson(`${BASE}/companies/find?domain=${encodeURIComponent(domain)}`, { headers: auth(key), fetchFn });
    const emp = Number(data?.estimated_number_of_employees);
    return { employees: Number.isFinite(emp) ? emp : null, size: data?.size || '', name: data?.name || '' };
  } catch {
    return null;
  }
}

// Net-new ICP sourcing — "300 leads from one search". Company-agnostic search by
// title/seniority/department, normalized to the same person shape the app uses.
export async function searchPeopleByIcp(icp = {}, key, { fetchFn } = {}) {
  if (!key) throw new Error('missing amplemarket key');
  const body = {
    person_titles: icp.titles || undefined,
    person_seniorities: icp.seniorities || ['VP', 'Director', 'Head'],
    person_departments: icp.departments || ['Engineering'],
    person_locations: icp.locations || undefined,
    company_domains: icp.domains || undefined,
    keywords: icp.keywords || undefined,
    page: { size: Math.min(Number(icp.size) || 25, 100) },
  };
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  const data = await fetchJson(`${BASE}/people/search`, { method: 'POST', headers: auth(key), body, fetchFn });
  const rows = data.people || data.results || data.data || [];
  return rows.map(normalizePerson).filter((p) => p.name);
}

// Live send: add one lead to an Amplemarket sequence. GATED by the caller behind
// cfg.flags.amplemarketPush — never reached on the default dry-run.
// Verified against https://docs.amplemarket.com/guides/sequences :
//   POST /sequences/{id}/leads  { leads: [{ email|linkedin_url, data:{...} }] }
// We omit `overrides`, so ignore_recently_contacted stays false and Amplemarket's
// own dedup ALSO skips anyone recently contacted — a backstop for the in-flight guard.
export async function addLeadToSequence({ sequenceId, person, fields = {} }, key, { fetchFn } = {}) {
  if (!key) throw new Error('missing amplemarket key');
  if (!sequenceId) throw new Error('missing sequenceId');
  if (!person?.email && !person?.linkedin) throw new Error(`lead has no email or linkedin: ${person?.name || 'unknown'}`);
  const [first, ...rest] = String(person.name || '').trim().split(/\s+/);
  // `data` keys must be lowercase alphanumeric/underscore; values are template merge vars.
  const data = { first_name: first || '', last_name: rest.join(' ') || '', company_name: person.company_name || '', ...fields };
  return fetchJson(`${BASE}/sequences/${encodeURIComponent(sequenceId)}/leads`, {
    method: 'POST',
    headers: auth(key),
    body: { leads: [{ email: person.email || undefined, linkedin_url: person.linkedin || undefined, data }] },
    fetchFn,
  });
}

function normalizePerson(p = {}) {
  const company = p.company || {};
  const phone = (p.phone_numbers || [])[0]?.number || '';
  return {
    name: p.name || [p.first_name, p.last_name].filter(Boolean).join(' '),
    title: p.title || p.headline || '',
    email: p.email || '',
    phone,
    linkedin: p.linkedin_url || '',
    source_url: p.url || '',
    source: 'amplemarket',
    company_name: p.company_name || company.name || '',
    company_domain: p.company_domain || domainFrom(company.website) || '',
    location: p.location || '',
    last_contacted_at: p.last_contacted_at || '',
    recent_activity: p.recent_activity || [],
  };
}

function domainFrom(url) {
  return String(url || '').replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0];
}

// Search for a CRM account by domain. Amplemarket's public docs list GET /accounts but
// do not expose query parameters. We try /accounts?company_domain=... and fall back to
// /companies/find (enrichment) when the CRM search returns nothing.
export async function searchAccountByDomain(domain, key, { fetchFn } = {}) {
  if (!key || !domain) return null;
  try {
    const data = await fetchJson(`${BASE}/accounts?company_domain=${encodeURIComponent(domain)}&page[size]=5`, {
      headers: auth(key),
      fetchFn,
    });
    const rows = data.accounts || data.results || data.data || [];
    const exact = rows.find((a) => {
      const d = String(a.domain || a.company_domain || '').toLowerCase();
      return d === domain;
    });
    return exact || rows[0] || null;
  } catch {
    // Fall back to company enrichment (not a CRM account, but the closest public match)
    try {
      const company = await enrichCompanyByDomain(domain, key, { fetchFn });
      return company ? { id: null, name: company.name, domain, source: 'company_enrichment' } : null;
    } catch { return null; }
  }
}

// Amplemarket does not expose a public API endpoint for updating account notes.
// This function is a dry-run placeholder: it logs the payload and returns a result
// so the caller can surface it in the UI. If you know the correct endpoint, replace
// this implementation.
export async function updateAccountNotes(accountId, notes, key, { fetchFn } = {}) {
  if (!key) throw new Error('missing amplemarket key');
  // eslint-disable-next-line no-unused-vars
  const _fetch = fetchFn; // reserved for future real call
  const payload = {
    account_id: accountId,
    notes: notes.slice(0, 4000),
    generated_at: new Date().toISOString(),
  };
  return {
    ok: false,
    dryRun: true,
    provider: 'amplemarket',
    message: 'Amplemarket account notes update is not confirmed in public API docs. '
      + `Payload would be: ${JSON.stringify(payload)}`,
  };
}
