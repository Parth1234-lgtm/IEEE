# Project Context — Attention-Adaptive UI (Hackathon)

This is a hackathon demo project.

## Core Idea
An attention-adaptive browser interface that:
- Adapts the UI, NOT the user
- Does NOT diagnose or label users
- Uses temporary page states (page-level), not personal traits
- Is explainable, reversible, and non-intrusive

## Architecture
Browser Extension demo with pipeline:
Signals → AdaptationPlan(JSON) → UI Changes (DOM/CSS)

Target page: demo/index.html only  
No persistence. Deterministic logic only (no LLMs).

## Supported States
- READABILITY — difficulty reading content
- OVERLOAD — information overload

These are page states, not user attributes.

## Inputs
1) Explicit (manual) — available from THREE surfaces:
- **Extension popup**: buttons ("Hard to read", "Too much information"), free-text input + Go, voice (mic) button
- **In-page floating widget** (bottom-right "Adaptive UI" panel): same buttons, free-text input + Go, voice (mic) button, status line
- Both surfaces share the same keyword mapping logic (lives in background.js `MAP_TEXT_TO_STATE`).
Explicit actions must auto-switch to Adaptive and apply immediately on the active demo tab.

2) Implicit (behavior):
- Scroll / dwell / reread / zoom signals with demo-friendly thresholds + cooldowns

3) Explicit (new): Text selection signal
- When user selects text on the demo page, capture the selected text and send to backend (mock first).

## Voice Input Note
Voice input (SpeechRecognition) requires a **secure context** (localhost or HTTPS).
Running the demo via `file://` will typically deny microphone access. When denied, the widget/popup status line shows a clear message.

## UI Constraints
- UI changes must be visually obvious.
- All adaptations must be fully reversible via Baseline toggle.
- No medical/accessibility/mental health framing.
- Multi-tab safety: only affect active tab in current window; ignore non-demo pages.


