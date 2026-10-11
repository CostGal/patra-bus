// ALLOWED_ORIGIN: "*" or a comma-separated list. An entry is an exact origin, or an origin whose host starts with
// "*." (e.g. https://*.patra-bus.pages.dev) = exactly one extra DNS label, so it only covers that project's previews.

const LABEL = '[a-z0-9-]+';

export function parseAllowed(env) {
  return (env.ALLOWED_ORIGIN || '*').split(',').map((o) => o.trim()).filter(Boolean);
}

const isPattern = (entry) => entry.includes('://*.');

function patternRegex(entry) {
  const [scheme, host] = entry.split('://*.');
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return new RegExp(`^${esc(scheme)}://${LABEL}\\.${esc(host)}$`, 'i');
}

// -> true when `origin` is in the list (exact or pattern) or the list is "*".
export function isAllowedOrigin(env, origin) {
  const allowed = parseAllowed(env);
  if (allowed.includes('*')) return true;
  if (!origin) return false;
  return allowed.some((e) => (isPattern(e) ? patternRegex(e).test(origin) : e === origin));
}

// -> true when `origin` is allowed only through a pattern entry (a preview deployment, not the production site).
export function isPatternOrigin(env, origin) {
  if (!origin) return false;
  const allowed = parseAllowed(env);
  if (allowed.includes(origin)) return false;
  return allowed.some((e) => isPattern(e) && patternRegex(e).test(origin));
}

// Value for Access-Control-Allow-Origin.
export function corsOriginFor(env, origin) {
  const allowed = parseAllowed(env);
  if (allowed.includes('*')) return '*';
  if (origin && isAllowedOrigin(env, origin)) return origin;
  return allowed.find((e) => !isPattern(e)) || 'null';
}
