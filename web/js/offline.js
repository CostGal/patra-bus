// STUB (owner: offline map). Contract in docs/ARCHITECTURE.md (Round 2).
import { h } from './ui.js';
export async function offlineMapStatus() { return { downloaded: false, tiles: 0, bytes: 0 }; }
export function mountOfflineCard(container) { container.replaceChildren(h('p', {}, 'Χάρτης χωρίς σύνδεση: σύντομα')); return { destroy() {} }; }
