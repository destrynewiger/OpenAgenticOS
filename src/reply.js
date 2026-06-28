// Reply gate — the safety core of full-auto outbound. Takes an inbound reply and
// decides what happens NEXT without a human in the per-message loop:
//   unsubscribe   → suppress the contact, never message again (hard rule, no LLM)
//   send_booking  → positive + high confidence → auto-send the booking link
//   draft_reply   → on-topic but not a clean yes → draft in voice, QUEUE for approval
//   queue_human   → negative / unclear / anything risky → hand to the human
//
// Design rule: default to queue_human on ANY doubt. Auto-sending to an annoyed or
// ambiguous prospect burns the account; queuing one extra reply costs nothing.
// Deterministic rules run FIRST and can hard-decide; the LLM only refines tone and
// writes the draft. Works today on the gemini key already in the keystore.
import fs from 'node:fs';
import path from 'node:path';
import { generateJSON, llmAvailable } from './llm.js';
import { getConfig, EXPORT_DIR, DATA_DIR } from './config.js';
import { getProviderKey } from './providers/keyStore.js';
import { enrichCompanyByDomain } from './providers/amplemarket.js';

// Cache company size by domain so we don't re-enrich every reply from the same co.
const sizeCache = new Map();
async function lookupEmployees(email, cfg) {
  const domain = String(email || '').split('@')[1] || '';
  if (!domain) return undefined;
  if (sizeCache.has(domain)) return sizeCache.get(domain);
  const r = await enrichCompanyByDomain(domain, getProviderKey('amplemarket', cfg)).catch(() => null);
  const emp = Number.isFinite(r?.employees) ? r.employees : undefined;
  sizeCache.set(domain, emp);
  return emp;
}

