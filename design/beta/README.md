# Closed beta 1 assets (TEL-16)

## What these files are

- `icon-beta.svg`: source of the beta app icon (the usual bus on full-bleed navy with an amber BETA pill).
  The bus and the badge sit inside the maskable safe circle, so the same artwork is used for
  `web/icons/icon-180.png`, `icon-192.png`, `icon-512.png` and `maskable-512.png`.
- `og-image.html`: source of `web/og-image.png`, the 1200×630 link preview (Greek). Render it at
  1200×630 next to `icon-beta.svg` and screenshot it to regenerate the PNG.

They live outside `web/` so GitHub Pages does not serve them.

## Restoring the stable icons after the beta

1. Move the stable PNGs back over the beta ones:
   `git mv -f web/icons/stable/icon-180.png web/icons/icon-180.png` (same for `icon-192`, `icon-512`,
   `maskable-512`), then remove the empty `web/icons/stable/`.
2. Re-add the SVG entry to `icons` in `web/manifest.webmanifest`:
   `{ "src": "icon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any" }`.
3. Bump `CACHE` in `web/sw.js` by one, so installed apps pick up the new icons.
4. Optionally update the `og:title` / `og:description` / `og-image.png` in `web/index.html` to drop "beta".
