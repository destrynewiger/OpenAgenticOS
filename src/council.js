function cleanIdea(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 10_000 || value.includes('\0')) {
    throw new Error('invalid idea')
  }
  return value.trim()
}

function excerpt(value, max = 220) {
  const compact = String(value || '').replace(/\s+/g, ' ').trim()
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact
}

export function buildCouncil({ idea, surfaces = [], notes = [] }) {
  const prompt = cleanIdea(idea)
  const online = surfaces.filter(surface => surface.state === 'online')
  const available = online.map(surface => surface.label).join(', ') || 'no responding surfaces'
  const memory = notes[0]
    ? `The newest local note says: “${excerpt(notes[0].body)}”`
    : 'No local memory note currently adds a constraint.'

  return {
    idea: prompt,
    generated_at: new Date().toISOString(),
    lenses: [
      {
        name: 'Builder',
        response: `Start with one testable slice. ${online.length} of ${surfaces.length} configured surfaces are responding (${available}), so design the first pass around those capabilities.`
      },
      {
        name: 'Operator',
        response: 'Define the owner, trigger, observable result, and recovery path before adding automation. Keep human approval at any boundary that changes external state.'
      },
      {
        name: 'Critic',
        response: 'The main risk is coupling a useful idea to assumptions about tools that may be offline or differently configured. Prove the workflow locally and make every integration optional.'
      },
      {
        name: 'Memory',
        response: memory
      }
    ],
    synthesis: 'Build the smallest local workflow that demonstrates the idea, measure whether it helps, and expand only after the failure and privacy boundaries are explicit.'
  }
}
