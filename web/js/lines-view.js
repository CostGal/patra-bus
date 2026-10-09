// STUB (owner: extras).
import { h } from './ui.js';
export function mountLines(container) { container.replaceChildren(h('h2', {}, 'Γραμμές')); return { destroy() {} }; }
export function mountLine(container, ctx, { code }) { container.replaceChildren(h('h2', {}, `Γραμμή ${code}`)); return { destroy() {} }; }
