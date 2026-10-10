// STUB (owner: push client). Contract in docs/ARCHITECTURE.md (Round 2).
import { h } from './ui.js';
export const isPushSupported = () => false;
export async function pushState() { return 'unsupported'; }
export async function enablePush() { return false; }
export async function disablePush() {}
export async function schedulePushReminder() { return null; }
export async function cancelPushReminder() {}
export function mountPushCard(container) { container.replaceChildren(h('p', {}, 'Ειδοποιήσεις push: σύντομα')); return { destroy() {} }; }
