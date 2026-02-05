# Project Context — Attention-Adaptive UI (Hackathon)

This is a hackathon demo project.

## Core Idea
An attention-adaptive browser interface that:
- Adapts the UI, NOT the user
- Does NOT diagnose or label users
- Uses temporary page states, not personal traits
- Is explainable, reversible, and non-intrusive

## Architecture
Browser Extension demo with pipeline:
Signals → AdaptationPlan(JSON) → UI Changes (DOM/CSS)

Target page: demo/index.html only  
No persistence. No LLMs. Deterministic logic only.

## Supported States
Only these two states exist:
- READABILITY — difficulty reading content
- OVERLOAD — information overload

These are page states, not user attributes.

## Input Channels
1) Explicit:
- Popup buttons: “Hard to read” → READABILITY
- “Too much information” → OVERLOAD
- Explicit actions must auto-switch to Adaptive mode and apply the correct plan.

2) Implicit:
- Behavior-based triggers from scroll, reread, zoom signals.
- Demo-friendly thresholds and cooldowns.

## UI Constraints
- UI changes must be visually obvious.
- All adaptations must be fully reversible via Baseline toggle.
- No medical, accessibility, or mental health framing.

## Current Task (IMPORTANT)
We are debugging the system.

Known issues previously identified:
1) Explicit popup buttons do not reliably reach the content script (missing fallback path).
2) rereads/min spikes due to dividing by too-short elapsed time.
3) scroll metrics not trimmed, leading to stale averages.
4) zoom oscillations often stuck at 0 due to logic.
5) text highlight replacement bug ($-unsafe replace).

Some fixes were started but NOT completed due to session limit.

### Goal now:
- Resume debugging from this state.
- Fix explicit button flow end-to-end.
- Stabilize metrics for demo use.
- Apply minimal patches only (do not re-architect).
