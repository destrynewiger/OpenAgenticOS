// Wire an EXISTING Google Sheet as the Trellus dial list. Service accounts have no
// Drive storage of their own, so they can't create a sheet — you create a blank one
// and share it (Editor) with the service-account email, then run this with its id/url.
// It writes DIAL_SHEET_ID + GOOGLE_SHEETS_CREDENTIALS to .env and runs the first sync.
//
// Usage:
//   node scripts/setup-dial-sheet.mjs <sheet-id-or-url> [path/to/service-account.json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv[2];
const credsArg = process.argv[3] || 'data/dial-sa.json';
const credsPath = path.isAbsolute(credsArg) ? credsArg : path.join(ROOT, credsArg);

if (!arg) { console.error('usage: node scripts/setup-dial-sheet.mjs <sheet-id-or-url> [service-account.json]'); process.exit(1); }
if (!fs.existsSync(credsPath)) { console.error('service-account key not found at', credsPath); process.exit(1); }

const id = (arg.match(/\/d\/([a-zA-Z0-9-_]+)/) || [, arg])[1]; // accept full URL or bare id
const saEmail = JSON.parse(fs.readFileSync(credsPath, 'utf8')).client_email;
console.log('sheet id:', id);
console.log('service account:', saEmail, '(must be shared as Editor on the sheet)');

// write .env
const envPath = path.join(ROOT, '.env');
let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
const setEnv = (k, v) => {
  const re = new RegExp(`^${k}=.*$`, 'm');
  env = re.test(env) ? env.replace(re, `${k}=${v}`) : env.replace(/\s*$/, '') + `\n${k}=${v}\n`;
};
setEnv('DIAL_SHEET_ID', id);
setEnv('GOOGLE_SHEETS_CREDENTIALS', credsPath);
fs.writeFileSync(envPath, env);
console.log('.env updated: DIAL_SHEET_ID + GOOGLE_SHEETS_CREDENTIALS');

// first sync
process.env.DIAL_SHEET_ID = id;
process.env.GOOGLE_SHEETS_CREDENTIALS = credsPath;
const { connect } = await import('../src/db.js');
connect();
const { syncDialSheet } = await import('../src/integrations/googleSheet.js');
try {
  const out = await syncDialSheet();
  if (out.skipped) { console.error('\nSync skipped:', out.message); process.exit(1); }
  console.log('sync:', JSON.stringify(out));
  console.log('\nDone. Connect this sheet in Trellus as your dial list.');
} catch (e) {
  console.error('\nSync failed:', e.message);
  if (/403|permission/i.test(e.message)) console.error(`→ Share the sheet as Editor with: ${saEmail}`);
  process.exit(1);
}
