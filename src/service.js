// Workflow service: the glue between data (models), scoring, and personas.
// Keeps models.js a pure data layer and avoids import cycles with research.
import * as db from './models.js';
import { scoreAccount, bandFor, BANDS } from './scoring.js';
import { classifyPersona, pickFirstContact, buildTeamMap } from './personas.js';
import { sequenceDisposition } from './exporter.js';

const WHY_NOW_ORDER = [
  'outage', 'new_to_role', 'infra_scaling', 'ai_initiative', 'eval', 'filing_quote',
  'pagerduty_detected', 'status_page', 'incident_stack', 'warm_account',
  'source_work_today', 'source_priority', 'historical_booked_meeting',
  'prior_thread_ready_task', 'sf_warm_task', 'sales_accepted', 'call_ready',
  'apollo_presence', 'amplemarket_presence',
];
const ACCOUNT_RESEARCH_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const PLACEHOLDER_ONLY = /^(unknown|needs research|run research|no research yet|none|n\/a|—|-)?$/i;

function placeholderText(value) {
  const s = String(value || '').replace(/\s+/g, ' ').trim();
  if (PLACEHOLDER_ONLY.test(s)) return true;
  return /no public data found|placeholder|sample only|template only/i.test(s);
}

export function accountResearchStatus(bundle, { now = new Date() } = {}) {
  const brief = bundle.latestAccountBrief || null;
  const reasons = [];
  if (!brief) {
    reasons.push('missing');
  } else {
    if (brief.generated_by === 'template') reasons.push('templated');
    const created = Date.parse(brief.created_at || '');
    if (created && Number(now) - created > ACCOUNT_RESEARCH_STALE_MS) reasons.push('stale');

    const textFields = [
      brief.company_overview,
      brief.incident_stack,
      brief.why_care,
      brief.outbound_angle,
      brief.call_prep_notes,
    ];
    const meaningfulTextCount = textFields.filter((v) => !placeholderText(v)).length;
    const evidenceCount =
      (brief.sources || []).length +
      (brief.recent_signals || []).length +
      (brief.relevant_people || []).length +
      (bundle.signals || []).filter((s) => s.kind !== 'missing_data').length +
      (bundle.tech || []).length +
      (bundle.quotes || []).length +
      (bundle.statusPage?.url ? 1 : 0);
    if (!evidenceCount && meaningfulTextCount < 2) reasons.push('placeholder');
  }
  return {
    hasRealResearch: reasons.length === 0,
    needsResearch: reasons.length > 0,
    reasons,
    latestAccountBriefId: brief?.id || null,
    generatedBy: brief?.generated_by || '',
    refreshedAt: brief?.created_at || '',
  };
}

// Classify a contact's persona from its title, then dedupe-insert it.
export function classifyAndAddContact(accountId, c) {
  const p = classifyPersona(c.title);
  const confidence = c.confidence ?? (p.matched ? Math.max(40, p.relevance) : 30);
  return db.upsertContact(accountId, {
    ...c,
    persona_level: c.persona_level || p.level,
    persona_role: c.persona_role || p.role,
    confidence,
  });
}

// Recompute score + band from everything currently known, persist, refresh the
// next-best-action, and keep workflow status coherent with the data.
export function rescoreAccount(id) {
  const bundle = db.getAccountBundle(id);
  if (!bundle) return null;
  const { score, band, reasons } = scoreAccount(bundle);

  const patch = { score, band, score_reasons: reasons, next_action: computeNextAction(bundle, band) };

  // Keep workflow status sane without overriding deliberate operator states.
  const a = bundle.account;
  if (a.rootly_customer === 'yes') {
    if (a.status !== 'already_worked') patch.status = 'blocked';
  } else if (a.status === 'blocked') {
    patch.status = 'research_needed'; // un-block if data changed
  }
  return db.updateAccount(id, patch);
}

export function rescoreAll() {
  const ids = db.listAccounts().map((a) => a.id);
  ids.forEach(rescoreAccount);
  return { rescored: ids.length };
}

