// SessionStart hook (.claude/settings.json): installs what `npm test` needs when a Claude Code session starts.
// Everywhere: npm ci only when node_modules is missing (a new worktree), so an existing checkout is never touched.
// Cloud only (CLAUDE_CODE_REMOTE): Chromium too; locally Playwright already shares one Chromium across worktrees.
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const cloud = process.env.CLAUDE_CODE_REMOTE === 'true';
const root = new URL('..', import.meta.url);
const run = cmd => execSync(cmd, { cwd: root, stdio: ['ignore', process.stderr, process.stderr] });

if (!existsSync(new URL('node_modules', root))) {
  try {
    run('npm ci');
  } catch (err) {
    if (cloud) throw err;
    console.error('session-start: npm ci failed; run `npm ci` by hand before `npm test`.');
    process.exit(0);
  }
}
if (cloud) run('npx playwright install --with-deps chromium');
