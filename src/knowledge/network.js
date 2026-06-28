// Personal-network connector: reads an optional local brain/vault and surfaces
// "who do I already know" against the pipeline. The canonical graph file
// (people.jsonl) is preferred; until then we can parse a hand-maintained
// LinkedIn/outreach export markdown file.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const VAULT = process.env.BRAIN_VAULT || path.join(os.homedir(), 'AI-Memory-Vault', '14_Brain');

// Section heading → relationship status.
const STATUS = [
  [/replied|warm/i, 'warm_reply'],
  [/dinner invite/i, 'dinner_invite'],
  [/ongoing/i, 'ongoing'],
  [/cold outbound/i, 'cold'],
];
function statusFor(heading) {
  for (const [re, s] of STATUS) if (re.test(heading)) return s;
  return 'known';
}

// Pull a company name out of a bullet's prose, best-effort (display only; matching
// uses full text so a miss here never drops a warm match).
function companyOf(text) {
  const at = text.match(/@\s*([^.,;\n]+)/);
  if (at) return at[1].trim();
  const c = text.match(/\bat\s+([A-Z][^.,;\n]+)/);
  return c ? c[1].trim() : '';
}

// Parse people.jsonl (canonical) if it has rows, else an outreach export markdown.
export function loadNetwork() {
  const jsonl = path.join(VAULT, 'people.jsonl');
  try {
    if (fs.existsSync(jsonl)) {
      const rows = fs.readFileSync(jsonl, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      if (rows.length) return rows.map((p) => ({ name: p.name || '', company: p.company || '', title: p.title || '', status: p.status || 'known', text: p.context || p.summary || p.note || '', source: 'people.jsonl' }));
    }
  } catch { /* fall through to markdown */ }
  return parseTrellusExport();
}

function parseTrellusExport() {
  const md = findExport();
  if (!md) return [];
  const people = [];
  let status = 'known';
  for (const line of md.split(/\r?\n/)) {
    const h = line.match(/^##+\s+(.*)/);
    if (h) { status = statusFor(h[1]); continue; }
    const b = line.match(/^[-*]\s+\*\*(.+?)\*\*\s*[—-]\s*(.+)$/);
    if (!b) continue;
    const name = b[1].trim();
    const text = b[2].trim();
    people.push({ name, company: companyOf(text), title: '', status, text, source: 'outreach-export' });
  }
  return people;
}

function findExport() {
  try {
    const f = fs.readdirSync(VAULT).find((n) => /trellus|linkedin.*export|outreach/i.test(n) && n.endsWith('.md'));
    return f ? fs.readFileSync(path.join(VAULT, f), 'utf8') : '';
  } catch { return ''; }
}

// Warm matches for one account: any person whose record mentions the account name
// (or its domain root). Word-boundary, case-insensitive — avoids "AI" matching half
// the list. Returns the people, richest status first.
const RANK = { warm_reply: 0, ongoing: 1, dinner_invite: 2, cold: 3, known: 4 };
export function matchAccount(account, people = loadNetwork()) {
  const needles = [account.name, (account.domain || '').split('.')[0]]
    .map((s) => String(s || '').trim()).filter((s) => s.length >= 3);
  if (!needles.length) return [];
  const res = people.filter((p) => {
    const hay = `${p.company} ${p.text}`.toLowerCase();
    return needles.some((n) => new RegExp(`\\b${escapeRe(n.toLowerCase())}\\b`).test(hay));
  });
  return res.sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9));
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Whole network joined to the pipeline: each person + which pipeline account (if any)
// they map to. accountsByMatch is computed by the caller (has DB access).
export function networkSummary() {
  const people = loadNetwork();
  const byStatus = people.reduce((m, p) => ((m[p.status] = (m[p.status] || 0) + 1), m), {});
  return { count: people.length, byStatus, people, vault: VAULT };
}

// ---- self-check: node src/knowledge/network.js --self-check ----
if (process.argv[1] && process.argv[1].endsWith('network.js') && process.argv.includes('--self-check')) {
  const net = loadNetwork();
  console.log(`parsed ${net.length} people from ${net[0]?.source || '(none)'}`);
  net.slice(0, 6).forEach((p) => console.log(`  [${p.status}] ${p.name} — ${p.company || '?'} :: ${p.text.slice(0, 50)}`));
  console.log('\nmatch test — Buildkite:', matchAccount({ name: 'Buildkite' }).map((p) => p.name));
  console.log('match test — Best Buy:', matchAccount({ name: 'Best Buy' }).map((p) => p.name));
  console.log('match test — Toptal:', matchAccount({ name: 'Toptal' }).map((p) => p.name));
}
