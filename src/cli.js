// Command-line driver for the command center. Same engine as the server, no UI.
//   node src/cli.js <command> [args]
// Commands:
//   seed                         import sample-data/sample_accounts.csv
//   import <file> [--contacts]   import an accounts (or contacts) CSV
//   import-real <call-list.csv> [--warm warm.csv] [--remove-examples]
//   research [<id> | --all]      run research for one account or all
//   rescore                      recompute every score
//   list                         print the priority list
//   show <id>                    print an account brief
//   callnotes <id>               (re)generate a call card
//   export <apollo|amplemarket> [--ids 1,2] [--status s] [--out file]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig } from './config.js';
import { connect } from './db.js';
import * as db from './models.js';
import * as svc from './service.js';
import { importAccountsCsv, importContactsCsv, importRealGtm } from './importer.js';
import { runResearch, runResearchBatch } from './research/index.js';
import { generateAndSave } from './callnotes.js';
import { writeExport } from './exporter.js';
import { BANDS } from './scoring.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const cfg = getConfig();
connect();

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name) => args.includes(name);
const opt = (name, d) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : d; };
const idsOpt = () => String(opt('--ids', '')).split(',').map((s) => Number(s.trim())).filter(Boolean);

function printList() {
  const cards = svc.listCards({});
  if (!cards.length) return console.log('No accounts yet. Run: npm run cli seed');
  console.log(`\n${cards.length} accounts (by priority):\n`);
  for (const c of cards) {
    const tag = (BANDS[c.band]?.label || c.band).padEnd(20);
    console.log(`  [${String(c.score).padStart(4)}] ${tag} ${c.name}  ${c.firstContact ? '→ ' + c.firstContact.name + ' (' + (c.firstContact.persona_role || '') + ')' : '→ (no contacts)'}`);
    console.log(`         next: ${c.next_action || '—'}`);
  }
  console.log('');
}

function printShow(id) {
  const d = svc.detailView(id);
  if (!d) return console.log('not found');
  const a = d.account;
  console.log(`\n${a.name}  —  score ${a.score} (${BANDS[a.band]?.label})  —  status ${a.status}`);
  console.log(`  website: ${a.website || '—'}   rootly: ${a.rootly_customer}   pagerduty: ${a.pagerduty_customer}`);
  console.log(`  incident stack: ${a.incident_stack || '—'}`);
  console.log(`  status page: ${a.status_page_url || 'No public status page found'} (${a.status_page_provider || 'unknown'})`);
  console.log(`  next action: ${a.next_action || '—'}`);
  console.log(`  reasons: ${(a.score_reasons || []).join(', ')}`);
  console.log(`\n  team map:`);
  for (const [lvl, list] of Object.entries(d.teamMap)) {
    if (!list.length) continue;
    console.log(`    ${lvl}: ${list.map((c) => `${c.name} (${c.persona_role || c.title})`).join(', ')}`);
  }
  if (d.quotes.length) { const q = d.quotes[0]; console.log(`\n  quote: "${q.quote}" — ${q.source_name} ${q.source_date}\n  why it matters: ${q.interpretation}`); }
  if (d.missing.length) console.log(`\n  missing: ${d.missing.join(', ')}`);
  console.log('');
}

async function main() {
  switch (cmd) {
    case 'seed': {
      const file = path.join(ROOT, 'sample-data', 'sample_accounts.csv');
      const out = importAccountsCsv(fs.readFileSync(file, 'utf8'), { source: 'seed' });
      console.log('seeded:', out);
      console.log('Tip: run `npm run cli research --all` to enrich them.');
      break;
    }
    case 'import': {
      const file = args[1];
      if (!file || !fs.existsSync(file)) return console.error('usage: import <file.csv> [--contacts]');
      const text = fs.readFileSync(file, 'utf8');
      console.log(flag('--contacts') ? importContactsCsv(text, { source: file }) : importAccountsCsv(text, { source: file }));
      break;
    }
    case 'import-real': {
      const file = args[1];
      if (!file || !fs.existsSync(file)) return console.error('usage: import-real <call-list.csv> [--warm warm.csv] [--remove-examples]');
      const warm = opt('--warm', '');
      if (warm && !fs.existsSync(warm)) return console.error('warm file not found: ' + warm);
      console.log(importRealGtm({
        callListText: fs.readFileSync(file, 'utf8'),
        warmListText: warm ? fs.readFileSync(warm, 'utf8') : '',
        source: file,
        removeExamples: flag('--remove-examples'),
      }));
      break;
    }
    case 'research': {
      if (flag('--all') || !args[1]) { console.log(await runResearchBatch([], { cfg })); }
      else { const d = await runResearch(Number(args[1]), { cfg }); console.log(`researched ${d.account.name}: score ${d.account.score} (${d.account.band})`); }
      break;
    }
    case 'rescore': console.log(svc.rescoreAll()); break;
    case 'list': printList(); break;
    case 'show': printShow(Number(args[1])); break;
    case 'callnotes': { const r = await generateAndSave(Number(args[1]), { cfg }); console.log(JSON.stringify(r, null, 2)); break; }
    case 'export': {
      const target = args[1] === 'amplemarket' ? 'amplemarket' : 'apollo';
      let ids = idsOpt();
      if (opt('--status')) ids = db.listAccounts({ status: opt('--status') }).map((a) => a.id);
      const out = writeExport(target, ids);
      if (opt('--out')) { fs.copyFileSync(out.file, opt('--out')); console.log('wrote', opt('--out')); }
      console.log(`exported ${out.count} rows → ${out.file}${out.skipped.length ? ' (skipped no-contact: ' + out.skipped.join(', ') + ')' : ''}`);
      break;
    }
    default:
      console.log('commands: seed | import <file> [--contacts] | import-real <call-list.csv> [--warm warm.csv] [--remove-examples] | research [<id>|--all] | rescore | list | show <id> | callnotes <id> | export <apollo|amplemarket> [--ids 1,2|--status s] [--out file]');
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
