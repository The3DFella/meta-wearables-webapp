# My Map — Meta Ray-Ban Display

OpenStreetMap location viewer built for Meta Ray-Ban Display glasses.

## Features

- Live GPS location via `navigator.geolocation` (from paired phone)
- OpenStreetMap raster tiles
- Reverse geocoding via [Nominatim](https://nominatim.org/) (open source)
- **Walking navigation** — enter a destination and get a planned walking route
  with live, spoken turn-by-turn directions:
  - Destination entry (`🔍 Go`):
    - **On-screen D-pad keyboard** — the glasses-compatible path. Webapps on
      the Ray-Ban Display have **no microphone or native text input**, so a
      focusable letter grid is used to spell out the place.
    - **Voice** (`🎤` key / Speak button) — works only in a desktop browser for
      testing; the glasses block mic access, so it falls back to the keyboard.
  - Destination lookup via Nominatim search
  - Walking route from the FOSSGIS-hosted OSRM `foot` router (free, no key)
  - Route + destination drawn on the map; an on-map banner shows the next
    maneuver and distance, auto-advancing as you walk
  - Step instructions are spoken aloud via `speechSynthesis`
  - Off-route detection triggers an automatic reroute
- D-pad navigation: focus the map canvas, press **Enter** to toggle pan mode,
  then use arrows to pan (green ring = pan mode)
- Zoom in/out and recenter buttons

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
