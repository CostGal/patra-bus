// STUB (owner: location).
const subs = new Set();
const location = {
  current: null, status: 'idle',
  start() {}, stop() {}, setManual(p) { this.current = p ? { ...p, accuracy: 0, heading: null, speed: null, ts: Date.now(), source: 'manual' } : null; subs.forEach((f) => f(this.current, this.status)); },
  subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }, async enableCompass() { return false; },
};
export default location;
