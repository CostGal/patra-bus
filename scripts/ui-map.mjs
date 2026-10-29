// Numbered UI map (TEL-198): one permanent ID per UI element, for UI reviews ("S2 — τώρα: … / θέλω: …").
// Letters are AREAS of the app, not screens, so the same element has the same ID on every screen and in every session.
// Rules (docs/DESIGN.md §4 "UI review"): never renumber or reuse an ID. A new element takes the next free number of
// its area; a removed one stays with `gone: true`. `all: true` labels every match (chips, rows), else only the first.
// Used by `npm run shots -- --annotate` (scripts/shots.mjs), which draws the boxes and writes shots/ui-map/LEGEND.md.
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

export const UI = [
  { id: 'N1', name: 'Αναζήτηση (στο φύλλο, μόνο αρχική)', sel: '#searchbar' },
  { id: 'N2', name: '☰ Μενού (μόνο του πάνω αριστερά· στο up μέσα στη γραμμή του search)', sel: '#menu-btn' },
  { id: 'N3', name: 'Πεδίο αναζήτησης', sel: '#search-input' },
  { id: 'N4', name: '✕ Καθαρισμός αναζήτησης', sel: '#search-clear' },
  { id: 'N5', name: 'Επικεφαλίδα αποτελεσμάτων', sel: '.sr-head', all: true },
  { id: 'N6', name: 'Αποτέλεσμα αναζήτησης', sel: '.sr', all: true },
  { id: 'N7', name: 'Σήμα DEMO', sel: '#demo-tag' },
  { id: 'N8', name: '✕ Κλείσιμο αναζήτησης', sel: '#search-close' },

  { id: 'M1', name: 'Εντοπισμός τοποθεσίας', sel: '#locate-btn' },
  { id: 'M2', name: 'i (attribution)', sel: '.maplibregl-ctrl-attrib-button' },
  { id: 'M3', name: 'Πλαίσιο attribution', sel: '.maplibregl-ctrl-attrib' },
  { id: 'M4', name: 'Σύνδεσμος attribution', sel: '.maplibregl-ctrl-attrib a', all: true },
  { id: 'M5', name: 'Marker στον χάρτη', sel: '.mk', all: true },

  { id: 'P1', name: 'Φύλλο (sheet / side panel)', sel: '#sheet' },
  { id: 'P2', name: 'Λαβή φύλλου', sel: '#sheet-handle' },
  { id: 'P3', name: 'Κεφαλίδα view', sel: '#sheet :is(.stopv-head, .ex-head, .view-head, .pl-head)' },
  { id: 'P4', name: '← Πίσω', sel: '#sheet .btn.round:has(> .icon-back)' },
  { id: 'P5', name: '✕ Κλείσιμο', sel: '#sheet :is(.stopv-head, .ex-head) .btn.round:has(> .icon-close)' },
  { id: 'P6', name: '⋯ Περισσότερα', sel: '#sheet :is(.stopv-head, .ex-head) .btn.round[aria-expanded]' },
  { id: 'P7', name: '☆ Αγαπημένο', sel: '.stopv-star' },
  { id: 'P8', name: 'Κοινοποίηση (κεφαλίδα)', sel: '#sheet .ex-head .btn.round:has(> .icon-share)' },

  { id: 'O1', name: 'Μενού ☰', sel: '#menu-pop' },
  { id: 'O2', name: 'Αλλαγή πόλης (μενού)', sel: '#menu-pop .pop-city' },
  { id: 'O3', name: 'Στοιχείο μενού', sel: '#menu-pop a.pop-item:not(.pop-city)', all: true },
  { id: 'O4', name: 'Θέμα (μενού)', sel: '#menu-pop .theme-row' },
  { id: 'O5', name: 'Επιλογή θέματος', sel: '#menu-pop .theme-opt', all: true },
  { id: 'O6', name: 'Μενού ⋯ στάσης', sel: '.stopv-menu' },
  { id: 'O7', name: 'Στοιχείο μενού ⋯', sel: '.stopv-item', all: true },
  { id: 'O8', name: 'i (πληροφορίες)', sel: '.ex-info', all: true },
  { id: 'O9', name: 'Περισσότερα ⋯ οχήματος', sel: '.ob-more' },

  { id: 'S1', name: 'Μπάρα φίλτρων γραμμής', sel: '.stopv-chipbar' },
  { id: 'S2', name: 'Φίλτρο γραμμής (chip)', sel: '.stopv-chip', all: true },
  { id: 'S3', name: 'Άφιξη LIVE', sel: '.atile-live', all: true },
  { id: 'S4', name: 'Άφιξη ΠΡΟΓΡ.', sel: '.atile-sched', all: true },
  { id: 'S5', name: 'Σήμα γραμμής (άφιξη)', sel: '.atile-badge' },
  { id: 'S6', name: 'Ετικέτα LIVE / ΠΡΟΓΡ.', sel: '.atile-flag' },
  { id: 'S7', name: 'Λεπτά (άφιξη)', sel: '.atile-eta' },

  { id: 'E1', name: 'Κάρτα «κοντά σου»', sel: '.nb' },
  { id: 'E2', name: 'Βρες τη στάση μου', sel: '.nb .btn.primary' },
  { id: 'E3', name: 'Περισσότερα («κοντά σου»)', sel: '.nb-how > summary' },
  { id: 'E4', name: 'Δεύτερο κουμπί («κοντά σου»)', sel: '.nb .btn.ghost' },
  { id: 'E5', name: 'Κάρτα «Πρώτη φορά εδώ;»', sel: '.guide-hint' },
  { id: 'E6', name: 'Άνοιγμα οδηγού (κάρτα)', sel: '.guide-hint-go' },
  { id: 'E7', name: '✕ Κλείσιμο κάρτας οδηγού', sel: '.guide-hint-x' },

  { id: 'F1', name: 'Γραμμή στάσης (λίστα)', sel: 'a.stop-row', all: true },

  { id: 'L1', name: 'Αναζήτηση γραμμής', sel: '.ex-search' },
  { id: 'L2', name: 'Γραμμή (λίστα)', sel: 'a.lines-row', all: true },
  { id: 'L3', name: 'Κατεύθυνση (chip)', sel: '.lines-chip', all: true },
  { id: 'L4', name: 'Αναχωρήσεις από την αφετηρία', sel: '.lines-times' },
  { id: 'L5', name: 'Σύνδεσμος αφετηρίας', sel: '.lines-times a[href]' },

  { id: 'R1', name: 'Αφετηρία', sel: '#pl-from' },
  { id: 'R2', name: 'Προορισμός', sel: '#pl-to' },
  { id: 'R3', name: 'Αντιστροφή', sel: '.pl-swap' },
  { id: 'R4', name: 'Πρόταση τόπου', sel: '.pl-sug', all: true },

  { id: 'V1', name: 'Ετικέτα LIVE (όχημα)', sel: '.ex-chip-live' },
  { id: 'V2', name: 'Θα κατέβω σε…', sel: '.ob-open' },
  { id: 'V3', name: 'Προηγούμενες στάσεις', sel: '.bv-toggle' },
  { id: 'V4', name: 'Στάση της διαδρομής (όχημα)', sel: 'a.bv-link', all: true },

  { id: 'G1', name: 'Ενότητα ρυθμίσεων', sel: '.set-lang', all: true },
  { id: 'G2', name: 'Επιλογή (segmented)', sel: '.ex-seg-btn', all: true },
  { id: 'G3', name: 'Πτυσσόμενη ενότητα', sel: '.set-sec > summary', all: true },
  { id: 'G4', name: 'Κουμπί «Άνοιγμα»', sel: '.set-row a.btn', all: true },
  { id: 'G5', name: 'Ενότητα οδηγού', sel: '.gd-sec', all: true },

  { id: 'D1', name: 'Κάρτα πρώτης ρύθμισης', sel: '.su-card' },
  { id: 'D2', name: 'Παράλειψη (setup)', sel: '.su-skip' },
  { id: 'D3', name: 'Επιλογή (setup)', sel: '.su-choice', all: true },
  { id: 'D4', name: 'Επόμενο (setup)', sel: '.su-next' },
  { id: 'D5', name: 'Κάρτα «Πρώτοι δοκιμαστές»', sel: '.wl-card' },
  { id: 'D6', name: 'Ας ξεκινήσουμε (welcome)', sel: '.wl-start' },
  { id: 'D7', name: 'Στείλε σχόλια (welcome)', sel: '.wl-link' },
  { id: 'D8', name: 'Κατηγορία (αναφορά)', sel: '.rp-cat', all: true },
  { id: 'D9', name: 'Κείμενο (αναφορά)', sel: '.rp-text' },
  { id: 'D10', name: 'Email (αναφορά)', sel: '.rp-input[type=email]' },
  { id: 'D11', name: 'Αποστολή (αναφορά)', sel: '.rp-submit' },
];

