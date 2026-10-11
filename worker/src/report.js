// Problem reports -> one page in a Notion database. Validation is shared with the app (web/js/report.js).
// Nothing is stored here: the report goes to Notion and that is all. The caller's IP is only used by the in-memory rate
// limiter in index.js and never reaches the payload below.
//
// Database schema this expects (property names are exact):
//   Name (title) · Category (select) · Status (select) · City (select) · Email (email) · Received (date)
// Secrets (wrangler secret put / worker/.dev.vars): NOTION_TOKEN (internal integration, shared with the database), NOTION_DB_ID.

const NOTION_PAGES = 'https://api.notion.com/v1/pages';
const NOTION_VERSION = '2022-06-28';
const FORWARD_MS = 8000;

export const MAX_REPORT_BYTES = 8192;
export const DAILY_MAX = 100; // reports forwarded per UTC day, all clients together: a flood stops here, not in Notion
const DAY_TTL_S = 2 * 86400;

const CATEGORY = { data: 'Data', app: 'App', idea: 'Idea', other: 'Other' };

// First line of the message, one line, at most `max` code points.
function headline(message, max = 70) {
  const line = Array.from(message.split('\n')[0].replace(/\s+/g, ' ').trim());
  return line.length > max ? `${line.slice(0, max - 1).join('')}…` : line.join('');
}

const text = (content) => [{ type: 'text', text: { content } }];

// Body of POST /v1/pages for a validated report (see validateReport).
export function notionPage(v, { dbId, now }) {
  const properties = {
    Name: { title: text(`${CATEGORY[v.category]}: ${headline(v.message)}`) },
    Category: { select: { name: CATEGORY[v.category] } },
    Status: { select: { name: 'New' } },
    Received: { date: { start: new Date(now).toISOString() } },
  };
  if (v.diag.city) properties.City = { select: { name: v.diag.city } };
  if (v.email) properties.Email = { email: v.email };
  return {
    parent: { database_id: dbId },
    properties,
    children: [
      { object: 'block', type: 'paragraph', paragraph: { rich_text: text(v.message) } },
      { object: 'block', type: 'heading_3', heading_3: { rich_text: text('Diagnostics') } },
      { object: 'block', type: 'code', code: { language: 'json', rich_text: text(JSON.stringify(v.diag, null, 2)) } },
    ],
  };
}

export class ForwardError extends Error {
  constructor(status) {
    super(`notion ${status}`);
    this.status = status;
  }
}

// Throws ForwardError (never with the report's content in the message). `fetchFn` is injectable for tests.
export async function forwardReport(env, v, now, fetchFn = (...a) => fetch(...a)) {
  let res;
  try {
    res = await fetchFn(NOTION_PAGES, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
      body: JSON.stringify(notionPage(v, { dbId: env.NOTION_DB_ID, now })),
      signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(FORWARD_MS) : undefined,
    });
  } catch {
    throw new ForwardError(0);
  }
  if (!res.ok) throw new ForwardError(res.status);
}

// Global daily cap in KV (best effort: a read-modify-write, so a burst can overshoot slightly; KV down = fail open).
// -> true when this report may go through.
export async function takeDailySlot(env, now) {
  const key = `report-day/${new Date(now).toISOString().slice(0, 10)}`;
  try {
    const n = Number(await env.KV.get(key)) || 0;
    if (n >= DAILY_MAX) return false;
    await env.KV.put(key, String(n + 1), { expirationTtl: DAY_TTL_S });
  } catch { /* no cap rather than no reports */ }
  return true;
}
