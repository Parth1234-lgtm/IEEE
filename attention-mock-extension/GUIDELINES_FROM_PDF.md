# Frozen Frontend ↔ Backend Contract Specification

This document defines the **exact JSON contract** between frontend and backend.
Frontend engineers should implement strictly against this spec.
No guessing. No interpretation. No additional fields.

---

## 1. Frontend → Backend Input

All frontend requests are standardized under **one common envelope**.

### 1.1 Common Request Envelope

```json
{
  "request_type": "explicit | implicit",
  "session_id": "uuid-or-tab-id",
  "page_context": {
    "url": "https://example.com",
    "title": "Page title"
  },
  "timestamp": 1739000000,
  "payload": {}
}
request_type determines how the backend interprets the request

session_id can be a tab ID or UUID

timestamp is a unix timestamp (seconds)

1.2 Implicit Input (Signal-Based)
Implicit input represents behavioral signals, batched every 30–60 seconds.

{
  "request_type": "implicit",
  "session_id": "tab-123",
  "page_context": {
    "url": "https://wikipedia.org/...",
    "title": "Neural Networks"
  },
  "timestamp": 1739000000,
  "payload": {
    "interaction_signals": {
      "zoom_count": 4,
      "long_pause_seconds": 18,
      "scroll_erratic_score": 0.72,
      "idle_time_seconds": 12,
      "rapid_clicking": false,
      "misclick_count": 3
    }
  }
}
Notes
All signals must be numbers or booleans

No raw event streams are sent

Backend decides thresholds, not frontend

1.3 Explicit User Input (Text / Audio)
Explicit input is sent when the user clearly asks for something.

A) Text Input
{
  "request_type": "explicit",
  "session_id": "tab-123",
  "page_context": {
    "url": "https://news.com/...",
    "title": "Breaking News"
  },
  "timestamp": 1739000000,
  "payload": {
    "user_text": "Summarize this",
    "user_audio": null,
    "page_text": {
      "source": "selection",
      "content": "The selected paragraph or highlighted text here..."
    }
  }
}
B) Audio Input
{
  "request_type": "explicit",
  "session_id": "tab-123",
  "page_context": {
    "url": "https://news.com/...",
    "title": "Breaking News"
  },
  "timestamp": 1739000000,
  "payload": {
    "user_text": null,
    "user_audio": {
      "encoding": "wav",
      "sample_rate": 16000,
      "base64": "UklGRjQAAABXQVZF..."
    },
    "page_text": {
      "source": "selection",
      "content": "The selected paragraph or highlighted text here..."
    }
  }
}
Backend runs audio_to_text.py only if user_audio != null

2. Backend → Frontend Response (Explicit Requests)
Explicit responses are DIRECT APPLY.
The user clearly asked for help.

2.1 Explicit Response Format
{
  "mode": "apply",
  "confidence": 0.92,
  "ui_actions": {
    "font_scale": 1.5,
    "line_spacing": 1.4,
    "contrast": "high",
    "simplify_layout": true,
    "highlight_focus": true
  },
  "content_actions": {
    "summary": {
      "enabled": true,
      "text": "This article explains the basics of neural networks..."
    },
    "audio": {
      "enabled": true,
      "audio_format": "mp3",
      "audio_base64": "SUQzBAAAAAAA..."
    },
    "flashcards": {
      "enabled": false,
      "cards": []
    }
  },
  "explanation": "User reported reading difficulty; increased text size and provided audio summary."
}
2.2 Frontend Responsibilities
ui_actions → applied directly by content.js

content_actions.summary.text → injected summary panel

content_actions.audio.audio_base64 → create <audio> blob and play

flashcards.cards → optional DOM cards

No guessing. No interpretation.

3. Backend → Frontend Response (Implicit Signals)
Implicit responses are SUGGESTION MODE.
The user did NOT explicitly ask.

3.1 Suggestion Response Format
{
  "mode": "suggest",
  "confidence": 0.67,
  "suggestion_text": "We noticed repeated zooming and long pauses. Would you like larger text and a simplified layout?",
  "proposed_ui_actions": {
    "font_scale": 1.4,
    "contrast": "high",
    "simplify_layout": true
  },
  "proposed_content_actions": {
    "summary": {
      "enabled": false
    },
    "audio": {
      "enabled": false
    }
  }
}
3.2 Frontend Behavior
Show a floating suggestion banner

If user clicks Apply:

Apply proposed_ui_actions

If user clicks Dismiss:

Do nothing

No extra backend call required

4. Reset & State Tracking (Frontend Only)
4.1 Stored Active Adaptations
Stored in chrome.storage:

{
  "active_ui_actions": {
    "font_scale": 1.5,
    "contrast": "high"
  },
  "active_content_actions": {
    "summary": true,
    "audio": true
  }
}
4.2 Popup Display Example
Active Adaptations:
• Font scale: 1.5×
• High contrast
• Audio summary enabled
4.3 Reset Action
Frontend sends:

{ "action": "reset" }
Reset Effects
Remove injected styles

Remove injected panels

Clear stored state

Restore baseline UI for comparison