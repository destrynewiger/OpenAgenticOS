import test from 'node:test'
import assert from 'node:assert/strict'

import { buildCouncil } from '../src/council.js'

test('buildCouncil returns four grounded lenses and a synthesis', () => {
  const result = buildCouncil({
    idea: 'Create a local dashboard for my agent tools.',
    surfaces: [
      { label: 'Codex', state: 'online' },
      { label: 'Ollama', state: 'offline' }
    ],
    notes: [{ title: 'Constraint', body: 'Keep the first version local-only.' }]
  })

  assert.equal(result.idea, 'Create a local dashboard for my agent tools.')
  assert.deepEqual(result.lenses.map(lens => lens.name), ['Builder', 'Operator', 'Critic', 'Memory'])
  assert.match(result.lenses[0].response, /1 of 2 configured surfaces/)
  assert.match(result.lenses[3].response, /Keep the first version local-only/)
  assert.match(result.synthesis, /smallest local workflow/)
})

test('buildCouncil rejects invalid ideas', () => {
  assert.throws(() => buildCouncil({ idea: '', surfaces: [], notes: [] }), /invalid idea/)
  assert.throws(() => buildCouncil({ idea: 'x'.repeat(10_001), surfaces: [], notes: [] }), /invalid idea/)
})
