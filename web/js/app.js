import { normalizeLive } from './arrivals.js';
import { titleCase, searchKey } from './text.js';

// Local dev talks to `wrangler dev`; everything else to the deployed worker.
const API_BASE = ['localhost', '127.0.0.1'].includes(location.hostname)
  ? 'http://localhost:8787'
  : 'https://patra-bus.patra-bus.workers.dev';
const POLL_MS = 20000;
const MIN_GAP_MS = 15000; // never fetch live more often than this, retries included
const STALE_MS = 60000;
const TIMEOUT_MS = 10000;
const GREY = '#757575';
const DEMO = new URLSearchParams(location.search).has('demo');

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

const app = document.getElementById('app');
const backLink = document.getElementById('back');
let stops = [];
let stopKeys = [];
const stopsByCode = new Map();
const linesByCode = new Map();

// ---- helpers ----

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...kids.flat().filter((k) => k != null && k !== false));
  return el;
}

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// Favorites: kept in memory, persisted best-effort.
let favs = (() => {
  try {
    const a = JSON.parse(localStorage.getItem('favs'));
    return Array.isArray(a) ? a.map(String) : [];
  } catch { return []; }
})();
function saveFavs() {
  try { localStorage.setItem('favs', JSON.stringify(favs)); } catch { /* ignore */ }
}

const msg = (text) => h('p', { class: 'state-msg' }, text);

function badge(code, color, textColor) {
  const el = h('span', { class: 'badge' }, code);
  el.style.background = color || GREY;
  el.style.color = textColor || '#fff';
  return el;
}
function lineBadge(code) {
  const l = linesByCode.get(code);
  return badge(code, l?.color, l?.textColor);
}

function stopRow(stop, dist) {
  return h('a', { class: 'stop-row', href: `#/stop/${encodeURIComponent(stop.code)}` },
    h('span', { class: 'stop-name' }, titleCase(stop.name)),
    h('span', { class: 'stop-meta' },
      h('span', { class: 'stop-code' }, `#${stop.code}`),
      stop.lineCodes.map(lineBadge),
      dist ? h('span', { class: 'stop-dist' }, dist) : null));
}

const stopList = (rows) => h('ul', { class: 'stop-list' }, rows.map((r) => h('li', {}, r)));

