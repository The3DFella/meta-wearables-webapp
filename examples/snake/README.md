# Snake — MetaDisplay Glasses Webapp Example

A classic Snake game built as a MetaDisplay Glasses webapp, designed for the 600x600 display canvas used on Meta wearables.

## How to run

Open `index.html` in any modern browser, or serve the directory with a local HTTP server:

```
npx serve .
```

## Controls

- **Arrow keys** — change direction
- **D-pad / EMG swipe gestures** — navigate menus and control the snake on-device

## Notes

- Fixed viewport: 600x600px, matching the wearable display resolution
- High scores are persisted via `localStorage`
- No dependencies — plain HTML, CSS, and JavaScript
