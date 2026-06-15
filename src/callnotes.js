// Call-prep card generation. Deterministic templates that use ONLY known facts.
// Honesty rules (hard requirements):
//   - If data is missing, say "unknown" / "needs research".
//   - Never claim an outage unless an outage signal exists.
//   - Never claim a specific seller/product integration unless the data confirms it.
//   - Never invent customer references or competitor claims.
// When an LLM key is present, we ask it to *rewrite for tone* from the same
// facts; on any failure we keep the template. The template is always the floor.
import * as db from './models.js';
import { getConfig } from './config.js';
import { generateJSON, llmAvailable } from './llm.js';
import { pickFirstContact } from './personas.js';
import { getProviderKey } from './providers/keyStore.js';
import { systemContext, talkTrackFor } from './knowledge/brain.js';

const PAIN_BY_LEVEL = {
  end_user: 'Alert fatigue and noisy on-call; manual coordination across chat, paging, and ticketing during incidents.',
  manager: 'On-call burnout, inconsistent incident process, and MTTR pressure on the team.',
  decision_maker: 'Reliability/MTTR as a reported metric, tool sprawl, and proving ROI on incident tooling.',
  department_head: 'Customer-impacting downtime, exec/customer comms during incidents, and overall operational maturity.',
  '': 'Coordinating people and comms quickly when something breaks.',
};

const SIGNAL_OPENER = {
  outage: (s) => `Saw the recent reliability event (${trim(s.detail || s.label)}).`,
  new_to_role: (s) => `Saw ${trim(s.label)} — new leaders usually re-evaluate the incident/on-call stack early.`,
  infra_scaling: (s) => `Saw you're scaling ${trim(s.detail || s.label)}.`,
  ai_initiative: (s) => `Saw the push into ${trim(s.detail || s.label)}.`,
  eval: (s) => `Heard you may be evaluating tooling in this space (${trim(s.label)}).`,
  filing_quote: (s) => `Noticed reliability/scale called out publicly (${trim(s.label)}).`,
};

const trim = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 120);

function sellerProduct(cfg = getConfig()) {
  const company = String(cfg.seller?.company || '').trim();
  return company && !/^your company$/i.test(company) ? company : 'your product';
}

function bestSignal(signals) {
  const order = ['outage', 'new_to_role', 'infra_scaling', 'ai_initiative', 'eval', 'filing_quote'];
  for (const k of order) { const s = signals.find((x) => x.kind === k); if (s) return s; }
  return null;
}

// Pure builder. bundle = { account, signals, quotes, tech }, contact optional.
export function buildCard(bundle, contact) {
  const a = bundle.account;
  const seller = sellerProduct();
  const signals = bundle.signals || [];
  const level = contact?.persona_level || '';
  const role = contact?.persona_role || contact?.title || 'the team';
  const pd = a.pagerduty_customer === 'yes';
  const sig = bestSignal(signals);

  // why_person
  const why_person = contact
    ? `${role} owns/feels incident response day-to-day${level ? ` (${level.replace('_', ' ')})` : ''}.`
    : 'No contact selected yet — map a person before calling (needs research).';

  // likely_pain (persona-aware, plus PD context if known)
  let likely_pain = PAIN_BY_LEVEL[level] || PAIN_BY_LEVEL[''];
  if (pd) likely_pain += ' Likely running PagerDuty for paging today.';

  // opening_line — reference a real signal if we have one, else PD, else generic
  let opening_line;
  if (sig && SIGNAL_OPENER[sig.kind]) {
    opening_line = `${SIGNAL_OPENER[sig.kind](sig)} Usually that means incident response gets messy across SRE, support, and exec comms — is PagerDuty still where most of that coordination lives today?`;
  } else if (pd) {
    opening_line = `Curious how incident response works once PagerDuty fires — where does the coordination, comms, and follow-up actually happen for ${a.name} today?`;
  } else {
    opening_line = `When something breaks for ${a.name}, how do the right people get pulled in and how do you handle customer/exec comms? (No assumptions — genuinely trying to understand your current setup.)`;
  }

  // rootly_angle — broad, no invented integrations
  const rootly_angle = pd
    ? `Many teams keep paging where it is and add ${seller} for what happens after the page: response orchestration, automation, comms, and retros in one workflow.`
    : `${seller} brings incident response, on-call, stakeholder comms, and automation into a single workflow. Tailor to whatever they say hurts most.`;

  // good_question — discovery, persona-aware
  const good_question = level === 'decision_maker' || level === 'department_head'
    ? 'How are you measuring incident performance today (MTTR, on-call load, customer comms), and who looks at it?'
    : 'Walk me through your last painful incident — who got pulled in, where did coordination happen, and what slowed you down?';

  // objection + response — depends on PD knowledge
  const likely_objection = pd ? 'We already use PagerDuty.' : 'We have a process / not a priority right now.';
  const best_response = pd
    ? `Totally. ${seller} is not a paging replacement. It owns the response after the alert: orchestration, automation, comms, and learning. Worth 20 minutes to compare where the manual work still lives?`
    : 'Fair — most teams do until an incident exposes the manual coordination cost. Worth 20 minutes to pressure-test your current flow against a few patterns we see?';

  const next_step = 'Book a 20-min working session; bring one recent incident to walk through.';

  return {
    why_person, likely_pain, opening_line, rootly_angle,
    good_question, likely_objection, best_response, next_step,
    generated_by: 'template',
  };
}

