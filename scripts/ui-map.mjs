// Numbered UI map (TEL-198): one permanent ID per UI element, for UI reviews ("S2 — τώρα: … / θέλω: …").
// Letters are AREAS of the app, not screens, so the same element has the same ID on every screen and in every session.
// Every element also has a `nick` (TEL-230): a short English name to say out loud ("badge", "countdown"), unique like the ID.
// Rules (docs/DESIGN.md §9 "UI review"): never renumber or reuse an ID or a nick. A new element takes the next free number of
// its area; a removed one stays with `gone: true`. `all: true` labels every match (chips, rows), else only the first.
// `edge: 'left'` boxes only the element's left border (the stripe of an arrival tile is a border, not an element).
// Used by `npm run shots -- --annotate` (scripts/shots.mjs), which draws the boxes and writes shots/ui-map/LEGEND.md
// and explorer.html (click an element on a screenshot to see its name).
export const AREAS = {
  N: 'Μπάρα αναζήτησης (πάνω)',
  M: 'Χάρτης',
  P: 'Φύλλο (sheet) και κεφαλίδα κάθε view',
  O: 'Μενού και popovers',
  S: 'Στάση και αφίξεις',
  E: 'Αρχική',
  F: 'Αγαπημένα και λίστες στάσεων',
  L: 'Γραμμές',
  R: 'Διαδρομή (planner)',
  V: 'Όχημα',
  G: 'Ρυθμίσεις και οδηγός',
  D: 'Διάλογοι και φόρμες (setup, welcome, αναφορά)',
};

// Box colour of each area (annotated shots and the explorer).
export const COLORS = { N: '#4363d8', M: '#3cb44b', P: '#911eb4', O: '#f58231', S: '#008080', E: '#9a6324', F: '#800000', L: '#000075', R: '#808000', V: '#e6194b', G: '#469990', D: '#f032e6' };

