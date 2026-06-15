// Seed a persistent demo DB (data/cockpit-demo.db) for visual verification of
// the Call Queue + cockpit. Never touches data/gtm.db. Safe to re-run (resets).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DBF = process.env.DATABASE_FILE || path.join(ROOT, 'data', 'cockpit-demo.db');
process.env.DATABASE_FILE = DBF;
process.env.BRAIN_DIR = process.env.BRAIN_DIR || path.join(ROOT, 'sample-data', 'brain');
['', '-wal', '-shm'].forEach((s) => { try { fs.rmSync(`${DBF}${s}`, { force: true }); } catch {} });

const { connect } = await import('../src/db.js');
connect();
const db = await import('../src/models.js');
const { rescoreAccount } = await import('../src/service.js');
const { buildQueue } = await import('../src/callQueue.js');

function account(name, website, contacts, signal) {
  const a = db.createAccount({ name, website, pagerduty_customer: 'yes', rootly_customer: 'no' });
  db.addSignal(a.id, signal);
  for (const c of contacts) db.upsertContact(a.id, c);
  rescoreAccount(a.id);
  return a;
}

account('Northwind Logistics', 'northwind.test',
  [
    { name: 'Dana Reyes', title: 'VP Engineering', phone: '+1 (415) 555-0142', email: 'dana@northwind.test', linkedin: 'https://www.linkedin.com/in/danareyes', persona_level: 'decision_maker', persona_role: 'VP Engineering', confidence: 90 },
    { name: 'Sam Patel', title: 'SRE Manager', phone: '+1 (415) 555-0199', email: 'sam@northwind.test', linkedin: 'https://www.linkedin.com/in/sampatel', persona_level: 'manager', persona_role: 'SRE Manager', confidence: 82 },
  ],
  { kind: 'new_to_role', label: 'New VP Engineering started', detail: 'Dana Reyes joined 3 weeks ago', source: 'sumble', confidence: 85 });

account('Helios Fintech', 'heliosfintech.test',
  [
    { name: 'Mara Lin', title: 'Head of Platform', phone: '+1 (646) 555-0117', email: 'mara@heliosfintech.test', linkedin: 'https://www.linkedin.com/in/maralin', persona_level: 'department_head', persona_role: 'Head of Platform', confidence: 88 },
    { name: 'Tom Avery', title: 'Staff Software Engineer', phone: '+1 (646) 555-0188', email: 'tom@heliosfintech.test', linkedin: 'https://www.linkedin.com/in/tomavery', persona_level: 'end_user', persona_role: 'Software Engineer', confidence: 75 },
  ],
  { kind: 'infra_scaling', label: 'Scaling platform team', detail: 'Hiring 4 SREs', source: 'sumble', confidence: 80 });

const out = buildQueue();
console.log('Seeded demo DB:', DBF);
console.log('Queue:', out);
console.log('First contact for cockpit demo:', db.listAllContacts().filter((c) => c.phone)[0]?.phone);
