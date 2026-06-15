// Knowledge loader for an optional local brain folder (AGENTS.md). Parses
// persona angles, CTAs, and hard copy rules so generated briefs/call cards stay
// on-message. The public repo ships with a small sample brain.
// Pure file read — no DB. Safe when the brain file is absent (returns defaults).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

let _cache = null;

export function brainDir() {
  return process.env.BRAIN_DIR || path.join(ROOT, 'sample-data', 'brain');
}

function readBrainFile() {
  const dir = brainDir();
  for (const f of ['AGENTS.md', 'ROOTLY_KNOWLEDGE_BANK.md']) {
    const p = path.join(dir, f);
    try { if (fs.existsSync(p)) return { raw: fs.readFileSync(p, 'utf8'), filePath: p }; } catch {}
  }
  return { raw: '', filePath: '' };
}

// Split a markdown doc into { lowercased heading -> body } by `## ` headings.
function sectionMap(raw) {
  const map = {};
  for (const part of raw.split(/^##\s+/m)) {
    const nl = part.indexOf('\n');
    if (nl === -1) continue;
    const head = part.slice(0, nl).trim().toLowerCase();
    const body = part.slice(nl + 1).trim();
    if (head) map[head] = body;
  }
  return map;
}

// Keywords for matching a contact title to a persona block. Kept as multi-word
// phrases (plus a few distinctive synonyms) so generic tokens like "engineer"
// don't pull leadership titles ("VP Engineering") into the IC persona.
function labelKeywords(label) {
  const lower = label.toLowerCase();
  const base = lower.split(/ or |,|\/| and /).map((s) => s.trim()).filter((s) => s.length > 3 && /\s/.test(s));
  const extra = [];
  if (/security/.test(lower)) extra.push('security', 'ciso');
  if (/support|customer care/.test(lower)) extra.push('support', 'customer success', 'customer care');
  if (/vp|platform/.test(lower)) extra.push('vice president');
  return [...new Set([...base, ...extra])];
}

// Persona angles: each entry is a label line ending with ':' then guidance lines.
function parsePersonas(section = '') {
  const personas = [];
  let cur = null;
  for (const raw of section.split(/\r?\n/)) {
    const t = raw.trim();
    if (!t) continue;
    if (/:$/.test(t) && t.length < 80) {
      if (cur) personas.push(cur);
      const label = t.replace(/:$/, '').trim();
      cur = { label, keywords: labelKeywords(label), angle: '' };
    } else if (cur) {
      cur.angle = cur.angle ? `${cur.angle} ${t}` : t;
    }
  }
  if (cur) personas.push(cur);
  return personas;
}

function bulletLines(section = '') {
  return section.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

export function loadBrain() {
  if (_cache) return _cache;
  const { raw, filePath } = readBrainFile();
  const sections = sectionMap(raw);
  const personas = parsePersonas(sections['persona angles'] || '');
  const ctas = bulletLines(sections['good ctas'] || '');
  const avoid = bulletLines(sections['avoid'] || '').filter((s) => !/^(do not say:?|avoid\b.*)$/i.test(s));
  _cache = {
    raw, filePath, sections, personas, ctas, avoid,
    proof: sections['proof points'] || '',
    positioning: sections['positioning'] || sections['rootly positioning'] || '',
    available: !!raw,
  };
  return _cache;
}

// Short, reusable memory the cockpit surfaces on every call: positioning and
// preferred proof/customer language.
export function keyMemory() {
  const b = loadBrain();
  const preferred = (sec) => (sec.match(/preferred wording:\s*([\s\S]*?)(?:\n\n|$)/i)?.[1] || '').trim();
  const firstLine = (sec) => (sec.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || '');
  return {
    positioning: firstLine(b.positioning),
    proof: preferred(b.proof) || firstLine(b.proof),
  };
}

// Built-in fallbacks so a talk track is always present even without the file.
const LEVEL_DEFAULT_ANGLE = {
  department_head: 'Standardizing incident process across teams and reducing manual response work; ownership and stakeholder comms.',
  decision_maker: 'Coordination drag, ownership confusion, stakeholder updates, and postmortem cleanup across teams.',
  manager: 'Coordination drag, ownership confusion, stakeholder updates, and postmortem cleanup after alerts fire.',
  end_user: 'Who owns incident process, handoffs, stakeholder updates, and postmortems after alerts fire.',
  '': 'Who owns incident response after the alert fires — coordination, comms, and postmortems.',
};

// Pick the persona angle + CTA for a contact. Keyword match first, then a
// sensible default by persona level.
export function talkTrackFor(contact = {}, account = {}) {
  const brain = loadBrain();
  const hay = `${contact.title || ''} ${contact.persona_role || ''}`.toLowerCase();
  let persona = brain.personas.find((p) => p.keywords.some((k) => hay.includes(k)));
  if (!persona && brain.personas.length) {
    const level = contact.persona_level;
    const byLabel = (re) => brain.personas.find((p) => re.test(p.label));
    persona = (level === 'department_head' || level === 'decision_maker')
      ? (byLabel(/vp|platform/i) || byLabel(/director|manager/i))
      : level === 'manager' ? byLabel(/manager|director/i)
      : level === 'end_user' ? byLabel(/software engineer|staff/i)
      : null;
  }
  const angle = persona?.angle || LEVEL_DEFAULT_ANGLE[contact.persona_level || ''] || LEVEL_DEFAULT_ANGLE[''];
  const ctas = brain.ctas.length ? brain.ctas : ['Who owns incident response process there?'];
  const cta = ctas[Math.abs(Number(contact.id) || 0) % ctas.length];
  return {
    persona: persona?.label || contact.persona_role || contact.persona_level || 'Engineering leader',
    angle,
    cta,
    available: brain.available,
  };
}

// Knowledge to append to any LLM system prompt that writes prospect-facing or
// call-prep copy. Enforces the brain's hard rules. Safe when the file is absent.
export function systemContext({ maxChars = 6000 } = {}) {
  const brain = loadBrain();
  const banned = (brain.avoid || []).filter((s) => s && s.length < 40).join(', ');
  return [
    'LOCAL GTM KNOWLEDGE BANK (authoritative when present — follow it exactly):',
    brain.raw ? brain.raw.slice(0, maxChars) : '(knowledge bank file not found; follow the hard rules below)',
    '',
    'HARD RULES:',
    '- Output PLAIN TEXT only. No markdown, HTML, colors, or rich text.',
    '- Never mention ungrounded competitors, integrations, customers, or metrics.',
    '- Keep it short, tactical, and human. 1-2 sentence paragraphs.',
    banned ? `- Avoid these phrases: ${banned}.` : '',
  ].filter(Boolean).join('\n');
}
