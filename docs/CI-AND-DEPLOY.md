# CI, merge window and deploys

This doc covers the GitHub workflows, the merge window, and how the site, the previews and the API worker get deployed. It is Fanis's area (`.github/`).

## 1. Workflows

All files are in `.github/workflows/`.

| File (name) | Runs when | What it does | PR comment / artifacts |
|---|---|---|---|
| `test.yml` (Test) | every PR, or by hand | Checks out full history, then: secret scan of every commit with gitleaks (config `.gitleaks.toml`), `npm ci`, installs Chromium, `npm test` (unit + Playwright smoke), `npm run check:i18n`, and `wrangler deploy --dry-run` for the worker (builds it, deploys nothing). Language is set to Greek because tests read Greek text. | No comment. On failure it uploads `playwright-results` (14 days). |
| `lighthouse.yml` (Lighthouse) | every PR, or by hand | Serves `web/` and runs Lighthouse 11.7.1 on `?demo` home and stop 1011 (performance, accessibility, PWA). Report only: low scores never fail it, a crash does. | Posts or updates one PR comment with the scores (not on fork PRs). Uploads `lighthouse-reports` (14 days). |
| `merge-window.yml` (Merge window) | PR opened/updated/reopened/ready, on a schedule, or by hand | Sets the commit status `merge-window` (section 3). | None. |
| `pages.yml` (Pages) | a published Release with a tag like `v0.9.1`, or by hand from such a tag | Checks the tag, stamps the service worker cache, uploads `web/`, deploys GitHub Pages (section 9). | None. |
| `worker-deploy.yml` (Worker deploy) | push to `main` that touches worker files (staging), a published Release (production), or by hand | Deploys the API worker (sections 6 and 9). | None. |
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
- The site changes only when a Release is published (section 9). Then `pages.yml` uploads only `web/` to GitHub Pages. A merge to `main` does not change the site. The tests do not gate the deploy; they gate the merge.
- Between releases, `main` is not shown on the site. A change is seen on its PR preview (section 5).
- The site lives under the subpath `/patra-bus/`. So paths inside `web/` stay relative (`./data/…`, `sw.js`, `start_url: "./"`). A path that starts with `/` would point at the wrong place.

## 5. PR previews and cache stamping

- Each PR gets a preview from Cloudflare Workers Builds, project `patra-bus-dev`. It reads the root `wrangler.jsonc` and serves the static files in `web/`.
- That project is not the API worker. Previews call the production worker `patra-bus`, whose `ALLOWED_ORIGIN` accepts `https://*-patra-bus-dev.patra-bus.workers.dev` (see `docs/WORKER.md`, section 6).
- Reports sent from a preview get the prefix `[preview]` in Notion. Counters ignore previews.
- The root `wrangler.jsonc` only affects the Cloudflare build. Every npm script names its config file, so local runs do not use it.
- `scripts/stamp-cache.mjs` rewrites the `CACHE` line in `web/sw.js` to `patra-bus-<first 8 characters of the commit>`. `pages.yml` runs it before upload. The Cloudflare preview build is meant to run it too; that build command is a Cloudflare dashboard setting and is not visible in this repo. The committed file keeps its old value, so nobody edits `CACHE` by hand and PRs do not collide on it. A new file in `web/` still has to be added to the SHELL list in `sw.js`.

## 6. Worker deploy

The only way the API worker is deployed is the Action "Worker deploy". Nobody runs `wrangler deploy` from a computer, not even for staging. (The comment in the root `wrangler.jsonc` that says "deployed by hand" is out of date.)

