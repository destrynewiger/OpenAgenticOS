import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { buildCouncil } from './council.js'
import { loadConfig } from './config.js'
import { MemoryStore } from './memory.js'
import { probeSurfaces } from './probes.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WEB = path.join(ROOT, 'web')
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])
const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']]
])

function secureHeaders(response) {
  response.setHeader('cache-control', 'no-store')
  response.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
  response.setHeader('referrer-policy', 'no-referrer')
  response.setHeader('x-content-type-options', 'nosniff')
  response.setHeader('x-frame-options', 'DENY')
}

function requestIsLocal(request) {
  try {
    const host = new URL(`http://${request.headers.host}`).hostname
    if (!LOOPBACK.has(host)) return false
    if (!request.headers.origin) return true
    const origin = new URL(request.headers.origin)
    return origin.protocol === 'http:' && LOOPBACK.has(origin.hostname)
  } catch {
    return false
  }
}

function sendJson(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(`${JSON.stringify(payload)}\n`)
}

function sendError(response, status, message) {
  sendJson(response, status, { error: message })
}

async function readJson(request) {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
    const error = new Error('content type must be application/json')
    error.status = 415
    throw error
  }
  let size = 0
  const chunks = []
  for await (const chunk of request) {
    size += chunk.length
    if (size > 24_000) {
      const error = new Error('request body is too large')
      error.status = 413
      throw error
    }
    chunks.push(chunk)
  }
  try {
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid')
    return payload
  } catch {
    const error = new Error('request body must be valid JSON')
    error.status = 400
    throw error
  }
}

export function createApp({ surfaces, memory = new MemoryStore(), probeFn = probeSurfaces }) {
  async function handle(request, response) {
    secureHeaders(response)
    if (!requestIsLocal(request)) return sendError(response, 403, 'local requests only')

    const url = new URL(request.url, 'http://localhost')
    if (request.method === 'GET' && ASSETS.has(url.pathname)) {
      const [file, type] = ASSETS.get(url.pathname)
      response.writeHead(200, { 'content-type': type })
      return response.end(fs.readFileSync(path.join(WEB, file)))
    }
    if (request.method === 'GET' && url.pathname === '/api/status') {
      return sendJson(response, 200, { surfaces: await probeFn(surfaces) })
    }
    if (request.method === 'GET' && url.pathname === '/api/memory') {
      return sendJson(response, 200, { notes: memory.list() })
    }
    if (request.method === 'POST' && url.pathname === '/api/memory') {
      const payload = await readJson(request)
      if (Object.keys(payload).sort().join(',') !== 'body,title') return sendError(response, 400, 'invalid memory fields')
      return sendJson(response, 201, { note: memory.add(payload) })
    }
    if (request.method === 'DELETE' && url.pathname.startsWith('/api/memory/')) {
      const id = url.pathname.slice('/api/memory/'.length)
      if (!/^[0-9a-f-]{36}$/i.test(id)) return sendError(response, 400, 'invalid note id')
      if (!memory.remove(id)) return sendError(response, 404, 'note not found')
      response.writeHead(204)
      return response.end()
    }
    if (request.method === 'POST' && url.pathname === '/api/council') {
      const payload = await readJson(request)
      if (Object.keys(payload).join(',') !== 'idea') return sendError(response, 400, 'invalid council fields')
      const status = await probeFn(surfaces)
      return sendJson(response, 200, buildCouncil({ idea: payload.idea, surfaces: status, notes: memory.list() }))
    }
    return sendError(response, 404, 'not found')
  }

  return http.createServer((request, response) => {
    handle(request, response).catch(error => sendError(response, error.status || 400, error.message || 'request failed'))
  })
}

export function start() {
  const config = loadConfig()
  const app = createApp({ surfaces: config.surfaces })
  app.listen(config.port, config.host, () => {
    process.stdout.write(`OpenAgenticOS is running at http://${config.host}:${config.port}\n`)
  })
  return app
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) start()
