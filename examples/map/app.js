(function () {
  'use strict';

  /* ============================================================
   * Config
   * ========================================================== */
  var TILE_SIZE = 256;
  // Dark raster tiles (CARTO, no key) used by the 2D canvas fallback engine.
  var RASTER_TILE_URL = 'https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png';
  // Local MapLibre vector style (OpenFreeMap source, no key). Tuned for the
  // additive display at runtime in applyAdditiveTheme().
  var GL_STYLE_URL = 'ofm-dark.json';

  var NOMINATIM_URL = 'https://nominatim.openstreetmap.org/reverse';
  var NOMINATIM_SEARCH_URL = 'https://nominatim.openstreetmap.org/search';
  var PHOTON_URL = 'https://photon.komoot.io/api/';
  var OSRM_FOOT_URL = 'https://routing.openstreetmap.de/routed-foot/route/v1/foot/';

  // Raster fallback zoom range.
  var MIN_ZOOM = 3;
  var MAX_ZOOM = 19;
  var PAN_STEP = 64;         // pixels per D-pad pan press
  var STEP_ADVANCE_M = 22;
  var ARRIVE_M = 18;
  var REROUTE_M = 45;

  var state = {
    currentScreen: 'map-screen',
    screenHistory: [],
    zoom: 17,
    centerLat: 37.7749,
    centerLon: -122.4194,
    userLat: null,
    userLon: null,
    accuracy: null,
    heading: null,
    followUser: true,
    placeName: null,
    geoWatchId: null,
    mapFocused: false,
    panMode: false,
    lastNominatimRequest: 0,
    engine: '2D',
    destination: null,
    route: null,
    routeActive: false,
    currentStepIndex: 0,
    arrived: false,
    rerouting: false,
    lastRerouteAt: 0,
  };

  var screens = {};
  var Map = null;               // active rendering engine (see below)
  var mapFocusEl;
  var gpsStatus, coordsBar, placeNameEl;
  var detailLat, detailLon, detailAccuracy, detailHeading, errorMessage;
  var navBanner, navBannerIcon, navBannerInstruction, navBannerDistance;
  var routeSummary, routeDestName, stepsList;
  var keyboardEl, typeQueryEl, typeStatus, recentListEl;
  var attributionEl;
  var lastFocused = null;
  var RECENTS_KEY = 'mdg_map_recents';

  var KEY_ROWS = [
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
    ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
    ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'],
    ['Z', 'X', 'C', 'V', 'B', 'N', 'M'],
    ['SPACE', 'DEL', 'GO'],
  ];
  var typedQuery = '';
  var kbFocus = { r: 1, c: 0 };

  /* ============================================================
   * Geometry helpers (shared)
   * ========================================================== */
  function latLonToWorld(lat, lon, zoom) {
    var scale = TILE_SIZE * Math.pow(2, zoom);
    var x = (lon + 180) / 360 * scale;
    var latRad = lat * Math.PI / 180;
    var y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * scale;
    return { x: x, y: y };
  }
  function worldToLatLon(x, y, zoom) {
    var scale = TILE_SIZE * Math.pow(2, zoom);
    var lon = x / scale * 360 - 180;
    var n = Math.PI - 2 * Math.PI * y / scale;
    var lat = 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    return { lat: lat, lon: lon };
  }
  function haversine(lat1, lon1, lat2, lon2) {
    var R = 6371000;
    var dLat = (lat2 - lat1) * Math.PI / 180;
    var dLon = (lon2 - lon1) * Math.PI / 180;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  function clampZoom(z) { return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z)); }

  /* ============================================================
   * WebGL capability detection
   * ========================================================== */
  function detectWebGL() {
    try {
      if (typeof maplibregl === 'undefined') return false;
      var c = document.createElement('canvas');
      var gl = c.getContext('webgl2') ||
               c.getContext('webgl') ||
               c.getContext('experimental-webgl');
      if (!gl) return false;
      // Some embedded browsers expose a context but fail on real programs.
      var ext = gl.getExtension('WEBGL_lose_context');
      if (ext) { /* present is fine */ }
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ============================================================
   * GL engine (MapLibre vector tiles)
   * ========================================================== */
  function createGLMapView() {
    var map, userMarker, userWedgeEl, destMarker, ready = false, pendingResize = false;

    function makeUserEl() {
      var wrap = document.createElement('div');
      wrap.className = 'gl-user';
      wrap.innerHTML =
        '<div class="gl-user-accuracy"></div>' +
        '<div class="gl-user-wedge"></div>' +
        '<div class="gl-user-dot"></div>';
      userWedgeEl = wrap.querySelector('.gl-user-wedge');
      return wrap;
    }
    function makeDestEl() {
      var el = document.createElement('div');
      el.className = 'gl-dest';
      el.innerHTML = '<div class="gl-dest-pin"></div>';
      return el;
    }

    function applyAdditiveTheme() {
      // Pure-black background = transparent on the additive waveguide display.
      try { map.setPaintProperty('background', 'background-color', '#000000'); } catch (e) {}
      var setColor = function (id, prop, val) {
        try { if (map.getLayer(id)) map.setPaintProperty(id, prop, val); } catch (e) {}
      };
      // Water subtle, land features muted, roads bright white for contrast.
      setColor('water', 'fill-color', '#0c1a26');
      setColor('landcover_wood', 'fill-color', '#0d160f');
      setColor('landuse_park', 'fill-color', '#0e1710');
      setColor('landuse_residential', 'fill-color', '#0a0a0f');
      setColor('building', 'fill-color', '#15151f');
      setColor('building', 'fill-opacity', 0.5);

      ['highway_path', 'highway_minor', 'highway_major_subtle',
       'highway_major_inner', 'highway_motorway_subtle', 'highway_motorway_inner']
        .forEach(function (id) { setColor(id, 'line-color', '#e6e9ee'); });
      ['highway_major_casing', 'highway_motorway_casing']
        .forEach(function (id) { setColor(id, 'line-color', '#3a3f47'); });

      ['place_other', 'place_suburb', 'place_village', 'place_town',
       'place_city', 'place_city_large', 'place_state', 'highway_name_other',
       'highway_name_motorway', 'water_name']
        .forEach(function (id) {
          setColor(id, 'text-color', '#ffffff');
          setColor(id, 'text-halo-color', '#000000');
        });
    }

    function ensureLayers() {
      if (!map.getSource('route')) {
        map.addSource('route', {
          type: 'geojson',
          data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] } },
        });
        map.addLayer({
          id: 'route-casing', type: 'line', source: 'route',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': 'rgba(0,212,255,0.35)', 'line-width': 10 },
        });
        map.addLayer({
          id: 'route-line', type: 'line', source: 'route',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#00d4ff', 'line-width': 5 },
        });
      }
    }

    map = new maplibregl.Map({
      container: 'map',
      style: GL_STYLE_URL,
      center: [state.centerLon, state.centerLat],
      zoom: state.zoom,
      minZoom: 3,
      maxZoom: 19,
      attributionControl: false,
      interactive: false,        // glasses have no pointer; we drive via D-pad
      fadeDuration: 0,
      dragRotate: false,
      pitchWithRotate: false,
      refreshExpiredTiles: false,
    });

    map.on('load', function () {
      ready = true;
      applyAdditiveTheme();
      ensureLayers();
      userMarker = new maplibregl.Marker({ element: makeUserEl(), rotationAlignment: 'map' });
      destMarker = new maplibregl.Marker({ element: makeDestEl(), anchor: 'bottom' });
      refreshUser();
      refreshDestination();
      refreshRoute();
      if (pendingResize) { map.resize(); pendingResize = false; }
    });

    map.on('error', function (e) {
      // Non-fatal: vector tiles/glyphs may be offline. Background still shows.
      if (e && e.error) console.warn('[map] gl error', e.error.message || e.error);
    });

    // Keep state center/zoom mirrored so nav logic stays consistent.
    map.on('moveend', function () {
      var c = map.getCenter();
      state.centerLat = c.lat;
      state.centerLon = c.lng;
      state.zoom = map.getZoom();
    });

    function panByPixels(dx, dy) {
      state.followUser = false;
      map.panBy([dx, dy], { duration: 130 });
    }
    function zoom(delta) {
      map.zoomTo(clampZoom(map.getZoom() + delta), { duration: 160 });
    }
    function recenter() {
      if (state.userLat === null) return;
      state.followUser = true;
      map.easeTo({ center: [state.userLon, state.userLat], duration: 260 });
    }
    function followIfNeeded() {
      if (state.followUser && state.userLat !== null) {
        map.easeTo({ center: [state.userLon, state.userLat], duration: 220 });
      }
    }
    function refreshUser() {
      if (!ready || !userMarker) return;
      if (state.userLat === null) { userMarker.remove(); return; }
      userMarker.setLngLat([state.userLon, state.userLat]).addTo(map);
      if (userWedgeEl) {
        if (state.heading !== null && !isNaN(state.heading)) {
          userWedgeEl.style.opacity = '1';
          userWedgeEl.style.transform = 'translate(-50%, -100%) rotate(' + state.heading + 'deg)';
        } else {
          userWedgeEl.style.opacity = '0';
        }
      }
      followIfNeeded();
    }
    function refreshDestination() {
      if (!ready || !destMarker) return;
      if (!state.destination) { destMarker.remove(); return; }
      destMarker.setLngLat([state.destination.lon, state.destination.lat]).addTo(map);
    }
    function refreshRoute() {
      if (!ready || !map.getSource('route')) return;
      var coords = (state.route && state.route.coords) ? state.route.coords : [];
      map.getSource('route').setData({
        type: 'Feature', geometry: { type: 'LineString', coordinates: coords },
      });
    }
    function resize() {
      if (ready) map.resize(); else pendingResize = true;
    }

    return {
      kind: 'gl',
      panByPixels: panByPixels,
      zoom: zoom,
      recenter: recenter,
      refreshUser: refreshUser,
      refreshDestination: refreshDestination,
      refreshRoute: refreshRoute,
      resize: resize,
    };
  }

  /* ============================================================
   * 2D engine (canvas raster fallback)
   * ========================================================== */
  function createCanvasMapView() {
    var canvas = document.getElementById('map-canvas');
    canvas.classList.remove('hidden');
    var ctx = canvas.getContext('2d');
    var tileCache = {};
    var pendingTiles = {};
    var renderScheduled = false;

    function resizeCanvas() {
      var wrapper = canvas.parentElement;
      var rect = wrapper.getBoundingClientRect();
      var w = Math.floor(rect.width);
      var h = Math.floor(rect.height);
      if (w > 0 && h > 0 && (canvas.width !== w || canvas.height !== h)) {
        canvas.width = w;
        canvas.height = h;
      }
    }

    function tileKey(z, x, y) { return z + '/' + x + '/' + y; }

    function loadTile(z, x, y) {
      var maxTile = Math.pow(2, z) - 1;
      if (x < 0 || y < 0 || x > maxTile || y > maxTile) return null;
      var key = tileKey(z, x, y);
      if (tileCache[key]) return tileCache[key];
      if (pendingTiles[key]) return null;
      pendingTiles[key] = true;
      var img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function () { tileCache[key] = img; delete pendingTiles[key]; scheduleRender(); };
      img.onerror = function () { delete pendingTiles[key]; };
      img.src = RASTER_TILE_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y);
      return null;
    }

    function scheduleRender() {
      if (renderScheduled) return;
      renderScheduled = true;
      requestAnimationFrame(function () { renderScheduled = false; render(); });
    }

    function render() {
      if (!ctx) return;
      resizeCanvas();
      var w = canvas.width, h = canvas.height;
      var rz = Math.round(state.zoom);
      var center = latLonToWorld(state.centerLat, state.centerLon, rz);
      var topLeftX = center.x - w / 2;
      var topLeftY = center.y - h / 2;

      ctx.fillStyle = '#05060a';
      ctx.fillRect(0, 0, w, h);

      var startTileX = Math.floor(topLeftX / TILE_SIZE);
      var startTileY = Math.floor(topLeftY / TILE_SIZE);
      var endTileX = Math.floor((topLeftX + w) / TILE_SIZE);
      var endTileY = Math.floor((topLeftY + h) / TILE_SIZE);

      for (var ty = startTileY; ty <= endTileY; ty++) {
        for (var tx = startTileX; tx <= endTileX; tx++) {
          var img = loadTile(rz, tx, ty);
          if (img) {
            ctx.drawImage(img, tx * TILE_SIZE - topLeftX, ty * TILE_SIZE - topLeftY, TILE_SIZE, TILE_SIZE);
          }
        }
      }

      if (state.route && state.route.coords && state.route.coords.length > 1) {
        ctx.beginPath();
        for (var i = 0; i < state.route.coords.length; i++) {
          var c = state.route.coords[i];
          var pw = latLonToWorld(c[1], c[0], rz);
          var px = pw.x - topLeftX, py = pw.y - topLeftY;
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.strokeStyle = 'rgba(0, 212, 255, 0.45)'; ctx.lineWidth = 9; ctx.stroke();
        ctx.strokeStyle = '#00d4ff'; ctx.lineWidth = 5; ctx.stroke();
      }

      if (state.destination) {
        var dWorld = latLonToWorld(state.destination.lat, state.destination.lon, rz);
        var dx = dWorld.x - topLeftX, dy = dWorld.y - topLeftY;
        ctx.beginPath(); ctx.arc(dx, dy - 4, 9, 0, Math.PI * 2);
        ctx.fillStyle = '#ff4466'; ctx.fill();
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.stroke();
        ctx.beginPath(); ctx.moveTo(dx - 7, dy); ctx.lineTo(dx, dy + 11); ctx.lineTo(dx + 7, dy);
        ctx.closePath(); ctx.fillStyle = '#ff4466'; ctx.fill();
      }

      if (state.userLat !== null && state.userLon !== null) {
        var userWorld = latLonToWorld(state.userLat, state.userLon, rz);
        var ux = userWorld.x - topLeftX, uy = userWorld.y - topLeftY;
        ctx.beginPath(); ctx.arc(ux, uy, 14, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0, 212, 255, 0.25)'; ctx.fill();
        ctx.beginPath(); ctx.arc(ux, uy, 8, 0, Math.PI * 2);
        ctx.fillStyle = '#00d4ff'; ctx.fill();
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.stroke();
        if (state.heading !== null && !isNaN(state.heading)) {
          var rad = (state.heading - 90) * Math.PI / 180;
          ctx.beginPath(); ctx.moveTo(ux, uy);
          ctx.lineTo(ux + Math.cos(rad) * 18, uy + Math.sin(rad) * 18);
          ctx.strokeStyle = '#00ff88'; ctx.lineWidth = 3; ctx.stroke();
        }
      }
    }

    function panByPixels(dx, dy) {
      state.followUser = false;
      var rz = Math.round(state.zoom);
      var center = latLonToWorld(state.centerLat, state.centerLon, rz);
      var np = worldToLatLon(center.x + dx, center.y + dy, rz);
      state.centerLat = np.lat; state.centerLon = np.lon;
      scheduleRender();
    }
    function zoom(delta) {
      var nz = clampZoom(Math.round(state.zoom) + (delta > 0 ? 1 : -1));
      if (nz === state.zoom) return;
      state.zoom = nz; scheduleRender();
    }
    function recenter() {
      if (state.userLat === null) return;
      state.followUser = true;
      state.centerLat = state.userLat; state.centerLon = state.userLon;
      scheduleRender();
    }

    scheduleRender();

    return {
      kind: 'canvas',
      panByPixels: panByPixels,
      zoom: zoom,
      recenter: recenter,
      refreshUser: function () {
        if (state.followUser && state.userLat !== null) {
          state.centerLat = state.userLat; state.centerLon = state.userLon;
        }
        scheduleRender();
      },
      refreshDestination: scheduleRender,
      refreshRoute: scheduleRender,
      resize: function () { resizeCanvas(); scheduleRender(); },
    };
  }

  /* ============================================================
   * Screen navigation
   * ========================================================== */
  function collectScreens() {
    document.querySelectorAll('.screen').forEach(function (s) {
      if (s.id) screens[s.id] = s;
    });
  }
  function navigateTo(screenId, options) {
    options = options || {};
    if (options.addToHistory !== false && state.currentScreen) {
      state.screenHistory.push(state.currentScreen);
    }
    Object.values(screens).forEach(function (s) { s.classList.add('hidden'); });
    if (screens[screenId]) {
      screens[screenId].classList.remove('hidden');
      state.currentScreen = screenId;
      if (screenId === 'details-screen') updateDetailsScreen();
      if (screenId === 'map-screen' && Map) {
        setTimeout(function () { Map.resize(); }, 30);
      }
      focusFirst(screens[screenId]);
    }
  }
  function navigateBack() {
    if (state.screenHistory.length > 0) {
      var prev = state.screenHistory.pop();
      Object.values(screens).forEach(function (s) { s.classList.add('hidden'); });
      screens[prev].classList.remove('hidden');
      state.currentScreen = prev;
      if (prev === 'map-screen' && Map) setTimeout(function () { Map.resize(); }, 30);
      focusFirst(screens[prev]);
    }
  }
  function focusFirst(container) {
    var el = container.querySelector('.focusable:not([disabled]):not(.hidden)');
    if (el) el.focus();
  }
  function isVisible(el) {
    return !!(el && el.offsetParent !== null && !el.classList.contains('hidden'));
  }
  function activeFocusable() {
    var ae = document.activeElement;
    if (ae && ae.classList && ae.classList.contains('focusable') && isVisible(ae)) return ae;
    var container = screens[state.currentScreen];
    if (!container) return null;
    if (lastFocused && container.contains(lastFocused) && isVisible(lastFocused)) {
      lastFocused.focus(); return lastFocused;
    }
    var first = container.querySelector('.focusable:not([disabled]):not(.hidden)');
    if (first) first.focus();
    return first;
  }
  function moveFocus(direction) {
    var container = screens[state.currentScreen];
    if (!container) return;
    var focusables = Array.from(container.querySelectorAll('.focusable:not([disabled]):not(.hidden)'));
    if (focusables.length === 0) return;
    var current = document.activeElement;
    var idx = focusables.indexOf(current);
    if (idx === -1) { focusFirst(container); return; }
    var nextIdx;
    if (direction === 'up' || direction === 'left') nextIdx = idx > 0 ? idx - 1 : focusables.length - 1;
    else nextIdx = idx < focusables.length - 1 ? idx + 1 : 0;
    focusables[nextIdx].focus();
  }

  /* ============================================================
   * Status / details
   * ========================================================== */
  function formatCoord(value, digits) { return value === null ? '—' : value.toFixed(digits); }
  function updateCoordsBar() {
    if (state.userLat === null) { coordsBar.textContent = 'Waiting for GPS…'; return; }
    var acc = state.accuracy ? ' ±' + Math.round(state.accuracy) + 'm' : '';
    coordsBar.textContent = formatCoord(state.userLat, 5) + ', ' + formatCoord(state.userLon, 5) + acc;
  }
  function updateGpsStatus(text) {
    gpsStatus.textContent = text + ' · ' + state.engine;
  }
  function updateDetailsScreen() {
    placeNameEl.textContent = state.placeName || 'Unknown location';
    detailLat.textContent = formatCoord(state.userLat, 6) + '°';
    detailLon.textContent = formatCoord(state.userLon, 6) + '°';
    detailAccuracy.textContent = state.accuracy ? Math.round(state.accuracy) + ' m' : '—';
    detailHeading.textContent = (state.heading !== null && !isNaN(state.heading))
      ? Math.round(state.heading) + '°' : '—';
  }

  function reverseGeocode(lat, lon) {
    var now = Date.now();
    if (now - state.lastNominatimRequest < 1100) return;
    state.lastNominatimRequest = now;
    var url = NOMINATIM_URL + '?format=json&lat=' + lat + '&lon=' + lon + '&zoom=16&addressdetails=1';
    fetch(url, { headers: { 'Accept': 'application/json' } })
      .then(function (res) { if (!res.ok) throw new Error('Geocode failed'); return res.json(); })
      .then(function (data) {
        state.placeName = data.display_name || null;
        if (state.currentScreen === 'details-screen') updateDetailsScreen();
      })
      .catch(function () {});
  }

  /* ============================================================
   * Geolocation
   * ========================================================== */
  function onLocationUpdate(pos) {
    var coords = pos.coords;
    state.userLat = coords.latitude;
    state.userLon = coords.longitude;
    state.accuracy = coords.accuracy;
    state.heading = coords.heading;
    if (state.followUser) { state.centerLat = coords.latitude; state.centerLon = coords.longitude; }
    updateCoordsBar();
    updateGpsStatus('Live');
    reverseGeocode(coords.latitude, coords.longitude);
    if (Map) Map.refreshUser();
    if (state.routeActive) updateNavigation();
    if (screens['error-screen'] && !screens['error-screen'].classList.contains('hidden')) {
      navigateTo('map-screen', { addToHistory: false });
      state.screenHistory = [];
    }
  }
  function onLocationError(err) {
    var msg = 'Location unavailable';
    if (err.code === 1) msg = 'Location permission denied';
    else if (err.code === 2) msg = 'Position unavailable';
    else if (err.code === 3) msg = 'Location request timed out';
    updateGpsStatus('Error');
    errorMessage.textContent = msg;
    navigateTo('error-screen', { addToHistory: false });
    state.screenHistory = [];
  }
  function startGeolocation() {
    if (!navigator.geolocation) {
      errorMessage.textContent = 'Geolocation not supported';
      navigateTo('error-screen', { addToHistory: false });
      return;
    }
    if (state.geoWatchId !== null) navigator.geolocation.clearWatch(state.geoWatchId);
    updateGpsStatus('Locating…');
    state.geoWatchId = navigator.geolocation.watchPosition(
      onLocationUpdate, onLocationError,
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );
  }

  /* ============================================================
   * Formatting + speech
   * ========================================================== */
  function formatDistance(m) {
    if (m == null) return '—';
    if (m < 1000) return Math.round(m) + ' m';
    return (m / 1000).toFixed(m < 10000 ? 1 : 0) + ' km';
  }
  function formatDuration(s) {
    var min = Math.round(s / 60);
    if (min < 60) return min + ' min';
    return Math.floor(min / 60) + 'h ' + (min % 60) + 'm';
  }
  function speak(text) {
    if (!('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text);
      u.rate = 1.0; u.lang = 'en-US';
      window.speechSynthesis.speak(u);
    } catch (e) {}
  }

  /* ============================================================
   * Destination entry (on-screen D-pad keyboard)
   * ========================================================== */
  function setSearchStatus(msg) { if (typeStatus) typeStatus.textContent = msg; }
  function keyLabel(k) {
    if (k === 'SPACE') return 'space';
    if (k === 'DEL') return '\u232B';
    if (k === 'GO') return 'Go';
    return k;
  }
  function buildKeyboard() {
    if (!keyboardEl || keyboardEl.childElementCount) return;
    KEY_ROWS.forEach(function (row, r) {
      var rowEl = document.createElement('div');
      rowEl.className = 'kb-row';
      row.forEach(function (k, c) {
        var b = document.createElement('button');
        b.className = 'kb-key focusable';
        if (k === 'GO') b.classList.add('primary');
        if (k === 'SPACE') b.classList.add('kb-space');
        b.dataset.key = k; b.dataset.r = r; b.dataset.c = c;
        b.textContent = keyLabel(k);
        rowEl.appendChild(b);
      });
      keyboardEl.appendChild(rowEl);
    });
    keyboardEl.addEventListener('click', function (e) {
      var keyEl = e.target.closest('.kb-key');
      if (keyEl) handleKey(keyEl.dataset.key);
    });
  }
  function focusKey(r, c) {
    r = Math.max(0, Math.min(KEY_ROWS.length - 1, r));
    c = Math.max(0, Math.min(KEY_ROWS[r].length - 1, c));
    kbFocus = { r: r, c: c };
    var el = keyboardEl.querySelector('[data-r="' + r + '"][data-c="' + c + '"]');
    if (el) el.focus();
  }
  function keyboardNav(dir) {
    var active = document.activeElement;
    if (active && active.classList.contains('kb-key')) {
      kbFocus = { r: parseInt(active.dataset.r, 10), c: parseInt(active.dataset.c, 10) };
    }
    var r = kbFocus.r, c = kbFocus.c;
    if (dir === 'up') r--; else if (dir === 'down') r++;
    else if (dir === 'left') c--; else if (dir === 'right') c++;
    if (r < 0) r = KEY_ROWS.length - 1;
    if (r > KEY_ROWS.length - 1) r = 0;
    var len = KEY_ROWS[r].length;
    if (c < 0) c = len - 1;
    if (c > len - 1) c = 0;
    focusKey(r, c);
  }
  function renderTypedQuery() { if (typeQueryEl) typeQueryEl.textContent = typedQuery; }
  function handleKey(k) {
    switch (k) {
      case 'GO': submitSearch(); return;
      case 'DEL': typedQuery = typedQuery.slice(0, -1); break;
      case 'SPACE': if (typedQuery && typedQuery.slice(-1) !== ' ') typedQuery += ' '; break;
      default: typedQuery += k;
    }
    renderTypedQuery();
  }
  function openSearchScreen() {
    buildKeyboard();
    typedQuery = ''; renderTypedQuery(); renderRecents();
    setSearchStatus('Move with the band, tap to pick a letter, then Go');
    navigateTo('type-screen');
    var recentFirst = recentListEl && recentListEl.querySelector('.recent-chip');
    if (recentFirst) recentFirst.focus(); else focusKey(1, 0);
  }
  function submitSearch() {
    var q = typedQuery.trim();
    if (!q) { setSearchStatus('Type a place first'); return; }
    setSearchStatus('Searching for \u201C' + q + '\u201D\u2026');
    findDestination(q);
  }

  /* ============================================================
   * Recents
   * ========================================================== */
  function loadRecents() {
    try {
      var raw = localStorage.getItem(RECENTS_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function saveRecent(place) {
    if (!place || place.lat == null || place.lon == null) return;
    try {
      var list = loadRecents().filter(function (p) {
        return !(Math.abs(p.lat - place.lat) < 1e-5 && Math.abs(p.lon - place.lon) < 1e-5);
      });
      list.unshift({ lat: place.lat, lon: place.lon, name: place.name });
      localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, 6)));
    } catch (e) {}
  }
  function shortName(name) { return (name || 'Destination').split(',').slice(0, 2).join(','); }
  function moveChip(delta) {
    if (!recentListEl) return;
    var chips = Array.prototype.slice.call(recentListEl.querySelectorAll('.recent-chip'));
    if (!chips.length) return;
    var idx = chips.indexOf(document.activeElement);
    if (idx === -1) { chips[0].focus(); return; }
    chips[(idx + delta + chips.length) % chips.length].focus();
  }
  function renderRecents() {
    if (!recentListEl) return;
    var list = loadRecents();
    recentListEl.innerHTML = '';
    if (!list.length) { recentListEl.classList.add('hidden'); return; }
    recentListEl.classList.remove('hidden');
    list.forEach(function (p, i) {
      var chip = document.createElement('button');
      chip.className = 'recent-chip focusable';
      chip.dataset.recent = i;
      chip.textContent = shortName(p.name);
      recentListEl.appendChild(chip);
    });
    if (!recentListEl._wired) {
      recentListEl.addEventListener('click', function (e) {
        var chip = e.target.closest('.recent-chip');
        if (!chip) return;
        var p = loadRecents()[parseInt(chip.dataset.recent, 10)];
        if (p) { setSearchStatus('Planning route\u2026'); applyDestination(p); }
      });
      recentListEl._wired = true;
    }
  }

  /* ============================================================
   * Geocoding
   * ========================================================== */
  function biasParams() {
    if (state.userLat !== null && state.userLon !== null) {
      return '&lat=' + state.userLat + '&lon=' + state.userLon;
    }
    return '';
  }
  function applyDestination(place) {
    state.destination = place;
    saveRecent(place);
    if (Map) Map.refreshDestination();
    setSearchStatus('Planning route\u2026');
    fetchRoute();
  }
  function findDestination(query) {
    setSearchStatus('Searching\u2026');
    geocodePhoton(query)
      .then(function (place) {
        if (place) { applyDestination(place); return; }
        return geocodeNominatim(query).then(function (p2) {
          if (p2) applyDestination(p2); else notFound(query);
        });
      })
      .catch(function () {
        geocodeNominatim(query)
          .then(function (p2) { if (p2) applyDestination(p2); else notFound(query); })
          .catch(function () { setSearchStatus('Search failed — check connection'); });
      });
  }
  function notFound(query) {
    setSearchStatus('Couldn\u2019t find \u201C' + query + '\u201D');
    speak('Sorry, I could not find ' + query);
  }
  function geocodePhoton(query) {
    var url = PHOTON_URL + '?limit=1&q=' + encodeURIComponent(query) + biasParams();
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error('photon ' + res.status);
      return res.json();
    }).then(function (data) {
      if (!data || !data.features || !data.features.length) return null;
      var f = data.features[0];
      var c = f.geometry && f.geometry.coordinates;
      if (!c) return null;
      return { lat: c[1], lon: c[0], name: photonName(f.properties) };
    });
  }
  function photonName(p) {
    if (!p) return 'Destination';
    var parts = [];
    if (p.name) parts.push(p.name);
    else if (p.street) parts.push(p.street + (p.housenumber ? ' ' + p.housenumber : ''));
    if (p.city) parts.push(p.city); else if (p.state) parts.push(p.state);
    if (p.country) parts.push(p.country);
    return parts.join(', ') || 'Destination';
  }
  function geocodeNominatim(query) {
    var url = NOMINATIM_SEARCH_URL + '?format=json&limit=1&q=' + encodeURIComponent(query);
    return fetch(url, { headers: { 'Accept': 'application/json' } })
      .then(function (res) { if (!res.ok) throw new Error('nominatim ' + res.status); return res.json(); })
      .then(function (results) {
        if (!results || !results.length) return null;
        var r = results[0];
        return { lat: parseFloat(r.lat), lon: parseFloat(r.lon), name: r.display_name || query };
      });
  }

  /* ============================================================
   * Walking route
   * ========================================================== */
  function fetchRoute(silent) {
    if (!state.destination) return;
    if (state.userLat === null) { setSearchStatus('Waiting for your location\u2026'); return; }
    var coords = state.userLon + ',' + state.userLat + ';' +
      state.destination.lon + ',' + state.destination.lat;
    var url = OSRM_FOOT_URL + coords + '?overview=full&geometries=geojson&steps=true&annotations=false';
    fetch(url)
      .then(function (res) { if (!res.ok) throw new Error('Routing failed'); return res.json(); })
      .then(function (data) {
        if (data.code !== 'Ok' || !data.routes || !data.routes.length) throw new Error('No route');
        var r = data.routes[0];
        var steps = [];
        r.legs.forEach(function (leg) {
          leg.steps.forEach(function (s) {
            steps.push({
              text: instructionText(s.maneuver, s.name),
              icon: maneuverIcon(s.maneuver),
              distance: s.distance,
              loc: s.maneuver.location,
            });
          });
        });
        state.route = { coords: r.geometry.coordinates, steps: steps, distance: r.distance, duration: r.duration };
        state.currentStepIndex = 0;
        state.arrived = false;
        if (Map) Map.refreshRoute();
        renderRouteScreen();
        if (silent) { updateNavBanner(); }
        else { navigateTo('route-screen'); }
      })
      .catch(function () {
        if (silent) { state.rerouting = false; return; }
        setSearchStatus('Couldn\u2019t plan a walking route');
        speak('Sorry, I could not plan a route there');
      });
  }
  function maneuverIcon(m) {
    var type = m.type, mod = m.modifier || '';
    if (type === 'arrive') return '🏁';
    if (type === 'depart') return '↑';
    if (type === 'roundabout' || type === 'rotary') return '↻';
    if (mod.indexOf('left') !== -1) return mod.indexOf('slight') !== -1 ? '↖' : '←';
    if (mod.indexOf('right') !== -1) return mod.indexOf('slight') !== -1 ? '↗' : '→';
    if (mod === 'uturn') return '↩';
    return '↑';
  }
  function instructionText(m, name) {
    var type = m.type, mod = m.modifier;
    var on = name ? (' onto ' + name) : '';
    var along = name ? (' on ' + name) : '';
    switch (type) {
      case 'depart': return 'Head off' + along;
      case 'turn': return 'Turn ' + (mod || 'ahead') + on;
      case 'new name': return 'Continue' + along;
      case 'continue': return 'Continue ' + (mod || 'straight') + along;
      case 'merge': return 'Merge' + on;
      case 'fork': return 'Keep ' + (mod || 'straight') + on;
      case 'end of road': return 'Turn ' + (mod || 'ahead') + on;
      case 'roundabout':
      case 'rotary': return 'Take the roundabout' + (m.exit ? ', exit ' + m.exit : '') + on;
      case 'arrive': return 'Arrive at your destination';
      default:
        return (type ? type.charAt(0).toUpperCase() + type.slice(1) : 'Continue') +
          (mod ? ' ' + mod : '') + on;
    }
  }
  function renderRouteScreen() {
    if (!state.route) return;
    routeDestName.textContent = state.destination
      ? state.destination.name.split(',').slice(0, 2).join(',') : '—';
    routeSummary.textContent = formatDistance(state.route.distance) + ' · ' + formatDuration(state.route.duration);
    stepsList.innerHTML = '';
    state.route.steps.forEach(function (step, i) {
      var item = document.createElement('div');
      item.className = 'step-item';
      if (state.routeActive && i < state.currentStepIndex) item.classList.add('done');
      if (state.routeActive && i === state.currentStepIndex) item.classList.add('active');
      item.innerHTML =
        '<div class="step-icon">' + step.icon + '</div>' +
        '<div class="step-body"><div class="step-text"></div>' +
        '<div class="step-dist">' + formatDistance(step.distance) + '</div></div>';
      item.querySelector('.step-text').textContent = step.text;
      stepsList.appendChild(item);
    });
  }

  /* ============================================================
   * Live navigation
   * ========================================================== */
  function startNavigation() {
    if (!state.route) return;
    state.routeActive = true; state.arrived = false; state.currentStepIndex = 0;
    state.followUser = true;
    navBanner.classList.remove('hidden');
    navigateTo('map-screen', { addToHistory: false });
    state.screenHistory = [];
    if (Map) Map.recenter();
    updateNavigation();
    var first = state.route.steps[0];
    if (first) speak(first.text);
  }
  function endNavigation(silent) {
    state.routeActive = false; state.route = null; state.destination = null;
    state.arrived = false; state.currentStepIndex = 0;
    if (navBanner) navBanner.classList.add('hidden');
    if (Map) { Map.refreshRoute(); Map.refreshDestination(); }
    if (!silent) speak('Navigation ended');
  }
  function updateNavBanner() {
    if (!state.routeActive || !state.route) return;
    var steps = state.route.steps;
    var idx = Math.min(state.currentStepIndex, steps.length - 1);
    var step = steps[idx];
    if (!step) return;
    navBannerIcon.textContent = step.icon;
    navBannerInstruction.textContent = step.text;
    var distToStep = null;
    if (state.userLat !== null && step.loc) {
      distToStep = haversine(state.userLat, state.userLon, step.loc[1], step.loc[0]);
    }
    navBannerDistance.textContent = distToStep !== null
      ? 'In ' + formatDistance(distToStep) : formatDistance(step.distance);
  }
  function updateNavigation() {
    if (!state.routeActive || !state.route || state.userLat === null) return;
    var steps = state.route.steps;
    if (state.destination) {
      var distToDest = haversine(state.userLat, state.userLon, state.destination.lat, state.destination.lon);
      if (distToDest <= ARRIVE_M && !state.arrived) {
        state.arrived = true;
        state.currentStepIndex = steps.length - 1;
        navBannerIcon.textContent = '🏁';
        navBannerInstruction.textContent = 'You have arrived';
        navBannerDistance.textContent = state.destination.name.split(',')[0];
        speak('You have arrived at your destination');
        renderRouteScreen();
        return;
      }
    }
    var advanced = false;
    while (state.currentStepIndex < steps.length - 1) {
      var step = steps[state.currentStepIndex];
      if (!step.loc) break;
      var d = haversine(state.userLat, state.userLon, step.loc[1], step.loc[0]);
      if (d <= STEP_ADVANCE_M) { state.currentStepIndex++; advanced = true; } else break;
    }
    if (advanced) {
      var ns = steps[state.currentStepIndex];
      if (ns) speak(ns.text);
      renderRouteScreen();
    }
    maybeReroute();
    updateNavBanner();
  }
  function maybeReroute() {
    if (!state.route || !state.route.coords || state.rerouting || state.arrived) return;
    var now = Date.now();
    if (now - state.lastRerouteAt < 8000) return;
    var minDist = Infinity, coords = state.route.coords;
    for (var i = 0; i < coords.length; i++) {
      var d = haversine(state.userLat, state.userLon, coords[i][1], coords[i][0]);
      if (d < minDist) minDist = d;
    }
    if (minDist > REROUTE_M) {
      state.rerouting = true; state.lastRerouteAt = now;
      navBannerDistance.textContent = 'Rerouting…';
      fetchRoute(true);
      setTimeout(function () { state.rerouting = false; }, 1000);
    }
  }

  /* ============================================================
   * Actions + events
   * ========================================================== */
  function handleAction(action) {
    switch (action) {
      case 'back': navigateBack(); break;
      case 'zoom-in': if (Map) Map.zoom(1); break;
      case 'zoom-out': if (Map) Map.zoom(-1); break;
      case 'recenter': if (Map) Map.recenter(); break;
      case 'details': navigateTo('details-screen'); break;
      case 'type': openSearchScreen(); break;
      case 'start-route': startNavigation(); break;
      case 'route-steps': renderRouteScreen(); navigateTo('route-screen'); break;
      case 'end-route':
        endNavigation();
        navigateTo('map-screen', { addToHistory: false });
        state.screenHistory = [];
        break;
      case 'refresh-location':
      case 'retry-location':
        startGeolocation();
        if (action === 'retry-location') {
          navigateTo('map-screen', { addToHistory: false });
          state.screenHistory = [];
        }
        break;
    }
  }

  function setPanMode(on) {
    state.panMode = !!on;
    if (mapFocusEl) mapFocusEl.classList.toggle('pan-mode', state.panMode);
  }

  function setupEvents() {
    document.addEventListener('click', function (e) {
      var actionEl = e.target.closest('[data-action]');
      if (actionEl && actionEl.dataset.action !== 'map-focus') handleAction(actionEl.dataset.action);
    });

    document.addEventListener('focusin', function (e) {
      if (e.target && e.target.classList && e.target.classList.contains('focusable')) lastFocused = e.target;
    });
    document.addEventListener('focusout', function () {
      setTimeout(function () {
        var ae = document.activeElement;
        if (ae && ae.classList && ae.classList.contains('focusable')) return;
        var container = screens[state.currentScreen];
        if (!container) return;
        if (lastFocused && container.contains(lastFocused) && isVisible(lastFocused)) lastFocused.focus();
        else focusFirst(container);
      }, 0);
    });

    if (mapFocusEl) {
      mapFocusEl.addEventListener('focus', function () { state.mapFocused = true; });
      mapFocusEl.addEventListener('blur', function () { state.mapFocused = false; setPanMode(false); });
    }

    document.addEventListener('keydown', function (e) {
      if (state.panMode && state.currentScreen === 'map-screen' && state.mapFocused) {
        switch (e.key) {
          case 'ArrowUp': if (Map) Map.panByPixels(0, -PAN_STEP); e.preventDefault(); return;
          case 'ArrowDown': if (Map) Map.panByPixels(0, PAN_STEP); e.preventDefault(); return;
          case 'ArrowLeft': if (Map) Map.panByPixels(-PAN_STEP, 0); e.preventDefault(); return;
          case 'ArrowRight': if (Map) Map.panByPixels(PAN_STEP, 0); e.preventDefault(); return;
          case 'Enter':
          case 'Escape': setPanMode(false); e.preventDefault(); return;
        }
      }

      if (state.currentScreen === 'type-screen' && document.activeElement &&
          document.activeElement.classList.contains('recent-chip')) {
        switch (e.key) {
          case 'ArrowLeft': moveChip(-1); e.preventDefault(); return;
          case 'ArrowRight': moveChip(1); e.preventDefault(); return;
          case 'ArrowDown': focusKey(0, 0); e.preventDefault(); return;
          case 'ArrowUp': e.preventDefault(); return;
        }
      }

      if (state.currentScreen === 'type-screen' && document.activeElement &&
          document.activeElement.classList.contains('kb-key')) {
        switch (e.key) {
          case 'ArrowUp':
            if (kbFocus.r === 0 && recentListEl && !recentListEl.classList.contains('hidden')) {
              var chip = recentListEl.querySelector('.recent-chip');
              if (chip) { chip.focus(); e.preventDefault(); return; }
            }
            keyboardNav('up'); e.preventDefault(); return;
          case 'ArrowDown': keyboardNav('down'); e.preventDefault(); return;
          case 'ArrowLeft': keyboardNav('left'); e.preventDefault(); return;
          case 'ArrowRight': keyboardNav('right'); e.preventDefault(); return;
        }
      }

      switch (e.key) {
        case 'ArrowUp': moveFocus('up'); e.preventDefault(); break;
        case 'ArrowDown': moveFocus('down'); e.preventDefault(); break;
        case 'ArrowLeft': moveFocus('left'); e.preventDefault(); break;
        case 'ArrowRight': moveFocus('right'); e.preventDefault(); break;
        case 'Enter':
          var target = activeFocusable();
          if (target === mapFocusEl) setPanMode(!state.panMode);
          else if (target) target.click();
          e.preventDefault();
          break;
        case 'Escape': navigateBack(); e.preventDefault(); break;
      }
    });

    window.addEventListener('resize', function () { if (Map) Map.resize(); });
  }

  /* ============================================================
   * Service worker (offline tiles + app shell)
   * ========================================================== */
  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }

  /* ============================================================
   * Init
   * ========================================================== */
  function init() {
    collectScreens();
    mapFocusEl = document.getElementById('map-focus');
    gpsStatus = document.getElementById('gps-status');
    coordsBar = document.getElementById('coords-bar');
    placeNameEl = document.getElementById('place-name');
    detailLat = document.getElementById('detail-lat');
    detailLon = document.getElementById('detail-lon');
    detailAccuracy = document.getElementById('detail-accuracy');
    detailHeading = document.getElementById('detail-heading');
    errorMessage = document.getElementById('error-message');
    navBanner = document.getElementById('nav-banner');
    navBannerIcon = document.getElementById('nav-banner-icon');
    navBannerInstruction = document.getElementById('nav-banner-instruction');
    navBannerDistance = document.getElementById('nav-banner-distance');
    routeSummary = document.getElementById('route-summary');
    routeDestName = document.getElementById('route-dest-name');
    stepsList = document.getElementById('steps-list');
    keyboardEl = document.getElementById('keyboard');
    typeQueryEl = document.getElementById('type-query');
    recentListEl = document.getElementById('recent-list');
    typeStatus = document.getElementById('type-status');
    attributionEl = document.getElementById('map-attribution');

    // Pick the rendering engine. Vector (WebGL) preferred; canvas raster fallback.
    var useGL = detectWebGL();
    if (useGL) {
      try {
        Map = createGLMapView();
        state.engine = 'Vector';
        if (attributionEl) attributionEl.textContent = '© OpenStreetMap · OpenFreeMap';
      } catch (e) {
        console.warn('[map] WebGL init failed, using 2D fallback:', e && e.message);
        Map = null;
      }
    }
    if (!Map) {
      Map = createCanvasMapView();
      state.engine = '2D';
      if (attributionEl) attributionEl.textContent = '© OpenStreetMap · CARTO';
    }
    console.log('[map] rendering engine =', state.engine, '(WebGL ' + (useGL ? 'available' : 'unavailable') + ')');

    setupEvents();
    startGeolocation();
    updateGpsStatus('Locating…');

    setTimeout(function () {
      if (Map) Map.resize();
      focusFirst(screens['map-screen']);
    }, 120);
  }

  registerServiceWorker();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
