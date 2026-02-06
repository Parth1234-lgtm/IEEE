# change_modality/txt_to_image.py

"""
Stubbed text-to-image module.

This implementation is intentionally lightweight and safe.
It preserves the exact contract expected by pipeline.py:

    text_to_image(summary_text: str) -> dict
        {
            "image_base64": str
        }
"""

def text_to_image(summary_text: str) -> dict:
    """
    Stub for text-to-image generation.

    Parameters
    ----------
    summary_text : str
        Short summary text generated from page content.

    Returns
    -------
    dict
        Dictionary with key 'image_base64', exactly as expected
        by the pipeline and response schema.
    """

    # Pipeline already checks page_text + enabled flags,
    # but we stay defensive.
    if not isinstance(summary_text, str):
        return {"image_base64": ""}

    if not summary_text.strip():
        return {"image_base64": ""}

    # Placeholder base64 string.
    # Frontend can render a dummy image / flashcard UI.
    return {
        "image_base64": "PLACEHOLDER_IMAGE_BASE64"
    }
