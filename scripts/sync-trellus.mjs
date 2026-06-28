#!/usr/bin/env node
// Sync Trellus dialer sessions into the GTM dashboard DB (trellus_sessions table).
//
// Talks JSON-RPC over stdio to the official `trellus-rpt-mcp` package — same
// client Claude uses — so we inherit its API handling instead of reverse-
// engineering Trellus's HTTP surface. No Claude, no extra deps; cron-friendly.
//
// Usage:  node scripts/sync-trellus.mjs [--days=30] [--limit=1000]
// Key:    TRELLUS_API_KEY env var, else read from ~/.claude.json mcpServers config.
//
// ponytail: pulls the session list only (disposition/sentiment/duration/contact).
// Transcripts are a separate heavy call — add a --transcripts pass if the
// dashboard ever needs call bodies.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect } from '../src/db.js';
import { upsertTrellusSession } from '../src/models.js';

const arg = (name, def) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : def;
};
const DAYS = Number(arg('days', 30));
const LIMIT = Number(arg('limit', 1000));

function resolveKey() {
  if (process.env.TRELLUS_API_KEY) return process.env.TRELLUS_API_KEY;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
    const found = [];
    const walk = (o) => {
      if (!o || typeof o !== 'object') return;
      for (const [k, v] of Object.entries(o)) {
        if (k === 'trellus-rpt' && v?.env?.TRELLUS_API_KEY) found.push(v.env.TRELLUS_API_KEY);
        walk(v);
      }
    };
    walk(cfg);
    if (found[0]) return found[0];
  } catch { /* fall through */ }
  return null;
}

// Minimal MCP stdio client: initialize → initialized → one tools/call. Resolves
// the call result, then tears the server down.
function callTrellus(key, toolName, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['-y', 'trellus-rpt-mcp@latest'], {
      env: { ...process.env, TRELLUS_API_KEY: key },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Trellus MCP timed out after 90s')); }, 90_000);
    let buf = '';
    const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');

    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          // init acked — announce initialized, then make the call
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: toolName, arguments: args } });
        } else if (msg.id === 2) {
          clearTimeout(timer);
          child.kill();
          if (msg.error) return reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          const text = msg.result?.content?.[0]?.text;
          try { resolve(JSON.parse(text)); } catch { resolve(text); }
        }
      }
    });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'gtm-sync', version: '1.0' } } });
  });
}

function mapRow(r) {
  const unix = Number(r.started_at) || 0;
  return {
    session_id: r.session_id,
    started_unix: unix,
    started_at: unix ? new Date(unix * 1000).toISOString() : '',
    direction: r['dial_metric.is_inbound'] ? 'inbound' : 'outbound',
    duration_sec: Number(r.duration) || 0,
    sip_code: r['dial_metric.sip_code'] ?? null,
    customer_name: r['customer_data.name'] || '',
    company_name: r['customer_data.company_name'] || '',
    customer_phone: r.customer_address || '',
    agent_phone: r.agent_address || '',
    disposition: r['user_log.disposition'] || '',
    sentiment: r['user_log.sentiment'] || '',
    purpose: r['user_log.purpose'] || '',
  };
}

async function main() {
  const key = resolveKey();
  if (!key) { console.error('No TRELLUS_API_KEY (env or ~/.claude.json). Aborting.'); process.exit(1); }

  const end = new Date();
  const start = new Date(end.getTime() - DAYS * 86400 * 1000);
  console.log(`Syncing Trellus sessions ${start.toISOString()} → ${end.toISOString()} (limit ${LIMIT})…`);

  const data = await callTrellus(key, 'trellus_search_sessions', {
    start_iso: start.toISOString(),
    end_iso: end.toISOString(),
    limit: LIMIT,
  });
  const rows = Array.isArray(data) ? data : (data?.sessions || []);
  if (!rows.length) { console.log('No sessions returned for the window.'); return; }

  connect(); // open data/gtm.db (honors DATABASE_FILE/DATABASE_URL)
  let n = 0;
  for (const r of rows) {
    if (!r.session_id) continue;
    upsertTrellusSession(mapRow(r));
    n++;
  }
  console.log(`Synced ${n} Trellus session(s) into trellus_sessions.`);
}

main().catch((e) => { console.error('sync-trellus failed:', e.message); process.exit(1); });
