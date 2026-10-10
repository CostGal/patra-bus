// City table (docs/MULTI-CITY.md). Everything city-specific reads the active city from here instead of its own
// constants. Pure data, no DOM: also imported by the worker and by the node scripts/tests.
// The table is a whitelist: agencies and hosts never come from a request.
export const CITIES = {
  patra: {
    id: 'patra',
    agency: 112,
    page: 'https://patra.citybus.gr/el/stops', // token scrape + Referer fallback
    bbox: { west: 21.60, south: 38.13, east: 21.90, north: 38.33 },
    center: { lat: 38.2466, lng: 21.7346 }, // Πλ. Γεωργίου Α', the "ΚΕΝΤΡΟ" of the route names
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

// Static data (stops/lines/routes/shapes) of a city, relative to web/. Patras stays at the old path.
export const dataDir = (c = city()) => (c.id === DEFAULT_CITY ? './data/' : `./data/${c.id}/`);

export const apiBase = (c) => `https://rest.citybus.gr/api/v1/el/${c.agency}`;