// Screens of the annotated sweep (hash appended to <base>/?demo…). `act` puts the screen in its state (menu open…).
export const UI_SCREENS = [
  { id: 'stop', url: '/?demo#/stop/1011' },
  { id: 'stop-scrolled', url: '/?demo#/stop/1011', act: (p) => p.evaluate(() => { const el = document.getElementById('sheet-body'); el.scrollTop = el.clientHeight * 0.6; }) },
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
  { id: 'guide', url: '/?demo#/guide' },
  { id: 'report', url: '/?demo#/report' },
  { id: 'setup', url: '/?demo&setup#/' },
  { id: 'welcome', url: '/?demo&welcome#/' },
];

// Runs in the page: boxes + IDs for the registry, red "?" for anything pressable that is not in it. Returns the legend.
export function annotate(ui) {
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
      const r = visible(el); if (!r) continue;
      found.push({ id: u.id, r }); marked.add(el); n++;
      if (!u.all) break;
    }
    if (n) found[found.length - n].first = true;
  }
  const PRESS = 'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=menuitem], [role=option], [role=tab]';
  const unknown = [];
  for (const el of document.querySelectorAll(PRESS)) {
    if (marked.has(el) || [...marked].some((m) => m !== el && el.contains(m))) continue;
    if ([...marked].some((m) => m.contains(el) && m.matches(PRESS))) continue; // inside a registered control (e.g. a tile's link)
    const r = visible(el); if (!r) continue;
    const cls = (typeof el.className === 'string' ? el.className : '').trim().split(/\s+/).filter(Boolean).join('.');
    const label = (el.getAttribute('aria-label') || el.placeholder || (el.innerText || '').trim().split('\n')[0] || '').slice(0, 50);
    unknown.push({ id: `?${unknown.length + 1}`, r, tag: `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls ? '.' + cls : ''}`, label });
  }
  const layer = document.createElement('div');
  layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
  const COLORS = { N: '#4363d8', M: '#3cb44b', P: '#911eb4', O: '#f58231', S: '#008080', E: '#9a6324', F: '#800000', L: '#000075', R: '#808000', V: '#e6194b', G: '#469990', D: '#f032e6' };
  const tags = [];
  const clash = (x, y, w) => tags.some((t) => x < t.x + t.w && t.x < x + w && y < t.y + 15 && t.y < y + 15);
  const place = (r, w, big) => { // first free corner of the box (outside, then inside), so a label stays on its box
    const L = r.left - 2, R = r.right - w + 2, T = r.top - 8, B = r.bottom - 7;
    const spots = big ? [[L, r.top + 2], [R, r.top + 2], [L, B - 8]] : [[L, T], [R, T], [L, r.top + 2], [R, r.top + 2], [L, B], [R, B]];
    const fit = spots.map(([x, y]) => [Math.max(0, Math.min(vw - w, x)), Math.max(0, Math.min(vh - 15, y))]);
    const [x, y] = fit.find(([x, y]) => !clash(x, y, w)) || fit[0];
    tags.push({ x, y, w }); return [x, y];
  };
  // big boxes first, so the small ones (and their labels) are drawn on top
  for (const it of [...found, ...unknown].sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)) {
    const c = it.id[0] === '?' ? '#ff0000' : COLORS[it.id[0]] || '#333';
    const big = it.r.width * it.r.height > vw * vh * 0.2;
    const box = document.createElement('div');
    box.style.cssText = `position:absolute;left:${it.r.left}px;top:${it.r.top}px;width:${it.r.width}px;height:${it.r.height}px;outline:2px ${big ? 'dashed' : 'solid'} ${c};outline-offset:-1px;border-radius:4px`;
    layer.append(box);
    const w = 8 + it.id.length * 7, [x, y] = place(it.r, w, big);
    const tag = document.createElement('div'); tag.textContent = it.id;
    tag.style.cssText = `position:absolute;left:${x}px;top:${y}px;background:${c};color:#fff;font:700 10px/14px system-ui,sans-serif;padding:0 3px;border-radius:7px;box-shadow:0 0 0 1px #fff`;
    layer.append(tag);
  }
  document.body.append(layer);
  return { ids: [...new Set(found.map((f) => f.id))], unknown: unknown.map(({ id, tag, label }) => ({ id, tag, label })) };
}

