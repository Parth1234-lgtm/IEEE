# change_modality/summariser.py
import os
from google import genai

client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))

def generate_summary(page_text: str, length: str = "short") -> str:
    """
    Generate a clean, accessibility-friendly summary from webpage text.
    """

    if not page_text or len(page_text.strip()) == 0:
        return ""

    if length not in ("short", "medium"):
        raise ValueError("length must be 'short' or 'medium'")

    target_words = "80–120 words" if length == "short" else "150–250 words"

    prompt = f"""
You are an accessibility-focused summarization engine.

TASK:
Summarize the following webpage content into a clear, neutral, easy-to-understand summary.

REQUIREMENTS:
- Length: {target_words}
- Use simple sentences
- No bullet points
- No headings
- No markdown
- No emojis
- No references to AI, models, or summarization
- Preserve factual meaning only
- Do not add new information

WEBPAGE CONTENT:
{page_text[:8000]}

Return ONLY the summary text.
"""

    response = client.models.generate_content(
        model="gemini-2.5-flash",
        contents=prompt
    )

    return response.text.strip()
