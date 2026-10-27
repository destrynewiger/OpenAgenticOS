import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { verifyTypeSafe } from '../scripts/verify-typesafe-skill.mjs'

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'typesafe-integrity-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const item of ['.agents', '.cursor', 'docs/typesafe-provenance.json', 'skills-lock.json']) {
    fs.mkdirSync(path.dirname(path.join(root, item)), { recursive: true })
    fs.cpSync(path.join(project, item), path.join(root, item), { recursive: true })
  }
  assert.equal(verifyTypeSafe(root).files, 4)
  return root
}

test('both project copies match pinned provenance and the skills lock', () => {
  assert.equal(verifyTypeSafe(project).files, 4)
})

test('a changed instruction or license is rejected, including synchronized drift', t => {
  for (const name of ['SKILL.md', 'LICENSE']) {
    const root = fixture(t)
    for (const base of ['.agents', '.cursor']) fs.appendFileSync(path.join(root, base, 'skills/typesafe-ai', name), '\nchanged\n')
    assert.throws(() => verifyTypeSafe(root))
  }
})

test('an unexpected executable, file symlink or directory symlink is rejected', t => {
  const extra = fixture(t)
  fs.writeFileSync(path.join(extra, '.agents/skills/typesafe-ai/run.sh'), 'exit 0\n')
  assert.throws(() => verifyTypeSafe(extra), /Unexpected skill files/)
  const fileRoot = fixture(t)
  const file = path.join(fileRoot, '.agents/skills/typesafe-ai/SKILL.md')
  fs.unlinkSync(file)
  fs.symlinkSync(path.join(project, '.agents/skills/typesafe-ai/SKILL.md'), file)
  assert.throws(() => verifyTypeSafe(fileRoot), /Expected regular file/)
  const dirRoot = fixture(t)
  const dir = path.join(dirRoot, '.cursor/skills/typesafe-ai')
  fs.rmSync(dir, { recursive: true })
  fs.symlinkSync(path.join(project, '.cursor/skills/typesafe-ai'), dir, 'dir')
  assert.throws(() => verifyTypeSafe(dirRoot), /Expected real directory/)
})

test('lock drift, manifest redirect and unpinned upstream revision are rejected', t => {
  for (const mutate of [
    root => { const file = path.join(root, 'skills-lock.json'); const value = JSON.parse(fs.readFileSync(file)); value.skills['typesafe-ai'].ref = 'main'; fs.writeFileSync(file, JSON.stringify(value)) },
    root => { const file = path.join(root, 'docs/typesafe-provenance.json'); const value = JSON.parse(fs.readFileSync(file)); value.locations = ['../outside']; fs.writeFileSync(file, JSON.stringify(value)) },
    root => { const file = path.join(root, 'docs/typesafe-provenance.json'); const value = JSON.parse(fs.readFileSync(file)); value.commit = 'main'; fs.writeFileSync(file, JSON.stringify(value)) },
  ]) {
    const root = fixture(t)
    mutate(root)
    assert.throws(() => verifyTypeSafe(root))
  }
})
