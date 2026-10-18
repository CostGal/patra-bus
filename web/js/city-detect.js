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
