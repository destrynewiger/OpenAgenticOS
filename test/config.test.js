import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { ConfigError, loadConfig, publicSurfaces } from '../src/config.js'

test('runs without a config and exposes generic local surfaces', () => {
  const config = loadConfig(path.join(os.tmpdir(), `missing-${Date.now()}.json`))
  assert.deepEqual(config.surfaces.map(surface => surface.id), ['claude-code', 'codex', 'hermes', 'openclaw', 'ollama'])
  assert.equal(config.host, '127.0.0.1')
  assert.equal(config.port, 4180)
})

test('private config can add a surface without exposing its command or URL', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openagenticos-config-'))
  const file = path.join(root, 'config.json')
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    surfaces: [{
      id: 'local-worker',
      label: 'Local Worker',
      description: 'Background task runner',
      probe: { type: 'command', command: ['worker', 'status'] }
    }]
  }))
  fs.chmodSync(file, 0o600)

  const config = loadConfig(file)
  const serialized = JSON.stringify(publicSurfaces(config.surfaces))

  assert.equal(config.surfaces.at(-1).id, 'local-worker')
  assert.doesNotMatch(serialized, /"command"|"url"|worker","status/)
})

test('rejects a config readable by other users', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openagenticos-config-'))
  const file = path.join(root, 'config.json')
  fs.writeFileSync(file, JSON.stringify({ version: 1, surfaces: [] }))
  fs.chmodSync(file, 0o644)

  assert.throws(() => loadConfig(file), error => error instanceof ConfigError && /private/.test(error.message))
})
