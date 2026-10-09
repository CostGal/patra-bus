// Shared DOM helpers (owner: shell). Signatures are a contract, see docs/ARCHITECTURE.md.
export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...kids.flat(Infinity).filter((x) => x != null && x !== false));
  return el;
}
export function icon(name) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); s.classList.add('icon', `icon-${name}`);
  return s;
}
export function toast(text) { console.info('[toast]', text); }
export function lineBadge(line) {
  const el = h('span', { class: 'badge' }, String(line?.code ?? ''));
  el.style.background = line?.color || '#757575'; el.style.color = line?.textColor || '#fff';
  return el;
}
const clock = new Intl.DateTimeFormat('el-GR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Europe/Athens' });
export const fmtClock = (ms) => clock.format(new Date(ms));
