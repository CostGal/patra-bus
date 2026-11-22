// Our map look (TEL-229): cream by day, Harbor by night, on top of OpenFreeMap's "liberty" style.
// styleFor() is a pure function from the provider's style to ours. A layer the provider renames is simply not restyled:
// the map keeps working. Same tiles, same provider, same attributions (CLAUDE.md rule 5). No new service or key.

export const BASE_STYLE = 'https://tiles.openfreemap.org/styles/liberty';

const SOURCE = 'openmaptiles';
// Map labels use our own Manrope glyphs (TEL-361). Every one of the 256 ranges exists, even the empty ones: MapLibre
// drops all the labels of a tile when one range fails to load. Manrope has no italic, so italic labels become upright.
const GLYPHS_URL = `${new URL('../fonts/', import.meta.url).href}{fontstack}/{range}.pbf`;
export const MAP_FONT = ['Manrope Regular'];
const PLACE_FONT = ['Manrope Bold'];

const PALETTES = {
  light: {
    bg: '#f5eedf', res: '#f1e8d6', retail: '#f3e9d6', park: '#cfdcae', wood: '#b9cf9f', grass: '#dbe4bd', water: '#a8cfcf', sand: '#f3e5bd',
    school: '#efe3c2', hospital: '#f2d9cd', cemetery: '#d3dcbc', pitch: '#bfd9a8', building: '#e3d5bb', edge: '#cfbd9e', shadow: '#c9b794',
    minor: '#fffaf0', major: '#fbf0d4', motor: '#f0d595', casing: '#dccfb8', rail: '#c8bca6', shore: '#d7ece6', parkEdge: '#b3c78f',
    text: '#4a3d2f', halo: '#fbf6ea', waterText: '#3f7478', disc: '#fffaf0',
    place: { food: '#b9582f', cafe: '#94643a', shop: '#a67c1e', health: '#b23f45', culture: '#a2487a', nature: '#4f7d3c', edu: '#7b5f3e', worship: '#6d5597', stay: '#54609f', service: '#37708f' },
  },
  dark: {
    bg: '#1f2a33', res: '#25323d', retail: '#293641', park: '#2a4a42', wood: '#254238', grass: '#2e4d45', water: '#12374a', sand: '#4d4a38',
    school: '#2d3944', hospital: '#3d3440', cemetery: '#2a423c', pitch: '#2f5249', building: '#394a57', edge: '#465866', shadow: '#141c23',
    minor: '#465663', major: '#5c6c78', motor: '#b08e55', casing: '#18212a', rail: '#43525e', shore: '#2f6377', parkEdge: '#3b6459',
    text: '#efe6d4', halo: '#17202a', waterText: '#8fc4d6', disc: '#3a362f',
    place: { food: '#e59a6f', cafe: '#d4a878', shop: '#dcb95c', health: '#e58a8a', culture: '#d993bd', nature: '#9cc27f', edu: '#c9ab84', worship: '#b6a2dc', stay: '#a3aee0', service: '#86bcd6' },
  },
};

const FILLS = {
  background: 'bg', landuse_residential: 'res', park: 'park', landcover_wood: 'wood', landcover_grass: 'grass', water: 'water', landcover_sand: 'sand',
  landuse_school: 'school', landuse_hospital: 'hospital', landuse_cemetery: 'cemetery', landuse_pitch: 'pitch',
};

// Kinds of place shown on the map. Bus stops from the map data are left out on purpose: they would look like our stops.
const PLACES = {
  food: ['restaurant', 'fast_food', 'bar', 'beer', 'ice_cream'], cafe: ['cafe', 'bakery'], shop: ['shop', 'clothing_store', 'grocery'],
  health: ['pharmacy', 'hospital', 'doctors', 'dentist'], culture: ['museum', 'art_gallery', 'castle', 'monument', 'attraction', 'theatre', 'cinema'],
  nature: ['park', 'garden', 'playground', 'stadium'], edu: ['school', 'college', 'library'], worship: ['place_of_worship'], stay: ['lodging'],
  service: ['bank', 'post', 'town_hall'],
};

