import fs from 'node:fs';
import path from 'node:path';
import { connect } from '../src/db.js';
import { importResearchPack } from '../src/importer.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const arg = (name, fallback = '') => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] || fallback : fallback;
};
const resolveInput = (value) => value ? (path.isAbsolute(value) ? value : path.join(ROOT, value)) : '';
const files = {
  accountResearch: resolveInput(arg('account-research', process.env.ACCOUNT_RESEARCH_FILE || '')),
  people: resolveInput(arg('people', process.env.PEOPLE_RESEARCH_FILE || '')),
  outreach: resolveInput(arg('outreach', process.env.OUTREACH_HISTORY_FILE || '')),
};

function read(file) {
  if (!fs.existsSync(file)) throw new Error(`Missing import file: ${file}`);
  return fs.readFileSync(file, 'utf8');
}

function writeObsidianReceipt(result) {
  const vault = resolveInput(arg('receipt-dir', process.env.RESEARCH_PACK_RECEIPT_DIR || ''));
  if (!fs.existsSync(vault)) return null;
  const file = path.join(vault, `${new Date().toISOString().slice(0, 10)}.md`);
  const block = [
    '',
    '## OpenAgenticOS research pack import',
    '',
    '- Imported account research, role/contact research, and outreach history into OpenAgenticOS.',
    `- Dashboard repo: ${ROOT}`,
    `- Accounts touched: ${result.accounts}`,
    `- Contacts merged: ${result.contacts}`,
    `- Signals added: ${result.signals}`,
    `- Tech stack entries added: ${result.tech}`,
    `- Call logs added: ${result.callLogs}`,
    `- Follow-up tasks added: ${result.tasks}`,
    '- Source files:',
    `  - ${files.accountResearch}`,
    `  - ${files.people}`,
    `  - ${files.outreach}`,
    '',
  ].join('\n');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (!existing.includes('## OpenAgenticOS research pack import')) fs.appendFileSync(file, block);
  return file;
}

for (const [label, file] of Object.entries(files)) {
  if (!file) {
    console.error(`Missing --${label.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}=<path>`);
    console.error('Usage: npm run import:research-pack -- --account-research path.txt --people path.txt --outreach path.txt');
    process.exit(1);
  }
}

connect();
const result = importResearchPack({
  accountResearchText: read(files.accountResearch),
  peopleText: read(files.people),
  outreachText: read(files.outreach),
  source: 'research_pack_2026_06_15',
});
const obsidianFile = writeObsidianReceipt(result);
console.log(JSON.stringify({ ...result, obsidianFile }, null, 2));
