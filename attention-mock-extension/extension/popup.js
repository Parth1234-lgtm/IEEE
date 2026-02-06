/* ===================================================================
   Popup Script
   - Toggle baseline / adaptive mode
   - Explicit feedback buttons (Hard to read / Too much info)
   - State indicator display
   - Poll live metrics from storage and update UI
   =================================================================== */

console.log("%c[popup] === POPUP LOADED (backend-enabled build) ===", "color:cyan;font-weight:bold;font-size:14px");

const toggle = document.getElementById("modeToggle");
const labelBaseline = document.getElementById("label-baseline");
const labelAdaptive = document.getElementById("label-adaptive");
const statusPill = document.getElementById("statusPill");

// Explicit input buttons
const btnReadability = document.getElementById("btnReadability");
const btnOverload = document.getElementById("btnOverload");

// State indicator
const elStateName = document.getElementById("stateName");
const elStateSource = document.getElementById("stateSource");

// Warning banner
const elWarning = document.getElementById("popupWarning");

// Metric elements
const elRereadPerMin = document.getElementById("rereadPerMin");
const elRereadTotal = document.getElementById("rereadTotal");
const elAvgScroll = document.getElementById("avgScroll");
const elElapsed = document.getElementById("elapsed");
const elZoomOsc = document.getElementById("zoomOsc");
const elLargeJumps = document.getElementById("largeJumps");

/* ---------------------------------------------------------------
   Helper: send STATE_CHANGED directly to the active tab.
   This is the critical fallback — the background broadcast
   (chrome.tabs.query → sendMessage to all) silently fails on
   file:// tabs, stale tabs, or when the service-worker is mid-
   sleep.  Sending from the popup uses the activeTab permission
   granted by the user opening the popup.
--------------------------------------------------------------- */
function notifyActiveTab(mode, userState, stateSource) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (chrome.runtime.lastError) {
      console.warn("[popup] tabs.query error:", chrome.runtime.lastError.message);
      return;
    }
    const tab = tabs && tabs[0];
    if (!tab) return;
    console.log(`[popup] Direct-sending STATE_CHANGED to tab ${tab.id}`);
    chrome.tabs.sendMessage(tab.id, {
      type: "STATE_CHANGED",
      mode,
      userState,
      stateSource
    }).catch((err) => {
      console.warn("[popup] Active tab unreachable:", err.message || err);
    });
  });
}

/* ---------------------------------------------------------------
   Init: read current state
--------------------------------------------------------------- */
chrome.runtime.sendMessage({ type: "GET_STATE" }, (res) => {
  if (chrome.runtime.lastError) {
    console.warn("[popup] GET_STATE error:", chrome.runtime.lastError.message);
  }
  if (res) {
    if (res.mode === "adaptive") {
      toggle.checked = true;
      updateLabels("adaptive");
    } else {
      toggle.checked = false;
      updateLabels("baseline");
    }
    updateStateIndicator(res.userState, res.stateSource);
  }
});

/* ---------------------------------------------------------------
   Toggle handler
--------------------------------------------------------------- */
toggle.addEventListener("change", () => {
  const newMode = toggle.checked ? "adaptive" : "baseline";
  console.log(`[popup] Toggle → ${newMode}`);
  chrome.runtime.sendMessage({ type: "SET_MODE", mode: newMode }, (res) => {
    if (chrome.runtime.lastError) {
      console.warn("[popup] SET_MODE error:", chrome.runtime.lastError.message);
    }
    if (res && res.ok) {
      updateLabels(newMode);
      if (newMode === "baseline") {
        updateStateIndicator(null, null);
      }
    }
    // Direct fallback: tell the active tab about the mode change
    notifyActiveTab(newMode, newMode === "baseline" ? null : undefined, null);
  });
});

