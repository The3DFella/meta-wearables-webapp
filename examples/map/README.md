# My Map — Meta Ray-Ban Display

OpenStreetMap location viewer built for Meta Ray-Ban Display glasses.

## Features

- Live GPS location via `navigator.geolocation` (from paired phone)
- OpenStreetMap raster tiles
- Reverse geocoding via [Nominatim](https://nominatim.org/) (open source)
- D-pad navigation: focus the map canvas and use arrows to pan
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
