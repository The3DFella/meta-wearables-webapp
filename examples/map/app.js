(function () {
  'use strict';

  /* ============================================================
   * Config
   * ========================================================== */
  var TILE_SIZE = 256;
  // Dark raster tiles (CARTO, no key) used by the 2D canvas fallback engine.
  var RASTER_TILE_URL = 'https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png';
  // Local MapLibre vector style (OpenFreeMap source, no key).
  var GL_STYLE_URL = 'ofm-dark.json';

  var MIN_ZOOM = 3;
  var MAX_ZOOM = 19;
  var PAN_STEP = 64;            // pixels per D-pad pan press

  // Teammate simulation.
  var MATE_COUNT = 5;
  var MATE_MIN_M = 20;         // closest spawn distance from you
  var MATE_MAX_M = 100;        // farthest spawn distance from you
  var MATE_LEASH_M = 130;      // wander no farther than this from spawn centre
  var WALK_SPEED = 1.4;        // metres per second (~5 km/h)
  var TICK_MS = 1000;          // movement update interval
  var EARTH_M_PER_DEG = 111320;

  var state = {
    currentScreen: 'map-screen',
    zoom: 17,
    centerLat: 37.7749,
    centerLon: -122.4194,
    userLat: null,
    userLon: null,
    accuracy: null,
    heading: null,
    followUser: true,
    geoWatchId: null,
    mapFocused: false,
    panMode: false,
    engine: '2D',
    mates: [],
    mateCenter: null,
    demo: false,
    demoTimer: null,
  };

  var screens = {};
  var Map = null;
  var mapFocusEl, gpsStatus, coordsBar, errorMessage, attributionEl;
  var lastFocused = null;
  var moveTimer = null;

  /* ============================================================
   * Geometry helpers
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

  // Offset a lat/lon by `dist` metres along `heading` (radians, 0 = north, CW).
  function offsetMeters(lat, lon, dist, heading) {
    var dNorth = dist * Math.cos(heading);
    var dEast = dist * Math.sin(heading);
    var newLat = lat + dNorth / EARTH_M_PER_DEG;
    var cosLat = Math.cos(lat * Math.PI / 180) || 1e-6;
    var newLon = lon + dEast / (EARTH_M_PER_DEG * cosLat);
    return { lat: newLat, lon: newLon };
  }
  // Bearing (radians, 0 = north, CW) from point 1 to point 2.
  function bearingTo(lat1, lon1, lat2, lon2) {
    var cosLat = Math.cos(lat1 * Math.PI / 180) || 1e-6;
    var dEast = (lon2 - lon1) * cosLat * EARTH_M_PER_DEG;
    var dNorth = (lat2 - lat1) * EARTH_M_PER_DEG;
    return Math.atan2(dEast, dNorth);
  }

  /* ============================================================
   * Teammates (dumb random-walk simulation)
   * ========================================================== */
  function randomName() {
    var L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    var s = '';
    for (var i = 0; i < 3; i++) s += L[Math.floor(Math.random() * L.length)];
    return s;
  }
  function spawnMates(lat, lon) {
    state.mateCenter = { lat: lat, lon: lon };
    state.mates = [];
    for (var i = 0; i < MATE_COUNT; i++) {
      var heading = Math.random() * Math.PI * 2;
      var dist = MATE_MIN_M + Math.random() * (MATE_MAX_M - MATE_MIN_M);
      var p = offsetMeters(lat, lon, dist, heading);
      state.mates.push({
        name: randomName(),
        lat: p.lat,
        lon: p.lon,
        heading: Math.random() * Math.PI * 2,
        marker: null,
        labelEl: null,
      });
    }
    if (Map) Map.refreshMates();
  }
  function stepMates(dt) {
    if (!state.mates.length || !state.mateCenter) return;
    var c = state.mateCenter;
    for (var i = 0; i < state.mates.length; i++) {
      var m = state.mates[i];
      // If wandered too far, steer back toward the spawn centre.
      var fromCenter = haversine(c.lat, c.lon, m.lat, m.lon);
      if (fromCenter > MATE_LEASH_M) {
        m.heading = bearingTo(m.lat, m.lon, c.lat, c.lon);
      } else {
        // Small random jitter so paths look organic.
        m.heading += (Math.random() - 0.5) * 0.8;
      }
      var p = offsetMeters(m.lat, m.lon, WALK_SPEED * dt, m.heading);
      m.lat = p.lat;
      m.lon = p.lon;
    }
    if (Map) Map.refreshMates();
  }
  function startMovement() {
    stopMovement();
    moveTimer = setInterval(function () { stepMates(TICK_MS / 1000); }, TICK_MS);
  }
  function stopMovement() {
    if (moveTimer) { clearInterval(moveTimer); moveTimer = null; }
  }

  /* ============================================================
   * WebGL capability detection
   * ========================================================== */
  function detectWebGL() {
    try {
      if (typeof maplibregl === 'undefined') return false;
      var c = document.createElement('canvas');
      var gl = c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl');
      return !!gl;
    } catch (e) {
      return false;
    }
  }

  /* ============================================================
   * GL engine (MapLibre vector tiles)
   * ========================================================== */
  function createGLMapView() {
    var map, userMarker, userWedgeEl, ready = false, pendingResize = false;

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
    function makeMateEl(name) {
      var wrap = document.createElement('div');
      wrap.className = 'gl-mate';
      wrap.innerHTML = '<div class="gl-mate-label"></div><div class="gl-mate-dot"></div>';
      wrap.querySelector('.gl-mate-label').textContent = name;
      return wrap;
    }

    function applyAdditiveTheme() {
      try { map.setPaintProperty('background', 'background-color', '#000000'); } catch (e) {}
      var setColor = function (id, prop, val) {
        try { if (map.getLayer(id)) map.setPaintProperty(id, prop, val); } catch (e) {}
      };
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

    map = new maplibregl.Map({
      container: 'map',
      style: GL_STYLE_URL,
      center: [state.centerLon, state.centerLat],
      zoom: state.zoom,
      minZoom: 3,
      maxZoom: 19,
      attributionControl: false,
      interactive: false,
      fadeDuration: 0,
      dragRotate: false,
      pitchWithRotate: false,
      refreshExpiredTiles: false,
    });

    map.on('load', function () {
      ready = true;
      applyAdditiveTheme();
      userMarker = new maplibregl.Marker({ element: makeUserEl(), rotationAlignment: 'map' });
      refreshUser();
      refreshMates();
      if (pendingResize) { map.resize(); pendingResize = false; }
    });

    map.on('error', function (e) {
      if (e && e.error) console.warn('[map] gl error', e.error.message || e.error);
    });

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
    function refreshMates() {
      if (!ready) return;
      state.mates.forEach(function (m) {
        if (!m.marker) {
          m.marker = new maplibregl.Marker({ element: makeMateEl(m.name) });
        }
        m.marker.setLngLat([m.lon, m.lat]).addTo(map);
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
      refreshMates: refreshMates,
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

      // Teammates.
      state.mates.forEach(function (m) {
        var mWorld = latLonToWorld(m.lat, m.lon, rz);
        var mx = mWorld.x - topLeftX, my = mWorld.y - topLeftY;
        ctx.beginPath(); ctx.arc(mx, my, 7, 0, Math.PI * 2);
        ctx.fillStyle = '#00ff88'; ctx.fill();
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.stroke();
        ctx.font = '700 13px -apple-system, "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.strokeText(m.name, mx, my - 12);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(m.name, mx, my - 12);
      });

      // You.
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
      refreshMates: scheduleRender,
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
  function navigateTo(screenId) {
    Object.values(screens).forEach(function (s) { s.classList.add('hidden'); });
    if (screens[screenId]) {
      screens[screenId].classList.remove('hidden');
      state.currentScreen = screenId;
      if (screenId === 'map-screen' && Map) setTimeout(function () { Map.resize(); }, 30);
      focusFirst(screens[screenId]);
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
    var idx = focusables.indexOf(document.activeElement);
    if (idx === -1) { focusFirst(container); return; }
    var nextIdx;
    if (direction === 'up' || direction === 'left') nextIdx = idx > 0 ? idx - 1 : focusables.length - 1;
    else nextIdx = idx < focusables.length - 1 ? idx + 1 : 0;
    focusables[nextIdx].focus();
  }

  /* ============================================================
   * Status
   * ========================================================== */
  function formatCoord(value, digits) { return value === null ? '—' : value.toFixed(digits); }
  function updateCoordsBar() {
    if (state.userLat === null) { coordsBar.textContent = 'Waiting for GPS…'; return; }
    coordsBar.textContent = formatCoord(state.userLat, 5) + ', ' + formatCoord(state.userLon, 5) +
      ' · ' + state.mates.length + ' teammates nearby';
  }
  function updateGpsStatus(text) {
    gpsStatus.textContent = text + ' · ' + state.engine;
  }

  /* ============================================================
   * Geolocation
   * ========================================================== */
  function ensureMates(lat, lon, force) {
    if (force || !state.mates.length) {
      // Drop any existing GL markers before respawning.
      state.mates.forEach(function (m) { if (m.marker) m.marker.remove(); });
      spawnMates(lat, lon);
      startMovement();
    }
  }
  function onLocationUpdate(pos) {
    var coords = pos.coords;
    var wasDemo = state.demo;
    state.demo = false;
    if (state.demoTimer) { clearTimeout(state.demoTimer); state.demoTimer = null; }
    state.userLat = coords.latitude;
    state.userLon = coords.longitude;
    state.accuracy = coords.accuracy;
    state.heading = coords.heading;
    if (state.followUser) { state.centerLat = coords.latitude; state.centerLon = coords.longitude; }
    // If teammates were placed around a demo location, move the whole squad to
    // the real position once we get a genuine fix.
    ensureMates(coords.latitude, coords.longitude, wasDemo);
    if (wasDemo) { state.followUser = true; if (Map) Map.recenter(); }
    updateCoordsBar();
    updateGpsStatus('Live');
    if (Map) Map.refreshUser();
    if (screens['error-screen'] && !screens['error-screen'].classList.contains('hidden')) {
      navigateTo('map-screen');
    }
  }
  function fallbackToDemo() {
    // Only show a demo location if we never got a genuine fix. Keeps the app
    // usable on desktop / when permission is blocked, without flashing a wrong
    // spot when the phone's GPS is just slow to acquire.
    if (state.userLat !== null) return;
    state.demo = true;
    state.userLat = state.centerLat;
    state.userLon = state.centerLon;
    state.heading = null;
    state.followUser = true;
    ensureMates(state.userLat, state.userLon, true);
    updateCoordsBar();
    updateGpsStatus('Demo');
    if (Map) { Map.refreshUser(); Map.recenter(); }
  }
  function onLocationError(err) {
    if (state.userLat === null) updateGpsStatus('Locating…');
  }
  function startGeolocation() {
    if (!navigator.geolocation) { fallbackToDemo(); return; }
    if (state.geoWatchId !== null) navigator.geolocation.clearWatch(state.geoWatchId);
    if (state.demoTimer) clearTimeout(state.demoTimer);
    updateGpsStatus('Locating…');
    state.geoWatchId = navigator.geolocation.watchPosition(
      onLocationUpdate, onLocationError,
      { enableHighAccuracy: true, maximumAge: 0, timeout: 27000 }
    );
    // Give the phone up to 20s to deliver a real fix before showing demo.
    state.demoTimer = setTimeout(fallbackToDemo, 20000);
  }

  /* ============================================================
   * Actions + events
   * ========================================================== */
  function handleAction(action) {
    switch (action) {
      case 'zoom-in': if (Map) Map.zoom(1); break;
      case 'zoom-out': if (Map) Map.zoom(-1); break;
      case 'recenter': if (Map) Map.recenter(); break;
      case 'retry-location':
        startGeolocation();
        navigateTo('map-screen');
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
    errorMessage = document.getElementById('error-message');
    attributionEl = document.getElementById('map-attribution');

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
