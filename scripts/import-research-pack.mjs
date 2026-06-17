import fs from 'node:fs';
import path from 'node:path';
import { connect } from '../src/db.js';
import { importResearchPack } from '../src/importer.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const files = {
  accountResearch: '/Users/alexnewiger/.codex/attachments/a4019531-64cc-4b85-9471-dd9781d25996/pasted-text.txt',
  people: '/Users/alexnewiger/.codex/attachments/0fd4fc48-8b9f-469a-8378-aebaaee65681/pasted-text.txt',
  outreach: '/Users/alexnewiger/.codex/attachments/b8e8bc6d-43cf-409e-ba89-6990bc1de693/pasted-text.txt',
};

function read(file) {
  if (!fs.existsSync(file)) throw new Error(`Missing import file: ${file}`);
  return fs.readFileSync(file, 'utf8');
}

function writeObsidianReceipt(result) {
  const vault = '/Users/alexnewiger/Library/Mobile Documents/com~apple~CloudDocs/Documents/Obsidian Vault';
  if (!fs.existsSync(vault)) return null;
  const file = path.join(vault, '2026-06-15.md');
  const block = [
    '',
    '## GTM research pack import',
    '',
    '- Imported account research, role/contact research, and Trellus outreach history into the local GTM Command Center.',
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
  if (!existing.includes('## GTM research pack import')) fs.appendFileSync(file, block);
  return file;
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
