// STUB (owner: location).
import { haversine } from './geo.js';
export function walkEstimate(a, b) { const m = haversine(a, b) * 1.3; return { seconds: m / 1.3, meters: m, geometry: null, source: 'estimate' }; }
export async function walkRoute(a, b) { return walkEstimate(a, b); }
