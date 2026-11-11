# CI, merge window and deploys

This doc covers the GitHub workflows, the merge window, and how the site, the previews and the API worker get deployed. It is Fanis's area (`.github/`).

## 1. Workflows

All files are in `.github/workflows/`.

| File (name) | Runs when | What it does | PR comment / artifacts |
|---|---|---|---|
| `test.yml` (Test) | every PR, or by hand | Checks out full history, then: secret scan of every commit with gitleaks (config `.gitleaks.toml`), `npm ci`, installs Chromium, `npm test` (unit + Playwright smoke), `npm run check:i18n`, and `wrangler deploy --dry-run` for the worker (builds it, deploys nothing). Language is set to Greek because tests read Greek text. | No comment. On failure it uploads `playwright-results` (14 days). |
| `lighthouse.yml` (Lighthouse) | every PR, or by hand | Serves `web/` and runs Lighthouse 11.7.1 on `?demo` home and stop 1011 (performance, accessibility, PWA). Report only: low scores never fail it, a crash does. | Posts or updates one PR comment with the scores (not on fork PRs). Uploads `lighthouse-reports` (14 days). |
| `merge-window.yml` (Merge window) | PR opened/updated/reopened/ready, on a schedule, or by hand | Sets the commit status `merge-window` (section 3). | None. |
| `pages.yml` (Pages) | push to `main`, or by hand | Stamps the service worker cache, uploads `web/`, deploys GitHub Pages. | None. |
| `worker-deploy.yml` (Worker deploy) | push to `main` that touches worker files, or by hand | Deploys the API worker (section 6). | None. |
| `watch-same-bus.yml` (Same-bus watch) | every 30 min in daytime, or by hand | Runs `scripts/watch-same-bus.mjs` (section 8). | Comments on one standing issue. |

## 2. Required checks before a merge

- The project rules name two required checks: `test` (the Test workflow) and `merge-window`.
- Lighthouse is not required. It only reports.
- Branch protection is a GitHub setting. It cannot be confirmed from the repo files, so check it in the repository settings if it matters.
- Only Kostas merges. `.github/CODEOWNERS` makes him the reviewer of every file. That becomes mandatory only if the branch ruleset has "Require review from Code Owners".
- Every PR uses `.github/pull_request_template.md`: task id, what changed, why, how it could break, screenshots from a phone, how it was tested.
- Before opening a PR, merge `main` into your branch, so the checks run against the current `main`.

## 3. Merge window

- No merges into `main` on Monday to Friday from 08:30 to 17:30 Athens time. The team's agreement is "nothing lands after 09:00"; the status closes at 08:30 so that a late GitHub cron run still closes it in time.
- The workflow computes Athens time itself and sets the status `merge-window` on the PR head commit. Open: `success`, "Merging is open". Closed: `pending`, "Closed until 17:30 (Athens). Use auto-merge to queue this PR."
- It runs on PR events and on a schedule. The cron lines are in UTC so both Athens offsets are covered; the job decides by Athens time. Close runs: 08:31 and 08:46. Open runs: 17:31 and 17:41 (two each, in case one is dropped). Scheduled runs update all open PRs that target `main`.
- A PR that is ready during the day gets "Enable auto-merge". It merges by itself after 17:30, once the status turns green.
- Holidays: add dates (`YYYY-MM-DD`, comma-separated) to the repository variable `MERGE_WINDOW_HOLIDAYS`. On those days the window stays open.
- To open it at once: Actions, Merge window, Run workflow.
- The job is called `stamp` on purpose. A check run named `merge-window` would satisfy the required check even while the status is pending.

## 4. The site

- Repo: https://github.com/CostGal/patra-bus. Site: https://costgal.github.io/patra-bus/.
- On every push to `main`, `pages.yml` uploads only `web/` to GitHub Pages. The tests do not gate it; they gate the merge.
- The site lives under the subpath `/patra-bus/`. So paths inside `web/` stay relative (`./data/…`, `sw.js`, `start_url: "./"`). A path that starts with `/` would point at the wrong place.

## 5. PR previews and cache stamping

- Each PR gets a preview from Cloudflare Workers Builds, project `patra-bus-dev`. It reads the root `wrangler.jsonc` and serves the static files in `web/`.
- That project is not the API worker. Previews call the production worker `patra-bus`, whose `ALLOWED_ORIGIN` accepts `https://*-patra-bus-dev.patra-bus.workers.dev` (see `docs/WORKER.md`, section 6).
- Reports sent from a preview get the prefix `[preview]` in Notion. Counters ignore previews.
- The root `wrangler.jsonc` only affects the Cloudflare build. Every npm script names its config file, so local runs do not use it.
- `scripts/stamp-cache.mjs` rewrites the `CACHE` line in `web/sw.js` to `patra-bus-<first 8 characters of the commit>`. `pages.yml` runs it before upload. The Cloudflare preview build is meant to run it too; that build command is a Cloudflare dashboard setting and is not visible in this repo. The committed file keeps its old value, so nobody edits `CACHE` by hand and PRs do not collide on it. A new file in `web/` still has to be added to the SHELL list in `sw.js`.

## 6. Worker deploy

The only way the API worker is deployed is the Action "Worker deploy". Nobody runs `wrangler deploy` from a computer, not even for staging. (The comment in the root `wrangler.jsonc` that says "deployed by hand" is out of date.)

- Staging: Actions, Worker deploy, Run workflow, pick any branch, target `staging`. Anyone with write access may do it. It goes to the worker `patra-bus-staging` (https://patra-bus-staging.patra-bus.workers.dev) with its own KV, Durable Objects and secrets (`[env.staging]` in `worker/wrangler.toml`).
- Production: only from `main`. The job refuses a production run from any other branch. It starts by itself after a push to `main` that changes one of these paths: `worker/**`, `web/js/arrivals.js`, `web/js/cities.js`, `web/js/notif-link.js`, `web/js/report.js`, `web/js/route.js`. It can also be started by hand on `main`.
- Then it waits for approval in the GitHub Environment `production`. Kostas approves. Without the approval, the worker stays behind the web files.
- The deploy step needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the matching GitHub Environment. It fails with a clear message if the token is missing. `wrangler deploy` does not change the worker's own secrets.
- One deploy per target at a time; a newer one waits.
- Order for a worker change: run it locally (`npm run dev:worker`), then deploy the branch to staging, then merge the PR and approve production.
- Staging and production share the daily free-plan limits of one Cloudflare account, so heavy staging tests use up production's quota.

## 7. Session start hook

`.claude/settings.json` has a `SessionStart` hook (matcher `startup`, timeout 600 s) that runs `node scripts/session-start.mjs`. The script makes sure `npm test` can run:

- It runs `npm ci` only if `node_modules` is missing (a new worktree). An existing checkout is never touched. If `npm ci` fails on a local machine, it prints a hint and goes on.
- In a cloud session (`CLAUDE_CODE_REMOTE=true`) it also installs Chromium for Playwright. Locally, Playwright shares one Chromium.

## 8. Same-bus watcher

`watch-same-bus.yml` looks for a live and a scheduled row of the same line that could be one bus, and reports on the issue "Same-bus watch (TEL-145)". It makes a few live requests per run with a token scraped on the fly, and it runs only from `main`. To pause it, disable the workflow in the Actions tab. Details are in `docs/ARCHITECTURE.md`.