// Our own icons, one line style, on a 24 px grid.
const GLYPHS = {
  food: 'M8 4v7M6 4v4a2 2 0 0 0 4 0V4M8 12v8M16 4c-2 1-3 4-3 7h3v9',
  cafe: 'M5 9h11v5a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4zM16 10h2a2 2 0 0 1 0 5h-2M8 3v3M12 3v3',
  shop: 'M6 9h12l1 11H5zM9 9V7a3 3 0 0 1 6 0v2',
  health: 'M12 5v14M5 12h14',
  culture: 'M4 20h16M6 10v7M10 10v7M14 10v7M18 10v7M3 10l9-6 9 6z',
  nature: 'M12 20v-8M12 12C7 12 5 9 5 5c5 0 7 3 7 7zM12 14c4 0 7-2 7-6-4 0-7 2-7 6',
  edu: 'M3 9l9-4 9 4-9 4zM7 11v5c3 2 7 2 10 0v-5',
  worship: 'M12 3v6M9 6h6M6 21v-9l6-3 6 3v9z',
  stay: 'M4 19V7M4 15h16v4M20 15v-3a3 3 0 0 0-3-3h-7v6',
  service: 'M4 10l8-5 8 5M6 10v8M10 10v8M14 10v8M18 10v8M4 20h16',
};

const paletteFor = (theme) => PALETTES[theme === 'dark' ? 'dark' : 'light'];

// One language on the map: the app's. Falls back to whatever name the map data has.
export const labelField = (lang) => (lang === 'en'
  ? ['coalesce', ['get', 'name_en'], ['get', 'name:latin'], ['get', 'name']]
  : ['coalesce', ['get', 'name:el'], ['get', 'name:nonlatin'], ['get', 'name']]);

const isNameLabel = (l) => l.type === 'symbol' && l.source === SOURCE && !/shield/.test(l.id)
  && JSON.stringify(l.layout?.['text-field'] ?? '').includes('name');

function scaleWidth(width, k) {
  if (Array.isArray(width) && width[0] === 'interpolate') {
    return [...width.slice(0, 3), ...width.slice(3).map((v, i) => (i % 2 && typeof v === 'number' ? +(v * k).toFixed(2) : v))];
  }
  if (width?.stops) return { ...width, stops: width.stops.map(([z, v]) => [z, +(v * k).toFixed(2)]) };
  return typeof width === 'number' ? +(width * k).toFixed(2) : width;
}

function styleRoad(l, c) {
  const id = l.id;
  if (/rail|transit/.test(id)) { l.paint['line-color'] = c.rail; return; }
  if (/path_pedestrian/.test(id)) {
    l.minzoom = 15.5;
    delete l.paint['line-dasharray'];
    l.paint['line-color'] = c.minor;
    l.paint['line-width'] = ['interpolate', ['linear'], ['zoom'], 15.5, 0.6, 20, 3];
    l.paint['line-opacity'] = ['interpolate', ['linear'], ['zoom'], 15.5, 0, 16.5, 0.6];
    return;
  }
  l.layout = { ...l.layout, 'line-cap': 'round', 'line-join': 'round' };
  const big = /motorway|trunk|primary/.test(id);
  l.paint['line-width'] = scaleWidth(l.paint['line-width'], big ? 1.25 : /secondary|tertiary/.test(id) ? 1.12 : 0.92);
  if (/casing/.test(id)) {
    l.paint['line-color'] = c.casing;
    l.paint['line-opacity'] = 0.6;
  } else {
    l.paint['line-color'] = /motorway|trunk/.test(id) ? c.motor : /primary|secondary/.test(id) ? c.major : c.minor;
  }
}

function useOurFont(style) {
  style.glyphs = GLYPHS_URL;
  for (const l of style.layers) {
    const font = l.layout?.['text-font'];
    if (font) l.layout['text-font'] = JSON.stringify(font).includes('Bold') ? PLACE_FONT : MAP_FONT;
  }
}

