import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Block, Card } from '../types'

// Βάσεις του Notion (Telematica): Blocks και Code Tasks. Μόνο ανάγνωση.
const BLOCKS = 'collection://6f2b0107-6723-4fe4-b05d-a9d242fe884c'
const TASKS = 'collection://4da2abc0-511d-4dfb-b9c5-180656a8f5e2'
// Ο server του Notion: «Notion» στο cloud, ένα id ανά χρήστη τοπικά. Τον βρίσκουμε από τα εργαλεία του session.
const SERVERS = ['Notion', 'claude.ai Notion']
const NOTION_TOOL = /^mcp__(.+)__notion-query-data-sources$/
const STATUSES = ['In progress', 'In review', 'Not started']
const EVERY_MS = 5 * 60_000
// Κολλημένο = In progress ή In review πάνω από 7 μέρες από το Started on (το formula του Notion δεν διαβάζεται με SQL).
const STUCK_STATUSES = ['In progress', 'In review']
const STUCK_MS = 7 * 24 * 3600_000

// Τα χρώματα του Notion στο dark mode: σκούρο φόντο, ανοιχτό κείμενο. Διαβάζονται και σε ανοιχτό φόντο.
const TAG = {
  blue: { bg: '#28456C', fg: '#D5E5F5' },
  orange: { bg: '#854C1D', fg: '#F5DCC8' },
  pink: { bg: '#69314C', fg: '#F3D6E4' },
  green: { bg: '#2B593F', fg: '#D2EBDC' },
  gray: { bg: '#454545', fg: '#E3E3E3' },
}
type Tone = keyof typeof TAG
// Κάθε ομάδα του board: χρώμα του pill και της τελείας.
const GROUP: Record<string, { tone: Tone; dot: string }> = {
  'In progress': { tone: 'blue', dot: '#5E9FE0' },
  'In review': { tone: 'orange', dot: '#FFA344' },
  'Not started': { tone: 'gray', dot: '#9B9B9B' },
}
const AREA: Record<string, Tone> = { App: 'blue', Worker: 'orange', Design: 'pink', Business: 'green' }
const DONE_COLOR = '#4DAB7A'
const TRACK_COLOR = '#3A3A3A'
const CARD_BORDER = '#3A3A3A'

const PANE = 'tel-sprint'
const block = atom({ plugin: 'tel-sprint', key: 'block' } as const, { cards: [] })

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

type Row = Omit<Card, 'area' | 'pr' | 'stuck'> & {
  area: string | null; pr: string | null; started: string | null
}

/** Κολλημένο: ανοιχτή κάρτα (In progress / In review) που ξεκίνησε πριν από πάνω από 7 μέρες. */
export function isStuck(status: string, started: string | null | undefined, now: number): boolean {
  if (!started || !STUCK_STATUSES.includes(status)) return false
  const t = Date.parse(started)
  return Number.isFinite(t) && now - t > STUCK_MS
}

/** Το τρέχον block (Κατάσταση = Τρέχον) και οι κάρτες του συνδεδεμένου χρήστη: οι ανοιχτές στη λίστα, οι Done μόνο ως πλήθος. */
export async function loadBlock(ways: Way[], now: number): Promise<Omit<Block, 'error' | 'updatedAt'>> {
  const self = await notion(ways, 'notion-get-self', {})
  const userId: string = self.user.id
  const blocks = await notion(ways, 'notion-query-data-sources', sql([BLOCKS],
    `SELECT url, "Block" AS name FROM "${BLOCKS}" WHERE "Κατάσταση" = 'Τρέχον'`))
  const current = blocks.results[0] as { url: string; name?: string } | undefined
  if (!current) return { cards: [], done: 0 }
  const blockId = current.url.split('/').pop()!.replace(/-/g, '')
  const tasks = await notion(ways, 'notion-query-data-sources', sql([TASKS],
    `SELECT "userDefined:ID" AS id, "Task" AS title, "Task status" AS status, url,
       "Area" AS area, "PR" AS pr, "date:Started on:start" AS started
     FROM "${TASKS}" WHERE "Block" LIKE ? AND "Owner" LIKE ?`,
    [`%${blockId}%`, `%${userId}%`]))
  const rows = tasks.results as Row[]
  const cards = rows.filter(r => r.status !== 'Done').map((r): Card => ({
    id: r.id, title: r.title, status: r.status, url: notionLink(r.url),
    area: r.area || undefined, pr: r.pr || undefined, stuck: isStuck(r.status, r.started, now) || undefined,
  })).sort((a, b) => STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status) || a.id - b.id)
  return { cards, done: rows.length - cards.length, name: current.name || undefined }
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

async function refresh($: EngineInterface): Promise<Block> {
  let next: Block
  try {
    const ways = notionWays($, await notionServers($))
    const now = await $.clock.now()
    next = { ...(await loadBlock(ways, now)), updatedAt: now }
  } catch (err) {
    const prev = await read($, block)
    next = { ...prev, error: err instanceof Error ? err.message : String(err) }
  }
  await update($, block, () => next)
  return next
}

/** Η λίστα ως κείμενο, για την απάντηση του /block (και όπου δεν φαίνεται το pane). */
export function listText(cards: Card[]): string {
  const lines = [`Block: ${cards.length} κάρτες`]
  for (const status of STATUSES) {
    const group = cards.filter(c => c.status === status)
    if (group.length === 0) continue
    lines.push(`${status} (${group.length})`)
    for (const c of group) lines.push(`  TEL-${c.id} · ${c.title}${c.stuck ? ' · Κολλημένο' : ''}`)
  }
  return lines.join('\n')
}

