/* app.js - Core Logic for Roadbook Odometer */

// State variables
let state = {
  trackingActive: false,
  demoActive: false,
  stageDistance: 0.0,
  totalDistance: 0.0,
  stageHistory: [], // Array of { id, distance, durationMs, timestamp }
  stageStartTime: null,
  totalStartTime: null,
  totalElapsedMs: 0,
  stageElapsedMs: 0
};

let watchId = null;
let demoIntervalId = null;
let timerIntervalId = null;
let wakeLock = null;
let lastPosition = null;

// DOM Elements
const stageOdoEl = document.getElementById('stage-odo');
const totalOdoEl = document.getElementById('total-odo');
const stageTimeEl = document.getElementById('stage-time');
const totalTimeEl = document.getElementById('total-time');
const btnToggleEl = document.getElementById('btn-toggle');
const btnNextEl = document.getElementById('btn-next');
const btnResetEl = document.getElementById('btn-reset');
const gpsDotEl = document.getElementById('gps-dot');
const gpsStatusTextEl = document.getElementById('gps-status-text');
const gpsAccuracyEl = document.getElementById('gps-accuracy');
const historyListEl = document.getElementById('history-list');
const historyEmptyEl = document.getElementById('history-empty');
const historyCountEl = document.getElementById('history-count');
const toastEl = document.getElementById('toast');
const toastTextEl = document.getElementById('toast-text');
const confirmOverlayEl = document.getElementById('confirm-overlay');
const btnConfirmCancelEl = document.getElementById('btn-confirm-cancel');
const btnConfirmOkEl = document.getElementById('btn-confirm-ok');

// --- HAPTIC FEEDBACK ---
function triggerHaptic(duration = 50) {
  if (navigator.vibrate) {
    try {
      navigator.vibrate(duration);
    } catch (e) {
      console.log('Vibration failed', e);
    }
  }
}

// --- LOCAL STORAGE ---
function saveStateToLocalStorage() {
  localStorage.setItem('roadbook_state', JSON.stringify({
    stageDistance: state.stageDistance,
    totalDistance: state.totalDistance,
    stageHistory: state.stageHistory,
    totalElapsedMs: state.totalElapsedMs + (state.trackingActive ? (Date.now() - state.totalStartTime) : 0),
    stageElapsedMs: state.stageElapsedMs + (state.trackingActive ? (Date.now() - state.stageStartTime) : 0)
  }));
}

function loadStateFromLocalStorage() {
  const saved = localStorage.getItem('roadbook_state');
  if (saved) {
    try {
      const data = JSON.parse(saved);
      state.stageDistance = data.stageDistance || 0.0;
      state.totalDistance = data.totalDistance || 0.0;
      state.stageHistory = data.stageHistory || [];
      state.totalElapsedMs = data.totalElapsedMs || 0;
      state.stageElapsedMs = data.stageElapsedMs || 0;

      updateUI();
      renderHistory();
      showToast('Wczytano poprzednią trasę z pamięci');
    } catch (e) {
      console.error('Error parsing local storage state', e);
    }
  }
}

// --- WAKE LOCK API ---
async function requestWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      console.log('Wake Lock is active');
    } catch (err) {
      console.warn(`Wake lock request failed: ${err.message}`);
    }
  }
}

function releaseWakeLock() {
  if (wakeLock !== null) {
    wakeLock.release().then(() => {
      wakeLock = null;
      console.log('Wake Lock released');
    });
  }
}

// Re-request wake lock on page visibility change
document.addEventListener('visibilitychange', async () => {
  if (wakeLock !== null && document.visibilityState === 'visible') {
    await requestWakeLock();
  }
});

// --- TOAST NOTIFICATION ---
let toastTimeoutId = null;
function showToast(message) {
  toastTextEl.textContent = message;
  toastEl.classList.add('show');

  if (toastTimeoutId) clearTimeout(toastTimeoutId);
  toastTimeoutId = setTimeout(() => {
    toastEl.classList.remove('show');
  }, 3000);
}

// --- HAVERSINE DISTANCE ---
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth radius in km
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c; // Distance in km
}

function deg2rad(deg) {
  return deg * (Math.PI / 180);
}

