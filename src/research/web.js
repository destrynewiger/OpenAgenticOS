// Web / public-research adapter — status page, customer status, initiatives,
// and public quotes. Same pattern as Sumble: a clean interface that resolves
// from fixtures offline, and an optional live path (status-page fetch) gated
// behind ENABLE_BROWSER_RESEARCH. Gemini/Google/NotebookLM can be plugged into
// `liveResearch` later without changing callers.
import { getConfig } from '../config.js';
import { fixtureFor } from './fixtures.js';
import { deriveStatusCandidates, analyzeStatusPage, detectProvider } from '../statuspage.js';

// Returns a normalized research result. Only asserts facts it can back up.
// {
//   source, rootlyCustomer, pagerDutyCustomer,
//   statusPage: { url, provider, hasActiveIncident, verified } | null,
//   statusCandidates: [...],            // unverified guesses when nothing confirmed
//   signals: [...], quotes: [...], note
// }
export async function researchWeb({ name, domain, cfg = getConfig() } = {}) {
  const fx = fixtureFor(domain);
  const out = {
    source: fx ? 'fixture' : 'web',
    rootlyCustomer: fx?.rootly_customer || 'unknown',
    pagerDutyCustomer: fx?.pagerduty_customer || 'unknown',
    statusPage: null,
    statusCandidates: deriveStatusCandidates(domain),
    signals: fx?.signals ? fx.signals.map((s) => ({ ...s, source: 'fixture' })) : [],
    quotes: fx?.quotes ? fx.quotes.map((q) => ({ ...q, url: q.url || '' })) : [],
    note: fx ? 'resolved from local sample data' : 'no public data found — needs research',
  };

  if (fx?.status_page) {
    out.statusPage = {
      url: fx.status_page.url,
      provider: fx.status_page.provider || detectProvider(fx.status_page.url),
      hasActiveIncident: false,
      lastIncident: fx.status_page.last_incident || '',
      verified: false, // fixture, not a live fetch
    };
  }

  // Optional live public research. This is intentionally conservative: it only
  // promotes clear text hits from search results / fetched pages.
  if (cfg.flags.browserResearch) {
    const live = await livePublicResearch({ name, domain, statusCandidates: out.statusCandidates });
    if (live) Object.assign(out, live);
  }

  if (cfg.flags.browserResearch && out.statusCandidates.length && !out.statusPage) {
    const probed = await probeStatusPage(out.statusCandidates);
    if (probed) out.statusPage = { ...probed, verified: true };
  }

  return out;
}

async function livePublicResearch({ name, domain, statusCandidates }) {
  const q = encodeURIComponent(`"${name}" ${domain || ''} PagerDuty incident reliability status`);
  const searchUrl = `https://duckduckgo.com/html/?q=${q}`;
  const html = await fetchText(searchUrl);
  if (!html) return null;
  const hits = parseSearchHits(html).slice(0, 6);
  const pageTexts = [];
  for (const h of hits.slice(0, 4)) {
    const text = await fetchText(h.url);
    if (text) pageTexts.push({ ...h, text: stripHtml(text).slice(0, 5000) });
  }
  const corpus = [stripHtml(html), ...hits.map((h) => `${h.title} ${h.snippet}`), ...pageTexts.map((p) => p.text)].join('\n');
  const out = {
    source: 'web-live',
    rootlyCustomer: 'unknown',
    pagerDutyCustomer: /pagerduty/i.test(corpus) ? 'yes' : 'unknown',
    tech: [],
    signals: [],
    quotes: [],
    note: 'live public web research',
  };
  if (/pagerduty/i.test(corpus)) out.tech.push({ tool: 'PagerDuty', category: 'incident', source: 'web-live', confidence: 70 });
  if (/(ai|artificial intelligence|machine learning|ml)\s+(operations|platform|workflow|initiative|launch|scale|scaling)|scaling\s+AI/i.test(corpus)) {
    out.signals.push({ kind: 'ai_initiative', label: 'AI / platform initiative mentioned publicly', detail: short(extractSentence(corpus, /AI|artificial intelligence|machine learning|ML/i)), source: 'web-live', confidence: 60 });
  }
  if (/scale|scaling|multi-region|platform|operations/i.test(corpus)) {
    out.signals.push({ kind: 'infra_scaling', label: 'Scale / platform context mentioned publicly', detail: short(extractSentence(corpus, /scale|scaling|platform|operations/i)), source: 'web-live', confidence: 55 });
  }
  for (const h of hits) {
    if (/pagerduty|incident|reliability|AI|operations|platform|status/i.test(`${h.title} ${h.snippet}`)) {
      out.quotes.push({
        quote: short(h.snippet || h.title, 220),
        source_name: h.title || 'Public search result',
        source_date: '',
        url: h.url,
        interpretation: 'Public context for reliability, incident response, or platform scale; verify details before outreach.',
      });
    }
  }
  const status = statusCandidates?.length ? await probeStatusPage(statusCandidates) : null;
  if (status) out.statusPage = { ...status, verified: true };
  return out;
}

async function fetchText(url) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    clearTimeout(t);
    if (!r.ok) return '';
    return (await r.text()).slice(0, 50000);
  } catch {
    return '';
  }
}

function parseSearchHits(html) {
  const hits = [];
  const re = /<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/a>)?/gi;
  let m;
  while ((m = re.exec(html)) && hits.length < 10) {
    hits.push({ url: decodeDdgUrl(m[1]), title: stripHtml(m[2]), snippet: stripHtml(m[3] || '') });
  }
  return hits.filter((h) => /^https?:\/\//.test(h.url));
}

function decodeDdgUrl(url) {
  let u = String(url || '').replace(/^\/\//, 'https://');
  try {
    const parsed = new URL(u);
    const uddg = parsed.searchParams.get('uddg');
    if (uddg) u = decodeURIComponent(uddg);
  } catch {}
  return u.replace(/&amp;/g, '&');
}

function stripHtml(s) {
  return String(s || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractSentence(text, pattern) {
  const sentences = String(text || '').split(/(?<=[.!?])\s+/);
  return sentences.find((s) => pattern.test(s)) || '';
}

function short(s, n = 160) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
}

// Try candidate URLs, return the first that responds with a recognizable page.
async function probeStatusPage(candidates) {
  for (const url of candidates) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 6000);
      const r = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
      clearTimeout(t);
      if (!r.ok) continue;
      const html = (await r.text()).slice(0, 20000);
      const a = analyzeStatusPage({ url: r.url || url, html });
      if (a.provider !== 'unknown' || /status/i.test(url)) return a;
    } catch {
      // try next candidate
    }
  }
  return null;
}

// STUB for richer initiative/quote research (Gemini CLI / Google / NotebookLM).
// Plug a command or API here later; callers already work without it.
export async function liveResearch({ name, domain, cfg }) {
  throw new Error('liveResearch not implemented — plug Gemini/Google/NotebookLM here');
}