// Hard suppression — must win over everything. One false-negative here = a
// compliance problem, so keep the net wide.
const UNSUB = /\b(unsubscribe|stop emailing|remove me|opt[- ]?out|take me off|do ?not (contact|email)|leave me alone)\b/i;
// Clear negatives — never auto-respond, let the human read the room.
const NEGATIVE = /\b(not interested|no thanks?|no thank you|not (a )?(good )?(fit|time)|already (have|use|using)|we use|wrong person|go away|piss off|stop)\b/i;
// Positive booking intent.
const POSITIVE = /\b(interested|sounds good|let'?s (chat|talk|connect)|happy to|love to|book|calendar|cal(?:endly)?|what times?|send (me )?(a |some )?times?|available|free (next|this) week|set up (a )?(call|time|meeting)|demo|learn more|tell me more)\b/i;
// A question without commitment — answer it, but a human should sign off.
const QUESTION = /\?\s*$|^\s*(how|what|why|when|who|where|can you|does it|do you|is it|are you)\b/i;
// Confirming a specific offered time → hand to the invite flow (colleague hold + Meet).
const CONFIRM = /\b(works for me|that works|works|let'?s do it|book it|confirmed?|lock it in|see you then|sounds good|go with|let'?s do)\b/i;
const TIMEREF = /\b(mon|tue|wed|thu|fri|monday|tuesday|wednesday|thursday|friday|tomorrow|\d{1,2}\s?(am|pm)|\d{1,2}:\d{2})\b/i;

// ctx = { contact:{name,...}, account:{name,...}, bookingUrl, sellerName }
export async function classifyReply(text, ctx = {}) {
  const body = String(text || '').trim();
  const bookingUrl = ctx.bookingUrl || process.env.BOOKING_URL || '';
  const seller = ctx.sellerName || getConfig().seller?.name || '';
  const slots = ctx.slots || trackSlots(ctx); // size-routed open times
  const framing = ctx.framing || trackLabel(ctx); // e.g. "founder intro" for commercial

  // ---- deterministic gate (authoritative for the hard cases) ----
  if (!body) return decision('queue_human', 0.0, 'empty reply', { body, ctx });

  // Amplemarket already classifies each reply (labels: Interested / hard_no /
  // not_interested / ooo / unsubscribe). Use it as a strong prior — it can only
  // make us MORE cautious, never auto-send something the rules wouldn't.
  const label = String(ctx.amplemarketLabel || '').toLowerCase().replace(/\s+/g, '_');
  if (UNSUB.test(body) || label === 'unsubscribe') {
    return decision('unsubscribe', 1.0, label === 'unsubscribe' ? 'amplemarket label: unsubscribe' : 'opt-out language detected', { body, ctx });
  }
  if (label === 'ooo' || label === 'out_of_office' || label === 'auto_reply') {
    return decision('queue_human', 0.5, `amplemarket label: ${label} — no auto-action`, { body, ctx });
  }
  const negative = NEGATIVE.test(body) || label === 'hard_no' || label === 'not_interested';
  const positive = POSITIVE.test(body) || label === 'interested';
  const question = QUESTION.test(body);

  // Negative always goes to a human — never auto-send into a "no".
  if (negative && !positive) {
    return decision('queue_human', 0.9, 'negative sentiment', { body, ctx });
  }

  // ---- LLM refinement (tone + draft). Falls back to rules on any failure. ----
  let llm = null;
  const runCfg = cfgWithGemini(getConfig());
  if (llmAvailable(runCfg)) {
    llm = await classifyWithLlm(body, { ...ctx, slots, framing }, runCfg).catch(() => null);
  }

  // Merge: rules set the floor, the LLM can only make us MORE cautious, not less.
  const sentiment = llm?.sentiment || (positive ? 'positive' : question ? 'neutral' : 'unclear');
  const conf = clamp(Math.min(
    llm?.confidence ?? (positive ? 0.75 : 0.4),
    // any whiff of negative caps confidence low regardless of what the LLM says
    negative ? 0.35 : 1,
  ));
  const draft = llm?.draft || templateDraft({ body, positive, question, seller, bookingUrl, slots, framing, ctx });

  // ---- route ----
  // Confirming a specific time → invite flow (a Claude job holds the covering
  // colleague's calendar + sends the prospect a Meet invite). Webhook enqueues it.
  const isConfirm = !negative && CONFIRM.test(body) && TIMEREF.test(body);
  let action;
  if (isConfirm) {
    action = 'confirm_time';
  } else if (sentiment === 'positive' && conf >= 0.7 && !negative) {
    // auto-book only if we can offer something concrete: a real open slot or a link
    action = (slots.length || bookingUrl) ? 'send_booking' : 'draft_reply';
  } else if (question || sentiment === 'neutral') {
    action = 'draft_reply';
  } else {
    action = 'queue_human';
  }
  return decision(action, conf, llm?.reason || `${sentiment}; rules+llm`, { body, ctx, draft, sentiment });
}

function decision(action, confidence, reason, { body, ctx, draft = '', sentiment = '' }) {
  return {
    action,                       // unsubscribe | send_booking | draft_reply | queue_human
    sentiment: sentiment || (action === 'unsubscribe' ? 'opt_out' : ''),
    confidence: Math.round(confidence * 100) / 100,
    reason,
    draft: action === 'unsubscribe' || action === 'queue_human' ? '' : draft,
    auto: action === 'send_booking' || action === 'unsubscribe', // safe to act without a human
    contact: ctx.contact?.name || ctx.contact?.email || '',
    account: ctx.account?.name || '',
    reply: body.slice(0, 500),
  };
}

async function classifyWithLlm(body, ctx, cfg) {
  const system = [
    `You triage inbound replies to cold sales outreach for ${cfg.seller?.company || 'our company'} (incident response / on-call software).`,
    `Classify the reply and, if a response is warranted, draft a SHORT reply in a calm, peer-to-peer SDR voice (no hype, no exclamation marks, plain text).`,
    `Return STRICT JSON: { "sentiment": "positive|neutral|negative|unclear", "confidence": 0..1, "reason": "<8 words", "draft": "<reply or empty>" }.`,
    `Rules: if they ask a question, answer it briefly then offer a short call. If positive, propose a specific time from the OPEN TIMES below — offer one or two, do NOT invent other times. Never invent product features, customers, or metrics. If unsure, say sentiment "unclear" and low confidence.`,
    /founder/i.test(ctx.framing || '') ? `Frame the meeting as a brief founder intro (our co-founder would join) — warm and low-key, not a demo.` : '',
  ].filter(Boolean).join('\n');
  const offered = (ctx.slots || []).length ? (ctx.slots || []).join(' | ') : '(none provided — offer to find a time)';
  const prompt = `Contact: ${ctx.contact?.name || 'unknown'} (${ctx.contact?.title || ''}) at ${ctx.account?.name || 'unknown'}\nOPEN TIMES (offer one or two of these exactly): ${offered}\nBooking link: ${ctx.bookingUrl || process.env.BOOKING_URL || '(none)'}\n\nINBOUND REPLY:\n"""${body}"""`;
  const out = await generateJSON(prompt, { system, cfg });
  if (!out || typeof out.sentiment !== 'string') return null;
  return {
    sentiment: out.sentiment.toLowerCase(),
    confidence: typeof out.confidence === 'number' ? out.confidence : 0.5,
    reason: String(out.reason || '').slice(0, 80),
    draft: String(out.draft || '').trim(),
  };
}

// Deterministic fallback draft so the gate still produces something with no LLM.
function templateDraft({ positive, question, seller, bookingUrl, slots = [], framing = '', ctx }) {
  const first = (ctx.contact?.name || '').split(/\s+/)[0] || 'there';
  const link = bookingUrl ? ` Or grab any time here: ${bookingUrl}` : '';
  const offer = slots.length
    ? ` I've got ${slots.slice(0, 2).join(' or ')} — does either work?`
    : ' Does a quick 20 minutes next week work?';
  const founder = /founder/i.test(framing);
  if (positive) {
    return founder
      ? `Thanks ${first} — I'd love to set up a quick founder intro with our co-founder.${offer}${link}`
      : `Thanks ${first} — happy to walk you through it.${offer}${link}`;
  }
  if (question) return `Good question, ${first}. Short version: we own the incident response workflow after the page — orchestration, comms, and retros. Easiest to show you live.${offer}${link}`;
  return `Thanks for the note, ${first}. Worth a quick call to see if it's relevant?${offer}${link}`;
}

function cfgWithGemini(cfg) {
  const geminiKey = getProviderKey('gemini', cfg);
  if (!geminiKey || cfg.llm.openaiKey || cfg.llm.anthropicKey || cfg.llm.geminiKey) return cfg;
  return { ...cfg, llm: { ...cfg.llm, geminiKey, model: /gemini/i.test(cfg.llm.model || '') ? cfg.llm.model : 'gemini-2.5-flash' } };
}

// Real open times the auto-booking offers, per colleague track. The refresh job
// rewrites data/booking-slots.json daily (calendar slots go stale). Empty/missing
// → gate falls back to a link or queues.
function loadSlotsConfig() {
  try {
    const f = path.join(DATA_DIR, 'booking-slots.json');
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch { return null; }
}

// Route a reply to a track by company size: under the threshold -> commercial;
// at/over -> enterprise. Explicit ctx.track wins.
// Explicit ctx.track wins. Unknown size → default_track (enterprise = full coverage).
export function pickTrack(ctx = {}) {
  if (ctx.track) return ctx.track;
  const cfg = loadSlotsConfig() || {};
  const max = cfg.size_routing?.commercial_max_employees ?? 100;
  const emp = Number(ctx.employees);
  if (Number.isFinite(emp)) return emp < max ? 'commercial' : 'enterprise';
  return cfg.default_track || 'enterprise';
}

// ctx.slots (incl. []) bypasses the file entirely (used by the self-check).
export function trackSlots(ctx = {}) {
  const cfg = loadSlotsConfig();
  if (!cfg) return [];
  if (Array.isArray(cfg.slots)) return cfg.slots.filter(Boolean); // legacy flat shape
  const tracks = cfg.tracks || {};
  const key = pickTrack(ctx);
  const t = tracks[key] || tracks[cfg.default_track || 'enterprise'] || {};
  return Array.isArray(t.slots) ? t.slots.filter(Boolean) : [];
}

// Label for the chosen track (e.g. "founder intro") — drives the draft framing.
function trackLabel(ctx = {}) {
  const cfg = loadSlotsConfig();
  return cfg?.tracks?.[pickTrack(ctx)]?.label || '';
}

const clamp = (n) => Math.max(0, Math.min(1, n));

// Batch triage for the reply loop. items: [{ text, contact, account }]. Returns
// triaged actions. Nothing is executed here — auto:true rows are READY to act
// (send booking link / suppress), but the actual send/suppress goes through your
// verified Amplemarket path so this stays safe to run unattended.
export async function triageBatch(items = [], ctx = {}) {
  const out = [];
  for (const it of items) {
    const r = await classifyReply(it.text, { ...ctx, contact: it.contact, account: it.account });
    out.push(r);
  }
  const counts = out.reduce((m, r) => ((m[r.action] = (m[r.action] || 0) + 1), m), {});
  return { count: out.length, counts, actions: out };
}

// Handle one Amplemarket reply webhook (verified payload shape:
// https://docs.amplemarket.com/webhooks/events/replies). Parses → triages →
// appends the action to data/exports/reply_actions.jsonl. Returns the decision.
// Nothing is sent here; auto:true rows are READY for your verified send/suppress path.
export async function recordReplyWebhook(payload = {}, ctx = {}) {
  if (!payload || payload.is_reply === false) return { skipped: 'not a reply' };
  const cfg = getConfig();
  const df = payload.dynamic_fields || {};
  const contact = { name: [df.first_name, df.last_name].filter(Boolean).join(' '), email: df.email || '', title: df.title || '' };
  const account = { name: df.company_name || '' };
  const label = Array.isArray(payload.labels) ? payload.labels[0] : payload.labels;
  const employees = await lookupEmployees(df.email, cfg); // company size → size routing
  const r = await classifyReply(payload.body || '', {
    contact, account, employees,
    sequence: payload.sequence?.name || '',
    amplemarketLabel: label,
    bookingUrl: ctx.bookingUrl || process.env.BOOKING_URL,
    sellerName: ctx.sellerName || cfg.seller?.name,
  });
  const track = pickTrack({ employees });
  const row = { ...r, track, employees: employees ?? null, sequence: payload.sequence?.name || '', sequence_id: payload.sequence?.id || '', subject: payload.subject || '', at: new Date().toISOString() };
  try {
    fs.mkdirSync(EXPORT_DIR, { recursive: true });
    fs.appendFileSync(path.join(EXPORT_DIR, 'reply_actions.jsonl'), JSON.stringify(row) + '\n');
    // Confirming a time → queue an invite for the Claude invite-processor to action.
    if (r.action === 'confirm_time') {
      const invite = {
        status: 'pending',
        prospect: { name: contact.name, email: contact.email, company: account.name },
        track, employees: employees ?? null,
        reply: (payload.body || '').slice(0, 600),
        sequence: payload.sequence?.name || '',
        at: row.at,
      };
      fs.appendFileSync(path.join(EXPORT_DIR, 'pending-invites.jsonl'), JSON.stringify(invite) + '\n');
    }
  } catch { /* non-fatal: still return the decision */ }
  return row;
}

// ---- runnable self-check: node src/reply.js --self-check (rules only, no network) ----
async function selfCheck() {
  const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exitCode = 1; } else console.log('ok:', m); };
  const noLlm = { sellerName: 'Seller', slots: [] }; // no link, no slots -> positive must NOT auto-book
  const cases = [
    ['unsubscribe me please', 'unsubscribe', true],
    ['Take me off your list', 'unsubscribe', true],
    ['not interested, we already use PagerDuty', 'queue_human', false],
    ['No thanks', 'queue_human', false],
    ['Tuesday at 2pm works for me', 'confirm_time', false],
    ['', 'queue_human', false],
  ];
  for (const [text, wantAction, wantAuto] of cases) {
    const r = await classifyReply(text, noLlm);
    assert(r.action === wantAction, `"${text.slice(0, 24)}" → ${r.action} (want ${wantAction})`);
    assert(r.auto === wantAuto, `"${text.slice(0, 24)}" auto=${r.auto} (want ${wantAuto})`);
  }
  // Positive auto-books when we can offer something concrete (real slot OR link).
  const withSlots = await classifyReply("Interested — what times work next week?", { sellerName: 'Seller', slots: ['Mon Jun 22, 2:00 PM PT'] });
  assert(withSlots.action === 'send_booking' && withSlots.auto, 'positive+slot → send_booking auto');
  const withLink = await classifyReply("Interested — what times work next week?", { sellerName: 'Seller', slots: [], bookingUrl: 'https://cal.com/seller' });
  assert(withLink.action === 'send_booking' && withLink.auto, 'positive+link → send_booking auto');
  const noOffer = await classifyReply("Interested — what times work next week?", { sellerName: 'Seller', slots: [] });
  assert(noOffer.action !== 'send_booking', 'positive+NO offer → never fabricate a booking');
  console.log(process.exitCode ? '\nSELF-CHECK FAILED' : '\nself-check passed');
}

if (process.argv[1] && process.argv[1].endsWith('reply.js') && process.argv.includes('--self-check')) {
  selfCheck();
}
