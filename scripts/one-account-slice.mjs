#!/usr/bin/env node
// One-account end-to-end slice: ingest → brief → sync → cockpit URL.
//
// Usage:
//   node scripts/one-account-slice.mjs --domain example.com
//   node scripts/one-account-slice.mjs --id 42
//
// Steps:
// 1. Ensure account exists (create/upsert if needed).
// 2. Generate / refresh the provider account brief (Sumble + others).
// 3. Sync that brief to Apollo + Amplemarket (dry-run unless flags ON).
// 4. Print the call-cockpit URL for the top contact at this account.

import { pathToFileURL } from 'node:url';
import { getConfig } from '../src/config.js';
import { connect } from '../src/db.js';
import * as db from '../src/models.js';
import { generateProviderAccountBrief } from '../src/providers/accountBrief.js';
import { syncBriefToCrm } from '../src/notesSync.js';
import { rankContactsForCalling } from '../src/personas.js';

const arg = (name, def) => {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=')[1];
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};

const domain = arg('domain', '');
const idArg = Number(arg('id', '')) || 0;
const useBrowser = process.argv.includes('--browser');

async function main() {
  connect();
  const cfg = getConfig();

  let accountId = idArg;

  if (domain) {
    const normalized = db.normalizeDomain(domain);
    if (!normalized) { console.error('Invalid domain:', domain); process.exit(1); }
    const upsert = db.upsertAccount({ name: domain, website: domain });
    if (upsert.created) {
      console.log(`Created account #${upsert.account.id} for ${normalized}`);
    } else {
      console.log(`Using existing account #${upsert.account.id} for ${normalized}`);
    }
    accountId = upsert.account.id;
  }

  if (!accountId) {
    console.error('Usage: node scripts/one-account-slice.mjs --domain <domain> | --id <accountId> [--browser]');
    process.exit(1);
  }

  const account = db.getAccount(accountId);
  if (!account) { console.error('Account not found:', accountId); process.exit(1); }

  console.log(`\n=== A. Ingest / Brief for ${account.name} ===`);
  try {
    const brief = await generateProviderAccountBrief(accountId, { cfg });
    console.log(`Brief generated (id ${brief.id}, by ${brief.generated_by}).`);
    console.log(`  Overview: ${brief.company_overview.slice(0, 100)}...`);
  } catch (e) {
    console.error('Brief generation failed:', e.message);
    // Continue to sync if an older brief exists
  }

  console.log(`\n=== B. Notes Sync (Apollo + Amplemarket)${useBrowser ? ' via Browser' : ''} ===`);
  const syncResult = await syncBriefToCrm(accountId, { cfg, method: useBrowser ? 'browser' : 'api' });
  console.log('Apollo:', syncResult.apollo?.ok ? '✅' : '⏸️', syncResult.apollo?.message || syncResult.apollo?.error || '');
  console.log('Amplemarket:', syncResult.amplemarket?.ok ? '✅' : '⏸️', syncResult.amplemarket?.message || syncResult.amplemarket?.error || '');

  console.log(`\n=== D. Cockpit URL ===`);
  const contacts = db.listContacts(accountId);
  const ranked = rankContactsForCalling(contacts).slice(0, 3);
  const top = ranked[0] || contacts[0];
  const base = cfg.sheets?.publicBase || `http://localhost:${cfg.port}`;
  if (top) {
    const url = `${base}/cockpit?contact=${encodeURIComponent(top.id)}`;
    console.log('Open cockpit:', url);
    if (top.linkedin) console.log('LinkedIn:', top.linkedin);
  } else {
    console.log('No contacts mapped yet. Add contacts or wait for enrichment.');
    console.log(`Account page: ${base}/#/accounts/${accountId}`);
  }

  console.log('');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => { console.error('slice failed:', e); process.exit(1); });
}