export const UI = [
  { id: 'N1', nick: 'searchbar', name: 'Μπάρα αναζήτησης', sel: '#searchbar' },
  { id: 'N2', nick: 'menu', name: '☰ Μενού / πίσω / κλείσιμο αναζήτησης', sel: '#menu-btn' },
  { id: 'N3', nick: 'search field', name: 'Πεδίο αναζήτησης', sel: '#search-input' },
  { id: 'N4', nick: 'clear', name: '✕ Καθαρισμός αναζήτησης', sel: '#search-clear' },
  { id: 'N5', nick: 'results head', name: 'Επικεφαλίδα αποτελεσμάτων', sel: '.sr-head', all: true },
  { id: 'N6', nick: 'result', name: 'Αποτέλεσμα αναζήτησης', sel: '.sr', all: true },
  { id: 'N7', nick: 'demo tag', name: 'Σήμα DEMO', sel: '#demo-tag' },

  { id: 'M1', nick: 'locate', name: 'Εντοπισμός τοποθεσίας', sel: '#locate-btn' },
  { id: 'M2', nick: 'attrib button', name: 'i (attribution)', sel: '.maplibregl-ctrl-attrib-button' },
  { id: 'M3', nick: 'attribution line', name: 'Πλαίσιο attribution', sel: '.maplibregl-ctrl-attrib' },
  { id: 'M4', nick: 'attrib link', name: 'Σύνδεσμος attribution', sel: '.maplibregl-ctrl-attrib a', all: true },
  { id: 'M5', nick: 'marker', name: 'Marker στον χάρτη', sel: '.mk', all: true },

  { id: 'P1', nick: 'sheet', name: 'Φύλλο (sheet / side panel)', sel: '#sheet' },
  { id: 'P2', nick: 'grabber', name: 'Λαβή φύλλου', sel: '#sheet-handle' },
  { id: 'P3', nick: 'header', name: 'Κεφαλίδα view', sel: '#sheet :is(.stopv-head, .ex-head, .view-head, .pl-head)' },
  { id: 'P4', nick: 'back', name: '← Πίσω', sel: '#sheet .btn.round:has(> .icon-back)' },
  { id: 'P5', nick: 'close', name: '✕ Κλείσιμο', sel: '#sheet :is(.stopv-head, .ex-head) .btn.round:has(> .icon-close)' },
  { id: 'P6', nick: 'more', name: '⋯ Περισσότερα', sel: '#sheet :is(.stopv-head, .ex-head) .btn.round[aria-expanded]' },
  { id: 'P7', nick: 'star', name: '☆ Αγαπημένο', sel: '.stopv-star' },
  { id: 'P8', nick: 'share', name: 'Κοινοποίηση (κεφαλίδα)', sel: '#sheet .ex-head .btn.round:has(> .icon-share)' },
  { id: 'P9', nick: 'title', name: 'Τίτλος view (π.χ. όνομα στάσης)', sel: '#sheet :is(.stopv-head, .ex-head, .view-head, .pl-head) h1' },
  { id: 'P10', nick: 'subtitle', name: 'Υπότιτλος (π.χ. «Στάση 1011»)', sel: '.stopv-sub' },

  { id: 'O1', nick: 'menu panel', name: 'Μενού ☰', sel: '#menu-pop' },
  { id: 'O2', nick: 'city switch', name: 'Αλλαγή πόλης (μενού)', sel: '#menu-pop .pop-city' },
  { id: 'O3', nick: 'menu item', name: 'Στοιχείο μενού', sel: '#menu-pop a.pop-item:not(.pop-city)', all: true },
  { id: 'O4', nick: 'theme row', name: 'Θέμα (μενού)', sel: '#menu-pop .theme-row' },
  { id: 'O5', nick: 'theme option', name: 'Επιλογή θέματος', sel: '#menu-pop .theme-opt', all: true },
  { id: 'O6', nick: 'more panel', name: 'Μενού ⋯ στάσης', sel: '.stopv-menu' },
  { id: 'O7', nick: 'more item', name: 'Στοιχείο μενού ⋯', sel: '.stopv-item', all: true },
  { id: 'O8', nick: 'info', name: 'i (πληροφορίες)', sel: '.ex-info', all: true },
  { id: 'O9', nick: 'bus more', name: 'Περισσότερα ⋯ οχήματος', sel: '.ob-more' },

  { id: 'S1', nick: 'chip bar', name: 'Μπάρα φίλτρων γραμμής', sel: '.stopv-chipbar' },
  { id: 'S2', nick: 'chip', name: 'Φίλτρο γραμμής (chip)', sel: '.stopv-chip', all: true },
  { id: 'S3', nick: 'live tile', name: 'Άφιξη LIVE', sel: '.atile-live', all: true },
  { id: 'S4', nick: 'sched tile', name: 'Άφιξη ΠΡΟΓΡ.', sel: '.atile-sched', all: true },
  { id: 'S5', nick: 'badge', name: 'Σήμα γραμμής (άφιξη)', sel: '.atile-badge' },
  { id: 'S6', nick: 'tag', name: 'Ετικέτα LIVE / ΠΡΟΓΡ.', sel: '.atile-flag' },
  { id: 'S7', nick: 'countdown', name: 'Λεπτά (άφιξη)', sel: '.atile-eta' },
  { id: 'S8', nick: 'stripe', name: 'Λωρίδα αριστερά (πράσινη = LIVE)', sel: '.atile', edge: 'left' },
  { id: 'S9', nick: 'destination', name: 'Προορισμός (άφιξη)', sel: '.atile-dest' },
  { id: 'S10', nick: 'chevron', name: '› Βελάκι (άφιξη)', sel: '.atile > .icon-chevron' },
  { id: 'S11', nick: 'note', name: '«συνήθως +3′» (άφιξη ΠΡΟΓΡ.)', sel: '.atile-usual' },
  { id: 'S12', nick: 'status line', name: 'Γραμμή κατάστασης (ηλικία · επόμενη ανανέωση)', sel: '.stopv-foot-text' },
  { id: 'S13', nick: 'refresh', name: 'Ανανέωση', sel: '.stopv-refresh' },
  { id: 'S14', nick: 'show all', name: 'Εμφάνιση όλων (αφίξεις)', sel: '.stopv-more' },

  { id: 'E1', nick: 'nearby card', name: 'Κάρτα «κοντά σου»', sel: '.nb' },
  { id: 'E2', nick: 'find stop', name: 'Βρες τη στάση μου', sel: '.nb .btn.primary' },
  { id: 'E3', nick: 'nearby how', name: 'Περισσότερα («κοντά σου»)', sel: '.nb-how > summary' },
  { id: 'E4', nick: 'nearby second', name: 'Δεύτερο κουμπί («κοντά σου»)', sel: '.nb .btn.ghost' },

  { id: 'F1', nick: 'stop row', name: 'Γραμμή στάσης (λίστα)', sel: 'a.stop-row', all: true },

  { id: 'L1', nick: 'line search', name: 'Αναζήτηση γραμμής', sel: '.ex-search' },
  { id: 'L2', nick: 'line row', name: 'Γραμμή (λίστα)', sel: 'a.lines-row', all: true },
  { id: 'L3', nick: 'direction chip', name: 'Κατεύθυνση (chip)', sel: '.lines-chip', all: true },
  { id: 'L4', nick: 'departures', name: 'Αναχωρήσεις από την αφετηρία', sel: '.lines-times' },
  { id: 'L5', nick: 'terminus link', name: 'Σύνδεσμος αφετηρίας', sel: '.lines-times a[href]' },

  { id: 'R1', nick: 'from', name: 'Αφετηρία', sel: '#pl-from' },
  { id: 'R2', nick: 'to', name: 'Προορισμός', sel: '#pl-to' },
  { id: 'R3', nick: 'swap', name: 'Αντιστροφή', sel: '.pl-swap' },
  { id: 'R4', nick: 'suggestion', name: 'Πρόταση τόπου', sel: '.pl-sug', all: true },

  { id: 'V1', nick: 'bus live', name: 'Ετικέτα LIVE (όχημα)', sel: '.ex-chip-live' },
  { id: 'V2', nick: 'get off', name: 'Θα κατέβω σε…', sel: '.ob-open' },
  { id: 'V3', nick: 'earlier stops', name: 'Προηγούμενες στάσεις', sel: '.bv-toggle' },
  { id: 'V4', nick: 'route stop', name: 'Στάση της διαδρομής (όχημα)', sel: 'a.bv-link', all: true },

  { id: 'G1', nick: 'settings section', name: 'Ενότητα ρυθμίσεων', sel: '.set-lang', all: true },
  { id: 'G2', nick: 'segmented', name: 'Επιλογή (segmented)', sel: '.ex-seg-btn', all: true },
  { id: 'G3', nick: 'fold', name: 'Πτυσσόμενη ενότητα', sel: '.set-sec > summary', all: true },
  { id: 'G4', nick: 'open button', name: 'Κουμπί «Άνοιγμα»', sel: '.set-row a.btn', all: true },

  { id: 'D1', nick: 'setup card', name: 'Κάρτα πρώτης ρύθμισης', sel: '.su-card' },
  { id: 'D2', nick: 'skip', name: 'Παράλειψη (setup)', sel: '.su-skip' },
  { id: 'D3', nick: 'setup choice', name: 'Επιλογή (setup)', sel: '.su-choice', all: true },
  { id: 'D4', nick: 'next', name: 'Επόμενο (setup)', sel: '.su-next' },
  { id: 'D5', nick: 'welcome card', name: 'Κάρτα «Πρώτοι δοκιμαστές»', sel: '.wl-card' },
  { id: 'D6', nick: 'start', name: 'Ας ξεκινήσουμε (welcome)', sel: '.wl-start' },
  { id: 'D7', nick: 'feedback link', name: 'Στείλε σχόλια (welcome)', sel: '.wl-link' },
  { id: 'D8', nick: 'category', name: 'Κατηγορία (αναφορά)', sel: '.rp-cat', all: true },
  { id: 'D9', nick: 'text', name: 'Κείμενο (αναφορά)', sel: '.rp-text' },
  { id: 'D10', nick: 'email', name: 'Email (αναφορά)', sel: '.rp-input[type=email]' },
  { id: 'D11', nick: 'send', name: 'Αποστολή (αναφορά)', sel: '.rp-submit' },
];

