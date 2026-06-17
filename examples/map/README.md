# Squad Map — Meta Ray-Ban Display

A minimal map for Meta Ray-Ban Display glasses: it shows **your location** plus a
**squad of 5 dummy teammates** wandering nearby.

## What it does

- Loads your live GPS location via `navigator.geolocation` (from the paired phone).
- Spawns 5 simulated teammates at random spots within ~100 m of you.
- Each teammate has a random 3-letter name shown above their dot.
- Teammates drift around with a dumb random walk at ~walking speed (1.4 m/s),
  staying loosely within range (they steer back if they wander too far).
- **Vector rendering** via [MapLibre GL JS](https://maplibre.org/) with free, no-key
  [OpenFreeMap](https://openfreemap.org/) tiles, recolored at runtime into a dark
  additive-display theme.
- **Automatic WebGL detection with graceful fallback** to a 2D `<canvas>` raster
  engine (dark CARTO tiles) if WebGL is unavailable. Active engine shows in the header.
- **Offline maps** via a Service Worker (`sw.js`): app shell cached cache-first,
  map tiles cached stale-while-revalidate.
- If location is denied/unavailable, it falls back to a **demo location** so the map
  and teammates still appear (useful on desktop).

## Controls (D-pad)

- Arrows move focus between the on-screen buttons.
- Focus the map, press **Enter** to toggle pan mode, then arrows pan (green ring).
- `+` / `−` zoom, **Center** recenters on you.

## Run locally

```bash
cd examples/map
npm install
npm run dev
```

Or open `index.html` directly in a browser.

## Test location in Chrome

1. Open DevTools (F12)
2. ⋮ → More tools → **Sensors**
3. Override **Location** with custom coordinates

## Deploy

Host at a public HTTPS URL and add to your glasses via the Meta AI app or QR code.
