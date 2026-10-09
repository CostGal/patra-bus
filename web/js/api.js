// STUB (owner: live data). Contract in docs/ARCHITECTURE.md.
import { normalizeLive } from './arrivals.js';
export const DEMO = new URLSearchParams(location.search).has('demo');
export const API_BASE = ['localhost', '127.0.0.1'].includes(location.hostname) ? 'http://localhost:8787' : 'https://patra-bus.patra-bus.workers.dev';
export class ApiError extends Error { constructor(kind, msg) { super(msg || kind); this.kind = kind; } }
export async function fetchLive(code, { signal } = {}) {
  if (DEMO) return normalizeLive(await (await fetch('./fixtures/live-1011.json')).json(), Date.now());
  const r = await fetch(`${API_BASE}/api/live/${encodeURIComponent(code)}`, { signal }).catch(() => { throw new ApiError('network'); });
  if (!r.ok) throw new ApiError('upstream'); return r.json();
}
export const remainingSec = (v, fetchedAt, now = Date.now()) => Math.max(0, v.etaSec - (now - fetchedAt) / 1000);
export function createLivePoller(code, onUpdate) {
  let dead = false; const tick = () => fetchLive(code).then((data) => !dead && onUpdate({ data, error: null, loading: false, nextAt: 0 }), (error) => !dead && onUpdate({ data: null, error, loading: false, nextAt: 0 }));
  tick(); return { refresh: tick, destroy() { dead = true; } };
}