// Screens of the annotated sweep (hash appended to <base>/?demo…). `act` puts the screen in its state (menu open…).
export const UI_SCREENS = [
  { id: 'stop', url: '/?demo#/stop/1011' },
  { id: 'stop-scrolled', url: '/?demo#/stop/1011', act: async (p) => { // sheet full, then to the end (status line, refresh)
    await p.click('#sheet-handle'); await p.waitForTimeout(600);
    await p.evaluate(() => { const el = document.getElementById('sheet-body'); el.scrollTop = el.scrollHeight; });
  } },
  { id: 'stop-more', url: '/?demo#/stop/1011', act: (p) => p.click('.stopv-more-btn') },
  { id: 'menu', url: '/?demo#/stop/1011', act: (p) => p.click('#menu-btn') },
  { id: 'search', url: '/?demo#/', act: async (p) => { await p.click('#search-input'); await p.fill('#search-input', 'παν'); } },
  { id: 'home', url: '/?demo#/' },
  { id: 'plan', url: '/?demo#/plan?to=38.2466,21.7346&name=Test' },
  { id: 'lines', url: '/?demo#/lines' },
  { id: 'line', url: '/?demo#/line/606' },
  { id: 'vehicle', url: '/?demo#/stop/1011', act: (p) => p.click('a.atile-live') },
  { id: 'vehicle-more', url: '/?demo#/stop/1011', act: async (p) => { await p.click('a.atile-live'); await p.waitForTimeout(700); await p.click('.bv-head .btn.round[aria-expanded]'); await p.click('#sheet-handle'); await p.waitForTimeout(600); await p.evaluate(() => document.querySelector('.ob-more')?.scrollIntoView({ block: 'center' })); } },
  { id: 'favorites', url: '/?demo#/favorites', act: async (p) => { // one favourite, so the list is not empty
    await p.evaluate(() => { const s = JSON.parse(localStorage.getItem('patra-bus:v2')); s.favorites = [{ code: '1011', city: 'patra' }]; localStorage.setItem('patra-bus:v2', JSON.stringify(s)); });
    await p.reload(); await p.waitForTimeout(800);
  } },
  { id: 'settings', url: '/?demo#/settings' },
  { id: 'report', url: '/?demo#/report' },
  { id: 'setup', url: '/?demo&setup#/' },
  { id: 'welcome', url: '/?demo&welcome#/' },
];

