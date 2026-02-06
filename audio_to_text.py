import base64
import os
import tempfile
import whisper
import torch

MODEL_NAME = "base"
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

model = whisper.load_model(MODEL_NAME).to(DEVICE)

def audio_to_text(base64_audio: str) -> str:
    if not base64_audio:
        return ""

    # Strip data URL prefix if present
    if "," in base64_audio:
        base64_audio = base64_audio.split(",")[1]

    # Fix base64 padding
    missing_padding = len(base64_audio) % 4
    if missing_padding:
        base64_audio += "=" * (4 - missing_padding)

    audio_bytes = base64.b64decode(base64_audio)

    # ✅ FRONTEND SENDS WAV → SAVE AS WAV
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp.write(audio_bytes)
        tmp_path = tmp.name

    try:
        audio = whisper.load_audio(tmp_path)
        audio = whisper.pad_or_trim(audio)

        mel = whisper.log_mel_spectrogram(audio).to(model.device)

        result = whisper.decode(
            model,
            mel,
            whisper.DecodingOptions(fp16=(DEVICE == "cuda"))
        )

        return result.text

    finally:
        try:
            os.remove(tmp_path)
        except Exception:
            pass
