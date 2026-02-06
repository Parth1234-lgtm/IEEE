import os
import json
from typing import Dict, List, Optional
from google import genai

client = genai.Client(
    api_key=os.getenv("GEMINI_API_KEY")
)


# -----------------------------
# Heuristic → semantic hints
# -----------------------------

def derive_accessibility_hints(signals: Dict) -> List[str]:
    """
    Convert raw interaction signals into semantic accessibility hints.
    These are NOT diagnoses, only friction indicators.
    """
    hints = []

    # Prefer schema-aligned fields (schemas.py InteractionSignals)
    if signals.get("constant_mouse_clicking") is True:
        hints.append("possible_motor_difficulty")

    if signals.get("frequent_zooming") is True:
        hints.append("possible_low_vision")

    # long_pauses / idle_time are floats (seconds)
    try:
        if float(signals.get("long_pauses") or 0) >= 15:
            hints.append("possible_cognitive_load")
    except Exception:
        pass

    if signals.get("scroll_erratic") is True:
        hints.append("possible_cognitive_load")

    try:
        if float(signals.get("idle_time") or 0) >= 20:
            hints.append("possible_cognitive_load")
    except Exception:
        pass

    # Backwards-compat / non-schema fields (ignored by schema validation on ingress,
    # but safe here if present from older clients)
    if signals.get("misclick_count", 0) >= 5:
        hints.append("possible_motor_difficulty")
    if signals.get("zoom_count", 0) >= 3:
        hints.append("possible_low_vision")
    if signals.get("long_pause_seconds", 0) >= 15:
        hints.append("possible_cognitive_load")

    return hints


# 🔹 NEW: condition-based hints (context, not diagnosis)
def derive_condition_hints(user_text: Optional[str]) -> List[str]:
    """
    Infer accessibility-related context from explicitly mentioned conditions.
    This does NOT diagnose or assume severity.
    """
    if not user_text:
        return []

    text = user_text.lower()
    hints = []

    if any(k in text for k in ["adhd", "attention deficit", "add"]):
        hints.append("possible_cognitive_load")

    if any(k in text for k in ["dyslexia", "reading disorder"]):
        hints.append("possible_reading_difficulty")

    if any(k in text for k in ["parkinson", "motor disorder", "tremor", "dystonia"]):
        hints.append("possible_motor_difficulty")

    if any(k in text for k in ["low vision", "visually impaired", "poor eyesight"]):
        hints.append("possible_low_vision")

    return hints


# -----------------------------
# Safe JSON parsing
# -----------------------------

def safe_json_parse(text: str) -> Dict:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {
            "mode": "suggest",
            "ui_actions": {
                "font_scale": 1.0,
                "line_spacing": 1.0,
                "contrast": "normal",
                "simplify_layout": False,
                "hide_distractions": False,
                "highlight_focus": False
            },
            "content_actions": {
                "summary": {"enabled": False, "length": "short"},
                "audio": {"enabled": False},
                "flashcards": {"enabled": False}
            },
            "reason": "LLM output parsing failed",
            "confidence": 0.0
        }


# -----------------------------
# Core LLM reasoning function
# -----------------------------

def infer_accessibility_actions(
    request_type: str,                 # "explicit" | "implicit"
    user_text: Optional[str],
    page_text: Optional[str],
    interaction_signals: Optional[Dict]
) -> Dict:
    """
    Uses an LLM to decide accessibility adaptations.
    Returns STRICT JSON describing UI + content actions.
    """

    signals = interaction_signals or {}

    # Existing signal-based hints
    signal_hints = derive_accessibility_hints(signals)

    # 🔹 NEW: condition-based hints
    condition_hints = derive_condition_hints(user_text)

    # Merge hints (no duplicates)
    hints = list(set(signal_hints + condition_hints))

    # Mode decision stays OUTSIDE LLM
    mode = "apply" if request_type == "explicit" else "suggest"

    prompt = f"""
You are an accessibility reasoning engine.

IMPORTANT:
- Mentions of medical or neurological conditions are CONTEXT, not commands.
- Do NOT assume severity.
- Prefer suggestion mode unless user explicitly requests changes.

INPUTS:
- Request type: {request_type}
- Mode (already decided): {mode}
- User message: {user_text}
- Interaction signals: {signals}
- Page content (may be empty): {page_text[:2000] if page_text else "None"}

DERIVED ACCESSIBILITY CONTEXT:
{hints}

TASK:
1. Use the derived context and user message to infer accessibility friction.
2. Do NOT change the provided mode.
3. Decide UI adaptations using ONLY the allowed UI actions.
4. Decide content modality changes ONLY if page_text is provided.
5. Return STRICT JSON in the schema below.
6. Do NOT add explanations outside the JSON.

INTERPRETATION RULES:
- possible_motor_difficulty:
  Prefer increased spacing, simplified layout, reduced precision.
- possible_low_vision:
  Prefer larger font, higher contrast, audio if content exists.
- possible_cognitive_load:
  Prefer simplified layout, hiding distractions, summaries.
- possible_reading_difficulty:
  Prefer summaries and audio if content exists.

CONTENT MODALITY DECISION RULES:
- Enable "summary" if:
  • user explicitly asks to summarize, simplify, or shorten, OR
  • cognitive or reading difficulty is indicated AND page_text exists.
- Enable "audio" if:
  • user explicitly asks to listen, OR
  • visual or reading difficulty is indicated AND page_text exists.
- Enable "flashcards" ONLY if:
  • user explicitly asks for flashcards or key points.
- If page_text is empty:
  • Do NOT enable summary, audio, or flashcards.

UI ACTION CONSTRAINTS:
- font_scale ∈ [1.0, 1.6]
- line_spacing ∈ [1.0, 1.6]

JSON SCHEMA:
{{
  "mode": "apply | suggest",
  "ui_actions": {{
    "font_scale": float,
    "line_spacing": float,
    "contrast": "normal | high",
    "simplify_layout": boolean,
    "hide_distractions": boolean,
    "highlight_focus": boolean
  }},
  "content_actions": {{
    "summary": {{ "enabled": boolean, "length": "short | medium" }},
    "audio": {{ "enabled": boolean }},
    "flashcards": {{ "enabled": boolean }}
  }},
  "reason": string,
  "confidence": float
}}

Return JSON ONLY.
"""

    response = client.models.generate_content(
        model="gemini-2.5-flash",
        contents=prompt
    )

    return safe_json_parse(response.text)
