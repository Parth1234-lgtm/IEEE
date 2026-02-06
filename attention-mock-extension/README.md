# Attention-Adaptive UI — Mock Demo Extension

A Manifest V3 browser extension that demonstrates the pipeline:
**Attention Signals → Mock Adaptation Plan (JSON) → Live UI Changes + Metrics.**

No backend, no API keys, no frameworks. Fully local.

---

## Folder Structure

```
attention-mock-extension/
├── extension/            ← Load this folder as an unpacked extension
│   ├── manifest.json
│   ├── background.js     ← Mock Adaptation Plan JSON + mode management
│   ├── content.js        ← Signal collection + adaptation apply/revert
│   ├── content.css       ← Injected styles for adaptations
│   ├── popup.html        ← Popup UI
│   ├── popup.js          ← Toggle logic + metric polling
│   └── popup.css         ← Popup styles
├── demo/
│   └── index.html        ← Controlled demo page (open this in the browser)
└── README.md
```

---

## Setup (2 minutes)

### Step 1 — Load the extension

1. Open **Chrome** or **Edge**.
2. Go to `chrome://extensions` (or `edge://extensions`).
3. Enable **Developer mode** (toggle in the top-right).
4. Click **Load unpacked**.
5. Select the `extension/` folder inside this repo.
6. The extension icon ("Adaptive UI") appears in the toolbar.

### Step 2 — Enable file URL access

Because the demo page is a local HTML file:

1. On the extensions page, find **Attention-Adaptive UI (Mock Demo)**.
2. Click **Details**.
3. Enable **Allow access to file URLs**.

### Step 3 — Open the demo page

Open `demo/index.html` in the same browser:
- Double-click the file, **or**
- Drag it into the browser, **or**
- Use `File → Open File`.

---

## How to Use

### Toggle Baseline vs Adaptive

1. Click the extension icon in the toolbar to open the popup.
2. Flip the toggle switch.
   - **Baseline** (left): No changes — the page looks exactly as authored.
   - **Adaptive** (right): All adaptations are applied immediately.
3. Flip back to **Baseline**: all changes revert cleanly.

### What changes in Adaptive mode (4 visible adaptations)

| # | Adaptation | What you see |
|---|-----------|-------------|
| 1 | **Readability boost** | Font size increases, line-height widens, content column narrows and centres. |
| 2 | **Paragraph cards** | Each paragraph wraps into a distinct card with border, shadow, and rounded corners. |
| 3 | **Summary block** | A blue "Key Takeaway" banner appears at the top of the article. |
| 4 | **Peripheral dimming** | Nav bar, sidebar, and footer fade to 25% opacity. |

### Trigger the live metric

1. With the demo page open and the popup visible:
2. **Scroll down** through the article — the "Avg scroll (px)" and "Elapsed" counters update.
3. **Scroll back up** to content you already read — this triggers **reread events**.
4. Watch "Re-reads / min" and "Total re-reads" climb in the popup.

---

## What to Screen-Record

Recommended flow for a ~60-second demo recording:

1. Show the demo page in Baseline mode (clean article).
2. Open the extension popup.
3. Toggle to **Adaptive** — pause to show all 4 visual changes.
4. Scroll slowly through the article, then scroll back up.
5. Show the popup metrics updating live.
6. Toggle back to **Baseline** — show clean revert.
7. (Optional) Open DevTools Console to show the `[content]` log messages.

---

## Debugging

- Open DevTools → Console on the demo page.
- All key events are logged with `[content]` prefix:
  - `[content] Mode → adaptive`
  - `[content] Applying adaptations…`
  - `[content] Reread detected at bucket N`
  - `[content] All adaptations reverted.`
- Background logs use `[bg]` prefix (visible in the extension's service worker console).
- Popup logs use `[popup]` prefix.

---

## Technical Notes

- **No external dependencies.** Everything is vanilla JS/CSS/HTML.
- **No LLM or API calls.** The adaptation plan is a hardcoded JSON object in `background.js`.
- **Signal collection:** scroll velocity, viewport dwell (IntersectionObserver), reread heuristic (upward scroll into previously-viewed zone).
- **Metrics:** stored in `chrome.storage.local`, polled by the popup every 600ms.
- **Clean revert:** readability uses CSS class toggle, cards are unwrapped, summary block is removed, dimming class is stripped. No DOM leaks.
