// Google Sheet dial list: an optional sheet used by a dialer/calling workflow.
// We overwrite a single
// tab with one row per queued contact (in dial order) plus a Brief link back to
// the cockpit. Zero-dep: signs a service-account JWT with node:crypto and calls
// the Sheets REST API with fetch. Degrades gracefully when unconfigured.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { getConfig } from './../config.js';
import * as db from './../models.js';
import { getQueue } from './../callQueue.js';
import { talkTrackFor } from './../knowledge/brain.js';

const HEADER = ['Account', 'Name', 'Title', 'Phone', 'Mobile', 'Email', 'LinkedIn URL', 'Why now', 'Talk track', 'Brief link'];

function loadCreds(cfg) {
  const raw = cfg.sheets.credentialsJson
    ? cfg.sheets.credentialsJson
    : (cfg.sheets.credentials && fs.existsSync(cfg.sheets.credentials) ? fs.readFileSync(cfg.sheets.credentials, 'utf8') : '');
  if (!raw) return null;
  const creds = JSON.parse(raw);
  if (creds.private_key) creds.private_key = creds.private_key.replace(/\\n/g, '\n');
  return creds.client_email && creds.private_key ? creds : null;
}

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function accessToken(creds) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: creds.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  }));
  const input = `${header}.${claim}`;
  const signature = b64url(crypto.createSign('RSA-SHA256').update(input).sign(creds.private_key));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${input}.${signature}` }),
  });
  if (!res.ok) throw new Error(`google token ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token;
}

async function sheetsApi(token, path, { method = 'GET', body } = {}) {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`sheets ${method} ${res.status}: ${await res.text()}`);
  return res.json();
}

function shortTalkTrack(contact, account) {
  const t = talkTrackFor(contact, account);
  const angle = String(t.angle || '').split(/(?<=[.!?])\s+/)[0];
  return [t.persona ? `${t.persona}.` : '', angle, t.cta ? `CTA: ${t.cta}` : ''].filter(Boolean).join(' ').slice(0, 240);
}

function rowFor(q, base) {
  const c = q.contact || {};
  return [
    q.account.name || '',
    c.name || '',
    c.title || c.persona_role || '',
    c.phone || '',
    '', // Mobile — reserved for dialer column mapping
    c.email || '',
    c.linkedin || '',
    q.whyNow || '',
    shortTalkTrack(c, q.account),
    c.id ? `${base}/cockpit?contact=${c.id}` : '',
  ];
}

// Overwrite the dial tab with the current queue. Returns { count, skipped?, message }.
export async function syncDialSheet({ cfg = getConfig() } = {}) {
  if (!cfg.sheets.sheetId) return { count: 0, skipped: true, message: 'Google Sheet not configured (set DIAL_SHEET_ID).' };
  const creds = loadCreds(cfg);
  if (!creds) return { count: 0, skipped: true, message: 'Sheets credentials missing (set GOOGLE_SHEETS_CREDENTIALS or GOOGLE_SHEETS_CREDENTIALS_JSON).' };

  const base = cfg.sheets.publicBase || `http://localhost:${cfg.port}`;
  const queue = getQueue();
  const values = [HEADER, ...queue.map((q) => rowFor(q, base))];

  const token = await accessToken(creds);
  const tab = cfg.sheets.tab;
  // A fresh sheet's only tab is "Sheet1" — create our tab if it isn't there yet.
  const meta = await sheetsApi(token, `${cfg.sheets.sheetId}?fields=sheets.properties.title`);
  const titles = (meta.sheets || []).map((s) => s.properties.title);
  if (!titles.includes(tab)) {
    await sheetsApi(token, `${cfg.sheets.sheetId}:batchUpdate`, { method: 'POST', body: { requests: [{ addSheet: { properties: { title: tab } } }] } });
  }
  await sheetsApi(token, `${cfg.sheets.sheetId}/values/${encodeURIComponent(tab)}:clear`, { method: 'POST', body: {} });
  await sheetsApi(token, `${cfg.sheets.sheetId}/values/${encodeURIComponent(`${tab}!A1`)}?valueInputOption=RAW`, {
    method: 'PUT', body: { values },
  });

  // Record the sheet row each contact landed on (header is row 1).
  queue.forEach((q, i) => db.setQueueSheetRow(q.id, i + 2));
  db.audit({ action: 'sync_dial_sheet', source: 'system', result: `${queue.length} rows → ${tab}`, confidence: 100 });
  return { count: queue.length, message: `Synced ${queue.length} rows to “${tab}”.` };
}