// --- GPS NOISE FILTER ---
function filterGpsPoint(newLat, newLon, newAccuracy, newTimestamp) {
  // 1. Ignore low accuracy points
  if (newAccuracy > 50) {
    gpsStatusTextEl.textContent = 'Słaba dokładność';
    gpsAccuracyEl.textContent = `dokładność: ±${Math.round(newAccuracy)}m`;
    gpsDotEl.setAttribute('class', 'gps-dot acquiring');
    return false;
  }

  if (!lastPosition) {
    lastPosition = { lat: newLat, lon: newLon, accuracy: newAccuracy, timestamp: newTimestamp };
    gpsDotEl.setAttribute('class', 'gps-dot connected');
    gpsAccuracyEl.textContent = `dokładność: ±${Math.round(newAccuracy)}m`;
    return true;
  }

  const d = calculateDistance(lastPosition.lat, lastPosition.lon, newLat, newLon);
  const dt = (newTimestamp - lastPosition.timestamp) / 1000; // in seconds

  if (dt <= 0) return false;

  const speedMs = (d * 1000) / dt; // speed in m/s

  // 2. Filter out stationary jitter (GPS drift)
  // If distance is less than 2 meters and speed is less than 0.5 m/s (~1.8 km/h), treat as stationary
  if (d < 0.002 || speedMs < 0.5) {
    // Just update GPS status panel without adding distance
    gpsDotEl.setAttribute('class', 'gps-dot connected');
    gpsStatusTextEl.textContent = 'Połączono (Postój)';
    gpsAccuracyEl.textContent = `dokładność: ±${Math.round(newAccuracy)}m`;
    return false;
  }

  // 3. Filter out unreasonable teleports (e.g. speed > 220 km/h or ~61 m/s)
  if (speedMs > 61) {
    console.warn(`Odrzucono anomalny punkt GPS (wyliczona prędkość: ${Math.round(speedMs * 3.6)} km/h)`);
    return false;
  }

  // Success: point accepted
  state.stageDistance += d;
  state.totalDistance += d;

  lastPosition = { lat: newLat, lon: newLon, accuracy: newAccuracy, timestamp: newTimestamp };

  gpsDotEl.setAttribute('class', 'gps-dot connected');
  gpsStatusTextEl.textContent = 'Połączono';
  gpsAccuracyEl.textContent = `dokładność: ±${Math.round(newAccuracy)}m`;

  updateUI();
  saveStateToLocalStorage();
  return true;
}

// --- TIMERS ---
function formatDuration(ms) {
  const totalSecs = Math.floor(ms / 1000);
  const hrs = Math.floor(totalSecs / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;

  const pad = (num) => String(num).padStart(2, '0');

  if (hrs > 0) {
    return `${pad(hrs)}:${pad(mins)}:${pad(secs)}`;
  }
  return `${pad(mins)}:${pad(secs)}`;
}

function updateTimers() {
  const now = Date.now();

  const currentStageElapsed = state.stageElapsedMs + (state.trackingActive ? (now - state.stageStartTime) : 0);
  const currentTotalElapsed = state.totalElapsedMs + (state.trackingActive ? (now - state.totalStartTime) : 0);

  if (stageTimeEl) stageTimeEl.textContent = formatDuration(currentStageElapsed);
  if (totalTimeEl) totalTimeEl.textContent = formatDuration(currentTotalElapsed);
}

// --- GPS START/STOP LOGIC ---
function startTracking() {
  if (state.trackingActive) return;

  triggerHaptic(60);
  state.trackingActive = true;
  state.stageStartTime = Date.now();
  state.totalStartTime = Date.now();

  requestWakeLock();

  // Transition button to Stop
  btnToggleEl.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
    Stop
  `;
  btnToggleEl.className = 'btn btn-toggle stop';

  // Start Odometer Timers
  timerIntervalId = setInterval(updateTimers, 1000);
  updateTimers();

  if (state.demoActive) {
    startDemoSimulation();
  } else {
    // Start Geolocation watch
    gpsDotEl.setAttribute('class', 'gps-dot acquiring');
    gpsStatusTextEl.textContent = 'Ustalanie pozycji...';

    if ("geolocation" in navigator) {
      watchId = navigator.geolocation.watchPosition(
        (position) => {
          filterGpsPoint(
            position.coords.latitude,
            position.coords.longitude,
            position.coords.accuracy,
            position.timestamp
          );
        },
        (error) => {
          console.error('GPS Watch error:', error);
          gpsDotEl.setAttribute('class', 'gps-dot error');
          let errorMsg = 'Błąd GPS';
          if (error.code === error.PERMISSION_DENIED) {
            errorMsg = 'Brak uprawnień GPS';
          } else if (error.code === error.POSITION_UNAVAILABLE) {
            errorMsg = 'Lokalizacja niedostępna';
          } else if (error.code === error.TIMEOUT) {
            errorMsg = 'Przekroczono limit czasu GPS';
          }
          gpsStatusTextEl.textContent = errorMsg;
          showToast(errorMsg);
        },
        {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 0
        }
      );
    } else {
      gpsDotEl.setAttribute('class', 'gps-dot error');
      gpsStatusTextEl.textContent = 'Brak GPS w przeglądarce';
      showToast('Wyszukiwanie lokalizacji nie jest wspierane');
    }
  }
}

function stopTracking() {
  if (!state.trackingActive) return;

  triggerHaptic(40);
  state.trackingActive = false;

  // Save current timer states
  const now = Date.now();
  state.stageElapsedMs += (now - state.stageStartTime);
  state.totalElapsedMs += (now - state.totalStartTime);

  releaseWakeLock();

  // Transition button to Start
  btnToggleEl.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
    Start
  `;
  btnToggleEl.className = 'btn btn-toggle start';

  // Stop intervals
  if (timerIntervalId) {
    clearInterval(timerIntervalId);
    timerIntervalId = null;
  }

  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }

  if (demoIntervalId) {
    clearInterval(demoIntervalId);
    demoIntervalId = null;
  }

  lastPosition = null;

  gpsDotEl.setAttribute('class', 'gps-dot');
  gpsStatusTextEl.textContent = state.demoActive ? 'Tryb Demo gotowy' : 'Śledzenie wyłączone';
  gpsAccuracyEl.textContent = '';

  saveStateToLocalStorage();
  updateUI();
}

