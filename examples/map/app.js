(function () {
  'use strict';

  var TILE_SIZE = 256;
  var TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  var NOMINATIM_URL = 'https://nominatim.openstreetmap.org/reverse';
  var NOMINATIM_SEARCH_URL = 'https://nominatim.openstreetmap.org/search';
  // FOSSGIS-hosted OSRM foot profile (free, no key) — same router used by openstreetmap.org.
  var OSRM_FOOT_URL = 'https://routing.openstreetmap.de/routed-foot/route/v1/foot/';
  var MIN_ZOOM = 12;
  var MAX_ZOOM = 18;
  var PAN_STEP = 48;
  var STEP_ADVANCE_M = 22;   // advance to next maneuver within this distance
  var ARRIVE_M = 18;         // considered arrived within this distance
  var REROUTE_M = 45;        // off-route distance that triggers a reroute

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
    panMode: false,
    tileCache: {},
    pendingTiles: {},
    lastNominatimRequest: 0,
    renderScheduled: false,
    // routing / navigation
    destination: null,        // { lat, lon, name }
    route: null,              // { coords:[[lon,lat]], steps:[...], distance, duration }
    routeActive: false,
    currentStepIndex: 0,
    arrived: false,
    rerouting: false,
    lastRerouteAt: 0,
  };

  var recognition = null;
  var listening = false;

  var screens = {};
  var canvas, ctx;
  var gpsStatus, coordsBar, placeNameEl;
  var detailLat, detailLon, detailAccuracy, detailHeading, errorMessage;
  var voiceOrb, voiceStatus, voiceTranscript;
  var navBanner, navBannerIcon, navBannerInstruction, navBannerDistance;
  var routeSummary, routeDestName, stepsList;
  var keyboardEl, typeQueryEl, typeStatus;

  var KEY_ROWS = [
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
    ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
    ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'],
    ['Z', 'X', 'C', 'V', 'B', 'N', 'M'],
    ['SPACE', 'DEL', 'MIC', 'GO'],
  ];
  var typedQuery = '';
  var kbFocus = { r: 1, c: 0 };

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

    // Route polyline
    if (state.route && state.route.coords && state.route.coords.length > 1) {
      ctx.beginPath();
      for (var i = 0; i < state.route.coords.length; i++) {
        var c = state.route.coords[i];
        var pw = latLonToWorld(c[1], c[0], state.zoom);
        var px = pw.x - topLeftX;
        var py = pw.y - topLeftY;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(0, 212, 255, 0.45)';
      ctx.lineWidth = 9;
      ctx.stroke();
      ctx.strokeStyle = '#00d4ff';
      ctx.lineWidth = 5;
      ctx.stroke();
    }

    // Destination marker
    if (state.destination) {
      var dWorld = latLonToWorld(state.destination.lat, state.destination.lon, state.zoom);
      var dx = dWorld.x - topLeftX;
      var dy = dWorld.y - topLeftY;
      ctx.beginPath();
      ctx.arc(dx, dy - 4, 9, 0, Math.PI * 2);
      ctx.fillStyle = '#ff4466';
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(dx - 7, dy);
      ctx.lineTo(dx, dy + 11);
      ctx.lineTo(dx + 7, dy);
      ctx.closePath();
      ctx.fillStyle = '#ff4466';
      ctx.fill();
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
    if (state.routeActive) updateNavigation();
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

  /* ---------- Geometry helpers ---------- */

  function haversine(lat1, lon1, lat2, lon2) {
    var R = 6371000;
    var dLat = (lat2 - lat1) * Math.PI / 180;
    var dLon = (lon2 - lon1) * Math.PI / 180;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

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

  /* ---------- On-screen keyboard (D-pad destination entry) ---------- */

  function keyLabel(k) {
    if (k === 'SPACE') return 'space';
    if (k === 'DEL') return '\u232B';
    if (k === 'MIC') return '\uD83C\uDFA4';
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
        b.dataset.key = k;
        b.dataset.r = r;
        b.dataset.c = c;
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
    if (dir === 'up') r--;
    else if (dir === 'down') r++;
    else if (dir === 'left') c--;
    else if (dir === 'right') c++;

    if (r < 0) r = KEY_ROWS.length - 1;
    if (r > KEY_ROWS.length - 1) r = 0;
    var len = KEY_ROWS[r].length;
    if (c < 0) c = len - 1;
    if (c > len - 1) c = 0;
    focusKey(r, c);
  }

  function renderTypedQuery() {
    if (typeQueryEl) typeQueryEl.textContent = typedQuery;
  }

  function handleKey(k) {
    switch (k) {
      case 'GO':
        submitTyped();
        return;
      case 'DEL':
        typedQuery = typedQuery.slice(0, -1);
        break;
      case 'SPACE':
        if (typedQuery && typedQuery.slice(-1) !== ' ') typedQuery += ' ';
        break;
      case 'MIC':
        navigateTo('voice-screen');
        startListening();
        return;
      default:
        typedQuery += k;
    }
    renderTypedQuery();
  }

  function submitTyped() {
    var q = typedQuery.trim();
    if (!q) {
      if (typeStatus) typeStatus.textContent = 'Type a place first';
      return;
    }
    if (typeStatus) typeStatus.textContent = 'Searching for \u201C' + q + '\u201D\u2026';
    findDestination(q);
  }

  function openTypeScreen() {
    buildKeyboard();
    typedQuery = '';
    renderTypedQuery();
    if (typeStatus) typeStatus.textContent = 'Spell out a place, then press Go';
    navigateTo('type-screen');
    focusKey(1, 0);
  }

  function setSearchStatus(msg) {
    if (voiceStatus) voiceStatus.textContent = msg;
    if (typeStatus) typeStatus.textContent = msg;
  }

  /* ---------- Voice recognition ---------- */

  function speechSupported() {
    return ('webkitSpeechRecognition' in window) || ('SpeechRecognition' in window);
  }

  function speak(text) {
    if (!('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text);
      u.rate = 1.0;
      u.lang = 'en-US';
      window.speechSynthesis.speak(u);
    } catch (e) { /* non-critical */ }
  }

  function setVoiceState(status, transcript, isListening) {
    if (voiceStatus) voiceStatus.textContent = status;
    if (transcript !== undefined && voiceTranscript) voiceTranscript.textContent = transcript;
    if (voiceOrb) voiceOrb.classList.toggle('listening', !!isListening);
    listening = !!isListening;
  }

  var micReady = false;
  var voiceRetried = false;
  var gotResult = false;

  // Pre-acquire microphone permission. SpeechRecognition only needs the
  // permission prompt to happen inside a user gesture; once granted it can be
  // (re)started freely. WebViews (like the glasses browser) are much more
  // reliable when the mic is granted via getUserMedia first.
  function ensureMic() {
    if (micReady) return Promise.resolve(true);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      // No getUserMedia — let SpeechRecognition try to handle permission itself.
      return Promise.resolve(true);
    }
    return navigator.mediaDevices.getUserMedia({ audio: true })
      .then(function (stream) {
        stream.getTracks().forEach(function (t) { t.stop(); });
        micReady = true;
        return true;
      })
      .catch(function (e) {
        var name = (e && e.name) ? e.name : 'error';
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          setVoiceState('Microphone permission denied', '', false);
        } else if (name === 'NotFoundError') {
          setVoiceState('No microphone found', '', false);
        } else {
          setVoiceState('Mic unavailable (' + name + ')', '', false);
        }
        return false;
      });
  }

  function startListening() {
    if (!speechSupported()) {
      setVoiceState('Voice not supported on this device', '', false);
      return;
    }
    voiceRetried = false;
    setVoiceState('Preparing mic…', '', false);
    ensureMic().then(function (ok) {
      if (ok) beginRecognition();
    });
  }

  function beginRecognition() {
    var Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (recognition) {
      try { recognition.abort(); } catch (e) {}
    }
    gotResult = false;
    recognition = new Ctor();
    recognition.lang = 'en-US';
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.continuous = false;

    recognition.onstart = function () {
      setVoiceState('Listening…', '', true);
    };
    recognition.onresult = function (e) {
      gotResult = true;
      var transcript = '';
      for (var i = 0; i < e.results.length; i++) {
        transcript += e.results[i][0].transcript;
      }
      transcript = transcript.trim();
      if (voiceTranscript) voiceTranscript.textContent = transcript;
      if (e.results[e.results.length - 1].isFinal && transcript) {
        setVoiceState('Searching…', transcript, false);
        findDestination(transcript);
      }
    };
    recognition.onerror = function (ev) {
      var err = ev.error || 'unknown';
      // Transient errors: retry once automatically.
      if ((err === 'network' || err === 'no-speech' || err === 'aborted') && !voiceRetried) {
        voiceRetried = true;
        setVoiceState('Reconnecting…', '', false);
        setTimeout(function () {
          try { recognition.start(); } catch (e) { beginRecognition(); }
        }, 600);
        return;
      }
      var msg;
      switch (err) {
        case 'not-allowed':
        case 'service-not-allowed':
          msg = 'Microphone permission denied'; micReady = false; break;
        case 'no-speech':
          msg = 'No speech detected — tap Speak'; break;
        case 'network':
          msg = 'Speech service offline — check connection'; break;
        case 'audio-capture':
          msg = 'No microphone found'; break;
        default:
          msg = 'Voice error (' + err + ') — tap Speak';
      }
      setVoiceState(msg, '', false);
    };
    recognition.onend = function () {
      // If it ended with no result and not mid-retry, reset to idle.
      if (listening && !gotResult && !voiceRetried) {
        setVoiceState('Tap Speak to try again', undefined, false);
      }
    };

    try {
      recognition.start();
    } catch (e) {
      // start() throws if called while already running — restart cleanly.
      setTimeout(beginRecognition, 300);
    }
  }

  /* ---------- Geocoding (destination lookup) ---------- */

  function findDestination(query) {
    var url = NOMINATIM_SEARCH_URL +
      '?format=json&limit=1&q=' + encodeURIComponent(query);
    // Bias results toward the user's vicinity when we know where they are.
    if (state.userLat !== null && state.userLon !== null) {
      var d = 0.5;
      url += '&viewbox=' +
        (state.userLon - d) + ',' + (state.userLat + d) + ',' +
        (state.userLon + d) + ',' + (state.userLat - d);
    }

    fetch(url, { headers: { 'Accept': 'application/json' } })
      .then(function (res) {
        if (!res.ok) throw new Error('Search failed');
        return res.json();
      })
      .then(function (results) {
        if (!results || results.length === 0) {
          setSearchStatus('Couldn\u2019t find \u201C' + query + '\u201D');
          speak('Sorry, I could not find ' + query);
          return;
        }
        var r = results[0];
        state.destination = {
          lat: parseFloat(r.lat),
          lon: parseFloat(r.lon),
          name: r.display_name || query,
        };
        setSearchStatus('Planning route\u2026');
        fetchRoute();
      })
      .catch(function () {
        setSearchStatus('Search failed — try again');
      });
  }

  /* ---------- Walking route ---------- */

  function fetchRoute(silent) {
    if (!state.destination) return;
    if (state.userLat === null) {
      setSearchStatus('Waiting for your location\u2026');
      return;
    }

    var coords =
      state.userLon + ',' + state.userLat + ';' +
      state.destination.lon + ',' + state.destination.lat;
    var url = OSRM_FOOT_URL + coords +
      '?overview=full&geometries=geojson&steps=true&annotations=false';

    fetch(url)
      .then(function (res) {
        if (!res.ok) throw new Error('Routing failed');
        return res.json();
      })
      .then(function (data) {
        if (data.code !== 'Ok' || !data.routes || !data.routes.length) {
          throw new Error('No route');
        }
        var r = data.routes[0];
        var steps = [];
        r.legs.forEach(function (leg) {
          leg.steps.forEach(function (s) {
            steps.push({
              text: instructionText(s.maneuver, s.name),
              icon: maneuverIcon(s.maneuver),
              distance: s.distance,
              loc: s.maneuver.location, // [lon, lat]
            });
          });
        });
        state.route = {
          coords: r.geometry.coordinates,
          steps: steps,
          distance: r.distance,
          duration: r.duration,
        };
        state.currentStepIndex = 0;
        state.arrived = false;
        renderRouteScreen();
        scheduleRender();
        if (silent) {
          // reroute: stay on map, just refresh guidance
          updateNavBanner();
        } else {
          navigateTo('route-screen');
        }
      })
      .catch(function () {
        if (silent) {
          state.rerouting = false;
          return;
        }
        setSearchStatus('Couldn\u2019t plan a walking route');
        speak('Sorry, I could not plan a route there');
      });
  }

  function maneuverIcon(m) {
    var type = m.type;
    var mod = m.modifier || '';
    if (type === 'arrive') return '🏁';
    if (type === 'depart') return '↑';
    if (type === 'roundabout' || type === 'rotary') return '↻';
    if (mod.indexOf('left') !== -1) return mod.indexOf('slight') !== -1 ? '↖' : '←';
    if (mod.indexOf('right') !== -1) return mod.indexOf('slight') !== -1 ? '↗' : '→';
    if (mod === 'uturn') return '↩';
    return '↑';
  }

  function instructionText(m, name) {
    var type = m.type;
    var mod = m.modifier;
    var on = name ? (' onto ' + name) : '';
    var along = name ? (' on ' + name) : '';

    switch (type) {
      case 'depart':
        return 'Head off' + along;
      case 'turn':
        return 'Turn ' + (mod || 'ahead') + on;
      case 'new name':
        return 'Continue' + along;
      case 'continue':
        return 'Continue ' + (mod || 'straight') + along;
      case 'merge':
        return 'Merge' + on;
      case 'fork':
        return 'Keep ' + (mod || 'straight') + on;
      case 'end of road':
        return 'Turn ' + (mod || 'ahead') + on;
      case 'roundabout':
      case 'rotary':
        return 'Take the roundabout' + (m.exit ? ', exit ' + m.exit : '') + on;
      case 'arrive':
        return 'Arrive at your destination';
      default:
        return (type ? type.charAt(0).toUpperCase() + type.slice(1) : 'Continue') +
          (mod ? ' ' + mod : '') + on;
    }
  }

  /* ---------- Route screen rendering ---------- */

  function renderRouteScreen() {
    if (!state.route) return;
    routeDestName.textContent = state.destination
      ? state.destination.name.split(',').slice(0, 2).join(',')
      : '—';
    routeSummary.textContent =
      formatDistance(state.route.distance) + ' · ' + formatDuration(state.route.duration);

    stepsList.innerHTML = '';
    state.route.steps.forEach(function (step, i) {
      var item = document.createElement('div');
      item.className = 'step-item';
      if (state.routeActive && i < state.currentStepIndex) item.classList.add('done');
      if (state.routeActive && i === state.currentStepIndex) item.classList.add('active');
      item.innerHTML =
        '<div class="step-icon">' + step.icon + '</div>' +
        '<div class="step-body">' +
        '<div class="step-text"></div>' +
        '<div class="step-dist">' + formatDistance(step.distance) + '</div>' +
        '</div>';
      item.querySelector('.step-text').textContent = step.text;
      stepsList.appendChild(item);
    });
  }

  /* ---------- Live navigation ---------- */

  function startNavigation() {
    if (!state.route) return;
    state.routeActive = true;
    state.arrived = false;
    state.currentStepIndex = 0;
    state.followUser = true;
    if (state.userLat !== null) {
      state.centerLat = state.userLat;
      state.centerLon = state.userLon;
    }
    navBanner.classList.remove('hidden');
    navigateTo('map-screen', { addToHistory: false });
    state.screenHistory = [];
    updateNavigation();
    var first = state.route.steps[0];
    if (first) speak(first.text);
    scheduleRender();
  }

  function endNavigation(silent) {
    state.routeActive = false;
    state.route = null;
    state.destination = null;
    state.arrived = false;
    state.currentStepIndex = 0;
    if (navBanner) navBanner.classList.add('hidden');
    scheduleRender();
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
      ? 'In ' + formatDistance(distToStep)
      : formatDistance(step.distance);
  }

  function updateNavigation() {
    if (!state.routeActive || !state.route || state.userLat === null) return;

    var steps = state.route.steps;

    // Arrival check
    if (state.destination) {
      var distToDest = haversine(
        state.userLat, state.userLon,
        state.destination.lat, state.destination.lon
      );
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

    // Advance through maneuvers we've reached.
    var advanced = false;
    while (state.currentStepIndex < steps.length - 1) {
      var step = steps[state.currentStepIndex];
      if (!step.loc) break;
      var d = haversine(state.userLat, state.userLon, step.loc[1], step.loc[0]);
      if (d <= STEP_ADVANCE_M) {
        state.currentStepIndex++;
        advanced = true;
      } else {
        break;
      }
    }
    if (advanced) {
      var ns = steps[state.currentStepIndex];
      if (ns) speak(ns.text);
      renderRouteScreen();
    }

    // Off-route detection → silent reroute (throttled).
    maybeReroute();

    updateNavBanner();
  }

  function maybeReroute() {
    if (!state.route || !state.route.coords || state.rerouting || state.arrived) return;
    var now = Date.now();
    if (now - state.lastRerouteAt < 8000) return;

    var minDist = Infinity;
    var coords = state.route.coords;
    for (var i = 0; i < coords.length; i++) {
      var d = haversine(state.userLat, state.userLon, coords[i][1], coords[i][0]);
      if (d < minDist) minDist = d;
    }
    if (minDist > REROUTE_M) {
      state.rerouting = true;
      state.lastRerouteAt = now;
      navBannerDistance.textContent = 'Rerouting…';
      fetchRoute(true);
      setTimeout(function () { state.rerouting = false; }, 1000);
    }
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
      case 'type':
        openTypeScreen();
        break;
      case 'voice':
        navigateTo('voice-screen');
        // Start within the same user-gesture call stack (required for the mic
        // permission prompt on the glasses browser / WebViews).
        startListening();
        break;
      case 'voice-listen':
        startListening();
        break;
      case 'start-route':
        startNavigation();
        break;
      case 'route-steps':
        renderRouteScreen();
        navigateTo('route-screen');
        break;
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
      setPanMode(false);
    });

    document.addEventListener('keydown', function (e) {
      // Pan mode: canvas is "activated" and arrows pan the map.
      if (state.panMode && state.currentScreen === 'map-screen' && state.mapFocused) {
        switch (e.key) {
          case 'ArrowUp':
            panMap(0, -PAN_STEP); e.preventDefault(); return;
          case 'ArrowDown':
            panMap(0, PAN_STEP); e.preventDefault(); return;
          case 'ArrowLeft':
            panMap(-PAN_STEP, 0); e.preventDefault(); return;
          case 'ArrowRight':
            panMap(PAN_STEP, 0); e.preventDefault(); return;
          case 'Enter':
          case 'Escape':
            setPanMode(false); e.preventDefault(); return;
        }
      }

      // The keyboard uses 2D grid navigation instead of linear focus order.
      if (state.currentScreen === 'type-screen' &&
          document.activeElement &&
          document.activeElement.classList.contains('kb-key')) {
        switch (e.key) {
          case 'ArrowUp':
            keyboardNav('up'); e.preventDefault(); return;
          case 'ArrowDown':
            keyboardNav('down'); e.preventDefault(); return;
          case 'ArrowLeft':
            keyboardNav('left'); e.preventDefault(); return;
          case 'ArrowRight':
            keyboardNav('right'); e.preventDefault(); return;
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
          // Enter on the focused map canvas toggles pan mode.
          if (document.activeElement === canvas) {
            setPanMode(true);
          } else if (document.activeElement &&
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

  function setPanMode(on) {
    state.panMode = !!on;
    if (canvas) canvas.classList.toggle('pan-mode', state.panMode);
  }

  function resizeCanvas() {
    var wrapper = canvas.parentElement;
    var rect = wrapper.getBoundingClientRect();
    var w = Math.floor(rect.width);
    var h = Math.floor(rect.height);
    if (w > 0 && h > 0 && (canvas.width !== w || canvas.height !== h)) {
      canvas.width = w;
      canvas.height = h;
      scheduleRender();
    }
  }

  function init() {
    collectScreens();
    canvas = document.getElementById('map-canvas');
    ctx = canvas.getContext('2d');
    resizeCanvas();
    gpsStatus = document.getElementById('gps-status');
    coordsBar = document.getElementById('coords-bar');
    placeNameEl = document.getElementById('place-name');
    detailLat = document.getElementById('detail-lat');
    detailLon = document.getElementById('detail-lon');
    detailAccuracy = document.getElementById('detail-accuracy');
    detailHeading = document.getElementById('detail-heading');
    errorMessage = document.getElementById('error-message');
    voiceOrb = document.getElementById('voice-orb');
    voiceStatus = document.getElementById('voice-status');
    voiceTranscript = document.getElementById('voice-transcript');
    navBanner = document.getElementById('nav-banner');
    navBannerIcon = document.getElementById('nav-banner-icon');
    navBannerInstruction = document.getElementById('nav-banner-instruction');
    navBannerDistance = document.getElementById('nav-banner-distance');
    routeSummary = document.getElementById('route-summary');
    routeDestName = document.getElementById('route-dest-name');
    stepsList = document.getElementById('steps-list');
    keyboardEl = document.getElementById('keyboard');
    typeQueryEl = document.getElementById('type-query');
    typeStatus = document.getElementById('type-status');

    setupEvents();
    scheduleRender();
    startGeolocation();

    setTimeout(function () {
      resizeCanvas();
      focusFirst(screens['map-screen']);
    }, 100);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
