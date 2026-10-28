import { expect, mock, test } from 'claude-code/testing'

const BLOCK = 'https://app.notion.com/0000000000000000000000000000aaaa'
const ME = '00000000-0000-0000-0000-00000000bbbb'

const RUN = {
  command: 'block',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 80 },
} as const

// Σταθερό ρολόι στα tests: το «Κολλημένο» (> 7 μέρες από το Started on) βγαίνει πάντα ίδιο.
const NOW = Date.parse('2026-10-28T12:00:00Z')
const CURRENT = { url: BLOCK, name: 'B0 · Θεμέλια' }

const daysAgo = (now: number, n: number) => new Date(now - n * 24 * 3600_000).toISOString()

function rows(now: number) {
  return [
    {
      id: 62, title: 'Words instead of symbols', status: 'Not started', url: 'https://app.notion.com/aaaa-0062',
      area: 'Design', started: null, pr: 'https://github.com/CostGal/patra-bus/issues/67',
    },
    {
      id: 90, title: 'Block pane', status: 'In progress', url: 'https://app.notion.com/p/bbbb-0090?pvs=4',
      area: 'App', started: daysAgo(now, 9), pr: 'https://github.com/CostGal/patra-bus/pull/77',
    },
    { id: 89, title: 'TEL ids', status: 'Done', url: 'https://app.notion.com/cccc', area: null, started: daysAgo(now, 20), pr: null },
    { id: 91, title: 'Fresh review', status: 'In review', url: 'https://app.notion.com/dddd', area: null, started: daysAgo(now, 2), pr: null },
  ]
}

const PANE = {
  component: 'Pane',
  requestId: 'tel-sprint',
  props: {
    title: 'Block', isFocused: false, bodyColumns: 80, placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 }, view: {},
  },
} as const

function text(value: unknown) {
  return { value: { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false } }
}

test('reads the current block and draws the cards grouped by status', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  const queries: unknown[] = []
  on('mcp.call', async (_$, e) => {
    if (e.tool === 'notion-get-self') return text({ user: { id: ME } })
    const data = (e.args as { data: { query: string; params: string[] } }).data
    queries.push(data.params)
    if (data.query.includes('Κατάσταση')) return text({ results: [CURRENT] })
    return text({ results: rows(NOW) })
  })

  const ran = await $.command.run(RUN)
  expect(ran.text).toBe([
    'Block: 3 κάρτες',
    'In progress (1)',
    '  TEL-90 · Block pane · Κολλημένο',
    'In review (1)',
    '  TEL-91 · Fresh review',
    'Not started (1)',
    '  TEL-62 · Words instead of symbols',
  ].join('\n'))
  expect(queries).toContainEqual(['%0000000000000000000000000000aaaa%', `%${ME}%`])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'tel-sprint', surface, ...PANE })
    // Κεφαλίδα: όνομα του block (χωρίς ημερομηνίες), πρόοδος με τις Done κάρτες στο σύνολο.
    expect(await ui.find({ type: 'Text', text: 'B0 · Θεμέλια' })).toBeDefined()
    expect(await ui.find({ text: /\d+\/\d+ – \d+\/\d+/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '1/4 done · 25%' })).toBeDefined()
    if (surface === 'desktop') expect((await ui.find({ type: 'Svg' }))?.props.alt).toBe('1/4 done')
    else expect((await ui.find({ type: 'Text', text: /█/ }))?.text).toBe('███░░░░░░░')
    expect(await ui.find({ text: 'Φόρτωση…' })).toBeUndefined()
    // Ομάδες με πλήθος· η Done κάρτα δεν φαίνεται.
    expect(await ui.find({ type: 'Text', text: 'In progress' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'In review' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Not started' })).toBeDefined()
    expect((await ui.findAll({ type: 'Text', text: '●' })).map(t => t.props.color))
      .toEqual(['#5E9FE0', '#FFA344', '#9B9B9B'])
    expect(await ui.find({ text: /TEL-89/ })).toBeUndefined()
    // Κάρτα σε πλαίσιο, τίτλος ως link στο www.notion.so.
    const card = await ui.find({ type: 'Box', key: 'TEL-90' })
    expect(card?.props.borderStyle).toBe('round')
    expect((await ui.find({ type: 'Link', text: 'Block pane' }))?.props.href).toBe('https://www.notion.so/bbbb0090')
    expect((await ui.find({ type: 'Link', text: 'Words instead of symbols' }))?.props.href)
      .toBe('https://www.notion.so/aaaa0062')
    // Ετικέτες με τα χρώματα του Notion (dark), Κολλημένο (μόνο στην παλιά κάρτα), PR και Issue.
    const app = await ui.find({ type: 'Text', text: /^ ?App ?$/ })
    expect(app?.props.color).toBe('#D5E5F5')
    if (surface === 'desktop') {
      // Pill: Box με στρογγυλό περίγραμμα στο χρώμα του φόντου.
      expect((await ui.find({ type: 'Box', key: 'area' }))?.props)
        .toMatchObject({ borderStyle: 'round', borderColor: '#28456C', backgroundColor: '#28456C' })
      expect((await ui.find({ type: 'Box', key: 'status-In progress' }))?.props.backgroundColor).toBe('#28456C')
    } else {
      expect(app?.props.backgroundColor).toBe('#28456C')
    }
    expect((await ui.findAll({ type: 'Text', text: /^ ?Κολλημένο ?$/ })).length).toBe(1)
    expect((await ui.find({ type: 'Text', text: /^ ?Design ?$/ }))?.props.color).toBe('#F3D6E4')
    expect(await ui.find({ text: /Due|Claude|Dev/ })).toBeUndefined()
    expect((await ui.find({ type: 'Link', text: 'PR #77' }))?.props.href)
      .toBe('https://github.com/CostGal/patra-bus/pull/77')
    expect((await ui.find({ type: 'Link', text: 'Issue #67' }))?.props.href)
      .toBe('https://github.com/CostGal/patra-bus/issues/67')
    await ui.unmount()
  }
})

