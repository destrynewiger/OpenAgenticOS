// Deterministic account scoring per the agreed model. Pure function: takes a
// plain bundle of account data, returns { score, band, reasons }. No DB access,
// so it is trivial to unit-test.

export const BANDS = {
  work_today:    { label: 'Work today',            color: 'green',  min: 90 },
  sequence_week: { label: 'Sequence this week',    color: 'yellow', min: 70 },
  research_more: { label: 'Research more',         color: 'blue',   min: 50 },
  low:           { label: 'Low priority',          color: 'gray',   min: -Infinity },
  blocked:       { label: 'Blocked / do not work', color: 'red',    min: null },
};

export const STATUSES = {
  research_needed:   { label: 'Research needed' },
  ready_to_sequence: { label: 'Ready to sequence' },
  ready_to_call:     { label: 'Ready to call' },
  already_worked:    { label: 'Already worked' },
  blocked:           { label: 'Blocked / not a fit' },
};

const INITIATIVE_KINDS = new Set(['infra_scaling', 'ai_initiative']);
const INCIDENT_TECH_CATEGORIES = new Set(['incident', 'observability', 'chatops', 'itsm']);
const INCIDENT_TECH_RE = /pagerduty|opsgenie|rootly|incident|statuspage|status page|datadog|grafana|new relic|dynatrace|splunk|servicenow|jira|slack/i;

function reachable(c) { return !!(c && (c.email || c.phone)); }
function isIncidentTech(t = {}) {
  return INCIDENT_TECH_CATEGORIES.has(String(t.category || '').toLowerCase()) || INCIDENT_TECH_RE.test(String(t.tool || ''));
}

// bundle = { account, signals, contacts, quotes, statusPage, tech }
export function scoreAccount(bundle) {
  const a = bundle.account || {};
  const signals = bundle.signals || [];
  const contacts = bundle.contacts || [];
  const quotes = bundle.quotes || [];
  const tech = bundle.tech || [];
  const kinds = new Set(signals.map((s) => s.kind));

  const reasons = [];
  let score = 0;
  const add = (pts, why) => { score += pts; reasons.push(`${why} (${pts > 0 ? '+' : ''}${pts})`); };

  const rootly = String(a.rootly_customer || 'unknown').toLowerCase();
  const pd = String(a.pagerduty_customer || 'unknown').toLowerCase();
  // PagerDuty is the strongest displacement signal.
  if (pd === 'yes') add(30, 'PagerDuty detected');

  // Customer/prospect status. Confirmed customer => hard block. Unknown remains
  // workable, but should not score like a verified non-customer.
  if (rootly === 'yes') {
    add(-100, 'Already a customer');
  } else if (rootly === 'no') {
    add(25, 'Not a customer');
  } else {
    add(10, 'Customer status unverified — verify before sequencing');
  }

  const hasStack = !!(a.incident_stack && a.incident_stack.trim()) || tech.some(isIncidentTech) || kinds.has('incident_stack');
  if (hasStack) add(15, 'Incident stack detected');

  const hasStatusPage = !!(a.status_page_url && a.status_page_url.trim()) || kinds.has('status_page');
  if (hasStatusPage) add(10, 'Public status page found');

  if (kinds.has('outage')) add(10, 'Recent outage / reliability event');
  if (kinds.has('new_to_role')) add(10, 'New exec / new engineering leader');
  if ([...kinds].some((k) => INITIATIVE_KINDS.has(k))) add(15, 'Recent infra / platform / AI / digital initiative');
  if (kinds.has('warm_account')) add(40, 'Warm account / direct referral');
  if (kinds.has('source_work_today')) add(30, 'Imported GTM source says work today');
  if (kinds.has('source_priority')) add(30, 'Prioritized by imported GTM source');
  if (kinds.has('historical_booked_meeting')) add(20, 'Historical booked-meeting signal');
  if (kinds.has('prior_thread_ready_task')) add(15, 'Prior thread has ready-to-work task');
  if (kinds.has('sf_warm_task')) add(15, 'Warm SF task from prior work');
  if (kinds.has('call_ready')) add(20, 'Call-ready contact data');
  if (kinds.has('sales_accepted')) add(10, 'Sales Accepted source status');

  const hasQuote = quotes.length > 0 || kinds.has('filing_quote');
  if (hasQuote) add(10, 'Relevant quote from public filing / report');

  const reach = contacts.filter(reachable);
  const levels = new Set(contacts.filter((c) => c.persona_level).map((c) => c.persona_level));
  const strongMap = reach.length >= 3 || (levels.size >= 2 && reach.length >= 1);
  if (strongMap) add(10, 'Strong contact map available');
  else if (contacts.length === 0 || reach.length === 0) add(-10, 'No clear contact data');

  return { score, band: bandFor(score, { rootlyCustomer: rootly === 'yes' }), reasons };
}

export function bandFor(score, { rootlyCustomer = false } = {}) {
  if (rootlyCustomer) return 'blocked';
  if (score >= 90) return 'work_today';
  if (score >= 70) return 'sequence_week';
  if (score >= 50) return 'research_more';
  return 'low';
}
