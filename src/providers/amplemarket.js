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