// --- NEXT STAGE LOGIC ---
function nextStage() {
  triggerHaptic(50);

  const now = Date.now();
  const currentStageElapsed = state.stageElapsedMs + (state.trackingActive ? (now - state.stageStartTime) : 0);
  const currentTotalElapsed = state.totalElapsedMs + (state.trackingActive ? (now - state.totalStartTime) : 0);

  // 1. Save current stage if distance > 0 or has elapsed time
  if (state.stageDistance > 0 || currentStageElapsed > 0) {
    const nextId = state.stageHistory.length + 1;
    const completedStage = {
      id: nextId,
      distance: state.stageDistance,
      totalDistance: state.totalDistance,
      durationMs: currentStageElapsed,
      totalDurationMs: currentTotalElapsed,
      timestamp: Date.now()
    };

    state.stageHistory.unshift(completedStage); // Add to the top of list
    showToast(`Etap ${nextId} zapisany: ${state.stageDistance.toFixed(2)} km`);
  } else {
    showToast('Etap pusty - brak dystansu');
  }

  // 2. Reset stage values
  state.stageDistance = 0.0;
  state.stageElapsedMs = 0;
  state.stageStartTime = state.trackingActive ? Date.now() : null;

  // Restart lastPosition logic to avoid telemetry leaps
  lastPosition = null;

  updateUI();
  renderHistory();
  saveStateToLocalStorage();
}

// --- RESET ALL LOGIC ---
function showResetConfirmation() {
  triggerHaptic(30);
  confirmOverlayEl.classList.add('show');
}

function hideResetConfirmation() {
  confirmOverlayEl.classList.remove('show');
}

function resetAll() {
  triggerHaptic(80);
  hideResetConfirmation();

  // Stop tracking if active
  const wasTracking = state.trackingActive;
  if (wasTracking) {
    stopTracking();
  }

  // Reset all state variables
  state.stageDistance = 0.0;
  state.totalDistance = 0.0;
  state.stageHistory = [];
  state.totalElapsedMs = 0;
  state.stageElapsedMs = 0;
  state.stageStartTime = null;
  state.totalStartTime = null;

  lastPosition = null;

  // Clear localStorage
  localStorage.removeItem('roadbook_state');

  // Update UI elements
  updateUI();
  renderHistory();

  if (stageTimeEl) stageTimeEl.textContent = '00:00';
  if (totalTimeEl) totalTimeEl.textContent = '00:00';

  showToast('Leczniki zresetowane do zera');

  // If was tracking, we stay stopped
}

// --- DEMO MODE SIMULATOR ---
function startDemoSimulation() {
  gpsDotEl.setAttribute('class', 'gps-dot connected');
  gpsStatusTextEl.textContent = 'Tryb Demo (W ruchu)';

  // Base coordinates near a scenic route (e.g. Tatra mountains / Zakopane road)
  let lat = 49.299;
  let lon = 19.949;
  let simulatedAccuracy = 3.0; // 3 meters accuracy

  lastPosition = { lat, lon, accuracy: simulatedAccuracy, timestamp: Date.now() };

  demoIntervalId = setInterval(() => {
    // Generate simulated driving movement:
    // Speed: ~54 km/h = 15 m/s = 0.015 km/s
    // Add small random noise to make the odometer fluctuate realistically (0.011 to 0.019 km per second)
    const deltaKm = 0.011 + (Math.random() * 0.008);

    // Convert distance to latitude/longitude increments (approximate for Europe)
    // 1 km is roughly 0.009 degrees of latitude
    // 1 km is roughly 0.014 degrees of longitude at this latitude
    const latIncrement = (deltaKm * 0.009) * (0.8 + Math.random() * 0.4);
    const lonIncrement = (deltaKm * 0.014) * (0.8 + Math.random() * 0.4);

    lat += latIncrement;
    lon += lonIncrement;

    // Vary accuracy slightly
    simulatedAccuracy = 2.0 + Math.random() * 2.0;

    // Add to distance
    state.stageDistance += deltaKm;
    state.totalDistance += deltaKm;

    // Update GPS status text with simulated accuracy
    gpsAccuracyEl.textContent = `dokładność: ±${simulatedAccuracy.toFixed(1)}m (Demo)`;

    updateUI();
    saveStateToLocalStorage();
  }, 1000);
}

