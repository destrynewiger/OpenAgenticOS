// Status-page detection + parsing. Pure functions (string in, facts out) so we
// can unit-test without the network. The web adapter calls these on fetched HTML
// when ENABLE_BROWSER_RESEARCH=true; otherwise they run on manual paste.

const PROVIDERS = [
  { provider: 'Atlassian Statuspage', re: /statuspage\.io|statuspage\.atlassian|\.statuspage\.|atlassian statuspage/i },
  { provider: 'incident.io', re: /incident\.io|status\.incident\.io|powered by incident\.io/i },
  { provider: 'Instatus', re: /instatus\.com|instatus/i },
  { provider: 'BetterStack', re: /betteruptime|betterstack|better stack|status\.betterstack/i },
  { provider: 'Statuspal', re: /statuspal/i },
  { provider: 'Cachet', re: /cachethq|cachet/i },
  { provider: 'Freshstatus', re: /freshstatus/i },
  { provider: 'Sorry', re: /sorryapp|status\.sorry/i },
];

// Candidate URLs to probe for a public status page, most likely first.
export function deriveStatusCandidates(domain) {
  const d = String(domain || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  if (!d || !d.includes('.')) return [];
  return [
    `https://status.${d}`,
    `https://${d}/status`,
    `https://${d}/status.html`,
    `https://statuspage.${d}`,
  ];
}

// Detect provider from a URL, headers blob, or full HTML. 'custom' when it looks
// like a real page we can't attribute; 'unknown' when there's nothing to go on.
export function detectProvider(input) {
  const s = String(input || '');
  if (!s.trim()) return 'unknown';
  for (const p of PROVIDERS) if (p.re.test(s)) return p.provider;
  // Looks like a URL/host or real markup but no known vendor fingerprint.
  if (/^https?:\/\//i.test(s) || /<html|<!doctype|status\./i.test(s)) return 'custom';
  return 'unknown';
}

const ACTIVE_RE = /(investigating|identified|degraded performance|partial outage|major outage|service disruption|under maintenance|monitoring an issue|elevated error)/i;
const OK_RE = /(all systems operational|all systems go|fully operational|no incidents|operational)/i;

// Parse a status-page text snippet into facts. Never asserts an outage unless
// the text actually contains incident language.
export function parseStatusSnippet(text) {
  const s = String(text || '');
  const provider = detectProvider(s);
  if (!s.trim()) return { provider, hasActiveIncident: false, lastIncident: '' };

  const active = ACTIVE_RE.test(s);
  // If it only says "operational" and shows no incident language, it's healthy.
  const healthyOnly = OK_RE.test(s) && !active;
  const lastIncident = active
    ? (s.split(/\r?\n/).find((l) => ACTIVE_RE.test(l)) || '').trim().slice(0, 200)
    : '';
  return { provider, hasActiveIncident: active && !healthyOnly, lastIncident };
}

// Convenience used by the web adapter: combine a probed URL + (optional) html.
export function analyzeStatusPage({ url = '', html = '' } = {}) {
  const parsed = parseStatusSnippet(html || url);
  const provider = parsed.provider !== 'unknown' ? parsed.provider : detectProvider(url);
  return {
    url,
    provider,
    hasActiveIncident: parsed.hasActiveIncident,
    lastIncident: parsed.lastIncident,
  };
}