// The provider's style in, ours out. Never changes its input.
export function styleFor(base, theme, lang) {
  if (!Array.isArray(base?.layers)) return base;
  const style = JSON.parse(JSON.stringify(base));
  useOurFont(style);
  if (!style.sources?.[SOURCE]) return style;
  const c = paletteFor(theme);
  const layers = [];
  for (const l of style.layers) {
    // The map never tilts, so 3D walls only show as broken dark ticks. Places are added by addPlaces().
    if (l.type === 'raster' || l.type === 'fill-extrusion' || l['source-layer'] === 'poi') continue;
    if (/hatching/.test(l.id) || l.id === 'road_area_pattern') continue;
    l.paint = l.paint || {};
    const fill = FILLS[l.id];
    if (fill && l.type === 'background') l.paint['background-color'] = c[fill];
    if (fill && l.type === 'fill') { l.paint['fill-color'] = c[fill]; l.paint['fill-opacity'] = 1; delete l.paint['fill-outline-color']; }
    if (l.type === 'line' && l['source-layer'] === 'waterway') l.paint['line-color'] = c.water;
    if (l.type === 'line' && l['source-layer'] === 'transportation') styleRoad(l, c);
    if (isNameLabel(l)) {
      l.layout['text-field'] = labelField(lang);
      l.paint['text-color'] = /water/.test(l.id) ? c.waterText : c.text;
      l.paint['text-halo-color'] = c.halo;
    }
    if (l.id === 'building') {
      layers.push({
        id: 'building-shadow', type: 'fill', source: SOURCE, 'source-layer': 'building', minzoom: 14.5,
        paint: {
          'fill-color': c.shadow, 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 14.5, 0, 15.5, 0.55],
          'fill-translate': ['interpolate', ['linear'], ['zoom'], 15, ['literal', [0.6, 0.8]], 18, ['literal', [2, 2.6]]],
          'fill-translate-anchor': 'viewport',
        },
      });
      l.paint['fill-color'] = c.building;
      l.paint['fill-outline-color'] = c.edge;
    }
    layers.push(l);
    if (l.id === 'landuse_residential') {
      layers.push({
        id: 'landuse_retail', type: 'fill', source: SOURCE, 'source-layer': 'landuse',
        filter: ['match', ['get', 'class'], ['retail', 'commercial'], true, false], paint: { 'fill-color': c.retail },
      });
    }
    if (l.id === 'water') {
      layers.push({
        id: 'water-shore', type: 'line', source: SOURCE, 'source-layer': 'water',
        paint: { 'line-color': c.shore, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 1, 18, 5], 'line-blur': 2, 'line-opacity': 0.75 },
      });
    }
    if (l.id === 'park') {
      layers.push({ id: 'park-edge', type: 'line', source: SOURCE, 'source-layer': 'park', paint: { 'line-color': c.parkEdge, 'line-width': 1.2, 'line-opacity': 0.7 } });
    }
  }
  style.layers = layers;
  return style;
}

function placeIcon(color, disc, glyph) {
  const size = 44;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const x = canvas.getContext('2d');
  x.beginPath();
  x.arc(22, 22, 19, 0, Math.PI * 2);
  x.fillStyle = color;
  x.fill();
  x.lineWidth = 3;
  x.strokeStyle = disc;
  x.stroke();
  x.translate(10.6, 10.6);
  x.scale(0.95, 0.95);
  x.lineWidth = 2.3;
  x.lineCap = 'round';
  x.lineJoin = 'round';
  x.stroke(new Path2D(glyph));
  return x.getImageData(0, 0, size, size);
}

// Colored places with our icons. Call on every style load: a new style starts with no images.
export function addPlaces(map, theme, lang) {
  if (!map.getSource(SOURCE)) return;
  const c = paletteFor(theme);
  const icon = ['match', ['get', 'class']];
  const color = ['match', ['get', 'class']];
  for (const [kind, classes] of Object.entries(PLACES)) {
    const name = `tel-place-${kind}`;
    if (map.hasImage(name)) map.removeImage(name);
    map.addImage(name, placeIcon(c.place[kind], c.disc, GLYPHS[kind]), { pixelRatio: 2 });
    icon.push(classes, name);
    color.push(classes, c.place[kind]);
  }
  icon.push('tel-place-shop');
  color.push(c.text);
  const before = map.getLayer('label_other') ? 'label_other' : undefined;
  const layer = (id, classes, minzoom) => map.addLayer({
    id, type: 'symbol', source: SOURCE, 'source-layer': 'poi', minzoom,
    filter: ['all', ['match', ['get', 'class'], classes, true, false], ['has', 'name']],
    layout: {
      'icon-image': icon, 'icon-size': 0.92, 'symbol-sort-key': ['get', 'rank'],
      'text-field': labelField(lang), 'text-font': PLACE_FONT, 'text-size': 11, 'text-max-width': 7,
      'text-variable-anchor': ['right', 'left', 'top', 'bottom'], 'text-radial-offset': 0.95, 'text-justify': 'auto',
    },
    paint: { 'text-color': color, 'text-halo-color': c.halo, 'text-halo-width': 1.4 },
  }, before);
  const { shop, ...rest } = PLACES;
  layer('tel-places', Object.values(rest).flat(), 15); // the app opens at zoom 14: that view stays calm behind the glass sheet
  layer('tel-places-shop', shop, 16.5); // the most common kind: only when zoomed in, so the city view keeps its variety
}

// The app's language changed: rename the map without reloading it.
export function setMapLanguage(map, lang) {
  for (const l of map.getStyle()?.layers || []) {
    if (isNameLabel(l)) map.setLayoutProperty(l.id, 'text-field', labelField(lang));
  }
}
