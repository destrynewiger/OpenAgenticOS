import * as db from './models.js';
import { getConfig } from './config.js';
import { generateJSON, llmProvider } from './llm.js';
import { pickFirstContact } from './personas.js';
import { getProviderKey } from './providers/keyStore.js';
import { systemContext } from './knowledge/brain.js';

export const RESEARCH_PROMPT_VERSION = 'research-brief-v2-outbound';

export const RESEARCH_SYSTEM_PROMPT = `You are the seller's senior GTM research engine for incident-response outbound.

Your job is to turn a contact profile plus company/account context into one concise JSON object for a seller's live command center.

Hard rules:
- Use only the facts in the supplied JSON context.
- Do not invent customer status, outages, current tooling, integrations, metrics, funding, initiatives, or PagerDuty usage.
- If a fact is unknown or unsupported, omit it from seller-facing copy instead of saying "unknown" or "needs verification".
- Do not imply the account lacks tooling or has manual process unless the supplied context explicitly says so.
- You may infer role-relevant likely pains from the contact's title, company size, reliability-sensitive environment, public status page, known signals, and known source notes, but do not present inferred pain as confirmed.
- Keep all copy specific to the contact's role and account context.
- The cold email should be under 60 words when possible and must be 65 words max.
- Cold email structure:
  Paragraph 1, what: name the specific intent signal in plain English.
  Paragraph 2, so what: explain why you are reaching out and why it should matter to them. Tie it to their role, team, company, or likely day to day. Make it feel like a real person noticed something specific.
  Paragraph 3, now what: one simple ask. The final sentence must be the ask.
- Cold email rules: 3 paragraphs max; last paragraph is only the ask; no bullets; no dashes; no em dashes; no formal sales language; no "hope you're well"; no "just checking in"; no overexplaining the seller's product; casual punctuation; put a space before the final question mark, like "open to brief chat ?"; sound like a sharp BDR texting a peer, not a marketing team.
- Return STRICT JSON only. No markdown, no prose before or after JSON.

Required JSON shape:
{
  "likely_pain": "2-4 sentences. Deep, role-specific, company-contextual pain hypotheses. Do not mention missing/unknown facts.",
  "questions_to_ask": [
    "Highly targeted strategic discovery question 1",
    "Highly targeted strategic discovery question 2",
    "Highly targeted strategic discovery question 3"
  ],
  "linkedin_touch": "First-touch LinkedIn connect note, 220 characters max, natural and specific.",
  "email_draft": "Cold email, 65 words max, exactly matching the three-paragraph what/so what/now what style rules."
}`;

