// CI only (.github/workflows/lighthouse.yml): turns Lighthouse JSON reports into the sticky PR comment.
// Usage: node scripts/lighthouse-comment.mjs <label>=<report.json> [<label>=<report.json> ...] > comment.md
// Env (optional): LH_SHA, LH_RUN_URL. Exits 1 if a report is missing/unreadable or Lighthouse hit a runtime error,
// so a crashed run fails the job; low scores never do (report only).
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const MARKER = '<!-- lighthouse-scores -->';
export const CATEGORIES = [
  ['performance', 'Performance'],
  ['accessibility', 'Accessibility'],
  ['pwa', 'PWA'],
];

export function badge(score) {
  if (score == null) return '⚪ n/a';
  const n = Math.round(score * 100);
  return `${n >= 90 ? '🟢' : n >= 50 ? '🟠' : '🔴'} ${n}`;
}

// reports: [{ label, lhr }]
export function buildComment(reports, { sha = '', runUrl = '' } = {}) {
  const head = `| | ${CATEGORIES.map(([, name]) => name).join(' | ')} |`;
  const sep = `|---|${CATEGORIES.map(() => ':---:').join('|')}|`;
  const rows = reports.map(({ label, lhr }) =>
    `| **${label}** | ${CATEGORIES.map(([id]) => badge(lhr.categories?.[id]?.score)).join(' | ')} |`);
  const urls = reports.map(({ label, lhr }) => `- **${label}**: \`${lhr.requestedUrl || lhr.finalDisplayedUrl || lhr.finalUrl}\``);
  const version = reports[0]?.lhr.lighthouseVersion;
  const warnings = reports.flatMap(({ label, lhr }) => (lhr.runWarnings || []).map((w) => `- ${label}: ${String(w).split('\n')[0]}`));
  return [
    MARKER,
    '### Lighthouse (mobile)',
    '',
    head,
    sep,
    ...rows,
    '',
    '<sub>🟢 ≥ 90 · 🟠 ≥ 50 · 🔴 &lt; 50</sub>',
    '',
    'Audited (static `web/` on http-server, `?demo` = simulated arrivals, no worker):',
    ...urls,
    '',
    `Commit: \`${sha ? sha.slice(0, 7) : 'unknown'}\`${version ? ` · Lighthouse ${version}` : ''}` +
      (runUrl ? ` · [full HTML/JSON reports (workflow artifacts)](${runUrl})` : ''),
    '',
    '> Single run on a shared CI VM with simulated mobile throttling: Performance can swing by ±10 between runs. ' +
      'Treat it as a trend signal, not a gate. Accessibility and PWA are stable.',
    ...(warnings.length ? ['', '<details><summary>Lighthouse warnings</summary>', '', ...warnings, '', '</details>'] : []),
    '',
  ].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error('usage: node scripts/lighthouse-comment.mjs <label>=<report.json> ...');
    process.exit(2);
  }
  const reports = [];
  let failed = false;
  for (const arg of args) {
    const i = arg.indexOf('=');
    const [label, file] = i > 0 ? [arg.slice(0, i), arg.slice(i + 1)] : [arg, arg];
    let lhr;
    try {
      lhr = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      console.error(`lighthouse-comment: cannot read ${file}: ${e.message}`);
      failed = true;
      continue;
    }
    if (lhr.runtimeError) {
      console.error(`lighthouse-comment: ${label}: ${lhr.runtimeError.code}: ${lhr.runtimeError.message}`);
      failed = true;
    }
    reports.push({ label, lhr });
  }
  if (failed) process.exit(1);
  process.stdout.write(buildComment(reports, { sha: process.env.LH_SHA, runUrl: process.env.LH_RUN_URL }));
}
