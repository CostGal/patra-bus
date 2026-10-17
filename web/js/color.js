// Line colours (owner: shell). Upstream sends each line's badge colour and text colour; many pairs are below the
// WCAG 1.4.3 minimum (white on #00bcd4 is 2.3:1, unreadable at a bus stop in sunlight). readableLine keeps the
// line's colour and changes as little as possible: first a barely visible darkening (≤ 6%) of the background,
// then the other text colour (dark on bright lines), and only if neither reads, a darker background.
const MIN = 4.5;
const DARK = '#1f1f1f'; // = --foreground (light theme)
const LIGHT = '#ffffff';
const NUDGE = 0.06;

const parse = (c) => {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(c ?? '').trim());
  if (!m) return null;
  const x = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1];
  return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16));
};
const hex = (rgb) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
const lum = (rgb) => {
  const [r, g, b] = rgb.map((v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
// Pure: WCAG contrast ratio of two colours (null if either is not a hex colour).
export function contrast(a, b) {
  const x = parse(a), y = parse(b);
  if (!x || !y) return null;
  const [hi, lo] = [lum(x), lum(y)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
}
const toward = (rgb, target, k) => rgb.map((v) => v + (target - v) * k);

// Pure: { color, textColor } -> the same pair, readable (≥ 4.5:1). Unknown / non-hex colours pass through unchanged.
export function readableLine(color, textColor) {
  const bg = parse(color);
  const fg = textColor || LIGHT;
  if (!bg || !parse(fg) || contrast(color, fg) >= MIN) return { color, textColor };
  const lightText = lum(parse(fg)) > 0.5;
  const shift = (k) => hex(toward(bg, lightText ? 0 : 255, k));
  for (let k = 0.01; k <= NUDGE + 1e-9; k += 0.01) if (contrast(shift(k), fg) >= MIN) return { color: shift(k), textColor: fg };
  const other = lightText ? DARK : LIGHT;
  if (contrast(color, other) >= MIN) return { color: hex(bg), textColor: other };
  for (let k = NUDGE; k <= 1; k += 0.01) if (contrast(shift(k), fg) >= MIN) return { color: shift(k), textColor: fg };
  return { color, textColor };
}
