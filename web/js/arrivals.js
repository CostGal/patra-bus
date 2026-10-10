// Shared by the worker (imported via wrangler/esbuild) and the frontend (api.js, demo.js, views).
// The one place that decides live vs scheduled. Pure: no DOM, no network, no globals.

// Upstream sends coordinates as strings; "0"/"0" means a scheduled departure
// with no tracking. Unparseable or out-of-range coordinates are also treated as not live.
export function isLive(v) {
  const lat = Number(v.latitude);
  const lng = Number(v.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return false;
  return !(lat === 0 && lng === 0);
}

// raw: upstream /stops/live/{code} body. fetchedAt: epoch ms of the upstream fetch.
export function normalizeLive(raw, fetchedAt) {
  const vehicles = (raw && Array.isArray(raw.vehicles) ? raw.vehicles : []).map((v) => {
    const live = isLive(v);
    const mins = Number(v.departureMins) || 0;
    const secs = Number(v.departureSeconds) || 0; // remainder 0–59, not a total
    const code = v.vehicleCode == null ? '' : String(v.vehicleCode).trim();
    const out = {
      lineCode: String(v.lineCode ?? ''),
      lineName: v.lineName ?? '',
      routeCode: String(v.routeCode ?? ''),
      routeName: v.routeName ?? '',
      color: v.lineColor || null,
      textColor: v.lineTextColor || null,
      live,
      departureMins: mins,
      etaSec: mins * 60 + secs,
      vehicleCode: code || null,
    };
    // Coordinates only ever leave this function for live vehicles.
    if (live) {
      out.lat = Number(v.latitude);
      out.lng = Number(v.longitude);
    }
    return out;
  });
  vehicles.sort((a, b) => a.etaSec - b.etaSec);
  return { fetchedAt, vehicles };
}

// Upstream 404 on /stops/live = nothing scheduled for this stop right now.
export const noServiceResult = (fetchedAt) => ({ fetchedAt, vehicles: [], noService: true });

// Compact countdown: "τώρα", "<1′", "7′", "1 ώ 05′". sec = remaining seconds (fractions fine).
export function etaText(sec) {
  const s = Number(sec);
  if (!Number.isFinite(s) || s < 15) return 'τώρα';
  if (s < 60) return '<1′';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}′`;
  return `${Math.floor(m / 60)} ώ ${String(m % 60).padStart(2, '0')}′`;
}

// Spoken form for aria-labels: "τώρα", "λιγότερο από ένα λεπτό", "7 λεπτά", "1 ώρα και 5 λεπτά".
export function etaSpoken(sec) {
  const s = Number(sec);
  if (!Number.isFinite(s) || s < 15) return 'τώρα';
  if (s < 60) return 'λιγότερο από ένα λεπτό';
  const m = Math.floor(s / 60);
  const min = (n) => (n === 1 ? '1 λεπτό' : `${n} λεπτά`);
  if (m < 60) return min(m);
  const hh = Math.floor(m / 60);
  const rest = m % 60;
  const hours = hh === 1 ? '1 ώρα' : `${hh} ώρες`;
  return rest ? `${hours} και ${min(rest)}` : hours;
}

// Age of data: "8″", "3′". Used by the "ενημερώθηκε πριν …" footer.
export function ageText(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  return s < 120 ? `${s}″` : `${Math.floor(s / 60)}′`;
}
