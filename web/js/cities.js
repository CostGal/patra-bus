// City table (docs/MULTI-CITY.md). Everything city-specific reads the active city from here instead of its own
// constants. Pure data, no DOM: also imported by the worker and by the node scripts/tests.
// The table is a whitelist: agencies and hosts never come from a request.
export const CITIES = {
  patra: {
    id: 'patra',
    name: { el: 'Πάτρα', en: 'Patras' },
    agency: 112,
    page: 'https://patra.citybus.gr/el/stops', // token scrape + Referer fallback
    bbox: { west: 21.60, south: 38.13, east: 21.90, north: 38.33 },
    center: { lat: 38.2466, lng: 21.7346 }, // Πλ. Γεωργίου Α', the "ΚΕΝΤΡΟ" of the route names
  },
  corfu: {
    id: 'corfu',
    name: { el: 'Κέρκυρα', en: 'Corfu' },
    agency: 101,
    page: 'https://corfu.citybus.gr/el/stops',
    // Stops' extent (19.805–19.927 E, 39.525–39.708 N on 2026-10-10) + ~2 km. The official page's bbox covers
    // most of the island (19.65–20.15 E, 39.35–39.80 N), far more than the network.
    bbox: { west: 19.78, south: 39.50, east: 19.95, north: 39.73 },
    center: { lat: 39.6243, lng: 19.9217 }, // Πλ. Σαρόκου (San Rocco), the town's bus hub
  },
};

export const DEFAULT_CITY = 'patra';

export const isCity = (id) => typeof id === 'string' && Object.hasOwn(CITIES, id);

// Active city: set once at boot by app.js (hash prefix → settings.city → default). Switching city reloads the
// page, so modules may read it at load time. Saved items without a `city` field belong to DEFAULT_CITY.
let active = DEFAULT_CITY;
export const city = () => CITIES[active];
export const cityId = () => active;
export function setActiveCity(id) {
  if (!isCity(id)) return false;
  active = id;
  return true;
}

// Localized display name ('el' | 'en'); anything else falls back to Greek.
export const cityName = (c = city(), lang = 'el') => c.name[lang] ?? c.name.el;

// Static data (stops/lines/routes/shapes) of a city, relative to web/. Patras stays at the old path.
export const dataDir = (c = city()) => (c.id === DEFAULT_CITY ? './data/' : `./data/${c.id}/`);

export const apiBase = (c) => `https://rest.citybus.gr/api/v1/el/${c.agency}`;
