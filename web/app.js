const elements = {
  onlineCount: document.querySelector('#online-count'),
  memoryCount: document.querySelector('#memory-count'),
  surfaceGrid: document.querySelector('#surface-grid'),
  noteList: document.querySelector('#note-list'),
  councilResults: document.querySelector('#council-results'),
  statusButton: document.querySelector('#refresh-status'),
  councilForm: document.querySelector('#council-form'),
  memoryForm: document.querySelector('#memory-form')
}

function node(tag, className, text) {
  const element = document.createElement(tag)
  if (className) element.className = className
  if (text !== undefined) element.textContent = text
  return element
}

async function api(url, options) {
  const response = await fetch(url, options)
  const payload = response.status === 204 ? null : await response.json()
  if (!response.ok) throw new Error(payload?.error || 'Request failed')
  return payload
}

function showError(container, error) {
  container.replaceChildren(node('p', 'error', error.message))
}

async function loadStatus() {
  elements.statusButton.disabled = true
  try {
    const { surfaces } = await api('/api/status')
    elements.onlineCount.textContent = String(surfaces.filter(surface => surface.state === 'online').length)
    elements.surfaceGrid.replaceChildren(...surfaces.map(surface => {
      const card = node('article', 'surface-card')
      const top = node('div', 'surface-top')
      top.append(node('h3', '', surface.label), node('span', `status ${surface.state}`, surface.state))
      card.append(top, node('p', '', surface.description), node('small', '', surface.detail))
      return card
    }))
    if (!surfaces.length) elements.surfaceGrid.append(node('p', 'empty', 'No surfaces are configured.'))
  } catch (error) {
    showError(elements.surfaceGrid, error)
  } finally {
    elements.statusButton.disabled = false
  }
}

async function loadMemory() {
  try {
    const { notes } = await api('/api/memory')
    elements.memoryCount.textContent = String(notes.length)
    if (!notes.length) {
      elements.noteList.replaceChildren(node('p', 'empty', 'No notes yet. Add the first piece of durable context.'))
      return
    }
    elements.noteList.replaceChildren(...notes.map(note => {
      const item = node('article', 'note')
      const heading = node('div', 'note-heading')
      const remove = node('button', 'text-button', 'Delete')
      remove.type = 'button'
      remove.addEventListener('click', async () => {
        remove.disabled = true
        try {
          await api(`/api/memory/${note.id}`, { method: 'DELETE' })
          await loadMemory()
        } catch (error) {
          remove.disabled = false
          showError(elements.noteList, error)
        }
      })
      heading.append(node('h3', '', note.title), remove)
      item.append(heading, node('p', '', note.body), node('time', '', new Date(note.created_at).toLocaleString()))
      return item
    }))
  } catch (error) {
    showError(elements.noteList, error)
  }
}

elements.statusButton.addEventListener('click', loadStatus)

elements.memoryForm.addEventListener('submit', async event => {
  event.preventDefault()
  const button = elements.memoryForm.querySelector('button')
  button.disabled = true
  const data = new FormData(elements.memoryForm)
  try {
    await api('/api/memory', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: data.get('title'), body: data.get('body') })
    })
    elements.memoryForm.reset()
    await loadMemory()
  } catch (error) {
    showError(elements.noteList, error)
  } finally {
    button.disabled = false
  }
})

elements.councilForm.addEventListener('submit', async event => {
  event.preventDefault()
  const button = elements.councilForm.querySelector('button')
  const idea = new FormData(elements.councilForm).get('idea')
  button.disabled = true
  elements.councilResults.replaceChildren(node('p', 'empty', 'Considering the current local context…'))
  try {
    const result = await api('/api/council', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idea })
    })
    const cards = result.lenses.map(lens => {
      const card = node('article', 'lens')
      card.append(node('h3', '', lens.name), node('p', '', lens.response))
      return card
    })
    const synthesis = node('article', 'synthesis')
    synthesis.append(node('h3', '', 'Synthesis'), node('p', '', result.synthesis))
    elements.councilResults.replaceChildren(...cards, synthesis)
  } catch (error) {
    showError(elements.councilResults, error)
  } finally {
    button.disabled = false
  }
})

await Promise.all([loadStatus(), loadMemory()])