/* ---------------------------------------------------------------
   Explicit feedback button handlers
   Strategy: fire 3 independent actions on click — no chaining.
     1. Update popup UI immediately (never wait for background).
     2. Write to chrome.storage.local so pollMetrics stays in sync.
     3. Send APPLY_STATE directly to the active tab's content script.
   Background SET_USER_STATE is fire-and-forget for bookkeeping.
--------------------------------------------------------------- */
async function triggerExplicitState(state) {
  const source = "explicit";
  const label = state === "readability" ? "Hard to read" : "Too much info";
  console.log(`[popup] ========== Button: ${label} ==========`);
  hideWarning();

  // --- 1. Popup UI: update immediately, never wait ---
  toggle.checked = true;
  updateLabels("adaptive");
  updateStateIndicator(state, source);
  console.log(`[popup] (1/4) Popup UI updated → ${state} (${source})`);

  // --- 2. Storage: write directly so pollMetrics reads correct values ---
  chrome.storage.local.set(
    { mode: "adaptive", userState: state, stateSource: source }
  );

  // --- 3. Call backend /adapt for adaptation plan ---
  let backendPlan = null;
  const BACKEND_URL = "http://127.0.0.1:8000/adapt";
  console.log(`%c[popup] BACKEND FETCH → ${BACKEND_URL} with state="${state}"`, "color:cyan;font-weight:bold");
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 3000);
    const resp = await fetch(BACKEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state }),
      signal: controller.signal
    });
    console.log(`%c[popup] BACKEND RESPONSE status=${resp.status}`, "color:lime;font-weight:bold");
    if (resp.ok) {
      backendPlan = await resp.json();
      console.log(`%c[popup] BACKEND PLAN:`, "color:lime;font-weight:bold", JSON.stringify(backendPlan));
    } else {
      console.warn(`[popup] Backend returned non-OK: ${resp.status} ${resp.statusText}`);
    }
  } catch (err) {
    console.warn(`%c[popup] BACKEND FETCH FAILED: ${err.name}: ${err.message}`, "color:red;font-weight:bold");
  }

  // --- 4. Direct-send APPLY_STATE_NOW to the active tab ---
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (chrome.runtime.lastError) {
      console.warn("[popup] (3/4) tabs.query error:", chrome.runtime.lastError.message);
      return;
    }
    const tab = tabs && tabs[0];
    if (!tab) {
      console.warn("[popup] (3/4) No active tab found");
      return;
    }
    console.log(`[popup] (3/4) Sending APPLY_STATE_NOW → tab ${tab.id} (backendPlan: ${!!backendPlan})`);
    chrome.tabs.sendMessage(tab.id, {
      type: "APPLY_STATE_NOW",
      state: state,
      source: source,
      backendPlan: backendPlan
    }).then((response) => {
      if (response && response.ok) {
        console.log(`[popup] (3/4) Tab ${tab.id} applied "${state}" (backendDriven: ${response.backendDriven})`);
        hideWarning();
      } else {
        const reason = (response && response.error) || "unknown";
        console.warn(`[popup] (3/4) Tab ${tab.id} rejected: ${reason}`);
        showWarning("Switch to the demo page tab and try again.");
      }
    }).catch((err) => {
      console.warn(`[popup] (3/4) Tab ${tab.id} FAILED:`, err.message || err);
      showWarning("Open the demo page to apply adaptations.");
    });
  });

  // --- 5. Fire-and-forget: tell background for its bookkeeping ---
  chrome.runtime.sendMessage(
    { type: "SET_USER_STATE", state, source },
    (res) => {
      if (chrome.runtime.lastError) {
        console.warn("[popup] (4/4) Background SET_USER_STATE error:", chrome.runtime.lastError.message);
      } else {
        console.log("[popup] (4/4) Background ack:", JSON.stringify(res));
      }
    }
  );
}

btnReadability.addEventListener("click", () => triggerExplicitState("readability"));
btnOverload.addEventListener("click", () => triggerExplicitState("overload"));

/* ---------------------------------------------------------------
   Free-text input: keyword-based routing → readability | overload
--------------------------------------------------------------- */
const textInput = document.getElementById("textInput");
const btnApplyText = document.getElementById("btnApplyText");
const btnMic = document.getElementById("btnMic");
const textHint = document.getElementById("textHint");

function handleTextSubmit() {
  const raw = textInput.value.trim();
  if (!raw) return;
  hideTextHint();

  chrome.runtime.sendMessage({ type: "MAP_TEXT_TO_STATE", text: raw }, (res) => {
    if (chrome.runtime.lastError) {
      showTextHint("Try: \"Hard to read\" or \"Too much info\"");
      return;
    }
    const state = res && res.state;
    if (state) {
      triggerExplicitState(state);
      textInput.value = "";
    } else {
      showTextHint("Try: \"Hard to read\" or \"Too much info\"");
    }
  });
}

btnApplyText.addEventListener("click", handleTextSubmit);
textInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") handleTextSubmit();
});

