// STUB (owner: live data).
import { h } from './ui.js';
export const etaText = (sec) => (sec < 60 ? '<1′' : `${Math.floor(sec / 60)}′`);
export function arrivalTile(v, fetchedAt) { return h('div', { class: 'arrival-tile' }, `${v.lineCode} ${v.live ? 'live' : 'προγρ.'}`); }
export function mountStop(container, ctx, { code }) { container.replaceChildren(h('h2', {}, ctx.data.stopByCode.get(code)?.displayName || code)); return { destroy() {} }; }