// Runs in the page. Finds every visible match of the registry and anything pressable that is not in it (red "?").
// With draw: true it also boxes them (nick on top, ID under it). Returns the ids seen, the unknown ones and every box
// (in CSS px), which the explorer uses as click targets.
export function annotate({ ui, colors, draw = true }) {
  const vw = innerWidth, vh = innerHeight;
  const visible = (el) => {
    if (el.closest('[hidden]')) return null;
    const cs = getComputedStyle(el);
    let r = el.getBoundingClientRect();
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) { // clip to scrolling parents (sheet body)
      if (getComputedStyle(a).overflowY === 'visible') continue;
      const c = a.getBoundingClientRect(), top = Math.max(r.top, c.top), left = Math.max(r.left, c.left);
      r = new DOMRect(left, top, Math.min(r.right, c.right) - left, Math.min(r.bottom, c.bottom) - top);
    }
    if (r.width < 6 || r.height < 6 || cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity < 0.1) return null;
    if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) return null;
    const hit = document.elementFromPoint(Math.min(vw - 1, Math.max(0, r.left + r.width / 2)), Math.min(vh - 1, Math.max(0, r.top + r.height / 2)));
    return hit && (el.contains(hit) || hit.contains(el)) ? r : null; // not covered by something else
  };
  const found = [], marked = new Set();
  for (const u of ui) {
    if (u.gone) continue;
    let els = []; try { els = [...document.querySelectorAll(u.sel)]; } catch { /* selector not supported here */ }
    let n = 0;
    for (const el of els) {
      let r = visible(el); if (!r) continue;
      if (u.edge === 'left') { // only the left border
        const bw = parseFloat(getComputedStyle(el).borderLeftWidth) || 0; if (bw < 1) continue;
        r = new DOMRect(r.left, r.top, Math.max(bw, 6), r.height);
      }
      found.push({ id: u.id, nick: u.nick, r, drawn: !n || !!u.all }); marked.add(el); n++;
    }
  }
  const PRESS = 'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=menuitem], [role=option], [role=tab]';
  const unknown = [];
  for (const el of document.querySelectorAll(PRESS)) {
    if (marked.has(el) || [...marked].some((m) => m !== el && el.contains(m))) continue;
    if ([...marked].some((m) => m.contains(el) && m.matches(PRESS))) continue; // inside a registered control (e.g. a tile's link)
    const r = visible(el); if (!r) continue;
    const cls = (typeof el.className === 'string' ? el.className : '').trim().split(/\s+/).filter(Boolean).join('.');
    const label = (el.getAttribute('aria-label') || el.placeholder || (el.innerText || '').trim().split('\n')[0] || '').slice(0, 50);
    unknown.push({ id: `?${unknown.length + 1}`, r, drawn: true, tag: `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls ? '.' + cls : ''}`, label });
  }
  const box = ({ r }) => ({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
  const result = {
    ids: [...new Set(found.map((f) => f.id))],
    unknown: unknown.map(({ id, tag, label }) => ({ id, tag, label })),
    boxes: [...found.map((f) => ({ id: f.id, ...box(f) })), ...unknown.map((u) => ({ id: u.id, tag: u.tag, label: u.label, ...box(u) }))],
    vw, vh,
  };
  if (!draw) return result;

  const layer = document.createElement('div');
  layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
  const tags = [];
  const clash = (x, y, w, h) => tags.some((t) => x < t.x + t.w && t.x < x + w && y < t.y + t.h && t.y < y + h);
  const place = (r, w, h, big) => { // first free corner of the box (outside, then inside), so a label stays on its box
    const L = r.left - 2, R = r.right - w + 2, T = r.top - h + 7, B = r.bottom - 7;
    const spots = big ? [[L, r.top + 2], [R, r.top + 2], [L, r.bottom - h - 2]] : [[L, T], [R, T], [L, r.top + 2], [R, r.top + 2], [L, B], [R, B]];
    const fit = spots.map(([x, y]) => [Math.max(0, Math.min(vw - w, x)), Math.max(0, Math.min(vh - h, y))]);
    const [x, y] = fit.find(([x, y]) => !clash(x, y, w, h)) || fit[0];
    tags.push({ x, y, w, h }); return [x, y];
  };
  // big boxes first, so the small ones (and their labels) are drawn on top
  for (const it of [...found, ...unknown].filter((f) => f.drawn).sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)) {
    const c = it.id[0] === '?' ? '#ff0000' : colors[it.id[0]] || '#333';
    const big = it.r.width * it.r.height > vw * vh * 0.2;
    const b = document.createElement('div');
    b.style.cssText = `position:absolute;left:${it.r.left}px;top:${it.r.top}px;width:${it.r.width}px;height:${it.r.height}px;outline:2px ${big ? 'dashed' : 'solid'} ${c};outline-offset:-1px;border-radius:4px`;
    layer.append(b);
    const w = 8 + Math.max((it.nick || '').length * 6, it.id.length * 6), h = it.nick ? 25 : 15, [x, y] = place(it.r, w, h, big);
    const tag = document.createElement('div');
    tag.style.cssText = `position:absolute;left:${x}px;top:${y}px;background:${c};color:#fff;font:700 10px/12px system-ui,sans-serif;padding:1px 3px;border-radius:6px;box-shadow:0 0 0 1px #fff;text-align:center;white-space:nowrap`;
    if (it.nick) { tag.textContent = it.nick; const sub = document.createElement('div'); sub.textContent = it.id; sub.style.cssText = 'font-weight:400;font-size:9px;opacity:.85'; tag.append(sub); } else tag.textContent = it.id;
    layer.append(tag);
  }
  document.body.append(layer);
  return result;
}

