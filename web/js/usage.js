// Anonymous daily usage counts (CLAUDE.md rule 4, worker/src/counters.js). The only thing sent is { metric, city }:
// "open" at most once per device per Athens day, "install" once, on the first launch as an installed app (iPhone
// included: there is no appinstalled event there). Nothing is sent when the user switched it off in Settings, when the
// browser sends Global Privacy Control, in ?demo, or anywhere but the production site (previews, localhost).
// The day already sent and the install flag stay on the device (store.js), never on the server.
import { API_BASE, DEMO } from './api.js';
import { getSettings, setSetting } from './store.js';
import { cityId } from './cities.js';
import { currentPlatform } from './platform.js';

export const PROD_ORIGIN = 'https://costgal.github.io';

const DAY_FORMAT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Athens', year: 'numeric', month: '2-digit', day: '2-digit' });

export const usageAllowed = ({ settings, origin, demo, gpc }) =>
  settings?.usageStats !== false && origin === PROD_ORIGIN && !demo && gpc !== true;

// POST without waiting on the page: true only when the worker answered 2xx (a failure is retried on the next launch).
async function postCount(body) {
  try {
    const res = await fetch(`${API_BASE}/api/count`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: true, credentials: 'omit',
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Called once after boot. Never throws, never shows anything. -> the metrics sent, e.g. ['open'] (for tests).
export async function reportUsage({
  settings = getSettings(),
  set = setSetting,
  origin = globalThis.location?.origin,
  demo = DEMO,
  gpc = globalThis.navigator?.globalPrivacyControl,
  installed,
  city = cityId(),
  now = Date.now(),
  post = postCount,
} = {}) {
  const sent = [];
  try {
    if (!usageAllowed({ settings, origin, demo, gpc })) return sent;
    const today = DAY_FORMAT.format(now);
    if (settings.usageDay !== today && (await post({ metric: 'open', city }))) {
      set('usageDay', today);
      sent.push('open');
    }
    const isApp = installed ?? currentPlatform().mode === 'app';
    if (isApp && settings.usageInstall !== true && (await post({ metric: 'install', city }))) {
      set('usageInstall', true);
      sent.push('install');
    }
  } catch { /* counting must never get in the way */ }
  return sent;
}