// Build + persist a card for an account's first (or specified) contact.
// Optionally upgrade tone with an LLM when a key is configured.
export async function generateAndSave(accountId, { contactId, useLlm = true, cfg = getConfig() } = {}) {
  const bundle = db.getAccountBundle(accountId);
  if (!bundle) throw new Error('account not found');
  const contact = contactId
    ? bundle.contacts.find((c) => c.id === Number(contactId))
    : pickFirstContact(bundle.contacts);

  let card = buildCard(bundle, contact);

  const runCfg = cfgWithDashboardGemini(cfg);
  if (useLlm && llmAvailable(runCfg)) {
    const improved = await llmRewrite(bundle, contact, card, runCfg);
    if (improved) card = { ...improved, generated_by: 'llm' };
  }

  const saved = db.addCallNote(accountId, contact ? contact.id : null, card);
  db.audit({
    account_id: accountId, action: 'generate_call_notes',
    source: card.generated_by, result: contact ? `card for ${contact.name}` : 'account-level card',
    confidence: 80,
  });
  return { ...saved, contact };
}

function cfgWithDashboardGemini(cfg) {
  const geminiKey = getProviderKey('gemini', cfg);
  if (!geminiKey || cfg.llm.openaiKey || cfg.llm.anthropicKey || cfg.llm.geminiKey) return cfg;
  return {
    ...cfg,
    llm: {
      ...cfg.llm,
      geminiKey,
      model: /gemini/i.test(cfg.llm.model || '') ? cfg.llm.model : 'gemini-2.5-flash',
    },
  };
}

// Generate a template card for EVERY mapped contact (used by research / the
// "generate all" button). Template-only by design so a batch never fans out
// into N LLM calls; use generateAndSave(contactId) for an LLM-enhanced single.
export function generateAllForAccount(accountId) {
  const bundle = db.getAccountBundle(accountId);
  if (!bundle) throw new Error('account not found');
  db.clearCallNotes(accountId);
  if (!bundle.contacts.length) {
    const card = buildCard(bundle, null);
    db.addCallNote(accountId, null, card);
    return { count: 0, accountLevel: true };
  }
  for (const c of bundle.contacts) db.addCallNote(accountId, c.id, buildCard(bundle, c));
  db.audit({ account_id: accountId, action: 'generate_call_notes', source: 'template', result: `${bundle.contacts.length} cards`, confidence: 80 });
  return { count: bundle.contacts.length, accountLevel: false };
}

// Ask the model to rewrite the SAME facts more naturally. Strict instructions
// against inventing anything; we validate the shape before trusting it.
async function llmRewrite(bundle, contact, card, cfg) {
  const a = bundle.account;
  const track = talkTrackFor(contact || {}, a);
  const facts = {
    company: a.name,
    pagerduty: a.pagerduty_customer,
    rootly: a.rootly_customer,
    incident_stack: a.incident_stack || 'unknown',
    signals: (bundle.signals || []).map((s) => `${s.kind}: ${s.label}`),
    quotes: (bundle.quotes || []).map((q) => `"${q.quote}" — ${q.source_name} ${q.source_date}`),
    contact: contact ? { name: contact.name, title: contact.title, level: contact.persona_level } : null,
    persona_angle: track.angle,
    suggested_cta: track.cta,
  };
  const system = [
    `You are a senior SDR coach for ${sellerProduct(cfg)} (incident response / on-call). Rewrite call-prep fields to be tight and natural. Use ONLY the facts provided. Do not invent outages, integrations, customers, metrics, or competitor claims. If a fact is missing, keep it vague rather than fabricating. Use the persona_angle and suggested_cta to aim the card at this person. Return STRICT JSON with keys: why_person, likely_pain, opening_line, rootly_angle, good_question, likely_objection, best_response, next_step. Keep each under 40 words.`,
    '',
    systemContext(),
  ].join('\n');
  const prompt = `FACTS:\n${JSON.stringify(facts, null, 2)}\n\nDRAFT (rewrite for tone, keep facts):\n${JSON.stringify(card, null, 2)}`;
  const out = await generateJSON(prompt, { system, cfg });
  const keys = ['why_person', 'likely_pain', 'opening_line', 'rootly_angle', 'good_question', 'likely_objection', 'best_response', 'next_step'];
  if (out && keys.every((k) => typeof out[k] === 'string' && out[k].trim())) {
    return Object.fromEntries(keys.map((k) => [k, out[k].trim()]));
  }
  return null;
}