// LEGEND.md: a nick → ID dictionary, the whole registry (where each ID was seen), then what each screen showed that is
// not in the registry.
export function legend(results, meta) {
  const seen = new Map();
  for (const r of results) for (const id of r.ids) seen.set(id, [...(seen.get(id) || []), r.screen]);
  const L = ['# UI map', '', meta, '',
    'Γράψε `nick — τώρα: … / θέλω: …` (π.χ. `chip — τώρα: δεν φαίνεται ποιο είναι επιλεγμένο / θέλω: γέμισμα χρώματος`). Το ID (`S2`) δουλεύει επίσης. Για ένα από πολλά ίδια: `chip (606)`.',
    'Nicks και IDs είναι μόνιμα (`scripts/ui-map.mjs`): το ίδιο στοιχείο έχει το ίδιο όνομα σε κάθε οθόνη και κάθε session. Δες τα πάνω στις οθόνες: `explorer.html`.', '',
    `Οθόνες: ${results.map((r) => (r.file ? `[${r.screen}](${r.file})` : r.screen)).join(' · ')}`, '',
    '## Λεξικό (A–Z)', '',
    UI.filter((u) => !u.gone).sort((a, b) => a.nick.localeCompare(b.nick)).map((u) => `**${u.nick}** ${u.id}`).join(' · '), ''];
  for (const [letter, area] of Object.entries(AREAS)) {
    L.push(`## ${letter}. ${area}`, '', '| ID | Nick | Στοιχείο | Οθόνες |', '|---|---|---|---|');
    for (const u of UI.filter((x) => x.id[0] === letter)) L.push(`| ${u.id} | ${u.nick} | ${u.name}${u.gone ? ' (αφαιρέθηκε)' : ''} | ${(seen.get(u.id) || ['—']).join(', ')} |`);
    L.push('');
  }
  const unk = results.filter((r) => r.unknown.length);
  L.push(`## Εκτός registry (κόκκινο ?) (${unk.reduce((n, r) => n + r.unknown.length, 0)})`, '');
  if (!unk.length) L.push('Κανένα: κάθε στοιχείο που πατιέται έχει ID.');
  for (const r of unk) L.push(`- **${r.screen}**: ${r.unknown.map((u) => `${u.id} \`${u.tag}\` «${u.label}»`).join(' · ')}`);
  return L.join('\n') + '\n';
}
