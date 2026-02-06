
# schemas.py

from typing import Optional, Dict, Any, Literal
from pydantic import BaseModel, Field

# REQUEST SCHEMAS

class UserAudio(BaseModel):
    base64: str


class PageText(BaseModel):
    content: str


class InteractionSignals(BaseModel):
    constant_mouse_clicking: Optional[bool] = None
    frequent_zooming: Optional[bool] = None
    long_pauses: Optional[float] = None
    scroll_erratic: Optional[bool] = None
    idle_time: Optional[float] = None


class RequestPayload(BaseModel):
    user_text: Optional[str] = None
    user_audio: Optional[UserAudio] = None
    page_text: Optional[PageText] = None
    interaction_signals: Optional[InteractionSignals] = None


class RequestSchema(BaseModel):
    request_type: Literal["explicit", "implicit"]
    payload: RequestPayload


# RESPONSE SCHEMAS

class UIActions(BaseModel):
    font_scale: Optional[float] = None
    line_spacing: Optional[float] = None
    contrast: Optional[Literal["normal", "high"]] = None
    simplify_layout: Optional[bool] = None
    hide_distractions: Optional[bool] = None
    highlight_focus: Optional[bool] = None


class SummaryAction(BaseModel):
    enabled: bool
    text: Optional[str] = None


class AudioAction(BaseModel):
    enabled: bool
    audio_format: Optional[str] = None
    audio_base64: Optional[str] = None


class FlashcardAction(BaseModel):
    enabled: bool
    image_base64: Optional[str] = None


class ContentActions(BaseModel):
    summary: SummaryAction
    audio: AudioAction
    flashcards: FlashcardAction


class ResponseSchema(BaseModel):
    mode: Literal["apply", "suggest"]
    ui_actions: UIActions
    content_actions: ContentActions
