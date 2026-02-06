
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, Dict, Any

app = FastAPI(
    title="Adaptive Accessibility Backend",
    description="Backend API for real-time UI adaptation",
    version="1.0.0"
)

# Allow extension (and local tools) to call the API via fetch.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Lightweight endpoints for extension demo ──────────────────────────

@app.get("/health")
def health():
    return {"ok": True}


class AdaptRequest(BaseModel):
    state: Optional[str] = None
    url: Optional[str] = None
    signals: Optional[Dict[str, Any]] = None


ADAPT_PLANS: Dict[str, Dict[str, Any]] = {
    "readability": {
        "mode": "apply",
        "confidence": 0.85,
        "ui_actions": {
            "font_scale": 1.4,
            "line_spacing": 1.8,
            "contrast": "high",
            "simplify_layout": False,
            "highlight_focus": True,
            "hide_distractions": False
        },
        "explanation": "Readability adaptations: increased font size to 1.4x, line spacing 1.8, high contrast, key sentence highlighting."
    },
    "overload": {
        "mode": "apply",
        "confidence": 0.82,
        "ui_actions": {
            "font_scale": 1.1,
            "line_spacing": 1.6,
            "contrast": "normal",
            "simplify_layout": True,
            "highlight_focus": False,
            "hide_distractions": True
        },
        "explanation": "Overload reduction: simplified layout, increased spacing, distractions hidden."
    }
}


@app.post("/adapt")
def adapt(request: AdaptRequest):
    state = request.state or "readability"
    if state not in ADAPT_PLANS:
        state = "readability"
    plan = dict(ADAPT_PLANS[state])
    plan["state"] = state
    return plan


# ── Legacy /process endpoint (requires full pipeline dependencies) ────

try:
    from schemas import RequestSchema, ResponseSchema
    from pipeline import handle_request

    @app.post("/process", response_model=ResponseSchema)
    def process_request(request: RequestSchema):
        request_dict = request.model_dump()
        response = handle_request(request_dict)
        return response
except Exception:
    pass
