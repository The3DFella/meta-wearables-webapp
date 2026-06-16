/* Offline support for the glasses map: app shell + map data caches.
 * - App shell: cache-first (instant load, works offline once installed).
 * - Map tiles / glyphs / sprites / style: stale-while-revalidate so
 *   previously-seen areas keep working with no network (Organic-Maps-style
 *   offline maps), while fresh tiles update in the background when online.
 */
var VERSION = 'v1';
var SHELL_CACHE = 'map-shell-' + VERSION;
var MAP_CACHE = 'map-data-' + VERSION;

var SHELL_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './ofm-dark.json',
  './Gavriel_logo.png',
  './vendor/maplibre-gl.js',
  './vendor/maplibre-gl.css',
];

// Hosts whose responses we cache for offline map use.
var MAP_HOSTS = [
  'tiles.openfreemap.org',     // vector tiles, glyphs, sprites (GL engine)
  'basemaps.cartocdn.com',     // dark raster tiles (2D fallback engine)
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(SHELL_CACHE).then(function (c) {
      return c.addAll(SHELL_ASSETS).catch(function () {});
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== SHELL_CACHE && k !== MAP_CACHE) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

function isMapData(url) {
  return MAP_HOSTS.indexOf(url.hostname) !== -1;
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url;
  try { url = new URL(req.url); } catch (err) { return; }

  // Map data: stale-while-revalidate.
  if (isMapData(url)) {
    e.respondWith(
      caches.open(MAP_CACHE).then(function (cache) {
        return cache.match(req).then(function (cached) {
          var network = fetch(req).then(function (res) {
            if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
            return res;
          }).catch(function () { return cached; });
          return cached || network;
        });
      })
    );
    return;
  }

  // Same-origin app shell: cache-first, fall back to network.
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(req).then(function (cached) {
        return cached || fetch(req).then(function (res) {
          if (res && res.ok) {
            var copy = res.clone();
            caches.open(SHELL_CACHE).then(function (c) { c.put(req, copy); });
          }
          return res;
        }).catch(function () { return cached; });
      })
    );
  }
});
