// Persona classification for the team map. Maps a job title to one of four
// levels (end_user, manager, decision_maker, department_head) plus a friendly
// role label and a relevance score (how close to incident/reliability pain).
// Pure functions — no DB.

export const PERSONA_LEVELS = ['end_user', 'manager', 'decision_maker', 'department_head'];
export const LEVEL_LABEL = {
  end_user: 'End user',
  manager: 'Manager',
  decision_maker: 'Decision maker',
  department_head: 'Department head',
};

// Ordered, most-specific-first. First match wins.
const RULES = [
  // Department heads (C-level + "Head of").
  { level: 'department_head', role: 'CTO', re: /\bcto\b|chief technolog(y|ist) officer/i, rel: 70 },
  { level: 'department_head', role: 'CIO', re: /\bcio\b|chief information officer/i, rel: 55 },
  { level: 'department_head', role: 'CISO', re: /\bciso\b|chief information security officer/i, rel: 45 },
  { level: 'department_head', role: 'Head of Engineering', re: /head of (engineering|eng|platform|infrastructure|infra|reliability|sre|devops)/i, rel: 80 },

  // Decision makers (VP / Director within an eng-ops domain).
  { level: 'decision_maker', role: 'VP Engineering', re: /\b(svp|evp|vp|vice president)\b.*(engineering|platform|infrastructure|infra|reliability|sre|devops|technology|operations)/i, rel: 85 },
  { level: 'decision_maker', role: 'Director of Engineering', re: /\bdirector\b.*(engineering|platform|infrastructure|infra|reliability|sre|devops|technolog)/i, rel: 90 },
  { level: 'decision_maker', role: 'Director of Engineering', re: /(engineering|platform|infrastructure|reliability) director/i, rel: 90 },

  // Incident-specific end users (must beat the generic "manager" rule).
  { level: 'end_user', role: 'Incident Commander', re: /incident (commander|manager|response lead|response)/i, rel: 95 },
  { level: 'end_user', role: 'On-call Engineer', re: /on-?call/i, rel: 85 },

  // Managers (within an eng-ops domain).
  { level: 'manager', role: 'SRE Manager', re: /(sre|site reliability|reliability).*(manager|lead)|manager.*(sre|site reliability|reliability)/i, rel: 88 },
  { level: 'manager', role: 'Platform Manager', re: /platform.*(manager|lead)|manager.*platform/i, rel: 85 },
  { level: 'manager', role: 'DevOps Manager', re: /devops.*(manager|lead)|manager.*devops/i, rel: 82 },
  { level: 'manager', role: 'Infrastructure Manager', re: /infrastructure.*(manager|lead)|manager.*infrastructure/i, rel: 80 },
  { level: 'manager', role: 'Engineering Manager', re: /(engineering|software).*(manager)|engineering manager|\bem\b/i, rel: 70 },

  // End users / individual contributors.
  { level: 'end_user', role: 'SRE', re: /\bsre\b|site reliability engineer|reliability engineer/i, rel: 92 },
  { level: 'end_user', role: 'Platform Engineer', re: /platform engineer|platform engineering/i, rel: 88 },
  { level: 'end_user', role: 'DevOps Engineer', re: /devops|dev ops/i, rel: 85 },
  { level: 'end_user', role: 'Infrastructure Engineer', re: /infrastructure engineer|infra engineer|cloud engineer/i, rel: 78 },
  { level: 'end_user', role: 'Software Engineer', re: /software engineer|backend engineer|systems engineer|swe\b/i, rel: 50 },
];

export function classifyPersona(title) {
  const t = String(title || '').trim();
  if (!t) return { level: '', role: '', relevance: 0, matched: false };
  for (const r of RULES) {
    if (r.re.test(t)) return { level: r.level, role: r.role, relevance: r.rel, matched: true };
  }
  // Generic catch: a "manager"/"director"/"vp" with no eng domain still ranks low.
  if (/\bdirector\b|\bvp\b|vice president/i.test(t)) return { level: 'decision_maker', role: 'Director', relevance: 20, matched: true };
  if (/\bmanager\b|\blead\b/i.test(t)) return { level: 'manager', role: 'Manager', relevance: 20, matched: true };
  if (/\bchief\b|founder|ceo|coo/i.test(t)) return { level: 'department_head', role: 'Exec', relevance: 15, matched: true };
  if (/engineer|developer/i.test(t)) return { level: 'end_user', role: 'Engineer', relevance: 30, matched: true };
  return { level: '', role: t, relevance: 0, matched: false };
}

// Group contacts into a team map, capped at `perLevel` (default 2) per level,
// sorted by confidence then relevance. Expects contacts with persona_level set.
export function buildTeamMap(contacts, perLevel = 2) {
  const map = { end_user: [], manager: [], decision_maker: [], department_head: [] };
  const sorted = [...contacts].sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  for (const c of sorted) {
    const lvl = c.persona_level;
    if (map[lvl] && map[lvl].length < perLevel) map[lvl].push(c);
  }
  return map;
}

// Who to call first. Prefer a relevant decision maker, then dept head, then
// manager, then end user. Within a tier, highest confidence wins.
export const FIRST_ORDER = ['decision_maker', 'manager', 'department_head', 'end_user'];

// Order a whole contact list for calling: by persona tier (FIRST_ORDER), then
// confidence. Same precedence pickFirstContact uses; contacts with an unknown
// persona level sort last. Used by the call-queue builder.
export function rankContactsForCalling(contacts = []) {
  const tier = (c) => {
    const i = FIRST_ORDER.indexOf(c.persona_level);
    return i === -1 ? FIRST_ORDER.length : i;
  };
  return [...contacts].sort((a, b) => tier(a) - tier(b) || (b.confidence || 0) - (a.confidence || 0));
}

export function pickFirstContact(contacts) {
  if (!contacts || !contacts.length) return null;
  for (const lvl of FIRST_ORDER) {
    const inTier = contacts
      .filter((c) => c.persona_level === lvl)
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
    if (inTier.length) return inTier[0];
  }
  return [...contacts].sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0];
}
