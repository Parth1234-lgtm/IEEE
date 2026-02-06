# CLAUDE CONTEXT — IEEE Hackathon Project

## Project Type
This is a **time-constrained hackathon project**, not a production system.

Primary goal: **a working demo before deadline**, not clean architecture.

## What this project is
An **Attention-Adaptive Browser Extension**:
- Frontend: Chrome/Edge Extension (Manifest V3)
- Backend: Local Python server (expected: FastAPI)
- Flow:
  Browser signals / explicit user actions
  → backend decision (JSON)
  → frontend applies UI changes (DOM/CSS)

## What already exists
- `attention-mock-extension/`: working extension with mock backend logic
- Python files in repo root:
  - `pipeline.py`, `schemas.py`, `utils.py`, `llm.py`, `audio_to_text.py`
  - These were designed to support a backend decision pipeline
- The frontend **already knows how to apply UI changes**
- The missing piece is: **a real backend HTTP endpoint**

## Current problem
- Frontend was previously connected to a mock backend
- We now need a **real local backend**
- The backend does NOT need to be smart
- The backend ONLY needs to:
  1. Accept JSON from frontend
  2. Return a deterministic adaptation plan JSON
  3. Be callable from the extension via `fetch("http://localhost:8000/...")`

## Success criteria (VERY IMPORTANT)
This task is successful if:
- A local Python server can be started with ONE command
- The extension can call it via HTTP
- The response triggers **at least 2 visible UI adaptations**
  (e.g. font size + layout simplification)
- Demo can show **Baseline vs Adaptive** comparison

Nothing else is required.

## Explicit non-goals
DO NOT:
- Refactor the whole project
- Introduce databases
- Add authentication
- Add background jobs
- Optimize prompts
- Add tests
- Change frontend UI logic unless required to connect backend

## Preferred solution
- Use **FastAPI**
- Enable CORS
- Minimal dependencies
- Deterministic responses are acceptable (no LLM call required)

## Mindset
When in doubt:
> “Does this help the demo work in 30 minutes?”

If not, skip it.
