// Headless smoke test for the call-cockpit additions. Uses a throwaway DB so it
// never touches data/gtm.db. Run: node --experimental-sqlite scripts/smoke-cockpit.mjs
process.env.DATABASE_URL = 'sqlite:./data/cockpit-smoke.db';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.BRAIN_DIR = process.env.BRAIN_DIR || path.join(ROOT, 'sample-data', 'brain');
const wipe = () => ['', '-wal', '-shm'].forEach((s) => { try { fs.rmSync(`./data/cockpit-smoke.db${s}`, { force: true }); } catch {} });
wipe();

const { connect } = await import('../src/db.js');
connect();
const db = await import('../src/models.js');
const { rescoreAccount } = await import('../src/service.js');
const { buildQueue, getQueue } = await import('../src/callQueue.js');
const { cockpitForQuery, logOutcome } = await import('../src/cockpit.js');
const { syncDialSheet } = await import('../src/integrations/googleSheet.js');
const { loadBrain, keyMemory } = await import('../src/knowledge/brain.js');

// Account 1: scores into work_today; has callable + non-callable contacts.
const a1 = db.createAccount({ name: 'Acme Cloud', website: 'acmecloud.test', pagerduty_customer: 'yes', rootly_customer: 'no' });
db.addSignal(a1.id, { kind: 'warm_account', label: 'Met at SRECon', detail: 'Booth chat', source: 'manual', confidence: 90 });
db.upsertContact(a1.id, { name: 'Dana Reyes', title: 'VP Engineering', phone: '+1 (415) 555-0142', email: 'dana@acmecloud.test', linkedin: 'https://linkedin.com/in/danareyes', persona_level: 'decision_maker', persona_role: 'VP Engineering', confidence: 88 });
db.upsertContact(a1.id, { name: 'Sam Patel', title: 'SRE Manager', phone: '4155550199', email: 'sam@acmecloud.test', linkedin: 'https://linkedin.com/in/sampatel', persona_level: 'manager', persona_role: 'SRE Manager', confidence: 80 });
db.upsertContact(a1.id, { name: 'No Phone', title: 'Director of Engineering', email: 'np@acmecloud.test', persona_level: 'decision_maker', confidence: 70 });
rescoreAccount(a1.id);

// Account 2: do_not_contact → must be excluded from the queue entirely.
const a2 = db.createAccount({ name: 'Blocked Co', website: 'blocked.test', pagerduty_customer: 'yes', rootly_customer: 'no' });
db.addSignal(a2.id, { kind: 'warm_account', label: 'warm', source: 'manual', confidence: 90 });
db.upsertContact(a2.id, { name: 'Pat Doe', title: 'VP Platform', phone: '2125550111', persona_level: 'decision_maker', confidence: 85 });
rescoreAccount(a2.id);
db.updateAccount(a2.id, { do_not_contact: true });

const brain = loadBrain();
console.log('BRAIN  available:', brain.available, '| personas:', brain.personas.length, '| ctas:', brain.ctas.length);
console.log('SCORES', db.listAccounts().map((a) => ({ name: a.name, score: a.score, band: a.band, dnc: a.do_not_contact })));

console.log('BUILD ', buildQueue());
const queue = getQueue();
console.log('QUEUE ', queue.map((r) => ({ rank: r.rank, acct: r.account.name, who: r.contact?.name, phone: r.contact?.phone, why: r.whyNow })));

const cp = cockpitForQuery({ phone: '415-555-0142' });
console.log('COCKPIT', cp && {
  matchedBy: cp.matchedBy, contact: cp.contact.name, persona: cp.talkTrack.persona,
  cta: cp.talkTrack.cta, opening: (cp.card.opening_line || '').slice(0, 50), linkedin: cp.linkedin,
  rankedContacts: (cp.accountContacts || []).map((c) => c.name),
  memoryProof: (cp.memory.proof || '').slice(0, 40), memoryPositioning: !!cp.memory.positioning,
  hasIncidentIO: /incident\.io/i.test(JSON.stringify(cp)),
});

console.log('MEMORY', keyMemory());

const outcome = logOutcome({ contactId: cp.contact.id, outcome: 'meeting_booked', note: 'Booked Tue 2pm' });
console.log('OUTCOME', outcome && { ok: outcome.ok, logged: outcome.log?.outcome, queueStatus: outcome.queue?.status });
const cp2 = cockpitForQuery({ phone: '415-555-0142' });
console.log('AFTER  ', { recentOutcomes: cp2.recentOutcomes });

console.log('SHEET ', await syncDialSheet());

const ok = brain.available
  && db.listAccounts().find((a) => a.name === 'Acme Cloud').band === 'work_today'
  && queue.length === 2
  && queue.every((r) => r.contact?.phone)
  && !queue.some((r) => r.account.name === 'Blocked Co')
  && cp && cp.matchedBy === 'phone' && cp.contact.name === 'Dana Reyes' && cp.talkTrack.cta
  && /vp|platform|director|manager|leader/i.test(cp.talkTrack.persona) // VP must route to a leadership angle
  && cp.accountContacts.length >= 2 && cp.accountContacts.some((c) => c.isCurrent) // ranked contacts incl. current
  && cp.memory.proof && cp.memory.positioning // memory present
  && outcome.ok && outcome.queue.status === 'done' // outcome logged + queue advanced
  && cp2.recentOutcomes.length === 1 && cp2.recentOutcomes[0].outcome === 'meeting_booked';
console.log(ok ? '\n✅ SMOKE PASS' : '\n❌ SMOKE FAIL');
wipe();
process.exit(ok ? 0 : 1);