// LEGEND.md: the whole registry (where each ID was seen), then what each screen showed that is not in the registry.
export function legend(results, meta) {
  const seen = new Map();
  for (const r of results) for (const id of r.ids) seen.set(id, [...(seen.get(id) || []), r.screen]);
  const L = ['# UI map', '', meta, '',
    'Γράψε `ID — τώρα: … / θέλω: …` (π.χ. `S2 — τώρα: δεν φαίνεται ποιο είναι επιλεγμένο / θέλω: γέμισμα χρώματος`). Για ένα από πολλά ίδια: `S2 (606)`.',
    'Τα IDs είναι μόνιμα (`scripts/ui-map.mjs`): το ίδιο στοιχείο έχει το ίδιο ID σε κάθε οθόνη και κάθε session.', '',
    `Οθόνες: ${results.map((r) => (r.file ? `[${r.screen}](${r.file})` : r.screen)).join(' · ')}`, ''];
  for (const [letter, area] of Object.entries(AREAS)) {
    L.push(`## ${letter}. ${area}`, '', '| ID | Στοιχείο | Οθόνες |', '|---|---|---|');
    for (const u of UI.filter((x) => x.id[0] === letter)) L.push(`| ${u.id} | ${u.name}${u.gone ? ' (αφαιρέθηκε)' : ''} | ${(seen.get(u.id) || ['—']).join(', ')} |`);
    L.push('');
  }
  const unk = results.filter((r) => r.unknown.length);
  L.push(`## Εκτός registry (κόκκινο ?) (${unk.reduce((n, r) => n + r.unknown.length, 0)})`, '');
  if (!unk.length) L.push('Κανένα: κάθε στοιχείο που πατιέται έχει ID.');
  for (const r of unk) L.push(`- **${r.screen}**: ${r.unknown.map((u) => `${u.id} \`${u.tag}\` «${u.label}»`).join(' · ')}`);
  return L.join('\n') + '\n';
}
