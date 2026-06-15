// SQLite connection (Node built-in node:sqlite — zero external deps).
// Run node with --experimental-sqlite (baked into package.json scripts).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { getConfig, DATA_DIR } from './config.js';
import { SCHEMA } from './schema.js';

let _db = null;

// Open (once) and migrate. Pass an explicit file to force a connection
// (tests use ':memory:'). Honors DATABASE_FILE / DATABASE_URL otherwise.
export function connect(file) {
  if (_db) return _db;
  const target = file || getConfig().databaseFile;
  if (target !== ':memory:') {
    fs.mkdirSync(path.dirname(target), { recursive: true });
  } else {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  _db = new DatabaseSync(target);
  _db.exec('PRAGMA foreign_keys = ON;');
  if (target !== ':memory:') _db.exec('PRAGMA journal_mode = WAL;');
  _db.exec(SCHEMA);
  return _db;
}

export function getDb() {
  return _db || connect();
}

// Test helper: drop the singleton and reopen a fresh in-memory DB.
export function resetForTests() {
  if (_db) { try { _db.close(); } catch {} }
  _db = null;
  return connect(':memory:');
}

export function nowIso() {
  return new Date().toISOString();
}
