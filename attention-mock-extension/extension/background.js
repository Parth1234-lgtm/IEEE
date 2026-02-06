/* ===================================================================
   Background Service Worker
   - Holds state-specific Adaptation Plans (readability / overload)
   - Manages mode state (baseline / adaptive) and user state
   - Responds to messages from popup and content script
   =================================================================== */

const PLANS = {
  readability: {
    state: "readability",
    goal: "Improve reading comfort for this page",
    reversible: true,
    actions: [
      {
        id: "font-boost",
        label: "Font & line-height boost",
        description: "Increase font size to 1.28rem and line-height to 1.9 for comfortable reading."
      },
      {
        id: "high-contrast",
        label: "High contrast text",
        description: "Boost text contrast for easier reading."
      },
      {
        id: "reduce-clutter",
        label: "Reduce clutter",
        description: "Dim navigation, sidebar, and footer elements."
      },
      {
        id: "highlight-key",
        label: "Highlight key sentences",
        description: "Highlight first sentence of each paragraph and sentences containing signal words."
      }
    ]
  },
  overload: {
    state: "overload",
    goal: "Reduce information density on this page",
    reversible: true,
    actions: [
      {
        id: "tldr-block",
        label: "TL;DR summary",
        description: "Extract first sentences into a summary block at the top."
      },
      {
        id: "collapse-sections",
        label: "Collapse sections",
        description: "Collapse middle sections with toggle links."
      },
      {
        id: "emphasize-headings",
        label: "Emphasize headings",
        description: "Make h2 headings larger and more prominent."
      },
      {
        id: "reduce-density",
        label: "Reduce density",
        description: "Increase spacing between paragraphs."
      },
      {
        id: "dim-periphery",
        label: "Dim periphery",
        description: "Dim navigation, sidebar, and footer elements."
      }
    ]
  }
};

// Initialise mode on install / startup
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    mode: "baseline",
    userState: null,
    stateSource: null,
    plan: null
  });
  console.log("[bg] Extension installed – mode set to baseline.");
});

chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.get("mode", (res) => {
    if (!res.mode) {
      chrome.storage.local.set({ mode: "baseline", userState: null, stateSource: null });
    }
  });
});

// Broadcast state change to all tabs
function broadcastStateChange(mode, userState, stateSource) {
  chrome.tabs.query({}, (tabs) => {
    console.log(`[bg] Broadcasting STATE_CHANGED to ${tabs.length} tab(s): mode=${mode}, userState=${userState}`);
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, {
        type: "STATE_CHANGED",
        mode,
        userState,
        stateSource
      }).then(() => {
        console.log(`[bg]   ✓ tab ${tab.id} received STATE_CHANGED`);
      }).catch((err) => {
        console.log(`[bg]   ✗ tab ${tab.id} unreachable: ${err.message || err}`);
      });
    }
  });
}

/* ---------------------------------------------------------------
   Text → State mapping (shared by popup + in-page widget)
--------------------------------------------------------------- */
const READABILITY_KW = [
  "read", "small", "tiny", "font", "text", "blurry", "blur", "zoom",
  "size", "letter", "spacing", "squint", "strain", "unclear", "legib"
];
const OVERLOAD_KW = [
  "much", "overload", "overwhelm", "clutter", "busy", "many",
  "simplif", "summariz", "hide", "collaps", "distract", "information",
  "noise", "dense", "crowd"
];

function mapTextToState(raw) {
  const text = raw.toLowerCase();
  let rScore = 0;
  let oScore = 0;
  for (const kw of READABILITY_KW) { if (text.includes(kw)) rScore++; }
  for (const kw of OVERLOAD_KW)    { if (text.includes(kw)) oScore++; }
  if (rScore === 0 && oScore === 0) return null;
  if (rScore > oScore) return "readability";
  if (oScore > rScore) return "overload";
  return null;
}

// Message router
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

  if (msg.type === "GET_STATE") {
    chrome.storage.local.get(["mode", "userState", "stateSource"], (res) => {
      sendResponse({
        mode: res.mode || "baseline",
        userState: res.userState || null,
        stateSource: res.stateSource || null
      });
    });
    return true;
  }

  if (msg.type === "SET_USER_STATE") {
    const { state, source } = msg; // state: "readability"|"overload", source: "explicit"|"implicit"
    const newMode = "adaptive";
    const updates = { mode: newMode, userState: state, stateSource: source };
    chrome.storage.local.set(updates, () => {
      console.log(`[bg] User state → ${state} (source: ${source}), mode → adaptive`);
      // No broadcast: popup sends APPLY_STATE_NOW directly to the active tab.
      // Broadcasting to all tabs caused cross-tab contamination.
      sendResponse({ ok: true, mode: newMode, userState: state, stateSource: source });
    });
    return true;
  }

  if (msg.type === "GET_PLAN_FOR_STATE") {
    const plan = PLANS[msg.state] || null;
    sendResponse({ plan });
    return true;
  }

  // Legacy: GET_PLAN returns the plan for the current userState
  if (msg.type === "GET_PLAN") {
    chrome.storage.local.get("userState", (res) => {
      const plan = res.userState ? PLANS[res.userState] : null;
      sendResponse({ plan });
    });
    return true;
  }

  if (msg.type === "SET_MODE") {
    const newMode = msg.mode; // "baseline" | "adaptive"
    const updates = { mode: newMode };
    if (newMode === "baseline") {
      updates.userState = null;
      updates.stateSource = null;
    }
    chrome.storage.local.set(updates, () => {
      console.log(`[bg] Mode changed → ${newMode}`);
      broadcastStateChange(newMode, newMode === "baseline" ? null : undefined, newMode === "baseline" ? null : undefined);
      sendResponse({ ok: true, mode: newMode });
    });
    return true;
  }

  if (msg.type === "SELECTION_CAPTURED") {
    console.log("[bg] Received SELECTION_CAPTURED message", msg);
    try {
      const text = msg.text || "";
      const url = msg.url || "(unknown)";
      console.log(`[bg] Selection captured (${text.length} chars) from ${url}`);
      const resp = {
        ok: true,
        mockSummary: `Received "${text.slice(0, 60)}${text.length > 60 ? "\u2026" : ""}"`,
        mockSuggestion: "Consider highlighting this passage for the reader."
      };
      console.log("[bg] Sending SELECTION_CAPTURED response", resp);
      sendResponse(resp);
    } catch (err) {
      console.error("[bg] SELECTION_CAPTURED handler error:", err);
      sendResponse({ ok: false, error: err.message });
    }
    return true;
  }

  if (msg.type === "GET_MODE") {
    chrome.storage.local.get(["mode", "userState", "stateSource"], (res) => {
      sendResponse({
        mode: res.mode || "baseline",
        userState: res.userState || null,
        stateSource: res.stateSource || null
      });
    });
    return true;
  }

  if (msg.type === "MAP_TEXT_TO_STATE") {
    const state = mapTextToState(msg.text || "");
    sendResponse({ state });
    return true;
  }
});
