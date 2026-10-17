import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Card, Sprint } from '../types'

// Βάσεις του Notion (Telematica): Sprints και Tasks. Μόνο ανάγνωση.
const SPRINTS = 'collection://3f82429c-7223-8005-bc25-000bf5983bd0'
const TASKS = 'collection://4da2abc0-511d-4dfb-b9c5-180656a8f5e2'
// Ο server του Notion: «Notion» στο cloud, ένα id ανά χρήστη τοπικά. Τον βρίσκουμε από τα εργαλεία του session.
const SERVERS = ['Notion', 'claude.ai Notion']
const NOTION_TOOL = /^mcp__(.+)__notion-query-data-sources$/
const STATUSES = ['In progress', 'In review', 'Not started']
const EVERY_MS = 5 * 60_000

// Τα χρώματα των ετικετών του Notion (light): φόντο και κείμενο, και η τελεία κάθε ομάδας του board.
const TAG = {
  blue: { bg: '#D3E5EF', fg: '#183347' },
  orange: { bg: '#FADEC9', fg: '#49290E' },
  pink: { bg: '#F5E0E9', fg: '#4C2337' },
  green: { bg: '#DBEDDB', fg: '#1C3829' },
  gray: { bg: '#E3E2E0', fg: '#32302C' },
}
type Tone = keyof typeof TAG
const DOT: Record<string, string> = { 'In progress': '#337EA9', 'In review': '#D9730D', 'Not started': '#9B9A97' }
const AREA: Record<string, Tone> = { App: 'blue', Worker: 'orange', Design: 'pink', Business: 'green' }
const WHO: Record<string, Tone> = { Dev: 'blue', Claude: 'orange' }
const DONE_COLOR = '#448361'

const PANE = 'tel-sprint'
const sprint = atom({ plugin: 'tel-sprint', key: 'sprint' } as const, { cards: [] })

/** Ένας τρόπος να καλέσουμε ένα εργαλείο του Notion· `run` δίνει το κείμενο της απάντησης. */
export type Way = { name: string; run: (tool: string, args: Record<string, unknown>) => Promise<string> }

// Ο τρόπος που δούλεψε τελευταία δοκιμάζεται πρώτος.
let working: string | undefined

