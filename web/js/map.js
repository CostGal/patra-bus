// STUB (owner: shell). Contract in docs/ARCHITECTURE.md.
export function createMap() {
  const noop = () => {};
  return { ready: Promise.resolve(), setStops: noop, highlightStop: noop, setUserFix: noop, setVehicles: noop, clearVehicles: noop,
    setOverlay: noop, clearOverlay: noop, setMarkers: noop, clearMarkers: noop, flyTo: noop, fitTo: noop, setPadding: noop, setTheme: noop,
    getCenter: () => ({ lat: 38.2466, lng: 21.7346 }) };
}