function showTextHint(msg) {
  textHint.textContent = msg;
  textHint.style.display = "block";
}
function hideTextHint() {
  textHint.style.display = "none";
}

/* ---------------------------------------------------------------
   Voice input: Web Speech API
--------------------------------------------------------------- */
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let isListening = false;

if (SpeechRecognition) {
  recognition = new SpeechRecognition();
  recognition.lang = "en-US";
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  recognition.addEventListener("result", (event) => {
    const transcript = event.results[0][0].transcript;
    textInput.value = transcript;
    stopListening();
    // Auto-submit after voice
    handleTextSubmit();
  });

  recognition.addEventListener("error", (event) => {
    console.warn("[popup] Speech error:", event.error);
    stopListening();
    if (event.error === "not-allowed") {
      showTextHint("Microphone access denied.");
    }
  });

  recognition.addEventListener("end", () => {
    stopListening();
  });
} else {
  // Browser doesn't support speech recognition
  btnMic.classList.add("disabled");
  btnMic.title = "Voice input not supported in this browser";
}

btnMic.addEventListener("click", () => {
  if (!recognition) return;
  if (isListening) {
    recognition.abort();
    stopListening();
  } else {
    startListening();
  }
});

function startListening() {
  if (!recognition) return;
  isListening = true;
  btnMic.classList.add("listening");
  btnMic.textContent = "…";
  hideTextHint();
  textInput.placeholder = "Listening…";
  recognition.start();
}

function stopListening() {
  isListening = false;
  btnMic.classList.remove("listening");
  btnMic.textContent = "🎤";
  textInput.placeholder = "Describe your difficulty…";
}

/* ---------------------------------------------------------------
   UI update helpers
--------------------------------------------------------------- */
function updateLabels(mode) {
  if (mode === "adaptive") {
    labelBaseline.classList.remove("active");
    labelAdaptive.classList.add("active");
    statusPill.textContent = "Adaptive";
    statusPill.className = "status-pill adaptive";
  } else {
    labelAdaptive.classList.remove("active");
    labelBaseline.classList.add("active");
    statusPill.textContent = "Baseline";
    statusPill.className = "status-pill baseline";
  }
}

function updateStateIndicator(userState, stateSource) {
  if (!userState) {
    elStateName.textContent = "None";
    elStateName.className = "state-name";
    elStateSource.textContent = "";
    // Clear button highlights
    btnReadability.classList.remove("active");
    btnOverload.classList.remove("active");
  } else {
    elStateName.textContent = userState === "readability" ? "Readability" : "Overload";
    elStateName.className = `state-name state-${userState}`;
    elStateSource.textContent = stateSource ? `(${stateSource})` : "";
    // Highlight active button
    btnReadability.classList.toggle("active", userState === "readability");
    btnOverload.classList.toggle("active", userState === "overload");
  }
}

function showWarning(msg) {
  if (elWarning) {
    elWarning.textContent = msg;
    elWarning.style.display = "block";
  }
}

function hideWarning() {
  if (elWarning) elWarning.style.display = "none";
}

/* ---------------------------------------------------------------
   Live metric polling (every 600ms)
--------------------------------------------------------------- */
function pollMetrics() {
  chrome.storage.local.get(["liveMetrics", "userState", "stateSource", "mode"], (res) => {
    if (chrome.runtime.lastError) return;
    const m = res.liveMetrics;
    if (m) {
      elRereadPerMin.textContent = m.rereadPerMin ?? "0.0";
      elRereadTotal.textContent = m.rereadTotal ?? 0;
      elAvgScroll.textContent = m.avgScrollPx ?? 0;
      elElapsed.textContent = formatElapsed(m.elapsedSec ?? 0);
      elZoomOsc.textContent = m.zoomOscillations ?? 0;
      elLargeJumps.textContent = m.largeJumps ?? 0;
    }

    // Sync state indicator from storage (catches implicit triggers)
    const mode = res.mode || "baseline";
    const userState = res.userState || null;
    const stateSource = res.stateSource || null;

    if (mode === "adaptive" && !toggle.checked) {
      toggle.checked = true;
      updateLabels("adaptive");
    } else if (mode === "baseline" && toggle.checked) {
      toggle.checked = false;
      updateLabels("baseline");
    }

    updateStateIndicator(userState, stateSource);
  });
}

function formatElapsed(sec) {
  if (sec < 60) return sec + "s";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

setInterval(pollMetrics, 600);
pollMetrics();
