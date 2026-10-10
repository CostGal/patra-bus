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

// Only Patras until the frontend has an active-city setting (MULTI-CITY.md step 4).
export const city = () => CITIES[DEFAULT_CITY];

export const apiBase = (c) => `https://rest.citybus.gr/api/v1/el/${c.agency}`;
