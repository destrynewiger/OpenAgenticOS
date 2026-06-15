import { fetchJson, safeError } from './http.js';

const BASE = 'https://api.sumble.com/v5';
const INCIDENT_TECH = [
  'PagerDuty', 'Opsgenie', 'Datadog', 'New Relic', 'Grafana', 'Prometheus',
  'Splunk', 'ServiceNow', 'Jira', 'Slack', 'Kubernetes', 'Terraform',
  'VictorOps', 'AWS', 'Amazon Web Services', 'GCP', 'Google Cloud',
];

function auth(key) {
  return { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
}

export async function testSumble(key, { fetchFn } = {}) {
  if (!key) return { status: 'missing', message: 'No Sumble key provided' };
  try {
    const data = await fetchJson(`${BASE}/organizations/match`, {
      method: 'POST',
      headers: auth(key),
      body: { organizations: [{ name: 'Sumble', url: 'sumble.com' }] },
      fetchFn,
    });
    return { status: 'connected', message: `Connected${data.credits_remaining !== undefined ? `; ${data.credits_remaining} credits remaining` : ''}` };
  } catch (e) {
    return { status: 'error', message: safeError(e) };
  }
}

export async function researchWithSumble(account, key, { fetchFn } = {}) {
  if (!key) return { provider: 'sumble', used: false, error: 'missing key', data: null };
  const out = { provider: 'sumble', used: true, error: '', data: { sources: [] } };
  try {
    const domain = account.domain || account.website || account.name;
    const org = await fetchJson(`${BASE}/organizations/match`, {
      method: 'POST',
      headers: auth(key),
      body: { organizations: [{ name: account.name, url: domain }] },
      fetchFn,
    });
    const match = org.results?.[0]?.match || null;
    out.data.company = match ? {
      name: match.name || account.name,
      domain: match.domain || account.domain,
      sumble_id: match.id,
      slug: match.slug,
    } : null;
    out.data.sources.push({ provider: 'sumble', label: 'Organization match', url: match?.url || '' });

    const enrich = await fetchJson(`${BASE}/organizations/enrich`, {
      method: 'POST',
      headers: auth(key),
      body: { organization: { domain: match?.domain || account.domain }, filters: { technologies: INCIDENT_TECH } },
      fetchFn,
    });
    out.data.incident_stack = (enrich.technologies || []).map((t) => t.name).filter(Boolean);
    out.data.technologies = (enrich.technologies || []).map((t) => ({
      name: t.name || '',
      category: t.category || '',
      source: 'sumble',
      confidence: t.confidence ?? 80,
    })).filter((t) => t.name);
    out.data.sources.push({ provider: 'sumble', label: 'Technology enrichment', url: enrich.source_data_url || '' });

    const people = await fetchJson(`${BASE}/people/find`, {
      method: 'POST',
      headers: auth(key),
      body: {
        organization: { domain: match?.domain || account.domain },
        filters: { job_functions: ['Engineering', 'Operations'], job_levels: ['Director', 'VP', 'Head', 'Manager', 'Individual Contributor'] },
        limit: 8,
      },
      fetchFn,
    });
    out.data.people = (people.people || []).map((p) => ({
      name: p.name || '',
      title: p.job_title || '',
      linkedin: p.linkedin_url || '',
      source_url: p.url || '',
      start_date: p.start_date || '',
      location: p.location || '',
    })).filter((p) => p.name);
    out.data.sources.push({ provider: 'sumble', label: 'People search', url: people.people_data_url || '' });
  } catch (e) {
    out.error = safeError(e);
  }
  return out;
}
