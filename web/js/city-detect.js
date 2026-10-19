// Which city is a point in? (owner: shell, TEL-142). Pure: the boxes come from cities.js and nothing leaves the device.
import { CITIES } from './cities.js';

// Returns the id of the city whose bounding box contains the point, or null. The edges count as inside.
// The two boxes do not overlap (see cities.js), so at most one city matches.
export function cityAt(point, cities = CITIES) {
  if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return null;
  for (const c of Object.values(cities)) {
    const b = c.bbox;
    if (point.lng >= b.west && point.lng <= b.east && point.lat >= b.south && point.lat <= b.north) return c.id;
  }
  return null;
}

const MAX_ACCURACY_M = 2000; // a coarser fix could be on the wrong side of the city edge

// The city to offer the user, or null. Only a real GPS fix counts (not a pin dropped by hand), it must be accurate
// enough, inside a known city, and that city must differ from the one on screen.
export function cityToOffer(fix, activeId, cities = CITIES) {
  if (!fix || fix.source !== 'gps' || !(fix.accuracy <= MAX_ACCURACY_M)) return null;
  const there = cityAt(fix, cities);
  return there && there !== activeId ? there : null;
}