function haversine(lat1, lng1, lat2, lng2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

function fmtDist(m) {
  if (m < 1000) return `${Math.round(m / 10) * 10} μ`;
  return `${(m / 1000).toFixed(1).replace('.', ',')} χλμ`;
}

// ---- home view ----

function homeView() {
  const parts = [];
  const favStops = favs.map((c) => stopsByCode.get(c)).filter(Boolean);
  if (favStops.length) {
    parts.push(h('section', {}, h('h2', {}, 'Αγαπημένες'), stopList(favStops.map((s) => stopRow(s)))));
  }

  const input = h('input', {
    type: 'search', class: 'search', inputmode: 'text', autocomplete: 'off',
    placeholder: 'Αναζήτηση στάσης ή κωδικού', 'aria-label': 'Αναζήτηση στάσης ή κωδικού',
  });
  const results = h('div');
  input.addEventListener('input', () => {
    const q = input.value.trim();
    const k = searchKey(q);
    if (!k) return results.replaceChildren();
    const hits = [];
    for (const e of stopKeys) {
      if (e.key.includes(k) || e.stop.code.startsWith(q)) {
        hits.push(e.stop);
        if (hits.length === 50) break;
      }
    }
    results.replaceChildren(hits.length ? stopList(hits.map((s) => stopRow(s))) : msg('Κανένα αποτέλεσμα'));
  });

  const nearBtn = h('button', { type: 'button', class: 'btn near-btn' }, 'Κοντά μου');
  const nearOut = h('div');
  const idle = () => { nearBtn.disabled = false; nearBtn.removeAttribute('aria-busy'); nearBtn.textContent = 'Κοντά μου'; };
  nearBtn.addEventListener('click', () => {
    if (!navigator.geolocation) {
      nearOut.replaceChildren(msg('Η συσκευή δεν υποστηρίζει εντοπισμό τοποθεσίας.'));
      return;
    }
    nearBtn.disabled = true;
    nearBtn.setAttribute('aria-busy', 'true');
    nearBtn.textContent = 'Εντοπισμός…';
    nearOut.replaceChildren();
    navigator.geolocation.getCurrentPosition((pos) => {
      idle();
      const { latitude, longitude } = pos.coords; // used only for the distance calculation
      const near = stops
        .map((s) => ({ s, d: haversine(latitude, longitude, s.latitude, s.longitude) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 10);
      nearOut.replaceChildren(h('h2', {}, 'Κοντινότερες στάσεις'),
        stopList(near.map((n) => stopRow(n.s, fmtDist(n.d)))));
    }, (err) => {
      idle();
      nearOut.replaceChildren(msg(
        err.code === 1 ? 'Δεν δόθηκε άδεια για την τοποθεσία σου. Μπορείς να αναζητήσεις στάση με το όνομα ή τον κωδικό.'
          : err.code === 3 ? 'Λήξη χρόνου: δεν βρέθηκε η τοποθεσία σου. Δοκίμασε ξανά.'
            : 'Η τοποθεσία σου δεν είναι διαθέσιμη αυτή τη στιγμή.'));
    }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 });
  });

  app.replaceChildren(...parts, input, results, nearBtn, nearOut);
}

// ---- stop view ----

const timeFmt = new Intl.DateTimeFormat('el-GR', {
  hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23', timeZone: 'Europe/Athens',
});

const fmtAge = (sec) => (sec > 120 ? `${Math.floor(sec / 60)}′` : `${Math.max(0, Math.floor(sec))}″`);

function arrivalRow(v, remaining, fetchedAt) {
  const line = linesByCode.get(v.lineCode);
  const eta = v.live
    ? h('span', { class: 'eta eta-live' },
      h('span', { class: 'dot', 'aria-hidden': 'true' }),
      `${remaining < 60 ? '<1' : Math.floor(remaining / 60)}′ · live`)
    : h('span', { class: 'eta eta-sched' },
      // etaSec, not just departureMins: scheduled entries can carry seconds too.
      `${timeFmt.format(new Date(fetchedAt + v.etaSec * 1000))} · προγρ.`);
  return h('li', { class: `arrival ${v.live ? 'live' : 'scheduled'}` },
    badge(v.lineCode, v.color || line?.color, v.textColor || line?.textColor),
    h('span', { class: 'dest' }, titleCase(v.routeName)),
    eta);
}

function stopView(code) {
  const stop = stopsByCode.get(code);
  if (!stop) {
    app.replaceChildren(msg('Η στάση δεν βρέθηκε'), h('a', { class: 'btn', href: '#/' }, 'Πίσω στην αρχική'));
    return () => {};
  }

  let data = null;
  let failed = false;
  let inflight = null;
  let dead = false;
  let lastAttempt = 0;
  let nextAt = 0;
  let pollTimer = null;
  let ticker = null;

  const star = h('button', { type: 'button', class: 'star' });
  const paintStar = () => {
    const on = favs.includes(code);
    star.textContent = on ? '★' : '☆';
    star.classList.toggle('on', on);
    star.setAttribute('aria-pressed', String(on));
    star.setAttribute('aria-label', on ? 'Αφαίρεση από τα αγαπημένα' : 'Προσθήκη στα αγαπημένα');
  };
  star.addEventListener('click', () => {
    favs = favs.includes(code) ? favs.filter((c) => c !== code) : [...favs, code];
    saveFavs();
    paintStar();
  });

  // Manual retry also respects the 15 s floor: too soon → brought forward to the floor.
  const retry = () => {
    const wait = lastAttempt + MIN_GAP_MS - Date.now();
    if (wait <= 0) return load();
    clearTimeout(pollTimer);
    nextAt = Date.now() + wait;
    pollTimer = setTimeout(load, wait);
    update();
  };
  const stateText = h('p', { class: 'state-msg' });
  const stateRetry = h('button', { type: 'button', class: 'btn primary', onclick: retry }, 'Δοκίμασε ξανά');
  const state = h('div', { class: 'state' }, stateText, stateRetry);
  const bannerText = h('span');
  const banner = h('div', { class: 'banner', role: 'alert' }, bannerText,
    h('button', { type: 'button', class: 'btn', onclick: retry }, 'Δοκίμασε ξανά'));
  const list = h('ul', { class: 'arrivals' });
  const status = h('p', { class: 'status', 'aria-live': 'polite' });

  app.replaceChildren(
    h('div', { class: 'stop-head' },
      h('div', {}, h('h1', {}, titleCase(stop.name)), h('p', { class: 'subtitle' }, `Στάση ${code}`)),
      star),
    banner, state, list,
    h('p', { class: 'legend' }, '● live = θέση οχήματος σε πραγματικό χρόνο · προγρ. = ώρα από το πρόγραμμα'),
    status);
  paintStar();

  function update() {
    if (dead) return;
    const now = Date.now();
    const stale = !!data && (failed || now - data.fetchedAt > STALE_MS);
    banner.hidden = !stale;
    if (data) bannerText.textContent = `Παλιά δεδομένα · ενημερώθηκε πριν ${fmtAge((now - data.fetchedAt) / 1000)}`;

    const text = !data ? (failed ? 'Δεν ήταν δυνατή η σύνδεση.' : 'Φόρτωση…')
      : data.vehicles.length ? '' : 'Καμία άφιξη αυτή τη στιγμή';
    stateText.textContent = text;
    stateRetry.hidden = !(failed && !data);
    state.hidden = !text;

    const items = (data ? data.vehicles : []).map((v) => ({
      v,
      key: v.live ? Math.max(0, v.etaSec - (now - data.fetchedAt) / 1000) : v.etaSec,
    })).sort((a, b) => a.key - b.key);
    list.replaceChildren(...items.map((i) => arrivalRow(i.v, i.key, data.fetchedAt)));

    const bits = [];
    if (data) bits.push(`ενημερώθηκε πριν ${fmtAge((now - data.fetchedAt) / 1000)}`);
    if (inflight) bits.push('ανανέωση…');
    else if (pollTimer) bits.push(`ανανέωση σε ${Math.max(0, Math.ceil((nextAt - now) / 1000))}″`);
    status.textContent = bits.join(' · ');
  }

  function schedule() {
    clearTimeout(pollTimer);
    pollTimer = null;
    if (dead || document.hidden) return;
    const delay = Math.max(0, lastAttempt + POLL_MS - Date.now());
    nextAt = Date.now() + delay;
    pollTimer = setTimeout(load, delay);
  }

  async function load() {
    if (inflight || dead) return;
    clearTimeout(pollTimer);
    pollTimer = null;
    lastAttempt = Date.now();
    const ctl = new AbortController();
    inflight = ctl;
    const timeout = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    update();
    try {
      const url = DEMO ? './fixtures/live-1011.json' : `${API_BASE}/api/live/${encodeURIComponent(code)}`;
      const res = await fetch(url, { signal: ctl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const next = DEMO ? normalizeLive(body, Date.now()) : body;
      if (!next || !Array.isArray(next.vehicles) || !Number.isFinite(next.fetchedAt)) throw new Error('bad body');
      data = next;
      failed = false;
    } catch {
      failed = true;
    } finally {
      clearTimeout(timeout);
      inflight = null;
    }
    if (dead) return;
    schedule();
    update();
  }

  function startTicker() {
    clearInterval(ticker);
    ticker = setInterval(update, 1000);
  }

  function onVisibility() {
    if (document.hidden) {
      clearTimeout(pollTimer);
      pollTimer = null;
      clearInterval(ticker);
      ticker = null;
      return;
    }
    startTicker();
    update();
    if (inflight) return; // load() will reschedule when it finishes
    if (Date.now() - lastAttempt >= MIN_GAP_MS) load();
    else schedule();
  }
  document.addEventListener('visibilitychange', onVisibility);

  update();
  if (!document.hidden) startTicker();
  load();

  return () => {
    dead = true;
    clearTimeout(pollTimer);
    clearInterval(ticker);
    if (inflight) inflight.abort();
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

// ---- routing ----

let cleanup = () => {};

function route() {
  cleanup();
  cleanup = () => {};
  const m = location.hash.match(/^#\/stop\/([^/?]+)/);
  backLink.hidden = !m;
  if (m) {
    let code = m[1];
    try { code = decodeURIComponent(code); } catch { /* keep raw */ }
    cleanup = stopView(code);
  } else {
    homeView();
  }
  window.scrollTo(0, 0);
}

async function init() {
  if (DEMO) document.getElementById('demo-tag').hidden = false;
  app.replaceChildren(msg('Φόρτωση…'));
  try {
    const [s, l] = await Promise.all([getJSON('./data/stops.json'), getJSON('./data/lines.json')]);
    stops = s;
    for (const line of l) linesByCode.set(String(line.code), line);
    for (const st of stops) stopsByCode.set(String(st.code), st);
    stopKeys = stops.map((st) => ({ stop: st, key: searchKey(st.name) }));
  } catch {
    app.replaceChildren(msg('Δεν φορτώθηκαν τα δεδομένα στάσεων.'),
      h('button', { type: 'button', class: 'btn primary', onclick: () => location.reload() }, 'Δοκίμασε ξανά'));
    return;
  }
  window.addEventListener('hashchange', route);
  route();
}

init();