test('keeps /sprint as an alias of /block', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('mcp.call', async (_$, e) => {
    if (e.tool === 'notion-get-self') return text({ user: { id: ME } })
    const data = (e.args as { data: { query: string } }).data
    if (data.query.includes('Κατάσταση')) return text({ results: [CURRENT] })
    return text({ results: [] })
  })
  const ran = await $.command.run({ ...RUN, command: 'sprint' })
  expect(ran.text).toBe('Block: 0 κάρτες')
})

test('says so when no block is current', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('mcp.call', async (_$, e) => {
    if (e.tool === 'notion-get-self') return text({ user: { id: ME } })
    return text({ results: [] })
  })
  const ran = await $.command.run(RUN)
  expect(ran.text).toBe('Block: 0 κάρτες')
})

test('finds a Notion server named by an id, as on the desktop', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('tool.list', async () => ({
    value: [{ name: 'mcp__3eab-id__notion-query-data-sources', description: '', mcp: true }],
  }))
  on('mcp.call', async (_$, e) => {
    if (e.server !== '3eab-id') {
      return { value: { content: [{ type: 'text', text: 'no such server' }], isError: true } }
    }
    if (e.tool === 'notion-get-self') return text({ user: { id: ME } })
    const data = (e.args as { data: { query: string } }).data
    if (data.query.includes('Κατάσταση')) return text({ results: [CURRENT] })
    return text({ results: rows(NOW) })
  })

  const ran = await $.command.run(RUN)
  expect(ran.text?.split('\n')[0]).toBe('Block: 3 κάρτες')
})

test('falls back to calling the tool as the model does when $.mcp.call cannot reach it', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('tool.list', async () => ({
    value: [{ name: 'mcp__3eab-id__notion-query-data-sources', description: '', mcp: true }],
  }))
  on('mcp.call', async () => ({ value: { content: [{ type: 'text', text: 'no tool' }], isError: true } }))
  const tools: string[] = []
  on('tool.call', async (_$, e) => {
    tools.push(e.tool)
    const answer = (value: unknown) => ({ result: [], text: JSON.stringify(value) })
    if (e.tool.endsWith('notion-get-self')) return answer({ user: { id: ME } })
    const data = (e as unknown as { data: { query: string } }).data
    if (data.query.includes('Κατάσταση')) return answer({ results: [CURRENT] })
    return answer({ results: rows(NOW) })
  })

  const ran = await $.command.run(RUN)
  expect(ran.text?.split('\n')[0]).toBe('Block: 3 κάρτες')
  expect(tools[0]).toBe('mcp__3eab-id__notion-get-self')
})

test('says so when Notion is not connected', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('mcp.call', async () => ({ value: { content: [{ type: 'text', text: 'not connected' }], isError: true } }))
  const ran = await $.command.run(RUN)
  expect(ran.text).toBe('Block: δεν διαβάστηκε το Notion (Notion: not connected | claude.ai Notion: not connected).')
})
