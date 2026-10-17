// SessionStart hook (.claude/settings.json): in a Claude Code cloud session, installs what `npm test` needs.
// Locally (no CLAUDE_CODE_REMOTE) it exits at once, so it never touches anyone's own checkout.
// npm ci only when node_modules is missing; Playwright skips a Chromium that is already installed.
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

if (process.env.CLAUDE_CODE_REMOTE !== 'true') process.exit(0);

const root = new URL('..', import.meta.url);
const run = cmd => execSync(cmd, { cwd: root, stdio: ['ignore', process.stderr, process.stderr] });

if (!existsSync(new URL('node_modules', root))) run('npm ci');
run('npx playwright install --with-deps chromium');
