# change_modality/tts.py
import asyncio
import base64
import edge_tts
import tempfile
from pathlib import Path

VOICE = "en-US-JennyNeural"  # good default VOICE_MODEL

async def _generate_audio(text: str, output_path: Path):
    communicate = edge_tts.Communicate(text, VOICE)
    await communicate.save(str(output_path))

def text_to_speech(text: str) -> dict:
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        audio_path = Path(f.name)

    asyncio.run(_generate_audio(text, audio_path))

    audio_bytes = audio_path.read_bytes()
    audio_base64 = base64.b64encode(audio_bytes).decode("utf-8")

    audio_path.unlink(missing_ok=True)

    return {
        "audio_format": "wav",
        "audio_base64": audio_base64
    }