// Short, operator-friendly "do this next" string. Never invents facts.
export function computeNextAction(bundle, band = bundle.account.band) {
  const a = bundle.account;
  if (a.rootly_customer === 'yes') return 'Already a customer — skip / hand to CS';

  const contacts = bundle.contacts || [];
  const first = pickFirstContact(contacts);
  const reachable = contacts.filter((c) => c.email || c.phone);

  if (!contacts.length) return 'Find contacts (provider/import) — no people mapped yet';
  if (!reachable.length) return `Enrich contact data for ${first ? first.name : 'mapped people'} (no email/phone)`;

  if (a.status === 'ready_to_call') {
    const who = first ? `${first.name}${first.persona_role ? ' (' + first.persona_role + ')' : ''}` : 'top contact';
    return `Call today: ${who}`;
  }

  if (band === 'work_today') {
    const who = first ? `${first.name}${first.persona_role ? ' (' + first.persona_role + ')' : ''}` : 'top contact';
    return `Work today: sequence/call ${who}`;
  }
  if (band === 'sequence_week') return `Sequence ${first ? first.name : 'top contact'} this week`;
  if (band === 'blocked') return 'Blocked — do not work';

  // research_more / low
  const gaps = missingResearch(bundle);
  if (gaps.length) return `Research more: ${gaps.slice(0, 2).join(', ')}`;
  return 'Review and decide';
}

// What is still missing for a confident decision. Drives the "Missing data" rail.
export function missingResearch(bundle) {
  const a = bundle.account;
  const gaps = [];
  if (a.pagerduty_customer === 'unknown') gaps.push('PagerDuty status unknown');
  if (a.rootly_customer === 'unknown') gaps.push('Customer status unverified');
  if (!a.incident_stack && (bundle.tech || []).length === 0) gaps.push('No incident stack');
  if (!a.status_page_url) gaps.push('No status page found');
  if (!(bundle.contacts || []).length) gaps.push('No contacts mapped');
  if (!(bundle.quotes || []).length) gaps.push('No public quote');
  return gaps;
}

// Operator actions.
export function approveForSequencing(id) {
  rescoreAccount(id);
  return db.updateAccount(id, { status: 'ready_to_sequence' });
}
export function markReadyToCall(id) { return db.updateAccount(id, { status: 'ready_to_call' }); }
export function markAlreadyWorked(id) { return db.updateAccount(id, { status: 'already_worked' }); }
export function setStatus(id, status) { return db.updateAccount(id, { status }); }

// Compact card for the homepage / accounts table. Adds first contact, a short
// human reason, and band presentation. One extra contacts query per account —
// fine for a single-operator local tool.
export function bestWhyNow(signals = [], account = {}) {
  for (const kind of WHY_NOW_ORDER) {
    const s = signals.find((x) => x.kind === kind);
    if (s) return s.label + (s.detail ? ` — ${s.detail}` : '');
  }
  if (account.pagerduty_customer === 'yes') return 'PagerDuty detected';
  return 'Needs research';
}

function exportSummary(latest = {}) {
  const one = (target) => latest[target]
    ? { exported: true, at: latest[target].created_at, contactCount: latest[target].contact_count, file: latest[target].file_path || '' }
    : { exported: false, at: '', contactCount: 0, file: '' };
  return { apollo: one('apollo'), amplemarket: one('amplemarket') };
}

