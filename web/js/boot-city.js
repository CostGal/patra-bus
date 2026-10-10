// Picks the active city before anything else reads it (owner: shell). Imported first by app.js, so every module that
// evaluates after it already sees the right city: hash prefix -> unprefixed link (= Patras) -> settings.city -> default.
import { setActiveCity } from './cities.js';
import { resolveBootCity } from './route.js';
import { getSettings } from './store.js';

let saved;
try { saved = getSettings().city; } catch { /* storage unavailable: default */ }
setActiveCity(resolveBootCity(globalThis.location?.hash ?? '', saved));
