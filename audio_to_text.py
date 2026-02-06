import whisper
import torch
import tempfile
import base64

MODEL_NAME = "base"
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

model = whisper.load_model(MODEL_NAME).to(DEVICE)


def audio_to_text(base64_audio:str)->str:
    # 1.Decode base64
    audio_bytes = base64.b64decode(base64_audio)

    # 2.write temp wav file(as whisper access files in ur hard drive so just create a temp file no need ot store data)
    with tempfile.NamedTemporaryFile(suffix=".wav",delete=True) as tmp: # as opened with with and deleteis true automaticlaly deletes temp file form harddisk
        tmp.write(audio_bytes)
        tmp.flush()

        #3.load+preprocess audio
        audio=whisper.load_audio(tmp.name)
        audio=whisper.pad_or_trim(audio)

        mel=whisper.log_mel_spectrogram(audio).to(model.device)
        """gives a spectogram ,frequency domained signal using fourier tarnsform as 
        model understand these better rather then these raw waveforms """

        #4.decode
        options=whisper.DecodingOptions(fp16=(DEVICE=="cuda"))
        result = whisper.decode(model, mel, options)

    return result.text
        
    
        


