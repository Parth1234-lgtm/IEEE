
from typing import Dict, Any, Optional, List

from audio_to_text import audio_to_text
from llm import infer_accessibility_actions
from change_modality.summariser import generate_summary
from change_modality.txt_to_image import text_to_image
from change_modality.tts import text_to_speech

def handle_request(request_json):
    request_type = request_json["request_type"]
    payload = request_json["payload"]

    user_text = payload.get("user_text")
    user_audio = payload.get("user_audio")
    page_text = (payload.get("page_text") or {}).get("content")
    interaction_signals = payload.get("interaction_signals")

    # Hardwired mode rules (LLM cannot override)
    desired_mode = "apply" if request_type == "explicit" else "suggest"

    # 1. Audio → text (intent only)
    if user_audio:
        user_text = audio_to_text(user_audio["base64"])

    # 2. LLM decides actions
    actions = infer_accessibility_actions(
        request_type=request_type,
        user_text=user_text,
        page_text=page_text,
        interaction_signals=interaction_signals
    )

    # 2b. Shape strictly to schemas.py (never invent / never return extra fields)
    raw_ui = (actions or {}).get("ui_actions") or {}
    ui_actions: Dict[str, Any] = {}

    # Clamp/validate common UI action fields defensively
    def _clamp_float(v: Any, lo: float, hi: float) -> Optional[float]:
        try:
            f = float(v)
        except Exception:
            return None
        return max(lo, min(hi, f))

    if raw_ui.get("font_scale") is not None:
        ui_actions["font_scale"] = _clamp_float(raw_ui.get("font_scale"), 0.8, 2.0)
    if raw_ui.get("line_spacing") is not None:
        ui_actions["line_spacing"] = _clamp_float(raw_ui.get("line_spacing"), 0.8, 2.5)
    if raw_ui.get("contrast") in ("normal", "high"):
        ui_actions["contrast"] = raw_ui.get("contrast")
    for k in ("simplify_layout", "hide_distractions", "highlight_focus"):
        if raw_ui.get(k) is not None:
            ui_actions[k] = bool(raw_ui.get(k))

    raw_ca = (actions or {}).get("content_actions") or {}
    summary_cfg = (raw_ca.get("summary") or {})
    audio_cfg = (raw_ca.get("audio") or {})
    flash_cfg = (raw_ca.get("flashcards") or {})

    summary_enabled = bool(summary_cfg.get("enabled", False))
    # Note: schema does not include "length", but LLM may output it; we use it internally only.
    summary_length = summary_cfg.get("length") or "short"
    if summary_length not in ("short", "medium"):
        summary_length = "short"

    audio_enabled = bool(audio_cfg.get("enabled", False))
    flash_enabled = bool(flash_cfg.get("enabled", False))

    response: Dict[str, Any] = {
        "mode": desired_mode,
        "ui_actions": ui_actions,
        "content_actions": {
            "summary": {"enabled": False},
            "audio": {"enabled": False},
            "flashcards": {"enabled": False},
        },
    }

    # 3. SUMMARY (independent)
    if page_text and summary_enabled:
        summary_text = generate_summary(page_text, summary_length)
        response["content_actions"]["summary"] = {"enabled": True, "text": summary_text}

    # 4. AUDIO (independent)
    if page_text and audio_enabled:
        audio_summary = generate_summary(page_text, "short")
        audio_payload = text_to_speech(audio_summary)
        response["content_actions"]["audio"] = {"enabled": True, **audio_payload}

    # 5. IMAGE (independent)
    if page_text and flash_enabled:
        image_summary = generate_summary(page_text, "short")
        image_payload = text_to_image(image_summary)
        response["content_actions"]["flashcards"] = {"enabled": True, **image_payload}

    return response

