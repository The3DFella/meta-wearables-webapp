# Map — Meta Ray-Ban Display

A walking navigation web app for Meta Ray-Ban Display (MRBD) glasses. Enter a
destination, get a planned walking route, and follow live, spoken turn-by-turn
directions on an OpenStreetMap view.

The app lives in [`examples/map`](examples/map).

## Features

- Live GPS location via `navigator.geolocation` (from the paired phone)
- Custom canvas renderer for OpenStreetMap raster tiles (no map library)
- Reverse geocoding via [Nominatim](https://nominatim.org/)
- **Walking navigation**: destination entry → route → live turn-by-turn
  - On-screen **D-pad keyboard** for destination entry — the Neural Band /
    captouch only emit arrow keys + Enter + Escape (webapps get no text input),
    so a focusable letter grid is used to spell out the place
  - **Recent destinations** saved locally (localStorage) for one-tap reuse
  - Geocoding via [Photon](https://photon.komoot.io/) with Nominatim fallback
  - Walking route from the FOSSGIS-hosted OSRM `foot` router (free, no key)
  - On-map banner with the next maneuver + distance, auto-advancing as you walk
  - Spoken step instructions via `speechSynthesis`; automatic reroute when off-route

## Run locally

```bash
cd examples/map
npm install
npm run dev
```

Then open the printed URL (e.g. `http://localhost:5173/`). Use the **arrow keys**
to move focus (simulating the D-pad), **Enter** to select, **Escape** to go back.
Focus the map and press **Enter** to toggle pan mode (green ring), then pan with
the arrows.

### Test location in Chrome

1. Open DevTools (F12)
2. `⋮` → More tools → **Sensors**
3. Override **Location** with custom coordinates (and step it along a route to
   watch the turn-by-turn advance)

## Meta Ray-Ban Display constraints

The UI is built for the glasses' display and input model:

- **600×600** fixed viewport
- **Additive display**: black (`#000000`) is transparent — dark backgrounds,
  white/high-contrast foreground
- **D-pad navigation only** (Neural Band / captouch → arrow keys, Enter, Escape);
  no cursor or touch. All interactive elements are `.focusable`
- **No microphone or text input** for webapps — the Neural Band only sends
  arrow keys, Enter, and Escape, so destination entry uses an on-screen keyboard
  navigated with the D-pad.

## Deploy

Host the contents of `examples/map` at a public **HTTPS** URL (required by the
glasses), then add the web app via the Meta AI app (Devices → Display Glasses
settings → App connections → Web apps).

## License

BSD — see [LICENSE](LICENSE).
