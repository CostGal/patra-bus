// «Update the app» (TEL-286, docs/WORKER.md section 12). Once after boot the app asks the worker which app versions it
// still serves (GET /version → { api, minApp }). When this app (APP_VERSION) is older than minApp, a toast asks the user
// to update; its button fetches the new service worker and reloads. Nothing is sent but the request itself (no id, no
// data: CLAUDE.md rule 4). Silent on any failure, and never in ?demo.
import { API_BASE, DEMO } from './api.js';
import { t, APP_VERSION } from './i18n.js';
import { toast } from './ui.js';

// Semver order with prereleases: 0.9.0-beta.1 < 0.9.0-beta.2 < 0.9.0 < 0.10.0 (same as tests/worker-contract.test.mjs).
export function compareVersions(a, b) {
  const [ma, pa = ''] = String(a).split('-');
  const [mb, pb = ''] = String(b).split('-');
  const na = ma.split('.').map(Number), nb = mb.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (na[i] !== nb[i]) return na[i] < nb[i] ? -1 : 1;
  if (pa === pb) return 0;
  if (!pa) return 1;
  if (!pb) return -1;
  const xa = pa.split('.'), xb = pb.split('.');
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    if (xa[i] === undefined) return -1;
    if (xb[i] === undefined) return 1;
    const da = /^\d+$/.test(xa[i]), db = /^\d+$/.test(xb[i]);
    if (da && db && Number(xa[i]) !== Number(xb[i])) return Number(xa[i]) < Number(xb[i]) ? -1 : 1;
    if (da !== db) return da ? -1 : 1;
    if (!da && xa[i] !== xb[i]) return xa[i] < xb[i] ? -1 : 1;
  }
  return 0;
}

const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;
// true only for a well-formed minApp newer than the app; anything odd from the worker is ignored.
export const isOutdated = (app, minApp) => VERSION_RE.test(String(minApp ?? '')) && VERSION_RE.test(String(app)) && compareVersions(app, minApp) < 0;

// ?update-test shows the toast at once, without asking the worker, so it can be seen on a phone (also with ?demo).
const FORCE = (() => { try { return new URLSearchParams(location.search).has('update-test'); } catch { return false; } })();

// The new files come with the new service worker (skipWaiting + clients.claim in sw.js): ask for it, reload once it
// has taken over, or after 4 s anyway.
function updateAndReload() {
  // In the ?update-test check there is no newer app: reload without the flag, so the toast goes away as it would after
  // a real update (with the flag it would come straight back).
  const reload = () => {
    if (!FORCE) return location.reload();
    const url = new URL(location.href);
    url.searchParams.delete('update-test');
    location.replace(url.href);
  };
  const sw = navigator.serviceWorker;
  if (FORCE || !sw) return reload();
  const timer = setTimeout(reload, 4000);
  sw.addEventListener('controllerchange', () => { clearTimeout(timer); reload(); }, { once: true });
  sw.getRegistration().then((r) => r?.update()).catch(() => {});
}

// Called once after boot. -> true when the toast was shown (for tests). Never throws.
export async function checkAppVersion({ fetchFn = globalThis.fetch, demo = DEMO, app = APP_VERSION, show = showToast, force = FORCE } = {}) {
  if (force) { show(); return true; }
  if (demo || typeof fetchFn !== 'function') return false;
  try {
    const res = await fetchFn(`${API_BASE}/version`, { credentials: 'omit', cache: 'no-store' });
    if (!res.ok) return false;
    const body = await res.json();
    if (!isOutdated(app, body?.minApp)) return false;
    show();
    return true;
  } catch {
    return false;
  }
}

function showToast() {
  toast(t('Η εφαρμογή χρειάζεται ενημέρωση.'), { ms: 20000, center: true, action: { label: t('Ενημέρωση'), onClick: updateAndReload, primary: true } });
}