export function accountCard(account, latestExports = {}) {
  const contacts = db.listContacts(account.id);
  const signals = db.listSignals(account.id);
  const bundle = {
    account,
    contacts,
    signals,
    tech: db.listTech(account.id),
    quotes: db.listQuotes(account.id),
  };
  const first = pickFirstContact(contacts);
  const positives = (account.score_reasons || []).filter((r) => !/\(-/.test(r));
  const reason = positives.slice(0, 3).join(' · ') || 'Needs research';
  const gaps = missingResearch(bundle);
  return {
    id: account.id,
    name: account.name,
    domain: account.domain,
    website: account.website,
    score: account.score,
    band: account.band,
    bandLabel: BANDS[account.band]?.label || account.band,
    color: BANDS[account.band]?.color || 'gray',
    status: account.status,
    pagerduty_customer: account.pagerduty_customer,
    rootly_customer: account.rootly_customer,
    incident_stack: account.incident_stack || '',
    next_action: account.next_action || '',
    reason,
    whyNow: bestWhyNow(signals, account),
    gapCount: gaps.length,
    gaps: gaps.slice(0, 4),
    needsVerification: account.rootly_customer === 'unknown' || account.pagerduty_customer === 'unknown',
    exportStatus: exportSummary(latestExports),
    contactCount: contacts.length,
    firstContact: first ? { id: first.id, name: first.name, title: first.title, persona_level: first.persona_level, persona_role: first.persona_role } : null,
  };
}

export function listCards(filter = {}) {
  const latest = db.latestExportsByAccount();
  return db.listAccounts(filter).map((a) => accountCard(a, latest.get(a.id) || {}));
}

function outreachBucket(account) {
  const notes = String(account.notes || '');
  const m = notes.match(/(?:Outreach bucket|Bucket):\s*([^\n]+)/i);
  return m ? m[1].trim() : '';
}

function targetPersonaFor(bucket = '') {
  if (/incident|cyber|security/i.test(bucket)) return 'SRE / Platform / Security Eng leader';
  if (/developer|cloud|data/i.test(bucket)) return 'Platform / Infra / Data leader';
  if (/fintech|crypto|payments/i.test(bucket)) return 'Engineering / Reliability leader';
  if (/consumer|marketplace|gaming/i.test(bucket)) return 'Platform / LiveOps / Eng leader';
  if (/enterprise|operations/i.test(bucket)) return 'Ops / Platform / Eng leader';
  return 'Engineering / Platform leader';
}

function signalWeight(s = {}) {
  const text = `${s.kind} ${s.label} ${s.detail}`.toLowerCase();
  if (/priority 1|p1|source_priority/.test(text)) return 100;
  if (/recently funded|recent funding|funding|series|raised|investment/.test(text)) return 99;
  if (/splash_logo|splash logo/.test(text)) return 98;
  if (/firehydrant|pagerduty|incident|status|outage/.test(text)) return 88;
  if (/new_to_role|hiring|funding|new project|platform|ai|infra/.test(text)) return 76;
  if (/planned outreach|bucket|source_work_today/.test(text)) return 62;
  return Number(s.confidence || 0);
}

function hasFundingSignal(signals = []) {
  return signals.some((s) => /funding|series|raised|investment/i.test(`${s.kind} ${s.label} ${s.detail}`));
}

function hasSplashSignal(signals = []) {
  return signals.some((s) => /splash_logo|splash logo/i.test(`${s.kind} ${s.label} ${s.detail}`));
}

function jjLane(signals = []) {
  if (hasFundingSignal(signals)) return 'Recently funded';
  if (hasSplashSignal(signals)) return 'Splash logo';
  return 'Build thesis';
}

function jjLaneRank(lane) {
  return lane === 'Recently funded' ? 3 : lane === 'Splash logo' ? 2 : 1;
}

export function plannedOutreachView() {
  const cards = listCards({});
  return cards
    .filter((c) => {
      const bundle = db.getAccountBundle(c.id);
      return c.band !== 'blocked' && (
        (bundle.signals || []).some((s) => s.kind === 'planned_outreach') ||
        /Outreach bucket:/i.test(bundle.account.notes || '')
      );
    })
    .map((c) => {
      const bundle = db.getAccountBundle(c.id);
      const allSignals = bundle.signals || [];
      const signals = allSignals
        .filter((s) => s.kind !== 'missing_data')
        .sort((a, b) => signalWeight(b) - signalWeight(a))
        .slice(0, 6);
      const bucket = outreachBucket(bundle.account);
      const lane = jjLane(allSignals);
      return {
        id: c.id,
        account: c.name,
        domain: c.domain || '',
        bucket,
        jjLane: lane,
        jjLaneRank: jjLaneRank(lane),
        priority: signals.some((s) => /priority 1|p1/i.test(`${s.label} ${s.detail}`)) ? 'P1' : '',
        score: c.score,
        status: c.status,
        targetName: c.firstContact?.name || '',
        targetTitle: c.firstContact?.title || c.firstContact?.persona_role || targetPersonaFor(bucket),
        targetKnown: Boolean(c.firstContact?.name),
        signals: signals.map((s) => ({
          kind: s.kind,
          label: s.label,
          detail: s.detail || '',
          source: s.source || '',
          confidence: s.confidence || 0,
          weight: signalWeight(s),
        })),
        signalSort: Math.max(0, ...signals.map(signalWeight)),
        nextAction: c.firstContact?.name ? c.next_action : `Find target: ${targetPersonaFor(bucket)}`,
      };
    })
    .sort((a, b) => b.jjLaneRank - a.jjLaneRank || (b.priority === 'P1') - (a.priority === 'P1') || b.score - a.score || b.signalSort - a.signalSort || a.account.localeCompare(b.account));
}

// Enriched detail bundle for the API: adds team map, first contact, gaps.
export function detailView(id) {
  const bundle = db.getAccountBundle(id);
  if (!bundle) return null;
  const firstContact = pickFirstContact(bundle.contacts);
  const firstCallNote = firstContact
    ? bundle.callNotes.find((n) => n.contact_id === firstContact.id) || null
    : bundle.callNotes.find((n) => !n.contact_id) || null;
  const latestResearchBrief = firstContact
    ? bundle.researchBriefs.find((b) => b.contact_id === firstContact.id) || bundle.researchBriefs[0] || null
    : bundle.researchBriefs[0] || null;
  return {
    ...bundle,
    teamMap: buildTeamMap(bundle.contacts),
    firstContact,
    firstCallNote,
    latestResearchBrief,
    accountResearch: accountResearchStatus(bundle),
    whyNow: bestWhyNow(bundle.signals, bundle.account),
    missing: missingResearch(bundle),
    exportStatus: exportSummary(bundle.latestExports),
  };
}

function trustFlags(bundle) {
  const a = bundle.account;
  return {
    rootly: a.rootly_customer === 'unknown' ? 'verify before sequencing' : a.rootly_customer,
    pagerduty: a.pagerduty_customer === 'unknown' ? 'unknown' : a.pagerduty_customer,
    incidentStack: a.incident_stack || (bundle.tech || []).map((t) => t.tool).join(', ') || 'unknown',
    sequence: sequenceDisposition(a, bundle.signals || []),
  };
}

export function closeoutView() {
  const cards = listCards({});
  const top = cards.filter((c) => c.band !== 'blocked').slice(0, 20).map((c) => {
    const bundle = db.getAccountBundle(c.id);
    return {
      id: c.id,
      account: c.name,
      domain: c.domain,
      score: c.score,
      band: c.band,
      firstContact: c.firstContact,
      nextAction: c.next_action,
      whyNow: c.whyNow,
      gaps: c.gaps,
      trust: trustFlags(bundle),
      exportStatus: c.exportStatus,
    };
  });
  const needsCustomerCheck = top.filter((x) => x.trust.rootly === 'verify before sequencing');
  const needsPagerDuty = top.filter((x) => x.trust.pagerduty === 'unknown');
  const needsStack = top.filter((x) => x.trust.incidentStack === 'unknown');
  const activeSequence = top.filter((x) => /active sequence|review active sequence/i.test(x.trust.sequence));
  const notExported = top.filter((x) => !x.exportStatus.apollo.exported || !x.exportStatus.amplemarket.exported);
  return {
    generatedAt: new Date().toISOString(),
    stats: db.stats(),
    top,
    criticalReview: [
      `${needsCustomerCheck.length} of top ${top.length} still need customer/prospect verification before sequencing.`,
      `${needsPagerDuty.length} of top ${top.length} still have unknown PagerDuty status.`,
      `${needsStack.length} of top ${top.length} still have unknown incident stack.`,
      `${activeSequence.length} of top ${top.length} already show Apollo/Amplemarket sequence activity; call/review before duplicate enrollment.`,
      `${notExported.length} of top ${top.length} are not exported to both Apollo and Amplemarket.`,
    ],
    pendingTasks: [
      ...needsCustomerCheck.slice(0, 8).map((x) => `Verify customer/prospect status: ${x.account}`),
      ...needsPagerDuty.slice(0, 8).map((x) => `Research PagerDuty/incident stack: ${x.account}`),
      ...activeSequence.slice(0, 8).map((x) => `Review active sequence before adding duplicate: ${x.account}`),
    ],
  };
}
