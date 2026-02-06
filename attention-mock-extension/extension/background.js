/* ===================================================================
   Background Service Worker (minimal)
   - Networking uses fetch in popup + content script (per requirements)
   - Content script owns per-page adaptation state
   =================================================================== */

chrome.runtime.onInstalled.addListener(() => {
  console.log("[bg] Installed.");
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "PING") {
    sendResponse({ ok: true });
    return true;
  }
});