async function notion(ways: Way[], tool: string, args: Record<string, unknown>): Promise<any> {
  const errors: string[] = []
  const ordered = [...ways].sort((a, b) => Number(b.name === working) - Number(a.name === working))
  for (const way of ordered) {
    try {
      const text = await way.run(tool, args)
      const value = JSON.parse(text)
      working = way.name
      return value
    } catch (err) {
      errors.push(`${way.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  throw new Error(errors.join(' | ') || 'Δεν βρέθηκε ο Notion connector')
}

function sql(urls: string[], query: string, params: string[] = []) {
  return { data: { data_source_urls: urls, query, params } }
}

/** Το Notion δίνει `https://app.notion.com/<id>`, που δεν ανοίγει στον browser· το `www.notion.so/<id>` ανοίγει. */
export function notionLink(url: string): string {
  const id = url.split('?')[0].split('/').pop() ?? ''
  return `https://www.notion.so/${id.replace(/-/g, '')}`
}

type Row = Omit<Card, 'area' | 'who' | 'due' | 'pr'> & {
  area: string | null; who: string | null; due: string | null; pr: string | null
}

/** Το τρέχον sprint και οι κάρτες του συνδεδεμένου χρήστη: οι ανοιχτές στη λίστα, οι Done μόνο ως πλήθος. */
export async function loadSprint(ways: Way[]): Promise<Omit<Sprint, 'error' | 'updatedAt'>> {
  const self = await notion(ways, 'notion-get-self', {})
  const userId: string = self.user.id
  const sprints = await notion(ways, 'notion-query-data-sources', sql([SPRINTS],
    `SELECT url, "Sprint name" AS name, "date:Dates:start" AS start, "date:Dates:end" AS end
     FROM "${SPRINTS}" WHERE "Sprint status" = 'Current'`))
  const current = sprints.results[0] as { url: string; name?: string; start?: string; end?: string } | undefined
  if (!current) return { cards: [], done: 0 }
  const sprintId = current.url.split('/').pop()!.replace(/-/g, '')
  const tasks = await notion(ways, 'notion-query-data-sources', sql([TASKS],
    `SELECT "userDefined:ID" AS id, "Task" AS title, "Task status" AS status, url,
       "Area" AS area, "Who does this" AS who, "date:Due:start" AS due, "PR" AS pr
     FROM "${TASKS}" WHERE "Sprint" LIKE ? AND "Owner" LIKE ?`,
    [`%${sprintId}%`, `%${userId}%`]))
  const rows = tasks.results as Row[]
  const cards = rows.filter(r => r.status !== 'Done').map((r): Card => ({
    id: r.id, title: r.title, status: r.status, url: notionLink(r.url),
    area: r.area || undefined, who: r.who || undefined, due: r.due || undefined, pr: r.pr || undefined,
  })).sort((a, b) => STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status) || a.id - b.id)
  return {
    cards,
    done: rows.length - cards.length,
    name: current.name || undefined,
    start: current.start || undefined,
    end: current.end || undefined,
  }
}

let timer: { cancel: () => void } | undefined

/** Οι servers που έχουν τα εργαλεία του Notion σε αυτό το session (τοπικά ένα id ανά χρήστη). */
async function notionServers($: EngineInterface): Promise<string[]> {
  try {
    return (await $.tool.list()).flatMap(t => NOTION_TOOL.exec(t.name)?.[1] ?? [])
  } catch {
    return []
  }
}

/**
 * Πρώτα $.mcp.call (χωρίς ερώτηση άδειας) στους servers που βρέθηκαν και στα γνωστά ονόματα, μετά
 * $.tool.call όπως τα καλεί το Claude (περνά από τις άδειες), για connectors που δίνει η εφαρμογή.
 */
function notionWays($: EngineInterface, found: string[]): Way[] {
  const direct = [...new Set([...found, ...SERVERS])].map((server): Way => ({
    name: server,
    run: async (tool, args) => {
      const res = await $.mcp.call(server, tool, args)
      const text = res.content.find(b => b.type === 'text')?.text ?? ''
      if (res.isError) throw new Error(text || 'σφάλμα Notion')
      return text
    },
  }))
  const asTool = found.map((server): Way => ({
    name: `tool:${server}`,
    run: async (tool, args) => {
      const res = await $.tool.call({ tool: `mcp__${server}__${tool}`, ...args } as never)
      if (res.deny) throw new Error(res.deny)
      if (res.isError) throw new Error(res.text || 'σφάλμα Notion')
      return res.text ?? ''
    },
  }))
  return [...direct, ...asTool]
}

async function refresh($: EngineInterface): Promise<Sprint> {
  let next: Sprint
  try {
    const ways = notionWays($, await notionServers($))
    next = { ...(await loadSprint(ways)), updatedAt: await $.clock.now() }
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

/** `2026-10-13` → `13/10`. */
function shortDate(iso: string): string {
  const [, m, d] = iso.slice(0, 10).split('-')
  return `${Number(d)}/${Number(m)}`
}

/** Μπάρα προόδου για το desktop: γκρι βάση, πράσινο το μέρος που είναι Done. */
export function progressSvg(done: number, total: number): string {
  const w = total > 0 ? Math.round((done / total) * 100) : 0
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 8" preserveAspectRatio="none">`
    + `<rect width="100" height="8" rx="4" fill="${TAG.gray.bg}"/>`
    + (w > 0 ? `<rect width="${w}" height="8" rx="4" fill="${DONE_COLOR}"/>` : '')
    + `</svg>`
}

/** Η ίδια μπάρα με χαρακτήρες, για το terminal (δεν έχει Svg). */
export function progressText(done: number, total: number, width = 10): string {
  const full = total > 0 ? Math.round((done / total) * width) : 0
  return '█'.repeat(full) + '░'.repeat(width - full)
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
    const els = $.ui.resolve(e)
    const { Box, Text, Link, Button } = els
    // Το terminal δεν έχει Svg (θα το έδειχνε κενό)· εκεί η μπάρα γίνεται με χαρακτήρες.
    const Svg = e.surface !== 'terminal' && 'Svg' in els ? els.Svg : undefined
    const s = await read($, sprint)
    const loaded = s.updatedAt !== undefined
    const time = loaded
      ? new Date(s.updatedAt!).toLocaleTimeString('el-GR', { hour: '2-digit', minute: '2-digit' })
      : '…'
    const done = s.done ?? 0
    const total = done + s.cards.length
    const dates = [s.start, s.end].filter(Boolean).map(d => shortDate(d!)).join(' – ')

    const tag = (key: string, label: string, tone: Tone) => (
      <Text key={key} backgroundColor={TAG[tone].bg} color={TAG[tone].fg}> {label} </Text>
    )

    return (
      <Box flexDirection="column" gap={1}>
        {s.name && (
          <Box flexDirection="column">
            <Text bold>{s.name}</Text>
            {dates && <Text dimColor>{dates}</Text>}
            <Box flexDirection="row" gap={1} alignItems="center">
              {Svg
                ? <Svg source={progressSvg(done, total)} alt={`${done}/${total} done`} width={160} height={8} />
                : <Text color={DONE_COLOR}>{progressText(done, total)}</Text>}
              <Text dimColor>{done}/{total} done</Text>
            </Box>
          </Box>
        )}
        {s.error && <Text color="red">Notion: {s.error}</Text>}
        {!s.error && !loaded && <Text dimColor>Φόρτωση…</Text>}
        {loaded && s.cards.length === 0 && <Text dimColor>Καμία ανοιχτή κάρτα στο τρέχον sprint.</Text>}
        {STATUSES.map(status => {
          const group = s.cards.filter(c => c.status === status)
          if (group.length === 0) return null
          return (
            <Box flexDirection="column" gap={1} key={status}>
              <Box flexDirection="row" gap={1}>
                <Text color={DOT[status]}>●</Text>
                <Text bold>{status}</Text>
                <Text dimColor>{group.length}</Text>
              </Box>
              {group.map(c => {
                const pr = c.pr ? /\/pull\/(\d+)/.exec(c.pr)?.[1] : undefined
                const tags = [
                  c.area && tag('area', c.area, AREA[c.area] ?? 'gray'),
                  c.who && tag('who', c.who, WHO[c.who] ?? 'gray'),
                  c.due && tag('due', `Due ${shortDate(c.due)}`, 'gray'),
                  c.pr && <Link key="pr" href={c.pr} label={pr ? `PR #${pr}` : 'PR'} />,
                ].filter(Boolean)
                return (
                  <Box key={`TEL-${c.id}`} flexDirection="column" borderStyle="round" borderColor="#D9D9D6" paddingX={1}>
                    <Text>
                      <Text dimColor>TEL-{c.id}</Text> <Link href={c.url} label={c.title} />
                    </Text>
                    {tags.length > 0 && <Box flexDirection="row" flexWrap="wrap" gap={1}>{tags}</Box>}
                  </Box>
                )
              })}
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
