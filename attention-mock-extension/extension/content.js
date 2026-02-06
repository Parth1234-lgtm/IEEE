/* ===================================================================
   Content Script
   - Collects attention signals (scroll, dwell, reread, zoom oscillation)
   - Implicit trigger engine evaluates READABILITY / OVERLOAD thresholds
   - Applies / reverts state-specific UI adaptations
   - Injects floating feedback bar for explicit input
   - Stores live metrics for the popup to read
   =================================================================== */

(function () {
  "use strict";

  // Guard against double-injection
  if (window.__adaptiveUIInjected) return;
  window.__adaptiveUIInjected = true;
  console.log("%c[content] === CONTENT SCRIPT LOADED (backend-enabled build) ===", "color:cyan;font-weight:bold;font-size:14px");

  /* ---------------------------------------------------------------
     Constants
  --------------------------------------------------------------- */
  const COOLDOWN_MS = 30000; // 30s cooldown between implicit state changes
  const TRIGGER_EVAL_INTERVAL = 2000; // check implicit triggers every 2s
  const MAX_SCROLL_SAMPLES = 50; // sliding window size for scroll distances
  const REREAD_WINDOW_MS = 60000; // 60s sliding window for reread rate
  const MIN_ELAPSED_FOR_RATE = 5000; // require 5s before computing per-minute rates

  const READABILITY_THRESH = {
    zoomOscillationsMin: 3,
    rereadRateMin: 2.5,
    windowMs: 60000
  };

  const OVERLOAD_THRESH = {
    avgScrollSpeedMin: 600,
    lowDwellPct: 0.3,
    largeJumpsMin: 4,
    windowMs: 30000
  };

  const SIGNAL_WORDS = ["important", "key", "critical", "significant", "notably", "essential", "crucial"];

  /* ---------------------------------------------------------------
     State
  --------------------------------------------------------------- */
  let currentMode = "baseline";
  let currentUserState = null; // "readability" | "overload" | null
  let applied = null; // which state's adaptations are currently applied

  // Timing
  let lastStateChangeTs = 0;
  let baselineSuppressUntil = 0;

  // Metrics
  const metrics = {
    startTime: Date.now(),
    scrollEvents: 0,
    scrollDistances: [],       // capped to MAX_SCROLL_SAMPLES
    rereadEvents: 0,
    rereadTimestamps: [],      // pruned periodically
    sectionsViewed: new Set(),
    lastScrollY: window.scrollY,
    lastScrollTime: Date.now(),
    // Zoom
    zoomOscillations: [],      // timestamps of direction changes (for trigger engine)
    zoomEvents: 0,             // total Ctrl+wheel / Ctrl+key zoom events (for display)
    lastZoomDirection: null,
    // Scroll behaviour
    scrollSpeeds: [],          // { speed, ts } sliding window (last 30)
    largeJumps: 0,
    largeJumpTimestamps: []
  };

  let metricInterval = null;
  let triggerInterval = null;

  /* ---------------------------------------------------------------
     Signal Collection
  --------------------------------------------------------------- */

  // --- Scroll tracking ---
  let scrollTick = false;
  window.addEventListener("scroll", () => {
    if (scrollTick) return;
    scrollTick = true;
    requestAnimationFrame(() => {
      const now = Date.now();
      const dy = Math.abs(window.scrollY - metrics.lastScrollY);
      const dt = now - metrics.lastScrollTime;
      metrics.scrollEvents++;
      metrics.scrollDistances.push(dy);
      // Cap to sliding window
      if (metrics.scrollDistances.length > MAX_SCROLL_SAMPLES) {
        metrics.scrollDistances.shift();
      }

      // Scroll speed tracking
      if (dt > 0) {
        metrics.scrollSpeeds.push({ speed: dy, ts: now });
        if (metrics.scrollSpeeds.length > 30) metrics.scrollSpeeds.shift();
      }

      // Large jump detection (>500px)
      if (dy > 500) {
        metrics.largeJumps++;
        metrics.largeJumpTimestamps.push(now);
      }

      // Reread heuristic: user scrolled UP past a section they already viewed
      if (window.scrollY < metrics.lastScrollY) {
        detectReread(window.scrollY);
      }

      // Track which vertical zones have been seen (100px buckets)
      const bucket = Math.floor(window.scrollY / 100);
      metrics.sectionsViewed.add(bucket);

      metrics.lastScrollY = window.scrollY;
      metrics.lastScrollTime = now;
      scrollTick = false;
    });
  }, { passive: true });

  function detectReread(scrollY) {
    const bucket = Math.floor(scrollY / 100);
    if (metrics.sectionsViewed.has(bucket)) {
      metrics.rereadEvents++;
      metrics.rereadTimestamps.push(Date.now());
      console.log(`[content] Reread detected at bucket ${bucket}  (total: ${metrics.rereadEvents})`);
    }
  }

  // --- Zoom tracking ---
  // Ctrl+scroll = browser zoom
  window.addEventListener("wheel", (e) => {
    if (!e.ctrlKey) return;
    metrics.zoomEvents++;
    const direction = e.deltaY < 0 ? "in" : "out";
    if (metrics.lastZoomDirection && direction !== metrics.lastZoomDirection) {
      metrics.zoomOscillations.push(Date.now());
      console.log(`[content] Zoom oscillation (${metrics.lastZoomDirection}→${direction}), oscillations: ${metrics.zoomOscillations.length}, total events: ${metrics.zoomEvents}`);
    }
    metrics.lastZoomDirection = direction;
  }, { passive: true });

  // Ctrl+Plus / Ctrl+Minus
  window.addEventListener("keydown", (e) => {
    if (!e.ctrlKey) return;
    let direction = null;
    if (e.key === "=" || e.key === "+") direction = "in";
    else if (e.key === "-") direction = "out";
    if (!direction) return;

    metrics.zoomEvents++;
    if (metrics.lastZoomDirection && direction !== metrics.lastZoomDirection) {
      metrics.zoomOscillations.push(Date.now());
      console.log(`[content] Zoom oscillation key (${metrics.lastZoomDirection}→${direction}), oscillations: ${metrics.zoomOscillations.length}, total events: ${metrics.zoomEvents}`);
    }
    metrics.lastZoomDirection = direction;
  });

  // --- Dwell tracking via IntersectionObserver ---
  const dwellMap = new Map(); // element → { enterTime, totalDwell }

  function setupDwellObserver() {
    const sections = document.querySelectorAll(
      "[data-adapt-content] p, [data-adapt-content] section, [data-adapt-content] h2, [data-adapt-content] h3"
    );
    if (sections.length === 0) return;

    const observer = new IntersectionObserver((entries) => {
      const now = Date.now();
      for (const entry of entries) {
        const el = entry.target;
        if (!dwellMap.has(el)) dwellMap.set(el, { enterTime: 0, totalDwell: 0 });
        const rec = dwellMap.get(el);
        if (entry.isIntersecting) {
          rec.enterTime = now;
        } else if (rec.enterTime > 0) {
          rec.totalDwell += now - rec.enterTime;
          rec.enterTime = 0;
        }
      }
    }, { threshold: 0.3 });

    sections.forEach((s) => observer.observe(s));
  }

  /* ---------------------------------------------------------------
     Metric flushing to storage (popup reads this)
  --------------------------------------------------------------- */
  function flushMetrics() {
    const now = Date.now();
    const elapsedMs = now - metrics.startTime;
    const elapsedSec = Math.round(elapsedMs / 1000);

    // --- Reread rate: sliding window (last 60s) ---
    // Only produce a non-zero rate after MIN_ELAPSED_FOR_RATE to avoid
    // absurd spikes when the first reread fires at 0.5s elapsed.
    const recentRereads = metrics.rereadTimestamps.filter(ts => now - ts < REREAD_WINDOW_MS);
    let rereadPerMin = 0;
    if (elapsedMs >= MIN_ELAPSED_FOR_RATE && recentRereads.length > 0) {
      // windowMs = the smaller of (total elapsed, 60s) — avoids dividing
      // a small count by 60s when the page has only been open for 8s.
      const windowMs = Math.min(elapsedMs, REREAD_WINDOW_MS);
      rereadPerMin = recentRereads.length / (windowMs / 60000);
      // Clamp to a sane demo-friendly max
      rereadPerMin = Math.min(rereadPerMin, 30);
    }

    // --- Avg scroll from recent samples only ---
    const avgScrollSpeed = metrics.scrollDistances.length > 0
      ? metrics.scrollDistances.reduce((a, b) => a + b, 0) / metrics.scrollDistances.length
      : 0;

    const payload = {
      rereadPerMin: Math.round(rereadPerMin * 10) / 10,
      rereadTotal: metrics.rereadEvents,
      scrollEvents: metrics.scrollEvents,
      avgScrollPx: Math.round(avgScrollSpeed),
      elapsedSec,
      mode: currentMode,
      userState: currentUserState,
      zoomOscillations: metrics.zoomOscillations.length,
      zoomEvents: metrics.zoomEvents,
      largeJumps: metrics.largeJumps,
      ts: now
    };

    chrome.storage.local.set({ liveMetrics: payload });

    // --- Prune old timestamps (keep 2× the relevant window) ---
    metrics.rereadTimestamps = metrics.rereadTimestamps.filter(ts => now - ts < REREAD_WINDOW_MS * 2);
    metrics.zoomOscillations = metrics.zoomOscillations.filter(ts => now - ts < 120000);
    metrics.largeJumpTimestamps = metrics.largeJumpTimestamps.filter(ts => now - ts < 120000);
  }

  /* ---------------------------------------------------------------
     Implicit Trigger Engine (runs every 2s)
  --------------------------------------------------------------- */
  function evaluateTriggers() {
    const now = Date.now();

    // Skip if within cooldown
    if (now - lastStateChangeTs < COOLDOWN_MS) return;
    // Skip if baseline suppression active
    if (now < baselineSuppressUntil) return;

    // Evaluate READABILITY trigger
    if (currentUserState !== "readability") {
      const recentOscillations = metrics.zoomOscillations.filter(ts => now - ts < READABILITY_THRESH.windowMs);
      const recentRereads = metrics.rereadTimestamps.filter(ts => now - ts < READABILITY_THRESH.windowMs);
      const windowMinutes = READABILITY_THRESH.windowMs / 60000;
      const rereadRate = windowMinutes > 0 ? recentRereads.length / windowMinutes : 0;

      if (recentOscillations.length >= READABILITY_THRESH.zoomOscillationsMin &&
          rereadRate >= READABILITY_THRESH.rereadRateMin) {
        console.log(`[content] Implicit READABILITY trigger fired (oscillations: ${recentOscillations.length}, rereadRate: ${rereadRate.toFixed(1)})`);
        setUserState("readability", "implicit");
        return;
      }
    }

    // Evaluate OVERLOAD trigger
    if (currentUserState !== "overload") {
      const recentSpeeds = metrics.scrollSpeeds.filter(s => now - s.ts < OVERLOAD_THRESH.windowMs);
      const avgSpeed = recentSpeeds.length > 0
        ? recentSpeeds.reduce((sum, s) => sum + s.speed, 0) / recentSpeeds.length
        : 0;

      const recentLargeJumps = metrics.largeJumpTimestamps.filter(ts => now - ts < OVERLOAD_THRESH.windowMs);

      // Calculate dwell ratio
      let totalSections = 0;
      let meaningfulDwell = 0;
      for (const [, rec] of dwellMap) {
        totalSections++;
        const dwell = rec.totalDwell + (rec.enterTime > 0 ? now - rec.enterTime : 0);
        if (dwell > 2000) meaningfulDwell++;
      }
      const dwellPct = totalSections > 0 ? meaningfulDwell / totalSections : 1;

      if (avgSpeed >= OVERLOAD_THRESH.avgScrollSpeedMin &&
          dwellPct < OVERLOAD_THRESH.lowDwellPct &&
          recentLargeJumps.length >= OVERLOAD_THRESH.largeJumpsMin) {
        console.log(`[content] Implicit OVERLOAD trigger fired (avgSpeed: ${avgSpeed.toFixed(0)}, dwellPct: ${dwellPct.toFixed(2)}, largeJumps: ${recentLargeJumps.length})`);
        setUserState("overload", "implicit");
        return;
      }
    }
  }

  /* ---------------------------------------------------------------
     State Management
  --------------------------------------------------------------- */
  function setUserState(state, source) {
    lastStateChangeTs = Date.now();
    currentUserState = state;
    currentMode = "adaptive";

    chrome.runtime.sendMessage({
      type: "SET_USER_STATE",
      state,
      source
    }, (res) => {
      if (chrome.runtime.lastError) {
        console.warn("[content] Could not reach background:", chrome.runtime.lastError.message);
        return;
      }
      console.log(`[content] State set → ${state} (source: ${source})`);
    });

    applyStateAdaptations(state);
    updateFloatingBar();
  }

  function setBaseline() {
    currentMode = "baseline";
    currentUserState = null;
    baselineSuppressUntil = Date.now() + COOLDOWN_MS;
    lastStateChangeTs = Date.now();

    chrome.runtime.sendMessage({ type: "SET_MODE", mode: "baseline" }, () => {
      if (chrome.runtime.lastError) return;
      console.log("[content] Switched to baseline (implicit suppressed for 30s)");
    });

    revertAllAdaptations();
    updateFloatingBar();
  }

  /* ---------------------------------------------------------------
     Adaptation Application — READABILITY State
  --------------------------------------------------------------- */
  function applyFontBoost() {
    const el = document.querySelector("[data-adapt-content]");
    if (el) el.classList.add("adapt--font-boost");
  }

  function revertFontBoost() {
    const el = document.querySelector("[data-adapt-content]");
    if (el) el.classList.remove("adapt--font-boost");
  }

  function applyHighContrast() {
    const el = document.querySelector("[data-adapt-content]");
    if (el) el.classList.add("adapt--high-contrast");
  }

  function revertHighContrast() {
    const el = document.querySelector("[data-adapt-content]");
    if (el) el.classList.remove("adapt--high-contrast");
  }

  function applyReduceClutter() {
    const els = document.querySelectorAll("[data-adapt-nav], [data-adapt-aside], [data-adapt-footer]");
    els.forEach(el => el.classList.add("adapt--dimmed"));
  }

  function revertReduceClutter() {
    document.querySelectorAll(".adapt--dimmed").forEach(el => el.classList.remove("adapt--dimmed"));
  }

  function applyHighlightKey() {
    const paragraphs = document.querySelectorAll("[data-adapt-content] p");
    paragraphs.forEach(p => {
      if (p.querySelector("mark.adapt--highlight")) return; // already highlighted
      const text = p.textContent;
      // Split into sentences
      const sentences = text.match(/[^.!?]+[.!?]+/g);
      if (!sentences || sentences.length === 0) return;

      let html = p.innerHTML;
      // Highlight first sentence
      const firstSentence = sentences[0].trim();
      if (firstSentence.length > 10) {
        const re = new RegExp(escapeForRegex(firstSentence));
        // Use function replacement to avoid $-substitution bugs
        html = html.replace(re, function () {
          return '<mark class="adapt--highlight">' + firstSentence + '</mark>';
        });
      }

      // Highlight sentences with signal words
      for (let i = 1; i < sentences.length; i++) {
        const sentence = sentences[i].trim();
        const lower = sentence.toLowerCase();
        if (SIGNAL_WORDS.some(w => lower.includes(w)) && sentence.length > 10) {
          const re = new RegExp(escapeForRegex(sentence));
          const captured = sentence; // close over value, not loop var
          html = html.replace(re, function () {
            return '<mark class="adapt--highlight">' + captured + '</mark>';
          });
        }
      }

      p.innerHTML = html;
    });
  }

  function revertHighlightKey() {
    document.querySelectorAll("mark.adapt--highlight").forEach(mark => {
      const parent = mark.parentNode;
      parent.replaceChild(document.createTextNode(mark.textContent), mark);
      parent.normalize();
    });
  }

  function escapeForRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /* ---------------------------------------------------------------
     Adaptation Application — OVERLOAD State
  --------------------------------------------------------------- */
  function applyTldr() {
    if (document.querySelector("[data-adapt-tldr]")) return;
    const contentEl = document.querySelector("[data-adapt-content]");
    if (!contentEl) return;

    const sections = contentEl.querySelectorAll("[data-adapt-section]");
    if (sections.length === 0) return;

    const bullets = [];
    sections.forEach(sec => {
      const firstP = sec.querySelector("p");
      if (firstP) {
        const text = firstP.textContent;
        const firstSentence = text.match(/^[^.!?]+[.!?]+/);
        if (firstSentence) {
          bullets.push(firstSentence[0].trim());
        }
      }
    });

    if (bullets.length === 0) return;

    const tldr = document.createElement("div");
    tldr.setAttribute("data-adapt-tldr", "true");
    tldr.innerHTML = `<strong>TL;DR Summary</strong><ul>${bullets.map(b => `<li>${b}</li>`).join("")}</ul>`;
    contentEl.insertBefore(tldr, contentEl.firstChild);
  }

  function revertTldr() {
    const el = document.querySelector("[data-adapt-tldr]");
    if (el) el.remove();
  }

  function applyCollapseSections() {
    const contentEl = document.querySelector("[data-adapt-content]");
    if (!contentEl) return;

    const sections = contentEl.querySelectorAll("[data-adapt-section]");
    if (sections.length <= 2) return; // need at least 3 to collapse middle ones

    // Collapse all except first and last
    for (let i = 1; i < sections.length - 1; i++) {
      const sec = sections[i];
      if (sec.querySelector(".adapt--section-toggle")) continue; // already collapsed

      const paragraphs = sec.querySelectorAll("p");
      if (paragraphs.length === 0) continue;

      // Wrap paragraphs in a collapsible container
      const container = document.createElement("div");
      container.className = "adapt--section-body";
      container.classList.add("adapt--section-collapsed");

      paragraphs.forEach(p => container.appendChild(p));
      sec.appendChild(container);

      // Add toggle link
      const toggle = document.createElement("a");
      toggle.className = "adapt--section-toggle";
      toggle.textContent = "Show section \u25b8";
      toggle.addEventListener("click", (e) => {
        e.preventDefault();
        const isCollapsed = container.classList.contains("adapt--section-collapsed");
        container.classList.toggle("adapt--section-collapsed");
        toggle.textContent = isCollapsed ? "Hide section \u25be" : "Show section \u25b8";
      });
      sec.insertBefore(toggle, container);
    }
  }

  function revertCollapseSections() {
    // Remove toggle links
    document.querySelectorAll(".adapt--section-toggle").forEach(el => el.remove());
    // Unwrap collapsed containers
    document.querySelectorAll(".adapt--section-body").forEach(container => {
      const parent = container.parentNode;
      while (container.firstChild) {
        parent.insertBefore(container.firstChild, container);
      }
      container.remove();
    });
  }

  function applyEmphasizeHeadings() {
    document.querySelectorAll("[data-adapt-content] h2").forEach(h2 => {
      h2.classList.add("adapt--heading-emphasis");
    });
  }

  function revertEmphasizeHeadings() {
    document.querySelectorAll(".adapt--heading-emphasis").forEach(el => el.classList.remove("adapt--heading-emphasis"));
  }

  function applyReduceDensity() {
    const el = document.querySelector("[data-adapt-content]");
    if (el) el.classList.add("adapt--low-density");
  }

  function revertReduceDensity() {
    const el = document.querySelector("[data-adapt-content]");
    if (el) el.classList.remove("adapt--low-density");
  }

  function applyDimPeriphery() {
    const els = document.querySelectorAll("[data-adapt-nav], [data-adapt-aside], [data-adapt-footer]");
    els.forEach(el => el.classList.add("adapt--dimmed"));
  }

  function revertDimPeriphery() {
    document.querySelectorAll(".adapt--dimmed").forEach(el => el.classList.remove("adapt--dimmed"));
  }

  /* ---------------------------------------------------------------
     Backend-driven ui_actions (overrides CSS class defaults)
  --------------------------------------------------------------- */
  function applyBackendUiActions(uiActions) {
    const el = document.querySelector("[data-adapt-content]");
    if (!el || !uiActions) return;

    if (uiActions.font_scale && uiActions.font_scale !== 1.0) {
      el.style.fontSize = uiActions.font_scale + "rem";
    }
    if (uiActions.line_spacing) {
      el.style.lineHeight = String(uiActions.line_spacing);
    }
    console.log(`[content] Backend ui_actions applied: font_scale=${uiActions.font_scale}, line_spacing=${uiActions.line_spacing}`);
  }

  function clearBackendUiActions() {
    const el = document.querySelector("[data-adapt-content]");
    if (el) {
      el.style.fontSize = "";
      el.style.lineHeight = "";
    }
  }

  /* ---------------------------------------------------------------
     Master Apply / Revert
  --------------------------------------------------------------- */
  function applyStateAdaptations(state) {
    revertAllAdaptations(); // clean slate first

    // Log target elements so we can verify selectors match the page
    const contentEl = document.querySelector("[data-adapt-content]");
    const periphery = document.querySelectorAll("[data-adapt-nav], [data-adapt-aside], [data-adapt-footer]");
    const sections  = document.querySelectorAll("[data-adapt-section]");
    const paragraphs = contentEl ? contentEl.querySelectorAll("p") : [];
    console.log(`[content] applyStateAdaptations("${state}") — content=${!!contentEl}, periphery=${periphery.length}, sections=${sections.length}, paragraphs=${paragraphs.length}`);

    if (!contentEl) {
      console.warn("[content] No [data-adapt-content] found — adaptations will have no effect.");
    }

    if (state === "readability") {
      applyFontBoost();
      applyHighContrast();
      applyReduceClutter();
      applyHighlightKey();
      // Verify
      if (contentEl) {
        console.log(`[content] Readability verify: font-boost=${contentEl.classList.contains("adapt--font-boost")}, high-contrast=${contentEl.classList.contains("adapt--high-contrast")}, dimmed=${document.querySelectorAll(".adapt--dimmed").length}, highlights=${document.querySelectorAll("mark.adapt--highlight").length}`);
      }
    }

    if (state === "overload") {
      applyTldr();
      applyCollapseSections();
      applyEmphasizeHeadings();
      applyReduceDensity();
      applyDimPeriphery();
      console.log(`[content] Overload verify: tldr=${!!document.querySelector("[data-adapt-tldr]")}, collapsed=${document.querySelectorAll(".adapt--section-collapsed").length}, dimmed=${document.querySelectorAll(".adapt--dimmed").length}`);
    }

    applied = state;
    console.log(`[content] "${state}" adaptations applied. applied="${applied}"`);
  }

  function revertAllAdaptations() {
    if (!applied) return;
    console.log(`[content] Reverting all adaptations (was: ${applied})…`);

    // Revert readability
    revertFontBoost();
    revertHighContrast();
    revertHighlightKey();

    // Revert overload
    revertTldr();
    revertCollapseSections();
    revertEmphasizeHeadings();
    revertReduceDensity();

    // Shared
    revertReduceClutter(); // also covers revertDimPeriphery

    // Clear backend-applied inline styles
    clearBackendUiActions();

    applied = null;
    console.log("[content] All adaptations reverted.");
  }

  /* ---------------------------------------------------------------
     Floating Feedback Bar
  --------------------------------------------------------------- */
  let feedbackBar = null;

  function injectFeedbackBar() {
    if (!document.querySelector("[data-adapt-content]")) return;
    if (document.querySelector(".adapt-feedback-bar")) return;

    feedbackBar = document.createElement("div");
    feedbackBar.className = "adapt-feedback-bar";
    feedbackBar.innerHTML = `
      <div class="adapt-fb-header">
        <span class="adapt-fb-title">Adaptive UI</span>
        <span class="adapt-fb-state-pill" id="adaptFbStatePill">Baseline</span>
        <button class="adapt-fb-close" id="adaptFbClose" title="Minimize">&times;</button>
      </div>
      <div class="adapt-fb-body" id="adaptFbBody">
        <div class="adapt-fb-buttons" id="adaptFbButtons">
          <button class="adapt-fb-btn adapt-fb-readability" id="adaptFbReadability">Hard to read</button>
          <button class="adapt-fb-btn adapt-fb-overload" id="adaptFbOverload">Too much info</button>
          <button class="adapt-fb-btn adapt-fb-baseline" id="adaptFbBaseline">Reset</button>
        </div>
        <div class="adapt-fb-text-row">
          <input type="text" class="adapt-fb-text-input" id="adaptFbTextInput" placeholder="Describe difficulty\u2026" autocomplete="off">
          <button class="adapt-fb-btn-go" id="adaptFbTextGo" title="Apply">Go</button>
          <button class="adapt-fb-btn-mic" id="adaptFbMic" title="Voice input">\uD83C\uDFA4</button>
        </div>
        <div class="adapt-fb-status" id="adaptFbStatus" style="display:none"></div>
      </div>
    `;

    document.body.appendChild(feedbackBar);

    // Button event handlers
    document.getElementById("adaptFbReadability").addEventListener("click", () => {
      setUserState("readability", "explicit");
    });
    document.getElementById("adaptFbOverload").addEventListener("click", () => {
      setUserState("overload", "explicit");
    });
    document.getElementById("adaptFbBaseline").addEventListener("click", () => {
      setBaseline();
    });

    // Text input handlers
    document.getElementById("adaptFbTextGo").addEventListener("click", handleWidgetTextSubmit);
    document.getElementById("adaptFbTextInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") handleWidgetTextSubmit();
    });

    // Voice input
    setupWidgetVoice();

    // Minimize toggle
    let minimized = false;
    document.getElementById("adaptFbClose").addEventListener("click", () => {
      const body = document.getElementById("adaptFbBody");
      minimized = !minimized;
      if (body) body.style.display = minimized ? "none" : "";
      document.getElementById("adaptFbClose").textContent = minimized ? "+" : "\u00d7";
    });

    updateFloatingBar();
  }

  function updateFloatingBar() {
    const pill = document.getElementById("adaptFbStatePill");
    if (!pill) return;

    if (currentMode === "baseline" || !currentUserState) {
      pill.textContent = "Baseline";
      pill.className = "adapt-fb-state-pill adapt-fb-pill-baseline";
    } else {
      pill.textContent = currentUserState === "readability" ? "Readability" : "Overload";
      pill.className = `adapt-fb-state-pill adapt-fb-pill-${currentUserState}`;
    }

    // Highlight active button
    const btnRead = document.getElementById("adaptFbReadability");
    const btnOver = document.getElementById("adaptFbOverload");
    if (btnRead) btnRead.classList.toggle("adapt-fb-btn-active", currentUserState === "readability");
    if (btnOver) btnOver.classList.toggle("adapt-fb-btn-active", currentUserState === "overload");
  }

  /* ---------------------------------------------------------------
     Widget: Text + Voice Input
  --------------------------------------------------------------- */
  function handleWidgetTextSubmit() {
    const input = document.getElementById("adaptFbTextInput");
    const raw = (input ? input.value : "").trim();
    if (!raw) return;
    hideWidgetStatus();

    chrome.runtime.sendMessage({ type: "MAP_TEXT_TO_STATE", text: raw }, (res) => {
      if (chrome.runtime.lastError) {
        showWidgetStatus('Try: "Hard to read" or "Too much info"');
        return;
      }
      const state = res && res.state;
      if (state) {
        setUserState(state, "explicit");
        if (input) input.value = "";
      } else {
        showWidgetStatus('Try: "Hard to read" or "Too much info"');
      }
    });
  }

  function showWidgetStatus(msg) {
    const el = document.getElementById("adaptFbStatus");
    if (el) { el.textContent = msg; el.style.display = "block"; }
  }

  function hideWidgetStatus() {
    const el = document.getElementById("adaptFbStatus");
    if (el) el.style.display = "none";
  }

  let widgetRecognition = null;
  let widgetListening = false;

  function setupWidgetVoice() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const micBtn = document.getElementById("adaptFbMic");
    if (!micBtn) return;

    if (!SR) {
      micBtn.classList.add("adapt-fb-mic-disabled");
      micBtn.title = "Voice not supported in this browser";
      return;
    }

    widgetRecognition = new SR();
    widgetRecognition.lang = "en-US";
    widgetRecognition.interimResults = false;
    widgetRecognition.maxAlternatives = 1;

    widgetRecognition.addEventListener("result", (event) => {
      const transcript = event.results[0][0].transcript;
      const input = document.getElementById("adaptFbTextInput");
      if (input) input.value = transcript;
      stopWidgetListening();
      handleWidgetTextSubmit();
    });

    widgetRecognition.addEventListener("error", (event) => {
      console.warn("[content] Widget speech error:", event.error);
      stopWidgetListening();
      if (event.error === "not-allowed") {
        showWidgetStatus("Mic denied. Use localhost or HTTPS.");
      } else {
        showWidgetStatus("Voice error: " + event.error);
      }
    });

    widgetRecognition.addEventListener("end", () => {
      stopWidgetListening();
    });

    micBtn.addEventListener("click", () => {
      if (widgetListening) {
        widgetRecognition.abort();
        stopWidgetListening();
      } else {
        startWidgetListening();
      }
    });
  }

  function startWidgetListening() {
    if (!widgetRecognition) return;
    widgetListening = true;
    const micBtn = document.getElementById("adaptFbMic");
    const input = document.getElementById("adaptFbTextInput");
    if (micBtn) { micBtn.classList.add("adapt-fb-mic-listening"); micBtn.textContent = "\u2026"; }
    if (input) input.placeholder = "Listening\u2026";
    hideWidgetStatus();
    widgetRecognition.start();
  }

  function stopWidgetListening() {
    widgetListening = false;
    const micBtn = document.getElementById("adaptFbMic");
    const input = document.getElementById("adaptFbTextInput");
    if (micBtn) { micBtn.classList.remove("adapt-fb-mic-listening"); micBtn.textContent = "\uD83C\uDFA4"; }
    if (input) input.placeholder = "Describe difficulty\u2026";
  }

  /* ---------------------------------------------------------------
     Text Selection → Backend (mock)
  --------------------------------------------------------------- */
  let _lastSelText = "";
  let _selThrottleTs = 0;
  const SEL_MIN_LEN = 6;
  const SEL_THROTTLE_MS = 800;

  function handleSelection() {
    if (!document.querySelector("[data-adapt-content]")) return;

    const text = (window.getSelection() || "").toString().trim();
    if (text.length < SEL_MIN_LEN) return;
    if (text === _lastSelText) return;

    const now = Date.now();
    if (now - _selThrottleTs < SEL_THROTTLE_MS) return;

    _lastSelText = text;
    _selThrottleTs = now;

    console.log(`[content] Selection captured (${text.length} chars): "${text.slice(0, 80)}…"`);

    chrome.runtime.sendMessage(
      { type: "SELECTION_CAPTURED", text, url: location.href, ts: now },
      (res) => {
        if (chrome.runtime.lastError) {
          console.warn("[content] Selection send failed:", chrome.runtime.lastError.message);
          return;
        }
        console.log("[content] Selection response:", JSON.stringify(res));
      }
    );
  }

  document.addEventListener("mouseup", handleSelection);
  document.addEventListener("keyup", handleSelection);

  /* ---------------------------------------------------------------
     Message Handling
  --------------------------------------------------------------- */
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

    // --- Direct apply from popup explicit buttons (always honour, no dedup) ---
    if (msg.type === "APPLY_STATE_NOW" || msg.type === "APPLY_STATE") {
      const state  = msg.state || msg.userState;
      const source = msg.source || msg.stateSource || "explicit";
      console.log(`[content] >>> ${msg.type}: state="${state}", source="${source}", current applied="${applied}"`);

      // Guard: only apply on pages with the demo structure
      if (!document.querySelector("[data-adapt-content]")) {
        console.warn(`[content] >>> ${msg.type} rejected — no [data-adapt-content] on this page.`);
        sendResponse({ ok: false, error: "not-demo-page" });
        return true;
      }
      if (!state) {
        console.warn(`[content] >>> ${msg.type} ignored — no state provided. msg keys: ${Object.keys(msg)}`);
        sendResponse({ ok: false, error: "no state" });
        return true;
      }
      currentMode = "adaptive";
      currentUserState = state;
      lastStateChangeTs = Date.now();
      applyStateAdaptations(state);

      // Apply backend-driven ui_actions (overrides CSS class defaults with server values)
      if (msg.backendPlan && msg.backendPlan.ui_actions) {
        console.log(`%c[content] APPLYING BACKEND UI_ACTIONS`, "color:lime;font-weight:bold", JSON.stringify(msg.backendPlan.ui_actions));
        applyBackendUiActions(msg.backendPlan.ui_actions);
      } else {
        console.log(`%c[content] NO backend plan in message (keys: ${Object.keys(msg).join(",")})`, "color:orange");
      }

      updateFloatingBar();
      console.log(`[content] >>> ${msg.type} complete — "${state}" applied, applied="${applied}", backendDriven=${!!msg.backendPlan}.`);
      sendResponse({ ok: true, applied: state, backendDriven: !!msg.backendPlan });
      return true;
    }

    if (msg.type === "STATE_CHANGED") {
      console.log(`[content] STATE_CHANGED: incoming mode="${msg.mode}" userState="${msg.userState}" | current mode="${currentMode}" userState="${currentUserState}" applied="${applied}"`);

      // Dedup: only skip if the *same adaptive state* is already applied.
      // Baseline transitions are never skipped.
      if (msg.mode === "adaptive" && msg.userState && applied === msg.userState) {
        console.log(`[content] STATE_CHANGED dedup — "${msg.userState}" already applied. Skipping.`);
        sendResponse({ ok: true });
        return true;
      }

      currentMode = msg.mode;
      currentUserState = msg.userState;
      lastStateChangeTs = Date.now();

      if (msg.mode === "baseline" || !msg.userState) {
        revertAllAdaptations();
      } else {
        applyStateAdaptations(msg.userState);
      }
      updateFloatingBar();
      sendResponse({ ok: true });
      return true;
    }

    // Legacy support
    if (msg.type === "MODE_CHANGED") {
      currentMode = msg.mode;
      if (msg.mode === "baseline") {
        currentUserState = null;
        revertAllAdaptations();
      }
      updateFloatingBar();
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === "PING") {
      sendResponse({ ok: true, mode: currentMode, userState: currentUserState });
      return true;
    }
  });

  /* ---------------------------------------------------------------
     Init
  --------------------------------------------------------------- */
  function init() {
    console.log("[content] Attention-Adaptive UI injected on", window.location.href);

    // Fetch current state
    chrome.runtime.sendMessage({ type: "GET_STATE" }, (res) => {
      if (chrome.runtime.lastError) {
        console.warn("[content] Could not reach background:", chrome.runtime.lastError.message);
        return;
      }
      if (res) {
        currentMode = res.mode || "baseline";
        currentUserState = res.userState || null;
        console.log(`[content] Initial state: mode=${currentMode}, userState=${currentUserState}`);

        if (currentMode === "adaptive" && currentUserState) {
          applyStateAdaptations(currentUserState);
        }
        updateFloatingBar();
      }
    });

    // Setup dwell observer
    setupDwellObserver();

    // Inject floating feedback bar
    injectFeedbackBar();

    // Start metric flush interval (every 500ms)
    metricInterval = setInterval(flushMetrics, 500);

    // Start implicit trigger evaluation (every 2s)
    triggerInterval = setInterval(evaluateTriggers, TRIGGER_EVAL_INTERVAL);

    console.log("[content] Attention-Adaptive UI content script initialised.");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
