import { expect, mock, test } from 'claude-code/testing'

const SPRINT = 'https://app.notion.com/0000000000000000000000000000aaaa'
const ME = '00000000-0000-0000-0000-00000000bbbb'

const RUN = {
  command: 'sprint',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 80 },
} as const

const ROWS = [
  { id: 62, title: 'Words instead of symbols', status: 'Not started', url: 'https://app.notion.com/a' },
  { id: 90, title: 'Sprint pane', status: 'In progress', url: 'https://app.notion.com/b' },
]

function text(value: unknown) {
  return { value: { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false } }
}

test('reads the current sprint and draws the cards grouped by status', async ($, on) => {
  mock.clock(on)
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  const queries: unknown[] = []
  on('mcp.call', async (_$, e) => {
    if (e.tool === 'notion-get-self') return text({ user: { id: ME } })
    const data = (e.args as { data: { query: string; params: string[] } }).data
    queries.push(data.params)
    if (data.query.includes('Sprint status')) return text({ results: [{ url: SPRINT }] })
    return text({ results: ROWS })
  })

  const ran = await $.command.run(RUN)
  expect(ran.text).toBe([
    'Sprint: 2 κάρτες',
    'In progress (1)',
    '  TEL-90 · Sprint pane',
    'Not started (1)',
    '  TEL-62 · Words instead of symbols',
  ].join('\n'))
  expect(queries).toContainEqual(['%0000000000000000000000000000aaaa%', `%${ME}%`])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'tel-sprint',
      surface,
      component: 'Pane',
      requestId: 'tel-sprint',
      props: {
        title: 'Sprint', isFocused: false, bodyColumns: 80, placement: 'dock',
        scroll: { offset: 0, bodyRows: 30 }, view: {},
      },
    })
    expect(await ui.find({ text: /In progress \(1\)/ })).toBeDefined()
    expect(await ui.find({ text: /Not started \(1\)/ })).toBeDefined()
    expect(await ui.find({ text: /TEL-90/ })).toBeDefined()
    await ui.unmount()
  }
})

test('finds a Notion server named by an id, as on the desktop', async ($, on) => {
  mock.clock(on)
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
    if (data.query.includes('Sprint status')) return text({ results: [{ url: SPRINT }] })
    return text({ results: ROWS })
  })

  const ran = await $.command.run(RUN)
  expect(ran.text?.split('\n')[0]).toBe('Sprint: 2 κάρτες')
})

test('falls back to calling the tool as the model does when $.mcp.call cannot reach it', async ($, on) => {
  mock.clock(on)
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
    if (data.query.includes('Sprint status')) return answer({ results: [{ url: SPRINT }] })
    return answer({ results: ROWS })
  })

  const ran = await $.command.run(RUN)
  expect(ran.text?.split('\n')[0]).toBe('Sprint: 2 κάρτες')
  expect(tools[0]).toBe('mcp__3eab-id__notion-get-self')
})

test('says so when Notion is not connected', async ($, on) => {
  mock.clock(on)
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('mcp.call', async () => ({ value: { content: [{ type: 'text', text: 'not connected' }], isError: true } }))
  const ran = await $.command.run(RUN)
  expect(ran.text).toBe('Sprint: δεν διαβάστηκε το Notion (Notion: not connected | claude.ai Notion: not connected).')
})
