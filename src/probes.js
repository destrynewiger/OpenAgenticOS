import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

async function defaultRun(file, args) {
  return exec(file, args, {
    timeout: 2500,
    windowsHide: true,
    env: {
      HOME: process.env.HOME,
      USER: process.env.USER,
      LOGNAME: process.env.LOGNAME,
      PATH: process.env.PATH
    }
  })
}

async function probe(surface, { run, fetchFn }) {
  try {
    if (surface.probe.type === 'command') {
      const [file, ...args] = surface.probe.command
      await run(file, args)
      return { id: surface.id, label: surface.label, description: surface.description, state: 'online', detail: 'Command responded' }
    }
    const response = await fetchFn(surface.probe.url, { signal: AbortSignal.timeout(2500), cache: 'no-store' })
    return {
      id: surface.id,
      label: surface.label,
      description: surface.description,
      state: response.ok ? 'online' : 'error',
      detail: response.ok ? 'Endpoint responded' : `Endpoint returned ${response.status}`
    }
  } catch (error) {
    return {
      id: surface.id,
      label: surface.label,
      description: surface.description,
      state: error?.code === 'ENOENT' ? 'missing' : 'offline',
      detail: error?.code === 'ENOENT' ? 'Not installed' : 'No response'
    }
  }
}

export function probeSurfaces(surfaces, { run = defaultRun, fetchFn = fetch } = {}) {
  return Promise.all(surfaces.map(surface => probe(surface, { run, fetchFn })))
}
