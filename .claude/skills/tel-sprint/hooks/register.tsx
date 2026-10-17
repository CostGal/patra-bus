import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Card, Sprint } from '../types'

// Βάσεις του Notion (Telematica): Sprints και Tasks. Μόνο ανάγνωση.
const SPRINTS = 'collection://3f82429c-7223-8005-bc25-000bf5983bd0'
const TASKS = 'collection://4da2abc0-511d-4dfb-b9c5-180656a8f5e2'
// Ο connector λέγεται «Notion» στο cloud και «claude.ai Notion» στο desktop.
const SERVERS = ['Notion', 'claude.ai Notion']
const STATUSES = ['In progress', 'In review', 'Not started']
const EVERY_MS = 5 * 60_000

const PANE = 'tel-sprint'
const sprint = atom({ plugin: 'tel-sprint', key: 'sprint' } as const, { cards: [] })

type Call = (server: string, tool: string, args?: Record<string, unknown>) => Promise<{
  content: { type: string; text?: string }[]
  isError: boolean
}>

async function notion(call: Call, tool: string, args: Record<string, unknown>): Promise<any> {
  let lastError = 'Δεν βρέθηκε ο Notion connector'
  for (const server of SERVERS) {
    try {
      const res = await call(server, tool, args)
      const text = res.content.find(b => b.type === 'text')?.text ?? ''
      if (res.isError) throw new Error(text || 'σφάλμα Notion')
      return JSON.parse(text)
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
  }
  throw new Error(lastError)
}

function sql(urls: string[], query: string, params: string[] = []) {
  return { data: { data_source_urls: urls, query, params } }
}

/** Οι κάρτες του συνδεδεμένου χρήστη στο τρέχον sprint που δεν είναι Done. */
export async function loadCards(call: Call): Promise<Card[]> {
  const self = await notion(call, 'notion-get-self', {})
  const userId: string = self.user.id
  const sprints = await notion(call, 'notion-query-data-sources',
    sql([SPRINTS], `SELECT url FROM "${SPRINTS}" WHERE "Sprint status" = 'Current'`))
  const sprintUrl: string | undefined = sprints.results[0]?.url
  if (!sprintUrl) return []
  const sprintId = sprintUrl.split('/').pop()!.replace(/-/g, '')
  const tasks = await notion(call, 'notion-query-data-sources', sql([TASKS],
    `SELECT "userDefined:ID" AS id, "Task" AS title, "Task status" AS status, url FROM "${TASKS}"
     WHERE "Sprint" LIKE ? AND "Owner" LIKE ? AND "Task status" != 'Done'`,
    [`%${sprintId}%`, `%${userId}%`]))
  return (tasks.results as Card[]).sort((a, b) =>
    STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status) || a.id - b.id)
}

let timer: { cancel: () => void } | undefined

async function refresh($: EngineInterface): Promise<Sprint> {
  let next: Sprint
  try {
    next = { cards: await loadCards((server, tool, args) => $.mcp.call(server, tool, args)), updatedAt: await $.clock.now() }
  } catch (err) {
    const prev = await read($, sprint)
    next = { ...prev, error: err instanceof Error ? err.message : String(err) }
  }
  await update($, sprint, () => next)
  return next
}

/** Η λίστα ως κείμενο, για την απάντηση του /sprint (και όπου δεν φαίνεται το pane). */
export function listText(cards: Card[]): string {
  const lines = [`Sprint: ${cards.length} κάρτες`]
  for (const status of STATUSES) {
    const group = cards.filter(c => c.status === status)
    if (group.length === 0) continue
    lines.push(`${status} (${group.length})`)
    for (const c of group) lines.push(`  TEL-${c.id} · ${c.title}`)
  }
  return lines.join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'sprint', description: 'Οι κάρτες TEL του τρέχοντος sprint σου (Notion)' })
    void $.ui.open({ id: PANE, title: 'Sprint' })
    void refresh($)
    timer?.cancel()
    timer = $.clock.every(EVERY_MS, () => void refresh($))
    return next(e)
  })

  on('command.run', { command: 'sprint' }, async $ => {
    const { isPlaced } = await $.ui.open({ id: PANE, title: 'Sprint' })
    const s = await refresh($)
    if (s.error) return { text: `Sprint: δεν διαβάστηκε το Notion (${s.error}).` }
    const where = isPlaced ? '' : '\n(Το pane δεν εμφανίζεται σε αυτό το session.)'
    return { text: listText(s.cards) + where }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Link, Button } = $.ui.resolve(e)
    const s = await read($, sprint)
    const time = s.updatedAt
      ? new Date(s.updatedAt).toLocaleTimeString('el-GR', { hour: '2-digit', minute: '2-digit' })
      : '…'

    return (
      <Box flexDirection="column">
        {s.error && <Text color="red">Notion: {s.error}</Text>}
        {!s.error && !s.updatedAt && <Text dimColor>Φόρτωση…</Text>}
        {s.updatedAt && s.cards.length === 0 && <Text dimColor>Καμία ανοιχτή κάρτα στο τρέχον sprint.</Text>}
        {STATUSES.map(status => {
          const group = s.cards.filter(c => c.status === status)
          if (group.length === 0) return null
          return (
            <Box flexDirection="column" key={status}>
              <Text weight="bold">{status} ({group.length})</Text>
              {group.map(c => (
                <Text key={String(c.id)}>
                  <Link href={c.url} label={`TEL-${c.id}`} /> {c.title}
                </Text>
              ))}
            </Box>
          )
        })}
        <Box>
          <Text dimColor>Ενημέρωση {time} · </Text>
          <Button key="refresh" label="Ανανέωση" onPress={() => void refresh($)} />
        </Box>
      </Box>
    )
  })
}
