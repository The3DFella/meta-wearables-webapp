(function () {
  'use strict';

  var TILE_SIZE = 256;
  var TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  var NOMINATIM_URL = 'https://nominatim.openstreetmap.org/reverse';
  var MIN_ZOOM = 12;
  var MAX_ZOOM = 18;
  var PAN_STEP = 48;

  var state = {
    currentScreen: 'map-screen',
    screenHistory: [],
    zoom: 16,
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
    tileCache: {},
    pendingTiles: {},
    lastNominatimRequest: 0,
    renderScheduled: false,
  };

  var screens = {};
  var canvas, ctx;
  var gpsStatus, coordsBar, placeNameEl;
  var detailLat, detailLon, detailAccuracy, detailHeading, errorMessage;

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
      focusFirst(screens[screenId]);
    }
  }

  function navigateBack() {
    if (state.screenHistory.length > 0) {
      var prev = state.screenHistory.pop();
      Object.values(screens).forEach(function (s) { s.classList.add('hidden'); });
      screens[prev].classList.remove('hidden');
      state.currentScreen = prev;
      focusFirst(screens[prev]);
    }
  }

  function focusFirst(container) {
    var el = container.querySelector('.focusable:not([disabled]):not(.hidden)');
    if (el) el.focus();
  }

  function moveFocus(direction) {
    var container = screens[state.currentScreen];
    if (!container) return;

    var focusables = Array.from(
      container.querySelectorAll('.focusable:not([disabled]):not(.hidden)')
    );
    if (focusables.length === 0) return;

    var current = document.activeElement;
    var idx = focusables.indexOf(current);

    if (idx === -1) {
      focusFirst(container);
      return;
    }

    var nextIdx;
    if (direction === 'up' || direction === 'left') {
      nextIdx = idx > 0 ? idx - 1 : focusables.length - 1;
    } else {
      nextIdx = idx < focusables.length - 1 ? idx + 1 : 0;
    }
    focusables[nextIdx].focus();
  }

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

  function tileKey(z, x, y) {
    return z + '/' + x + '/' + y;
  }

  function loadTile(z, x, y) {
    var maxTile = Math.pow(2, z) - 1;
    if (x < 0 || y < 0 || x > maxTile || y > maxTile) return null;

    var key = tileKey(z, x, y);
    if (state.tileCache[key]) return state.tileCache[key];
    if (state.pendingTiles[key]) return null;

    state.pendingTiles[key] = true;
    var img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = function () {
      state.tileCache[key] = img;
      delete state.pendingTiles[key];
      scheduleRender();
    };
    img.onerror = function () {
      delete state.pendingTiles[key];
    };
    img.src = TILE_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    return null;
  }

  function scheduleRender() {
    if (state.renderScheduled) return;
    state.renderScheduled = true;
    requestAnimationFrame(function () {
      state.renderScheduled = false;
      renderMap();
    });
  }

  function renderMap() {
    if (!ctx) return;

    var w = canvas.width;
    var h = canvas.height;
    var center = latLonToWorld(state.centerLat, state.centerLon, state.zoom);
    var topLeftX = center.x - w / 2;
    var topLeftY = center.y - h / 2;

    ctx.fillStyle = '#1C1E21';
    ctx.fillRect(0, 0, w, h);

    var startTileX = Math.floor(topLeftX / TILE_SIZE);
    var startTileY = Math.floor(topLeftY / TILE_SIZE);
    var endTileX = Math.floor((topLeftX + w) / TILE_SIZE);
    var endTileY = Math.floor((topLeftY + h) / TILE_SIZE);

    for (var ty = startTileY; ty <= endTileY; ty++) {
      for (var tx = startTileX; tx <= endTileX; tx++) {
        var img = loadTile(state.zoom, tx, ty);
        if (img) {
          var drawX = tx * TILE_SIZE - topLeftX;
          var drawY = ty * TILE_SIZE - topLeftY;
          ctx.drawImage(img, drawX, drawY, TILE_SIZE, TILE_SIZE);
        }
      }
    }

    if (state.userLat !== null && state.userLon !== null) {
      var userWorld = latLonToWorld(state.userLat, state.userLon, state.zoom);
      var ux = userWorld.x - topLeftX;
      var uy = userWorld.y - topLeftY;

      ctx.beginPath();
      ctx.arc(ux, uy, 14, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0, 212, 255, 0.25)';
      ctx.fill();

      ctx.beginPath();
      ctx.arc(ux, uy, 8, 0, Math.PI * 2);
      ctx.fillStyle = '#00d4ff';
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.stroke();

      if (state.heading !== null && !isNaN(state.heading)) {
        var rad = (state.heading - 90) * Math.PI / 180;
        ctx.beginPath();
        ctx.moveTo(ux, uy);
        ctx.lineTo(ux + Math.cos(rad) * 18, uy + Math.sin(rad) * 18);
        ctx.strokeStyle = '#00ff88';
        ctx.lineWidth = 3;
        ctx.stroke();
      }
    }
  }

  function panMap(dx, dy) {
    state.followUser = false;
    var center = latLonToWorld(state.centerLat, state.centerLon, state.zoom);
    var newPos = worldToLatLon(center.x + dx, center.y + dy, state.zoom);
    state.centerLat = newPos.lat;
    state.centerLon = newPos.lon;
    scheduleRender();
  }

  function setZoom(delta) {
    var newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, state.zoom + delta));
    if (newZoom === state.zoom) return;
    state.zoom = newZoom;
    scheduleRender();
  }

  function recenterOnUser() {
    if (state.userLat === null) return;
    state.followUser = true;
    state.centerLat = state.userLat;
    state.centerLon = state.userLon;
    scheduleRender();
  }

  function formatCoord(value, digits) {
    return value === null ? '—' : value.toFixed(digits);
  }

  function updateCoordsBar() {
    if (state.userLat === null) {
      coordsBar.textContent = 'Waiting for GPS…';
      return;
    }
    var acc = state.accuracy ? ' ±' + Math.round(state.accuracy) + 'm' : '';
    coordsBar.textContent =
      formatCoord(state.userLat, 5) + ', ' + formatCoord(state.userLon, 5) + acc;
  }

  function updateGpsStatus(text) {
    gpsStatus.textContent = text;
  }

  function updateDetailsScreen() {
    placeNameEl.textContent = state.placeName || 'Unknown location';
    detailLat.textContent = formatCoord(state.userLat, 6) + '°';
    detailLon.textContent = formatCoord(state.userLon, 6) + '°';
    detailAccuracy.textContent = state.accuracy
      ? Math.round(state.accuracy) + ' m'
      : '—';
    detailHeading.textContent = state.heading !== null && !isNaN(state.heading)
      ? Math.round(state.heading) + '°'
      : '—';
  }

  function reverseGeocode(lat, lon) {
    var now = Date.now();
    if (now - state.lastNominatimRequest < 1100) return;
    state.lastNominatimRequest = now;

    var url = NOMINATIM_URL +
      '?format=json&lat=' + lat + '&lon=' + lon + '&zoom=16&addressdetails=1';

    fetch(url, { headers: { 'Accept': 'application/json' } })
      .then(function (res) {
        if (!res.ok) throw new Error('Geocode failed');
        return res.json();
      })
      .then(function (data) {
        state.placeName = data.display_name || null;
        if (state.currentScreen === 'details-screen') updateDetailsScreen();
      })
      .catch(function () { /* non-critical */ });
  }

  function onLocationUpdate(pos) {
    var coords = pos.coords;
    state.userLat = coords.latitude;
    state.userLon = coords.longitude;
    state.accuracy = coords.accuracy;
    state.heading = coords.heading;

    if (state.followUser) {
      state.centerLat = coords.latitude;
      state.centerLon = coords.longitude;
    }

    updateCoordsBar();
    updateGpsStatus('Live');
    reverseGeocode(coords.latitude, coords.longitude);
    scheduleRender();

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

    if (state.geoWatchId !== null) {
      navigator.geolocation.clearWatch(state.geoWatchId);
    }

    updateGpsStatus('Locating…');

    state.geoWatchId = navigator.geolocation.watchPosition(
      onLocationUpdate,
      onLocationError,
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );
  }

  function handleAction(action) {
    switch (action) {
      case 'back':
        navigateBack();
        break;
      case 'zoom-in':
        setZoom(1);
        break;
      case 'zoom-out':
        setZoom(-1);
        break;
      case 'recenter':
        recenterOnUser();
        break;
      case 'details':
        navigateTo('details-screen');
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

  function setupEvents() {
    document.addEventListener('click', function (e) {
      var actionEl = e.target.closest('[data-action]');
      if (actionEl && actionEl.dataset.action !== 'map-focus') {
        handleAction(actionEl.dataset.action);
      }
    });

    canvas.addEventListener('focus', function () {
      state.mapFocused = true;
    });
    canvas.addEventListener('blur', function () {
      state.mapFocused = false;
    });

    document.addEventListener('keydown', function (e) {
      if (state.currentScreen === 'map-screen' && state.mapFocused) {
        switch (e.key) {
          case 'ArrowUp':
            panMap(0, -PAN_STEP);
            e.preventDefault();
            return;
          case 'ArrowDown':
            panMap(0, PAN_STEP);
            e.preventDefault();
            return;
          case 'ArrowLeft':
            panMap(-PAN_STEP, 0);
            e.preventDefault();
            return;
          case 'ArrowRight':
            panMap(PAN_STEP, 0);
            e.preventDefault();
            return;
        }
      }

      switch (e.key) {
        case 'ArrowUp':
          moveFocus('up');
          e.preventDefault();
          break;
        case 'ArrowDown':
          moveFocus('down');
          e.preventDefault();
          break;
        case 'ArrowLeft':
          moveFocus('left');
          e.preventDefault();
          break;
        case 'ArrowRight':
          moveFocus('right');
          e.preventDefault();
          break;
        case 'Enter':
          if (document.activeElement &&
              document.activeElement.classList.contains('focusable')) {
            document.activeElement.click();
          }
          e.preventDefault();
          break;
        case 'Escape':
          navigateBack();
          e.preventDefault();
          break;
      }
    });
  }

  function init() {
    collectScreens();
    canvas = document.getElementById('map-canvas');
    ctx = canvas.getContext('2d');
    gpsStatus = document.getElementById('gps-status');
    coordsBar = document.getElementById('coords-bar');
    placeNameEl = document.getElementById('place-name');
    detailLat = document.getElementById('detail-lat');
    detailLon = document.getElementById('detail-lon');
    detailAccuracy = document.getElementById('detail-accuracy');
    detailHeading = document.getElementById('detail-heading');
    errorMessage = document.getElementById('error-message');

    setupEvents();
    scheduleRender();
    startGeolocation();

    setTimeout(function () {
      focusFirst(screens['map-screen']);
    }, 100);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
