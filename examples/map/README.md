# My Map — Meta Ray-Ban Display

OpenStreetMap location viewer built for Meta Ray-Ban Display glasses.

## Features

- Live GPS location via `navigator.geolocation` (from paired phone)
- **Vector map rendering** (Organic-Maps-style) via [MapLibre GL JS](https://maplibre.org/)
  with free, no-key [OpenFreeMap](https://openfreemap.org/) tiles, recolored at
  runtime into a dark additive-display theme. Crisp at any zoom, smooth pan/zoom.
- **Automatic WebGL detection with graceful fallback.** If the glasses browser
  can't run WebGL, the app falls back to a 2D `<canvas>` raster engine using dark
  CARTO tiles — same UI, routing, and navigation. The active engine is shown in
  the header (`Vector` vs `2D`) and logged to the console.
- **Offline maps** via a Service Worker (`sw.js`): the app shell is cached
  cache-first, and map tiles/glyphs/sprites are cached stale-while-revalidate, so
  previously-viewed areas keep working with no network.
- Reverse geocoding via [Nominatim](https://nominatim.org/) (open source)
- **Walking navigation** — enter a destination and get a planned walking route
  with live, spoken turn-by-turn directions:
  - Destination entry (`🔍 Go`) via an **on-screen D-pad keyboard**. Webapps on
    the Ray-Ban Display get no text input (the Neural Band only emits arrow keys
    + Enter + Escape), so a focusable letter grid is used to spell out the place.
  - Destination lookup via Photon geocoder (Nominatim fallback)
  - Walking route from the FOSSGIS-hosted OSRM `foot` router (free, no key)
  - Route + destination drawn on the map; an on-map banner shows the next
    maneuver and distance, auto-advancing as you walk
  - Step instructions are spoken aloud via `speechSynthesis`
  - Off-route detection triggers an automatic reroute
- D-pad navigation: focus the map, press **Enter** to toggle pan mode,
  then use arrows to pan (green ring = pan mode)
- Zoom in/out and recenter buttons

## Map engine

The map layer is abstracted behind a small interface so the rest of the app
(routing, search, navigation, markers) is engine-agnostic:

- `createGLMapView()` — MapLibre GL vector tiles (preferred). Requires WebGL.
- `createCanvasMapView()` — 2D canvas raster fallback (no WebGL needed).

On startup `detectWebGL()` picks the engine; if MapLibre init throws, it falls
back to canvas automatically. MapLibre and its CSS are vendored under `vendor/`
so the app loads offline and needs no build step or CDN.

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
