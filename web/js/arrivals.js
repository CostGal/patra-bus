// Shared by the worker (imported via wrangler/esbuild) and the frontend (?demo).
// The one place that decides live vs scheduled.

// Upstream sends coordinates as strings; "0"/"0" means a scheduled departure
// with no tracking. Unparseable coordinates are also treated as not live.
export function isLive(v) {
  const lat = Number(v.latitude);
  const lng = Number(v.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  return !(lat === 0 && lng === 0);
}

// raw: upstream /stops/live/{code} body. fetchedAt: epoch ms of the upstream fetch.
export function normalizeLive(raw, fetchedAt) {
  const vehicles = (raw && Array.isArray(raw.vehicles) ? raw.vehicles : []).map((v) => {
    const live = isLive(v);
    const mins = Number(v.departureMins) || 0;
    const secs = Number(v.departureSeconds) || 0; // remainder 0–59, not a total
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
