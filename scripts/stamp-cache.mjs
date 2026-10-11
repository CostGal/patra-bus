// Deploy-time only: stamps CACHE in web/sw.js with the commit, so nobody bumps it by hand (and PRs don't conflict on it).
// Usage: node scripts/stamp-cache.mjs [sha]   (sha defaults to GITHUB_SHA, CF_PAGES_COMMIT_SHA, then `git rev-parse HEAD`)
// The committed file keeps its patra-bus-vNN value; run this on the deploy checkout only.
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const SW = new URL('../web/sw.js', import.meta.url);
const RE = /^const CACHE = '[^']*';/m;

export function stamp(source, sha) {
  if (!RE.test(source)) throw new Error('stamp-cache: CACHE line not found in sw.js');
  return source.replace(RE, `const CACHE = 'patra-bus-${sha.slice(0, 8)}';`);
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  const sha = process.argv[2] || process.env.GITHUB_SHA || process.env.CF_PAGES_COMMIT_SHA || execSync('git rev-parse HEAD').toString().trim();
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) throw new Error('stamp-cache: bad sha');
  writeFileSync(SW, stamp(readFileSync(SW, 'utf8'), sha));
  console.log(`CACHE -> patra-bus-${sha.slice(0, 8)}`);
}
