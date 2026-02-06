
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

    response = {
        "mode": actions["mode"],
        "confidence": actions["confidence"],
        "ui_actions": actions["ui_actions"],
        "content_actions": {},
        "explanation": actions["reason"]
    }

    # 3. SUMMARY (independent)
    if page_text and actions["content_actions"]["summary"]["enabled"]:
        summary_text = generate_summary(
            page_text,
            actions["content_actions"]["summary"]["length"]
        )
        response["content_actions"]["summary"] = {
            "enabled": True,
            "text": summary_text
        }
    else:
        response["content_actions"]["summary"] = {"enabled": False}

    # 4. AUDIO (independent)
    if page_text and actions["content_actions"]["audio"]["enabled"]:
        audio_summary = generate_summary(page_text, "short")
        audio_payload = text_to_speech(audio_summary)
        response["content_actions"]["audio"] = {
            "enabled": True,
            **audio_payload
        }
    else:
        response["content_actions"]["audio"] = {"enabled": False}

    # 5. IMAGE (independent)
    if page_text and actions["content_actions"]["flashcards"]["enabled"]:
        image_summary = generate_summary(page_text, "short")
        image_payload = text_to_image(image_summary)
        response["content_actions"]["flashcards"] = {
            "enabled": True,
            **image_payload
        }
    else:
        response["content_actions"]["flashcards"] = {"enabled": False}

    return response

