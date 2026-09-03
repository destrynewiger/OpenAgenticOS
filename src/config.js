import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ID = /^[a-z0-9][a-z0-9._-]{0,62}$/
const DEFAULT_SURFACES = Object.freeze([
  Object.freeze({
    id: 'claude-code',
    label: 'Claude Code',
    description: 'Interactive coding agent',
    probe: Object.freeze({ type: 'command', command: Object.freeze(['claude', '--version']) })
  }),
  Object.freeze({
    id: 'codex',
    label: 'Codex',
    description: 'Local coding and project agent',
    probe: Object.freeze({ type: 'command', command: Object.freeze(['codex', '--version']) })
  }),
  Object.freeze({
    id: 'hermes',
    label: 'Hermes',
    description: 'Agent orchestration and recurring work',
    probe: Object.freeze({ type: 'command', command: Object.freeze(['hermes', '--version']) })
  }),
  Object.freeze({
    id: 'openclaw',
    label: 'OpenClaw',
    description: 'Browser and computer execution agent',
    probe: Object.freeze({ type: 'command', command: Object.freeze(['openclaw', '--version']) })
  }),
  Object.freeze({
    id: 'ollama',
    label: 'Ollama',
    description: 'Local model runtime',
    probe: Object.freeze({ type: 'http', url: 'http://127.0.0.1:11434/api/tags' })
  })
])

export class ConfigError extends Error {}

export function defaultConfigPath() {
  return process.env.OPEN_AGENTIC_OS_CONFIG || path.join(os.homedir(), '.config', 'openagenticos', 'config.json')
}

function text(value, field, max = 180) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) {
    throw new ConfigError(`invalid ${field}`)
  }
  return value.trim()
}

function command(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) throw new ConfigError('invalid probe command')
  return value.map(token => text(token, 'probe command token', 256))
}

function probe(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConfigError('invalid probe')
  if (value.type === 'command' && Object.keys(value).sort().join(',') === 'command,type') {
    return { type: 'command', command: command(value.command) }
  }
  if (value.type === 'http' && Object.keys(value).sort().join(',') === 'type,url') {
    const url = new URL(text(value.url, 'probe URL', 512))
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      throw new ConfigError('probe URL must use loopback HTTP')
    }
    return { type: 'http', url: url.toString() }
  }
  throw new ConfigError('invalid probe')
}

function surface(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConfigError('invalid surface')
  if (Object.keys(value).sort().join(',') !== 'description,id,label,probe') throw new ConfigError('invalid surface fields')
  const id = text(value.id, 'surface id', 63)
  if (!ID.test(id)) throw new ConfigError('invalid surface id')
  return {
    id,
    label: text(value.label, 'surface label'),
    description: text(value.description, 'surface description'),
    probe: probe(value.probe)
  }
}

export function loadConfig(file = defaultConfigPath()) {
  if (!fs.existsSync(file)) return { host: '127.0.0.1', port: 4180, surfaces: [...DEFAULT_SURFACES] }
  const details = fs.statSync(file)
  if (!details.isFile() || details.uid !== process.getuid() || (details.mode & 0o077) !== 0) {
    throw new ConfigError('config must be a private file owned by the current user (chmod 600)')
  }
  let payload
  try {
    payload = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new ConfigError(`config is not valid JSON: ${error.message}`)
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.version !== 1) {
    throw new ConfigError('config version must be 1')
  }
  if (!Array.isArray(payload.surfaces) || payload.surfaces.length > 24) throw new ConfigError('invalid surfaces')
  const extra = Object.keys(payload).filter(key => !['version', 'surfaces', 'port'].includes(key))
  if (extra.length) throw new ConfigError('invalid config fields')
  const surfaces = [...DEFAULT_SURFACES, ...payload.surfaces.map(surface)]
  if (new Set(surfaces.map(item => item.id)).size !== surfaces.length) throw new ConfigError('duplicate surface id')
  const port = payload.port ?? 4180
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new ConfigError('invalid port')
  return { host: '127.0.0.1', port, surfaces }
}

export function publicSurfaces(surfaces) {
  return surfaces.map(({ id, label, description }) => ({ id, label, description }))
}
