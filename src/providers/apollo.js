import { fetchJson, safeError } from './http.js';

const BASE = 'https://api.apollo.io/api/v1';

function auth(key) {
  return { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
}

export async function testApollo(key, { fetchFn } = {}) {
  if (!key) return { status: 'missing', message: 'No Apollo key provided' };
  try {
    const data = await fetchJson(`${BASE}/accounts/search`, {
      method: 'POST',
      headers: auth(key),
      body: { q: 'apollo.io', per_page: 1 },
      fetchFn,
    });
    return { status: 'connected', message: `Connected; ${data.accounts?.length ?? 0} accounts returned` };
  } catch (e) {
    return { status: 'error', message: safeError(e) };
  }
}

export async function searchAccountByDomain(domain, key, { fetchFn } = {}) {
  if (!key || !domain) return null;
  const data = await fetchJson(`${BASE}/accounts/search`, {
    method: 'POST',
    headers: auth(key),
    body: { q: domain, per_page: 5 },
    fetchFn,
  });
  const accounts = data.accounts || [];
  const exact = accounts.find((a) => {
    const d = String(a.domain || '').toLowerCase();
    const w = String(a.website_url || '').toLowerCase().replace(/^https?:\/\//, '');
    return d === domain || w === domain || w.startsWith(domain + '/');
  });
  return exact || accounts[0] || null;
}

export async function updateAccountNotes(accountId, notes, key, { fetchFn } = {}) {
  if (!key || !accountId) throw new Error('missing Apollo key or accountId');
  const fieldName = process.env.APOLLO_ACCOUNT_NOTES_FIELD || 'description';
  const body = { [fieldName]: notes };
  await fetchJson(`${BASE}/accounts/${encodeURIComponent(accountId)}`, {
    method: 'PATCH',
    headers: auth(key),
    body,
    fetchFn,
  });
  return { ok: true, field: fieldName };
}
