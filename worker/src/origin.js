// ALLOWED_ORIGIN: "*" or a comma-separated list. An entry is an exact origin, or an origin whose FIRST host label
// contains one "*" that stands for one or more of [a-z0-9-] (https://*.x.dev, https://*-app.x.dev): it matches
// previews of one project and nothing else. Wildcards anywhere else make the entry match nothing.

const LABEL = '[a-z0-9-]+';

export function parseAllowed(env) {
  return (env.ALLOWED_ORIGIN || '*').split(',').map((o) => o.trim()).filter(Boolean);
}

const hostOf = (entry) => entry.split('://')[1] || '';
const isPattern = (entry) => entry !== '*' && entry.includes('*');

// Valid pattern = exactly one "*", inside the first label of the host.
function patternRegex(entry) {
  const host = hostOf(entry);
  const first = host.split('.')[0];
  if (!first.includes('*') || entry.split('*').length !== 2 || host.slice(first.length).includes('*')) return null;
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const [pre, post] = entry.split('*');
  return new RegExp(`^${esc(pre)}${LABEL}${esc(post)}$`, 'i');
}

const patternMatches = (entry, origin) => patternRegex(entry)?.test(origin) ?? false;

// -> true when `origin` is in the list (exact or pattern) or the list is "*".
export function isAllowedOrigin(env, origin) {
  const allowed = parseAllowed(env);
  if (allowed.includes('*')) return true;
  if (!origin) return false;
  return allowed.some((e) => (isPattern(e) ? patternMatches(e, origin) : e === origin));
}

// -> true when `origin` is allowed only through a pattern entry (a preview deployment, not the production site).
export function isPatternOrigin(env, origin) {
  if (!origin) return false;
  const allowed = parseAllowed(env);
  if (allowed.includes(origin)) return false;
  return allowed.some((e) => isPattern(e) && patternMatches(e, origin));
}

// Value for Access-Control-Allow-Origin.
export function corsOriginFor(env, origin) {
  const allowed = parseAllowed(env);
  if (allowed.includes('*')) return '*';
  if (origin && isAllowedOrigin(env, origin)) return origin;
  return allowed.find((e) => !isPattern(e) && e !== '*') || 'null';
}
