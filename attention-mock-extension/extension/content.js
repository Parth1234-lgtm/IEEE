/* ===================================================================
   Content Script (schemas.py-aligned)
   - Continuously tracks implicit accessibility signals on the active page
   - Sends RequestSchema (implicit) every 30–60s to POST /process
   - Shows floating suggestion UI for implicit responses (mode=suggest)
   - Applies adaptations + content actions for explicit responses immediately
   - Preserves reversibility via injected CSS + removable content container
   =================================================================== */

(function () {
  "use strict";

  if (window.__attentionAdaptiveInjected) return;
  window.__attentionAdaptiveInjected = true;

  const BACKEND_URL = "http://127.0.0.1:8000/process";

  const STYLE_ID = "__aau_injected_css";
  const SUGGEST_ID = "__aau_suggestion_ui";
  const CONTENT_ID = "__aau_content_actions";
  const HTML_CLASS = "__aau_applied";

  const DISMISS_SUPPRESS_MS = 2 * 60 * 1000;
  const IMPLICIT_MIN_MS = 30 * 1000;
  const IMPLICIT_MAX_MS = 60 * 1000;

  let suppressSuggestionsUntil = 0;
  let lastSuggestedResponse = null;

  const appliedState = {
    ui_actions: {},
    content_actions: {
      summary: { enabled: false },
      audio: { enabled: false },
      flashcards: { enabled: false }
    }
  };

  /* ---------------------------------------------------------------
     Utilities
  --------------------------------------------------------------- */
  function nowMs() { return Date.now(); }

  function isActivePage() {
    // "Active page" best-effort: visible tab
    return document.visibilityState === "visible";
  }

  function randMs(min, max) {
    return Math.floor(min + Math.random() * (max - min + 1));
  }

  function safeBool(v) {
    return v === true;
  }

  function ensureStyleTag() {
    let el = document.getElementById(STYLE_ID);
    if (!el) {
      el = document.createElement("style");
      el.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(el);
    }
    return el;
  }

  function removeById(id) {
    const el = document.getElementById(id);
    if (el) el.remove();
  }

  function summarizeUIActions(ui) {
    const items = [];
    if (!ui || typeof ui !== "object") return items;
    if (typeof ui.font_scale === "number") items.push(`Font scale: ${ui.font_scale.toFixed(2)}`);
    if (typeof ui.line_spacing === "number") items.push(`Line spacing: ${ui.line_spacing.toFixed(2)}`);
    if (ui.contrast === "high") items.push("High contrast");
    if (safeBool(ui.simplify_layout)) items.push("Simplify layout");
    if (safeBool(ui.hide_distractions)) items.push("Hide distractions");
    if (safeBool(ui.highlight_focus)) items.push("Highlight focus");
    return items;
  }

  /* ---------------------------------------------------------------
     Apply / Reset (DOM changes are injected & reversible)
  --------------------------------------------------------------- */
  function buildInjectedCss(ui) {
    const rules = [];
    rules.push(`html.${HTML_CLASS} { transition: background 180ms ease, color 180ms ease; }`);

    if (typeof ui.font_scale === "number" && Number.isFinite(ui.font_scale)) {
      const pct = Math.max(80, Math.min(200, Math.round(ui.font_scale * 100)));
      rules.push(`html.${HTML_CLASS} { font-size: ${pct}% !important; }`);
    }

    if (typeof ui.line_spacing === "number" && Number.isFinite(ui.line_spacing)) {
      const lh = Math.max(0.9, Math.min(2.5, ui.line_spacing));
      rules.push(`html.${HTML_CLASS} body { line-height: ${lh} !important; }`);
      rules.push(`html.${HTML_CLASS} p, html.${HTML_CLASS} li { line-height: ${lh} !important; }`);
    }

    if (ui.contrast === "high") {
      rules.push(`html.${HTML_CLASS}, html.${HTML_CLASS} body { background: #000 !important; color: #fff !important; }`);
      rules.push(`html.${HTML_CLASS} a { color: #7ab7ff !important; }`);
      rules.push(`html.${HTML_CLASS} :where(p, li, span, div) { color: inherit !important; }`);
    }

    if (safeBool(ui.simplify_layout)) {
      rules.push(`html.${HTML_CLASS} body { max-width: 980px !important; margin-left: auto !important; margin-right: auto !important; padding-left: 14px !important; padding-right: 14px !important; }`);
      rules.push(`html.${HTML_CLASS} img, html.${HTML_CLASS} video, html.${HTML_CLASS} iframe { max-width: 100% !important; height: auto !important; }`);
    }

    if (safeBool(ui.hide_distractions)) {
      // Intentionally conservative selector set to avoid breaking essential navigation
      rules.push([
        `html.${HTML_CLASS} aside,`,
        `html.${HTML_CLASS} nav,`,
        `html.${HTML_CLASS} footer,`,
        `html.${HTML_CLASS} [role="banner"],`,
        `html.${HTML_CLASS} [role="complementary"],`,
        `html.${HTML_CLASS} [aria-label*="advertisement" i],`,
        `html.${HTML_CLASS} [id*="advert" i],`,
        `html.${HTML_CLASS} [class*="advert" i],`,
        `html.${HTML_CLASS} [id*="ads" i],`,
        `html.${HTML_CLASS} [class*="ads" i]`,
        `{ display: none !important; }`
      ].join("\n"));
    }

    if (safeBool(ui.highlight_focus)) {
      rules.push(`html.${HTML_CLASS} :focus-visible { outline: 3px solid #ffbf00 !important; outline-offset: 3px !important; }`);
    }

    return rules.join("\n");
  }

  function applyUIActions(ui_actions) {
    const ui = (ui_actions && typeof ui_actions === "object") ? ui_actions : {};
    const css = buildInjectedCss(ui);
    ensureStyleTag().textContent = css;
    document.documentElement.classList.add(HTML_CLASS);
    appliedState.ui_actions = { ...ui };
  }

  function renderContentActions(content_actions) {
    const ca = (content_actions && typeof content_actions === "object") ? content_actions : null;
    removeById(CONTENT_ID);
    if (!ca) return;

    const summary = ca.summary || { enabled: false };
    const audio = ca.audio || { enabled: false };
    const flashcards = ca.flashcards || { enabled: false };

    const hasAny =
      summary.enabled === true ||
      audio.enabled === true ||
      flashcards.enabled === true;

    if (!hasAny) {
      appliedState.content_actions = {
        summary: { enabled: false },
        audio: { enabled: false },
        flashcards: { enabled: false }
      };
      return;
    }

    const root = document.createElement("div");
    root.id = CONTENT_ID;
    root.className = "aau-content";

    if (summary.enabled === true && typeof summary.text === "string" && summary.text.trim()) {
      const sec = document.createElement("div");
      sec.className = "aau-content__section";
      sec.innerHTML = `<div class="aau-content__label">Summary</div>`;
      const body = document.createElement("div");
      body.className = "aau-content__summary";
      body.textContent = summary.text;
      sec.appendChild(body);
      root.appendChild(sec);
    }

    if (audio.enabled === true && typeof audio.audio_base64 === "string" && audio.audio_base64.trim()) {
      const sec = document.createElement("div");
      sec.className = "aau-content__section";
      sec.innerHTML = `<div class="aau-content__label">Audio</div>`;
      const player = document.createElement("audio");
      player.controls = true;
      const fmt = (typeof audio.audio_format === "string" && audio.audio_format) ? audio.audio_format : "wav";
      player.src = `data:audio/${fmt};base64,${audio.audio_base64}`;
      sec.appendChild(player);
      root.appendChild(sec);
    }

    if (flashcards.enabled === true && typeof flashcards.image_base64 === "string" && flashcards.image_base64.trim()) {
      const sec = document.createElement("div");
      sec.className = "aau-content__section";
      sec.innerHTML = `<div class="aau-content__label">Flashcards</div>`;
      const img = document.createElement("img");
      img.alt = "Flashcard";
      img.src = `data:image/png;base64,${flashcards.image_base64}`;
      sec.appendChild(img);
      root.appendChild(sec);
    }

    document.documentElement.appendChild(root);
    appliedState.content_actions = {
      summary: { enabled: summary.enabled === true, text: summary.text },
      audio: { enabled: audio.enabled === true, audio_format: audio.audio_format, audio_base64: audio.audio_base64 },
      flashcards: { enabled: flashcards.enabled === true, image_base64: flashcards.image_base64 }
    };
  }

  function applyResponse(response) {
    if (!response || typeof response !== "object") return;
    applyUIActions(response.ui_actions || {});
    renderContentActions(response.content_actions || null);
    hideSuggestionUI();
  }

  function resetAll() {
    removeById(STYLE_ID);
    removeById(CONTENT_ID);
    document.documentElement.classList.remove(HTML_CLASS);
    appliedState.ui_actions = {};
    appliedState.content_actions = {
      summary: { enabled: false },
      audio: { enabled: false },
      flashcards: { enabled: false }
    };
  }

  /* ---------------------------------------------------------------
     Floating Suggestion UI (implicit mode)
  --------------------------------------------------------------- */
  function hideSuggestionUI() {
    removeById(SUGGEST_ID);
  }

  function showSuggestionUI(response) {
    lastSuggestedResponse = response;

    if (nowMs() < suppressSuggestionsUntil) return;

    const actions = summarizeUIActions((response || {}).ui_actions || {});
    if (actions.length === 0) {
      hideSuggestionUI();
      return;
    }

    hideSuggestionUI();

    const root = document.createElement("div");
    root.id = SUGGEST_ID;
    root.className = "aau-suggest";

    const listHtml = actions.map((t) => `<li>${escapeHtml(t)}</li>`).join("");

    root.innerHTML = `
      <div class="aau-suggest__header">
        <div class="aau-suggest__title">Suggested adaptations</div>
        <div class="aau-suggest__badge">Suggest</div>
      </div>
      <div class="aau-suggest__body">
        <ul class="aau-suggest__list">${listHtml}</ul>
      </div>
      <div class="aau-suggest__actions">
        <button class="aau-btn aau-btn--primary" id="__aau_apply_btn" type="button">Apply</button>
        <button class="aau-btn" id="__aau_dismiss_btn" type="button">Dismiss</button>
      </div>
    `;

    document.documentElement.appendChild(root);

    const applyBtn = document.getElementById("__aau_apply_btn");
    const dismissBtn = document.getElementById("__aau_dismiss_btn");

    if (applyBtn) {
      applyBtn.addEventListener("click", () => {
        if (lastSuggestedResponse) applyResponse(lastSuggestedResponse);
      });
    }
    if (dismissBtn) {
      dismissBtn.addEventListener("click", () => {
        suppressSuggestionsUntil = nowMs() + DISMISS_SUPPRESS_MS;
        hideSuggestionUI();
      });
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  /* ---------------------------------------------------------------
     Implicit signal tracking (we track all requested signals locally,
     but only send schemas.py fields in InteractionSignals)
  --------------------------------------------------------------- */
  const period = {
    startedAt: nowMs(),
    zoom_count: 0,
    scroll_samples: 0,
    scroll_dir_changes: 0,
    last_scroll_dir: 0,
    click_ts: [],
    misclick_count: 0,
    max_pause_seconds: 0,
    last_interaction_ts: nowMs()
  };

  function markInteraction() {
    const t = nowMs();
    const pauseSec = (t - period.last_interaction_ts) / 1000;
    if (Number.isFinite(pauseSec) && pauseSec > period.max_pause_seconds) {
      period.max_pause_seconds = pauseSec;
    }
    period.last_interaction_ts = t;
  }

  function isInteractiveTarget(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName ? el.tagName.toLowerCase() : "";
    if (tag === "a" || tag === "button" || tag === "input" || tag === "textarea" || tag === "select") return true;
    if (el.isContentEditable) return true;
    const role = el.getAttribute && el.getAttribute("role");
    if (role && ["button", "link", "textbox", "menuitem"].includes(role)) return true;
    if (el.getAttribute && el.getAttribute("onclick")) return true;
    return false;
  }

  // Basic interaction events
  ["mousemove", "keydown", "pointerdown", "touchstart"].forEach((evt) => {
    window.addEventListener(evt, markInteraction, { passive: true, capture: true });
  });

  // Click tracking (rapid clicking + misclick heuristic)
  window.addEventListener("click", (e) => {
    markInteraction();
    const t = nowMs();
    period.click_ts.push(t);
    // keep last 2s
    period.click_ts = period.click_ts.filter((x) => t - x <= 2000);
    const target = e.target;
    if (!isInteractiveTarget(target)) period.misclick_count += 1;
  }, { capture: true });

  (function setupScrollDeltaTracking() {
    let lastY = window.scrollY || 0;
    window.addEventListener("scroll", () => {
      markInteraction();
      const y = window.scrollY || 0;
      const dy = y - lastY;
      lastY = y;
      if (dy === 0) return;
      const dir = dy > 0 ? 1 : -1;
      period.scroll_samples += 1;
      if (period.last_scroll_dir !== 0 && dir !== period.last_scroll_dir) {
        period.scroll_dir_changes += 1;
      }
      period.last_scroll_dir = dir;
    }, { passive: true });
  })();

  // Zoom tracking (visualViewport scale + ctrl zoom gestures)
  function recordZoom() {
    period.zoom_count += 1;
    markInteraction();
  }

  if (window.visualViewport) {
    let lastScale = window.visualViewport.scale;
    window.visualViewport.addEventListener("resize", () => {
      const s = window.visualViewport.scale;
      if (typeof s === "number" && typeof lastScale === "number" && Math.abs(s - lastScale) >= 0.05) {
        recordZoom();
        lastScale = s;
      }
    });
  }

  window.addEventListener("wheel", (e) => {
    if (e.ctrlKey) recordZoom();
  }, { passive: true });

  window.addEventListener("keydown", (e) => {
    if (!e.ctrlKey) return;
    if (e.key === "+" || e.key === "=" || e.key === "-") recordZoom();
  }, { capture: true });

  function snapshotInteractionSignalsForSchema() {
    const t = nowMs();
    const idleSeconds = Math.max(0, (t - period.last_interaction_ts) / 1000);
    const clickCount2s = period.click_ts.length;
    const rapidClicking = clickCount2s >= 6; // heuristic

    const scrollErraticScore = period.scroll_samples > 0
      ? (period.scroll_dir_changes / period.scroll_samples)
      : 0;

    // Map requested metrics → schemas.py InteractionSignals fields
    const interaction_signals = {};

    interaction_signals.constant_mouse_clicking = rapidClicking;
    interaction_signals.frequent_zooming = period.zoom_count >= 3;
    interaction_signals.long_pauses = Math.max(0, period.max_pause_seconds);
    interaction_signals.scroll_erratic = scrollErraticScore >= 0.35;
    interaction_signals.idle_time = idleSeconds;

    return interaction_signals;
  }

  function resetPeriodMetrics() {
    period.startedAt = nowMs();
    period.zoom_count = 0;
    period.scroll_samples = 0;
    period.scroll_dir_changes = 0;
    period.last_scroll_dir = 0;
    period.click_ts = [];
    period.misclick_count = 0;
    period.max_pause_seconds = 0;
  }

  /* ---------------------------------------------------------------
     Implicit networking loop (30–60s)
  --------------------------------------------------------------- */
  let implicitTimer = null;

  async function postProcess(requestBody) {
    const res = await fetch(BACKEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody)
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Backend error ${res.status}: ${txt || res.statusText}`);
    }
    return await res.json();
  }

  async function sendImplicitOnce() {
    const interaction_signals = snapshotInteractionSignalsForSchema();

    const requestBody = {
      request_type: "implicit",
      payload: { interaction_signals }
    };

    try {
      const response = await postProcess(requestBody);
      // Backend must always return mode=suggest for implicit; we ignore mode anyway and treat as suggest UI.
      if (isActivePage()) {
        showSuggestionUI(response);
      }
    } catch (err) {
      // Fail silently on page; console only
      console.warn("[aau] implicit send failed:", err && err.message ? err.message : err);
    } finally {
      resetPeriodMetrics();
    }
  }

  function scheduleImplicitLoop() {
    if (implicitTimer) clearTimeout(implicitTimer);
    const delay = randMs(IMPLICIT_MIN_MS, IMPLICIT_MAX_MS);
    implicitTimer = setTimeout(async () => {
      if (isActivePage()) {
        await sendImplicitOnce();
      }
      scheduleImplicitLoop();
    }, delay);
  }

  /* ---------------------------------------------------------------
     Message handling (popup → content)
  --------------------------------------------------------------- */
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "APPLY_ACTIONS") {
      // Explicit requests must apply immediately; we do not ask for confirmation here.
      applyResponse(msg.response);
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === "RESET_ADAPTATIONS") {
      resetAll();
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === "GET_APPLIED") {
      sendResponse({ ok: true, applied: appliedState });
      return true;
    }
  });

  /* ---------------------------------------------------------------
     Init
  --------------------------------------------------------------- */
  function init() {
    scheduleImplicitLoop();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
