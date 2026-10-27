import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const source = 'https://github.com/typesafe-ai/skills'
const commit = '65a39f393687675ce170e6094757de20370365b9'
const locations = ['.agents/skills/typesafe-ai', '.cursor/skills/typesafe-ai']
const filenames = ['LICENSE', 'SKILL.md']
const sha256 = data => createHash('sha256').update(data).digest('hex')

export function verifyTypeSafe(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'docs/typesafe-provenance.json')))
  assert.equal(manifest.version, 1)
  assert.equal(manifest.source, source)
  assert.equal(manifest.commit, commit)
  assert.deepEqual(manifest.locations, locations)
  assert.deepEqual(Object.keys(manifest.installed).sort(), filenames)
  assert.equal(manifest.automatic_updates, false)
  assert.equal(manifest.upstream['skills/typesafe-ai/SKILL.md'].sha256, '71ea90d7906c6554c4f4c460ef7361b2d26f59116ccdae986dc6d997b9389f52')
  assert.equal(manifest.upstream.LICENSE.sha256, '835f233f1d6ed84a9b9a351aba0689b47644a4137d6316911fc7957bde523b02')
  const canonical = new Map()
  for (const location of locations) {
    // A checkout validator, not a sandbox against a same-user concurrent attacker.
    let current = root
    for (const component of location.split('/')) {
      current = path.join(current, component)
      assert(fs.lstatSync(current).isDirectory(), `Expected real directory: ${current}`)
    }
    assert.deepEqual(fs.readdirSync(current).sort(), filenames, 'Unexpected skill files')
    const folderHash = createHash('sha256')
    for (const name of filenames) {
      const file = path.join(current, name)
      assert(fs.lstatSync(file).isFile(), `Expected regular file: ${file}`)
      const bytes = fs.readFileSync(file)
      assert.equal(bytes.length, manifest.installed[name].bytes)
      assert.equal(sha256(bytes), manifest.installed[name].sha256, `Content drift: ${file}`)
      if (canonical.has(name)) assert.deepEqual(bytes, canonical.get(name), 'Skill copies diverged')
      else canonical.set(name, bytes)
      folderHash.update(name).update(bytes)
    }
    assert.equal(folderHash.digest('hex'), manifest.folder_sha256)
  }
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'skills-lock.json')))
  assert.equal(lock.version, 1)
  assert.equal(lock.skills['typesafe-ai'].source, 'typesafe-ai/skills')
  assert.equal(lock.skills['typesafe-ai'].sourceType, 'github')
  assert.equal(lock.skills['typesafe-ai'].skillPath, 'skills/typesafe-ai/SKILL.md')
  assert.equal(lock.skills['typesafe-ai'].ref, commit)
  assert.equal(lock.skills['typesafe-ai'].computedHash, manifest.folder_sha256)
  return { commit, files: locations.length * filenames.length, folderSha256: manifest.folder_sha256 }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = verifyTypeSafe(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'))
    console.log(`TYPESAFE_SKILL_VERIFIED ${JSON.stringify(result)}`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
