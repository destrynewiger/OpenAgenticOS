import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { MemoryStore } from '../src/memory.js'
import { createApp } from '../src/server.js'

async function withApp(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openagenticos-server-'))
  const memory = new MemoryStore(path.join(directory, 'state.json'))
  const surfaces = [{ id: 'test', label: 'Test Agent', description: 'Test surface', probe: { type: 'command', command: ['test'] } }]
  const app = createApp({
    surfaces,
    memory,
    probeFn: async () => [{ id: 'test', label: 'Test Agent', description: 'Test surface', state: 'online', detail: 'Command responded' }]
  })
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve))
  const address = app.address()
  try {
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise(resolve => app.close(resolve))
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

test('serves the local dashboard with restrictive security headers', async () => {
  await withApp(async base => {
    const response = await fetch(base)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-security-policy'), /default-src 'self'/)
    assert.equal(response.headers.get('x-frame-options'), 'DENY')
    assert.match(await response.text(), /OpenAgenticOS/)
  })
})

test('exposes status, memory, and council APIs', async () => {
  await withApp(async base => {
    const status = await fetch(`${base}/api/status`).then(response => response.json())
    assert.equal(status.surfaces[0].state, 'online')

    const createdResponse = await fetch(`${base}/api/memory`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Boundary', body: 'Keep it local.' })
    })
    assert.equal(createdResponse.status, 201)
    const created = await createdResponse.json()

    const councilResponse = await fetch(`${base}/api/council`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idea: 'Coordinate my local agents.' })
    })
    const council = await councilResponse.json()
    assert.match(council.lenses[3].response, /Keep it local/)

    const removed = await fetch(`${base}/api/memory/${created.note.id}`, { method: 'DELETE' })
    assert.equal(removed.status, 204)
  })
})

test('rejects foreign hosts and oversized request bodies', async () => {
  await withApp(async base => {
    const foreignStatus = await new Promise((resolve, reject) => {
      const request = http.get(`${base}/api/status`, { headers: { host: 'example.com' } }, response => {
        response.resume()
        response.on('end', () => resolve(response.statusCode))
      })
      request.on('error', reject)
    })
    assert.equal(foreignStatus, 403)

    const oversized = await fetch(`${base}/api/council`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idea: 'x'.repeat(25_000) })
    })
    assert.equal(oversized.status, 413)
  })
})
