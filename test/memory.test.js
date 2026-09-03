import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { MemoryStore } from '../src/memory.js'

test('persists local notes in an owner-only state file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openagenticos-memory-'))
  const file = path.join(root, 'state', 'memory.json')
  const first = new MemoryStore(file)

  const note = first.add({ title: 'Release rule', body: 'Run the privacy scan before publication.' })
  const second = new MemoryStore(file)

  assert.equal(second.list()[0].id, note.id)
  assert.equal(second.list()[0].title, 'Release rule')
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700)
})

test('rejects empty and oversized notes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openagenticos-memory-'))
  const store = new MemoryStore(path.join(root, 'state.json'))
  assert.throws(() => store.add({ title: '', body: 'body' }), /invalid title/)
  assert.throws(() => store.add({ title: 'title', body: 'x'.repeat(20_001) }), /invalid body/)
})
