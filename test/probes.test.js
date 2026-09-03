import assert from 'node:assert/strict'
import test from 'node:test'

import { probeSurfaces } from '../src/probes.js'

test('reports command and HTTP availability without exposing probe details', async () => {
  const surfaces = [
    { id: 'runner', label: 'Runner', description: 'Local worker', probe: { type: 'command', command: ['runner', '--version'] } },
    { id: 'model', label: 'Model', description: 'Local model', probe: { type: 'http', url: 'http://127.0.0.1:9999/status' } },
    { id: 'missing', label: 'Missing', description: 'Unavailable tool', probe: { type: 'command', command: ['missing', '--version'] } }
  ]
  const run = async (file) => {
    if (file === 'missing') throw Object.assign(new Error('not found'), { code: 'ENOENT' })
    return { stdout: 'Runner 9.1.0' }
  }
  const fetchFn = async () => ({ ok: true, status: 200 })

  const result = await probeSurfaces(surfaces, { run, fetchFn })
  const serialized = JSON.stringify(result)

  assert.deepEqual(result.map(item => item.state), ['online', 'online', 'missing'])
  assert.doesNotMatch(serialized, /--version|9999|9\.1\.0/)
})