function compact(v, max = 260) {
  return String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function wordCount(s) {
  return String(s || '').trim().split(/\s+/).filter(Boolean).length;
}

function trimWords(s, max = 60) {
  const words = String(s || '').replace(/\[Seller Name\]|\[Your Name\]/gi, 'there').trim().split(/\s+/).filter(Boolean);
  return words.length <= max ? words.join(' ') : words.slice(0, max).join(' ');
}

function sellerContext(cfg = getConfig()) {
  const company = String(cfg.seller?.company || '').trim();
  const safeCompany = company && !/^your company$/i.test(company) ? company : 'your product';
  return {
    company: safeCompany,
    angle: 'incident response, on-call, stakeholder comms, automation, retrospectives',
  };
}

function firstName(name) {
  return String(name || 'there').trim().split(/\s+/)[0] || 'there';
}

function bestIntentSignal(ctx) {
  const signals = ctx.signals || [];
  const textFor = (s) => `${s.kind || ''} ${s.label || ''} ${s.detail || ''}`.toLowerCase();
  const ranked = signals
    .filter((s) => !/(unknown|needs research|unverified|missing_data)/i.test(`${s.label || ''} ${s.detail || ''}`))
    .map((s) => {
      const text = textFor(s);
      let score = 0;
      if (/sumble|amplemarket/i.test(s.source || '')) score += 30;
      if (/series|funding|raised|investment/.test(text)) score += 35;
      if (/new_to_role|new hire|joined|appointed|promoted/.test(text)) score += 34;
      if (/hiring|sre|site reliability/.test(text)) score += 33;
      if (/closed lost|past customer|former customer/.test(text)) score += 32;
      if (/ai|platform|infra|migration|project|launch/.test(text)) score += 26;
      if (/warm|meeting|invite/.test(text)) score += 20;
      return { ...s, score };
    })
    .sort((a, b) => b.score - a.score);
  return ranked[0] || null;
}

function signalLine(ctx) {
  const signal = bestIntentSignal(ctx);
  if (!signal) return `Saw ${ctx.account.name} has a few current growth signals.`;
  const label = String(signal.label || '').replace(/\s+/g, ' ').trim();
  const detail = String(signal.detail || '').replace(/\s+/g, ' ').trim();
  if (/series|funding|raised|investment/i.test(`${label} ${detail}`)) return `Saw ${ctx.account.name} raised a Series B.`;
  if (/ai|platform|automation|documentation/i.test(`${label} ${detail}`)) return `Saw ${ctx.account.name} is building AI powered documentation workflows.`;
  if (/warm|meeting|invite/i.test(`${label} ${detail}`)) return `Saw there was already some recent outreach around ${ctx.account.name}.`;
  if (/hiring|sre|site reliability/i.test(`${label} ${detail}`)) return `Saw ${ctx.account.name} is hiring around reliability.`;
  if (/new_to_role|new hire|joined|appointed|promoted/i.test(`${label} ${detail}`)) return `Saw recent leadership movement at ${ctx.account.name}.`;
  return `Saw ${detail || label}.`;
}

function outboundEmailDraft(ctx) {
  const a = ctx.account;
  const c = ctx.contact || {};
  const role = c.persona_role || c.title || 'engineering';
  const first = firstName(c.name);
  const what = `Hi ${first},\n${signalLine(ctx)}`;
  const soWhat = `Given your ${role.toLowerCase()} seat, I’d imagine reliability and incident response need to stay tight as the team scales. ${ctx.seller.company} helps teams coordinate that work without adding more process.`;
  const ask = 'Is this your wheelhouse ?';
  return enforceEmailStyle(`${what}\n\n${soWhat}\n\n${ask}`);
}

function enforceEmailStyle(email) {
  let out = String(email || '')
    .replace(/[—–-]/g, ' ')
    .replace(/hope you'?re well[,.]?\s*/gi, '')
    .replace(/just checking in[,.]?\s*/gi, '')
    .replace(/\bWould you be open to\b/gi, 'Open to')
    .replace(/\?/g, ' ?')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  out = out.replace(/\s+\?/g, ' ?');
  const paragraphs = out.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).slice(0, 3);
  if (!/\?\s*$/.test(paragraphs.at(-1) || '')) {
    if (paragraphs.length >= 3) paragraphs[2] = 'Is this your wheelhouse ?';
    else paragraphs.push('Is this your wheelhouse ?');
  }
  out = paragraphs.join('\n\n');
  if (wordCount(out) > 65) {
    const last = paragraphs.at(-1) || 'Open to a brief chat ?';
    const before = trimWords(paragraphs.slice(0, -1).join('\n\n'), Math.max(8, 65 - wordCount(last)));
    out = [before, last].filter(Boolean).join('\n\n');
  }
  return out;
}

function contextFor(bundle, contact, cfg = getConfig()) {
  const a = bundle.account;
  const seller = sellerContext(cfg);
  return {
    seller,
    account: {
      name: a.name,
      domain: a.domain,
      website: a.website,
      rootly_customer: a.rootly_customer,
      pagerduty_customer: a.pagerduty_customer,
      incident_stack: a.incident_stack || 'unknown',
      status_page_url: a.status_page_url || '',
      status_page_provider: a.status_page_provider || '',
      priority_score: a.score,
      priority_band: a.band,
      current_next_action: a.next_action || '',
      notes: compact(a.notes, 800),
    },
    contact: contact ? {
      name: contact.name,
      title: contact.title,
      email: contact.email,
      phone: contact.phone ? 'present' : '',
      linkedin: contact.linkedin,
      persona_level: contact.persona_level,
      persona_role: contact.persona_role,
      source: contact.source,
      confidence: contact.confidence,
    } : null,
    signals: (bundle.signals || []).filter((s) => s.kind !== 'missing_data').slice(0, 18).map((s) => ({
      kind: s.kind, label: s.label, detail: compact(s.detail, 500), source: s.source, confidence: s.confidence,
    })),
    tech_stack: (bundle.tech || []).map((t) => ({ tool: t.tool, category: t.category, source: t.source, confidence: t.confidence })),
    status_page: bundle.statusPage ? {
      url: bundle.statusPage.url,
      provider: bundle.statusPage.provider,
      last_incident: bundle.statusPage.last_incident || '',
      source: bundle.statusPage.source,
    } : null,
    quotes: (bundle.quotes || []).slice(0, 5).map((q) => ({
      quote: compact(q.quote, 500), source_name: q.source_name, source_date: q.source_date, interpretation: compact(q.interpretation, 500),
    })),
    missing_research: [
      a.rootly_customer === 'unknown' ? 'Customer status unknown' : '',
      a.pagerduty_customer === 'unknown' ? 'PagerDuty status unknown' : '',
      !a.incident_stack && !(bundle.tech || []).length ? 'Incident stack unknown' : '',
      !a.status_page_url ? 'Status page unknown/not found' : '',
    ].filter(Boolean),
  };
}

function fallbackBrief(ctx) {
  const a = ctx.account;
  const c = ctx.contact;
  const role = c?.persona_role || c?.title || 'engineering/reliability leader';
  const knownStatus = a.status_page_url ? `A public status page is known (${a.status_page_provider || 'provider unknown'}), so customer-facing reliability is worth probing.` : '';
  const pd = a.pagerduty_customer === 'yes'
    ? 'PagerDuty is marked as detected, so ask where response work happens after the page.'
    : '';
  const stack = a.incident_stack && a.incident_stack !== 'unknown'
    ? `Known incident stack detail: ${a.incident_stack}.`
    : '';
  const name = firstName(c?.name);
  return {
    likely_pain: `${role} may care about incident coordination, on-call load, stakeholder comms, and post-incident follow-through. ${knownStatus} ${pd} ${stack}`,
    questions_to_ask: [
      `How does ${a.name} coordinate response after an alert fires, and where does that work live today?`,
      'What part of incident response is still too manual: escalation, comms, status updates, retros, or follow-up tracking?',
      'What reliability or workflow signal would make incident-response tooling worth revisiting this quarter?',
    ],
    linkedin_touch: `Hi ${name}, curious how ${a.name} handles incident coordination after alerts fire. Worth comparing notes?`,
    email_draft: outboundEmailDraft(ctx),
  };
}

function normalizeBrief(raw, fallback) {
  const out = raw && typeof raw === 'object' ? raw : {};
  const questions = Array.isArray(out.questions_to_ask) ? out.questions_to_ask : fallback.questions_to_ask;
  return {
    likely_pain: compact(out.likely_pain || fallback.likely_pain, 1200),
    questions_to_ask: questions.map((q) => compact(q, 300)).filter(Boolean).slice(0, 5),
    linkedin_touch: compact(out.linkedin_touch || fallback.linkedin_touch, 280),
    email_draft: enforceEmailStyle(out.email_draft || fallback.email_draft),
  };
}

export async function generateResearchBrief(accountId, { contactId, cfg = getConfig() } = {}) {
  const bundle = db.getAccountBundle(accountId);
  if (!bundle) throw new Error('account not found');
  const contact = contactId
    ? bundle.contacts.find((c) => c.id === Number(contactId))
    : pickFirstContact(bundle.contacts);
  const ctx = contextFor(bundle, contact, cfg);
  const fallback = fallbackBrief(ctx);
  const prompt = `Generate the research JSON for this account/contact context:\n${JSON.stringify(ctx, null, 2)}`;
  const runCfg = cfgWithDashboardGemini(cfg);
  const provider = llmProvider(runCfg);
  // Inject optional local memory hard rules so research briefs get the same
  // guardrails as call notes.
  const system = [RESEARCH_SYSTEM_PROMPT, systemContext()].join('\n');
  const raw = provider ? await generateJSON(prompt, { system, cfg: runCfg }) : null;
  const brief = normalizeBrief(raw, fallback);
  brief.email_draft = outboundEmailDraft(ctx);
  const saved = db.addResearchBrief(accountId, contact ? contact.id : null, {
    ...brief,
    prompt_version: RESEARCH_PROMPT_VERSION,
    generated_by: provider || 'template',
    model: provider ? runCfg.llm.model : '',
    source_snapshot: ctx,
  });
  db.audit({
    account_id: accountId,
    action: 'generate_research_brief',
    source: saved.generated_by,
    result: `${contact ? contact.name : 'account-level'} research brief`,
    confidence: provider ? 85 : 60,
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
