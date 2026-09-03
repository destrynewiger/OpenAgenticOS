import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function defaultStatePath() {
  return process.env.OPEN_AGENTIC_OS_STATE || path.join(os.homedir(), '.local', 'share', 'openagenticos', 'state.json')
}

function field(value, name, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /\0/.test(value)) throw new Error(`invalid ${name}`)
  return value.trim()
}

export class MemoryStore {
  constructor(file = defaultStatePath()) {
    this.file = path.resolve(file)
    this.notes = []
    this.#load()
  }

  #load() {
    if (!fs.existsSync(this.file)) return
    const details = fs.lstatSync(this.file)
    if (!details.isFile() || details.isSymbolicLink() || details.uid !== process.getuid() || (details.mode & 0o077) !== 0) {
      throw new Error('state file must be private and owned by the current user')
    }
    const payload = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    if (!payload || payload.version !== 1 || !Array.isArray(payload.notes)) throw new Error('invalid state file')
    this.notes = payload.notes
  }

  #save() {
    const directory = path.dirname(this.file)
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    fs.chmodSync(directory, 0o700)
    const temporary = path.join(directory, `.${path.basename(this.file)}.${process.pid}.tmp`)
    fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, notes: this.notes }, null, 2)}\n`, { mode: 0o600 })
    fs.chmodSync(temporary, 0o600)
    fs.renameSync(temporary, this.file)
  }

  list() {
    return this.notes.map(note => ({ ...note }))
  }

  add({ title, body }) {
    const note = {
      id: crypto.randomUUID(),
      title: field(title, 'title', 160),
      body: field(body, 'body', 20_000),
      created_at: new Date().toISOString()
    }
    this.notes.unshift(note)
    this.notes = this.notes.slice(0, 500)
    this.#save()
    return { ...note }
  }

  remove(id) {
    const before = this.notes.length
    this.notes = this.notes.filter(note => note.id !== id)
    if (this.notes.length === before) return false
    this.#save()
    return true
  }
}
