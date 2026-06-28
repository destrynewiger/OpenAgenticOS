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
import { runPipeline } from './pipeline.js';
import { classifyReply, triageBatch } from './reply.js';
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
    case 'pipeline': {
      // Full-auto run. Dry-run unless --send + ENABLE_AMPLEMARKET_PUSH=true + --sequence.
      //   pipeline [--icp-titles "VP Engineering,Head of SRE"] [--icp-domains a.com,b.com]
      //            [--limit 25] [--send --sequence <id>]
      const icp = {};
      if (opt('--icp-titles')) icp.titles = String(opt('--icp-titles')).split(',').map((s) => s.trim()).filter(Boolean);
      if (opt('--icp-seniorities')) icp.seniorities = String(opt('--icp-seniorities')).split(',').map((s) => s.trim()).filter(Boolean);
      if (opt('--icp-departments')) icp.departments = String(opt('--icp-departments')).split(',').map((s) => s.trim()).filter(Boolean);
      if (opt('--icp-domains')) icp.domains = String(opt('--icp-domains')).split(',').map((s) => s.trim()).filter(Boolean);
      if (opt('--icp-keywords')) icp.keywords = opt('--icp-keywords');
      if (opt('--icp-size')) icp.size = Number(opt('--icp-size'));
      await runPipeline({
        cfg,
        icp: Object.keys(icp).length ? icp : undefined,
        accountIds: idsOpt(),
        limit: Number(opt('--limit', 25)),
        send: flag('--send'),
        sequenceId: opt('--sequence'),
      });
      break;
    }
    case 'reply': {
      // Triage one inbound reply. reply "<text>" [--booking https://cal.com/you]
      const text = args[1] && !args[1].startsWith('--') ? args[1] : '';
      if (!text) return console.error('usage: reply "<inbound reply text>" [--booking <url>]');
      const r = await classifyReply(text, { bookingUrl: opt('--booking'), sellerName: cfg.seller?.name });
      console.log(JSON.stringify(r, null, 2));
      break;
    }
    case 'replies': {
      // Batch-triage inbound replies. replies <file.json> — [{text, contact, account}]
      // Feed it from the Amplemarket inbox (MCP list_inbox_threads → this file).
      const file = args[1];
      if (!file || !fs.existsSync(file)) return console.error('usage: replies <inbox.json>  (array of {text, contact, account})');
      const items = JSON.parse(fs.readFileSync(file, 'utf8'));
      const res = await triageBatch(items, { bookingUrl: opt('--booking') || process.env.BOOKING_URL, sellerName: cfg.seller?.name });
      const out = path.join(ROOT, 'data', 'exports', `reply_actions_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, JSON.stringify(res.actions, null, 2));
      console.log(`triaged ${res.count}:`, JSON.stringify(res.counts), `→ ${path.basename(out)}`);
      break;
    }
    case 'dedupe-contacts': {
      // Collapse same-name dup contacts within an account into the highest-
      // confidence row. Dry-run unless --apply.  dedupe-contacts [--apply]
      const apply = flag('--apply');
      const r = db.dedupeContacts({ apply });
      console.log(`${apply ? 'merged' : 'would merge'} ${r.groups} groups → delete ${r.contactsDeleted} contacts, backfill ${r.fieldsBackfilled} fields`);
      console.log(`  call_queue rows repointed: ${r.queueRepointed}   call_log rows repointed: ${r.logRepointed}`);
      if (r.callNotesDropped || r.researchBriefsDropped) {
        console.log(`  cascade-dropped on deleted rows: ${r.callNotesDropped} call_notes, ${r.researchBriefsDropped} research_briefs (survivors keep their own)`);
      }
      for (const m of r.merges.slice(0, 15)) {
        const fields = Object.keys(m.patch);
        console.log(`  acct ${m.account_id} "${m.name}": keep #${m.keepId} (${m.keepTitle || 'no title'}), drop ${m.deleteIds.map((i) => '#' + i).join(',')}${fields.length ? ' (+' + fields.join(',') + ')' : ''}`);
      }
      if (r.merges.length > 15) console.log(`  ... and ${r.merges.length - 15} more`);
      if (!apply) console.log('dry-run — re-run with --apply to write.');
      break;
    }
    case 'backfill-locations': {
      // Fill contact.location from Amplemarket for existing contacts (top accounts first).
      //   backfill-locations [--limit 50 | --all]
      const { enrichPersonLocation } = await import('./providers/amplemarket.js');
      const { getProviderKey } = await import('./providers/keyStore.js');
      const key = getProviderKey('amplemarket', cfg);
      if (!key) return console.error('no Amplemarket key configured');
      const missing = db.listAllContacts().filter((c) => c.email && !String(c.location || '').trim());
      const todo = flag('--all') ? missing : missing.slice(0, Number(opt('--limit', 50)));
      console.log(`backfilling location for ${todo.length} of ${missing.length} contacts missing it (top-score first)...`);
      let filled = 0;
      for (const c of todo) {
        const loc = await enrichPersonLocation({ email: c.email, linkedin: c.linkedin, name: c.name, domain: c.account_domain }, key);
        if (loc) { db.updateContact(c.id, { location: loc }); filled++; }
        if (filled && filled % 10 === 0) console.log(`  ${filled} filled...`);
        await new Promise((r) => setTimeout(r, 250)); // gentle on the API
      }
      console.log(`done: ${filled}/${todo.length} got a location.`);
      break;
    }
    default:
      console.log('commands: seed | import <file> [--contacts] | import-real <call-list.csv> [--warm warm.csv] [--remove-examples] | research [<id>|--all] | rescore | list | show <id> | callnotes <id> | dedupe-contacts [--apply] | backfill-locations [--limit N|--all] | pipeline [--icp-titles ..|--icp-domains ..|--limit N|--send --sequence <id>] | reply "<text>" [--booking <url>] | replies <inbox.json> | export <apollo|amplemarket> [--ids 1,2|--status s] [--out file]');
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