/** Μπάρα προόδου για το desktop: γκρι βάση, πράσινο το μέρος που είναι Done. */
export function progressSvg(done: number, total: number): string {
  const w = total > 0 ? Math.round((done / total) * 100) : 0
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 8" preserveAspectRatio="none">`
    + `<rect width="100" height="8" rx="4" fill="${TRACK_COLOR}"/>`
    + (w > 0 ? `<rect width="${w}" height="8" rx="4" fill="${DONE_COLOR}"/>` : '')
    + `</svg>`
}

/** Η ίδια μπάρα με χαρακτήρες, για το terminal (δεν έχει Svg). */
export function progressText(done: number, total: number, width = 10): string {
  const full = total > 0 ? Math.round((done / total) * width) : 0
  return '█'.repeat(full) + '░'.repeat(width - full)
}

/** Το πεδίο «PR» μπορεί να έχει PR ή issue του GitHub: `…/pull/77` → `PR #77`, `…/issues/24` → `Issue #24`. */
export function githubLabel(url: string): string {
  const m = /\/(pull|issues)\/(\d+)/.exec(url)
  if (!m) return 'PR'
  return `${m[1] === 'pull' ? 'PR' : 'Issue'} #${m[2]}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'block', description: 'Οι κάρτες TEL του τρέχοντος block σου (Notion)' })
    await $.command.register({ name: 'sprint', description: 'Alias του /block' })
    void $.ui.open({ id: PANE, title: 'Block' })
    void refresh($)
    timer?.cancel()
    timer = $.clock.every(EVERY_MS, () => void refresh($))
    return next(e)
  })

  // Το /sprint μένει ως alias του /block.
  for (const command of ['block', 'sprint']) {
    on('command.run', { command }, async $ => {
      const { isPlaced } = await $.ui.open({ id: PANE, title: 'Block' })
      const s = await refresh($)
      if (s.error) return { text: `Block: δεν διαβάστηκε το Notion (${s.error}).` }
      const where = isPlaced ? '' : '\n(Το pane δεν εμφανίζεται σε αυτό το session.)'
      return { text: listText(s.cards) + where }
    })
  }

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Link, Button } = els
    // Το terminal δεν έχει Svg ούτε στρογγυλές γωνίες (ένα περίγραμμα εκεί πιάνει 3 γραμμές):
    // εκεί μένουν απλές χρωματιστές ετικέτες και μπάρα με χαρακτήρες.
    const gui = e.surface !== 'terminal'
    const Svg = gui && 'Svg' in els ? els.Svg : undefined
    const s = await read($, block)
    const loaded = s.updatedAt !== undefined
    const time = loaded
      ? new Date(s.updatedAt!).toLocaleTimeString('el-GR', { hour: '2-digit', minute: '2-digit' })
      : '…'
    const done = s.done ?? 0
    const total = done + s.cards.length
    const pct = total > 0 ? Math.round((done / total) * 100) : 0

    // Pill: στο desktop Box με στρογγυλό περίγραμμα στο χρώμα του φόντου· στο terminal Text με φόντο.
    const pill = (key: string, tone: Tone, label: string, href?: string) => {
      const { bg, fg } = TAG[tone]
      if (!gui) {
        return href
          ? <Link key={key} href={href} label={label} />
          : <Text key={key} backgroundColor={bg} color={fg}> {label} </Text>
      }
      return (
        <Box key={key} borderStyle="round" borderColor={bg} backgroundColor={bg} paddingX={1}>
          {href ? <Link href={href} label={label} /> : <Text color={fg}>{label}</Text>}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        {s.name && (
          <Box flexDirection="column">
            <Text bold>{s.name}</Text>
            <Box flexDirection="row" gap={1} alignItems="center">
              {Svg
                ? <Svg source={progressSvg(done, total)} alt={`${done}/${total} done`} width={200} height={10} />
                : <Text color={DONE_COLOR}>{progressText(done, total)}</Text>}
              <Text dimColor>{done}/{total} done · {pct}%</Text>
            </Box>
          </Box>
        )}
        {s.error && <Text color="red">Notion: {s.error}</Text>}
        {!s.error && !loaded && <Text dimColor>Φόρτωση…</Text>}
        {loaded && s.cards.length === 0 && <Text dimColor>Καμία ανοιχτή κάρτα στο τρέχον block.</Text>}
        {STATUSES.map(status => {
          const group = s.cards.filter(c => c.status === status)
          if (group.length === 0) return null
          const { tone, dot } = GROUP[status]!
          return (
            <Box flexDirection="column" gap={1} key={status}>
              <Box flexDirection="row" gap={1} alignItems="center">
                {gui
                  ? (
                    <Box key={`status-${status}`} flexDirection="row" gap={1} borderStyle="round"
                      borderColor={TAG[tone].bg} backgroundColor={TAG[tone].bg} paddingX={1}>
                      <Text color={dot}>●</Text>
                      <Text color={TAG[tone].fg}>{status}</Text>
                    </Box>
                  )
                  : <Text color={dot}>●</Text>}
                {!gui && <Text bold>{status}</Text>}
                <Text dimColor>{group.length}</Text>
              </Box>
              {group.map(c => {
                const tags = [
                  c.area && pill('area', AREA[c.area] ?? 'gray', c.area),
                  c.stuck && pill('stuck', 'orange', 'Κολλημένο'),
                  c.pr && pill('pr', 'gray', githubLabel(c.pr), c.pr),
                ].filter(Boolean)
                return (
                  <Box key={`TEL-${c.id}`} flexDirection="column"
                    borderStyle="round" borderColor={CARD_BORDER} paddingX={1}>
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
        <Box flexDirection="row" alignItems="center">
          <Text dimColor>Ενημέρωση {time} · </Text>
          <Button key="refresh" label="Ανανέωση" onPress={() => void refresh($)} />
        </Box>
      </Box>
    )
  })
}