- Staging: it deploys by itself after a push to `main` that changes one of these paths: `worker/**`, `web/js/arrivals.js`, `web/js/cities.js`, `web/js/notif-link.js`, `web/js/report.js`, `web/js/route.js`. So staging follows `main`. By hand: Actions, Worker deploy, Run workflow, pick any branch, target `staging`. Anyone with write access may do it. A merge to `main` overwrites a branch that someone put on staging by hand, so say it in the team chat when you test there. It goes to the worker `patra-bus-staging` (https://patra-bus-staging.patra-bus.workers.dev) with its own KV, Durable Objects and secrets (`[env.staging]` in `worker/wrangler.toml`).
- Production: only from a published Release (section 9). The `check` job refuses a production run that is not on a tag like `v0.9.1`, or whose commit is not in `main`. A merge to `main` does not reach production. By hand it runs only from such a tag (the rollback in section 9).
- Then it waits for approval in the GitHub Environment `production`. Kostas approves. Without the approval, the worker stays behind the site.
- The deploy step needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the matching GitHub Environment. It fails with a clear message if the token is missing. `wrangler deploy` does not change the worker's own secrets.
- One deploy per target at a time; a newer one waits.
- Order for a worker change: run it locally (`npm run dev:worker`), then deploy the branch to staging, then merge the PR (staging now has `main`), then publish a Release and approve production.
- Staging and production share the daily free-plan limits of one Cloudflare account, so heavy staging tests use up production's quota.

## 7. Session start hook

`.claude/settings.json` has a `SessionStart` hook (matcher `startup`, timeout 600 s) that runs `node scripts/session-start.mjs`. The script makes sure `npm test` can run:

- It runs `npm ci` only if `node_modules` is missing (a new worktree). An existing checkout is never touched. If `npm ci` fails on a local machine, it prints a hint and goes on.
- In a cloud session (`CLAUDE_CODE_REMOTE=true`) it also installs Chromium for Playwright. Locally, Playwright shares one Chromium.

## 8. Same-bus watcher

`watch-same-bus.yml` looks for a live and a scheduled row of the same line that could be one bus, and reports on the issue "Same-bus watch (TEL-145)". It makes a few live requests per run with a token scraped on the fly, and it runs only from `main`. To pause it, disable the workflow in the Actions tab. Details are in `docs/ARCHITECTURE.md`.

## 9. Releases: how users get a change

Users get a change only when a GitHub Release is published (TEL-211). A merge to `main` updates staging only.

How to publish:

1. GitHub, Releases, "Draft a new release".
2. "Choose a tag": type a new tag, `v` and three numbers (for example `v0.9.1`), and pick "Create new tag on publish". Target: `main`.
3. Title: the tag, plus a few words if you like. Press "Generate release notes".
4. Leave "Set as a pre-release" off. A pre-release deploys nothing.
5. "Publish release". Kostas presses it. Anyone may prepare the draft ("Save draft"); a draft deploys nothing.

What happens next:

- `pages.yml` runs at once and the site changes.
- `worker-deploy.yml` waits in the Environment `production`. Kostas opens the run in Actions, "Review deployments", approves. Until then the site is ahead of the worker.
- Both run on every release, also when only one of the two changed.
- In both, the `check` job runs first. It fails, and nothing is deployed, when the tag is not `v` and three numbers or its commit is not in `main`.
- Check after: https://costgal.github.io/patra-bus/ and https://patra-bus.patra-bus.workers.dev/health.
- Editing or deleting a release later deploys nothing and undoes nothing.

How to roll back to the release before:

1. Actions, Pages, "Run workflow", "Use workflow from": tab Tags, pick the older tag (for example `v0.9.0`), Run.
2. Actions, Worker deploy, "Run workflow", the same tag, target `production`, Run. Kostas approves.

Limits of the rollback:

- It works for tags made after TEL-211 was merged. A run from a tag uses the workflow file as it was at that tag.
- The worker cannot go back past a Durable Object migration (`[[migrations]]` in `worker/wrangler.toml`). Then fix it on `main` and publish a new release.
- The other way is always open: a PR that reverts the change, then a new release (for example `v0.9.2`).

Settings this needs (GitHub, Settings, Environments; Kostas). They cannot be confirmed from the repo files:

- `production` and `github-pages` must allow tags `v*` under "Deployment branches and tags". If they allow only the branch `main`, a release run is refused.
- `github-pages` has no reviewer unless one is added there. Without one, whoever publishes a release changes the site with no approval step.