// Hidden Demo Mode trigger (easter egg: 5 taps on Total Odometer Card)
let totalCardClicks = 0;
let totalCardClicksTimeout = null;

function handleHiddenDemoTrigger() {
  totalCardClicks++;
  triggerHaptic(30);

  if (totalCardClicksTimeout) clearTimeout(totalCardClicksTimeout);

  if (totalCardClicks >= 5) {
    totalCardClicks = 0;
    triggerHaptic(150);
    state.demoActive = !state.demoActive;

    if (state.demoActive) {
      gpsDotEl.setAttribute('class', 'gps-dot acquiring');
      gpsStatusTextEl.textContent = 'Tryb Demo aktywny';
      showToast('Aktywowano ukryty Symulator GPS');
    } else {
      if (state.trackingActive) {
        stopTracking();
      }
      gpsDotEl.setAttribute('class', 'gps-dot');
      gpsStatusTextEl.textContent = 'Śledzenie wyłączone';
      showToast('Wyłączono Symulator GPS');
    }
  } else {
    totalCardClicksTimeout = setTimeout(() => {
      totalCardClicks = 0;
    }, 3000);
  }
}

// --- UI UPDATES & RENDERING ---
function updateUI() {
  stageOdoEl.textContent = state.stageDistance.toFixed(2);
  totalOdoEl.textContent = state.totalDistance.toFixed(2);
  historyCountEl.textContent = state.stageHistory.length;
}

function renderHistory() {
  if (state.stageHistory.length === 0) {
    historyEmptyEl.style.display = 'flex';
    historyListEl.style.display = 'none';
    return;
  }

  historyEmptyEl.style.display = 'none';
  historyListEl.style.display = 'flex';

  historyListEl.innerHTML = '';

  state.stageHistory.forEach(stage => {
    const card = document.createElement('div');
    card.className = 'stage-log-card';

    const formattedTime = new Date(stage.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const durationText = formatDuration(stage.durationMs);
    const totalDurationText = formatDuration(stage.totalDurationMs !== undefined ? stage.totalDurationMs : stage.durationMs);
    const totalDist = stage.totalDistance !== undefined ? stage.totalDistance : stage.distance;

    card.innerHTML = `
      <div class="stage-log-left">
        <div class="stage-number-badge">${stage.id}</div>
        <div class="stage-log-info">
          <div style="font-weight: 700; font-size: 0.85rem;">Etap ${stage.id}</div>
          <div class="stage-time">Zapisano o ${formattedTime}</div>
        </div>
      </div>
      <div class="stage-log-right">
        <div class="stage-log-distance">${stage.distance.toFixed(2)} km</div>
        <div class="stage-log-cumulative">Suma: ${totalDist.toFixed(2)} km</div>
        <div class="stage-duration">Czas: ${durationText}</div>
        <div class="stage-duration">Suma: ${totalDurationText}</div>
      </div>
    `;
    historyListEl.appendChild(card);
  });
}

// --- INITIALIZATION ---
function init() {
  // Bind buttons
  btnToggleEl.addEventListener('click', () => {
    if (state.trackingActive) {
      stopTracking();
    } else {
      startTracking();
    }
  });

  btnNextEl.addEventListener('click', nextStage);
  btnResetEl.addEventListener('click', showResetConfirmation);

  btnConfirmCancelEl.addEventListener('click', hideResetConfirmation);
  btnConfirmOkEl.addEventListener('click', resetAll);

  // Bind hidden demo easter egg to the Total Odometer Card
  document.querySelector('.total-card').addEventListener('click', handleHiddenDemoTrigger);

  // Load saved state if any
  loadStateFromLocalStorage();

  // Initial updates
  updateUI();
  renderHistory();
}

// Start app
window.addEventListener('DOMContentLoaded', init);

// Register Service Worker for PWA installation support on Android
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then(reg => {
        console.log('Service Worker registered successfully!', reg);
        // Check for updates periodically
        reg.update();
      })
      .catch(err => console.error('Service Worker registration failed:', err));
  });

  // Automatically reload page when a new service worker takes over
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!refreshing) {
      refreshing = true;
      window.location.reload();
    }
  });
}
