// Which stop a cold start opens (TEL-365, CLAUDE.md rule 6). Runs on the device only; nothing here is stored or sent.
// In order: the nearest stop to a fix, the first favourite, the last stop opened. None: the app stays on home.
import { nearestStops, inArea } from './geo.js';

export const START_NEAR_M = 800;
const MAX_ACC_M = 1500; // a coarser fix says too little to pick a stop

export function pickStartStop({ fix = null, favorites = [], recents = [], stops = [], stopByCode }) {
  if (fix && inArea(fix) && !(fix.accuracy > MAX_ACC_M)) {
    const [near] = nearestStops(stops, fix, { limit: 1, maxMeters: START_NEAR_M });
    if (near) return String(near.stop.code);
  }
  for (const code of [...favorites, ...recents]) {
    if (stopByCode.has(String(code))) return String(code);
  }
  return null;
}
