"""Memory-only PCM recognizer. No microphone, files, network, or transcripts."""
import base64
import json
import os
import sys
import io
import wave
from pathlib import Path

import numpy as np
import sherpa_onnx

# Reap the model if the Node parent dies uncleanly (Linux).
if sys.platform.startswith("linux"):
    import ctypes
    ctypes.CDLL(None).prctl(1, 15)
    if os.getppid() == 1:
        sys.exit(0)

root = Path(sys.argv[1])
speaking = len(sys.argv) > 2 and sys.argv[2] == 'tts'
waking = len(sys.argv) > 2 and sys.argv[2] == 'wake'
# docs/VOICE.md - Microsoft Edge neural voices through the unofficial
# edge-tts endpoint: text leaves the machine, audio comes back as MP3. The
# Node side falls back to local Kokoro when this child fails.
edge = len(sys.argv) > 2 and sys.argv[2] == 'edge'
if edge:
    import asyncio
    import edge_tts
    edge_voice = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3].count('-') >= 2 else 'en-GB-SoniaNeural'

    def edge_speak(text):
        async def run():
            data = bytearray()
            async for chunk in edge_tts.Communicate(text, edge_voice).stream():
                if chunk['type'] == 'audio':
                    data.extend(chunk['data'])
            return bytes(data)
        return asyncio.run(run())
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        try:
            text = json.loads(line)['text']
            if not isinstance(text, str) or not 0 < len(text) <= 500:
                raise ValueError('Invalid speech text')
            audio = edge_speak(text)
            if not audio:
                raise ValueError('No audio')
            print(json.dumps({'audio': base64.b64encode(audio).decode('ascii'), 'format': 'mp3'}), flush=True)
        except Exception:
            print(json.dumps({"error": "Edge speech failed."}), flush=True)
    sys.exit(0)
phrase_model = None
grammar = ['computer', 'end capture', 'cancel capture', 'hey computer',
           'a computer', 'the computer', 'over', 'execute', 'engage',
           'make it so', 'cancel', 'belay that', 'never mind', '[unk]']
if waking or not speaking:
    phrase_root = root if waking else root.parent / 'vosk-model-small-en-us-0.15'
    if (phrase_root / 'am' / 'final.mdl').is_file():
        try:
            import vosk
            vosk.SetLogLevel(-1)
            phrase_model = vosk.Model(str(phrase_root))
        except Exception:
            if waking:
                raise

def phrase_recognizer():
    return vosk.KaldiRecognizer(phrase_model, 16000, json.dumps(grammar))

def recognize_phrases(pcm):
    if phrase_model is None:
        return ''
    decoder = phrase_recognizer()
    phrases = []
    for offset in range(0, len(pcm), 8000):
        if decoder.AcceptWaveform(pcm[offset:offset + 8000]):
            phrases.append(json.loads(decoder.Result()).get('text', ''))
    phrases.append(json.loads(decoder.FinalResult()).get('text', ''))
    result = ' '.join(p for p in phrases if p)
    # A long directive can make the small grammar swallow the closing words
    # into [unk]. Independently decode the trailing window as well; this
    # changes only reserved-boundary metadata, never the directive body.
    # Also for short segments: after a 350 ms endpoint the closing phrase is
    # usually its own short segment, which the earlier >2.5 s gate skipped.
    if not result.endswith(('end capture', 'cancel capture')):
        tail = vosk.KaldiRecognizer(phrase_model, 16000, json.dumps(['end capture', 'cancel capture', '[unk]']))
        tail.AcceptWaveform(pcm[-80000:])
        closing = json.loads(tail.FinalResult()).get('text', '')
        for phrase in ('end capture', 'cancel capture'):
            if closing.endswith(phrase):
                result += ' ' + phrase
                break
    return result

if waking:
    if phrase_model is None:
        raise ValueError('Install the local phrase model with voice:setup')
    wake_stream = None
    wake_done = False
    wake_samples = 0
elif speaking:
    if (root / 'voices.bin').is_file():
        model = sherpa_onnx.OfflineTtsModelConfig(
            kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(
                model=str(root / 'model.onnx'), voices=str(root / 'voices.bin'),
                tokens=str(root / 'tokens.txt'), data_dir=str(root / 'espeak-ng-data'),
                lexicon=str(root / 'lexicon-gb-en.txt'), lang='en'),
            num_threads=2, provider='cpu', debug=False)
        speaker_id = 22 if len(sys.argv) > 3 and sys.argv[3] == 'isabella' else 21
    else:
        model = sherpa_onnx.OfflineTtsModelConfig(vits=sherpa_onnx.OfflineTtsVitsModelConfig(
                model=str(root / 'en_US-lessac-medium.onnx'),
                tokens=str(root / 'tokens.txt'), data_dir=str(root / 'espeak-ng-data')),
            num_threads=2, provider='cpu', debug=False)
        speaker_id = 0
    speaker = sherpa_onnx.OfflineTts(sherpa_onnx.OfflineTtsConfig(model=model))
elif (root / 'encoder.int8.onnx').is_file():
    recognizer = sherpa_onnx.OfflineRecognizer.from_transducer(
        encoder=str(root / 'encoder.int8.onnx'),
        decoder=str(root / 'decoder.int8.onnx'),
        joiner=str(root / 'joiner.int8.onnx'),
        tokens=str(root / 'tokens.txt'),
        num_threads=4, provider='cpu', model_type='nemo_transducer')
else:
    recognizer = sherpa_onnx.OfflineRecognizer.from_moonshine(
    preprocessor=str(root / "preprocess.onnx"),
    encoder=str(root / "encode.int8.onnx"),
    uncached_decoder=str(root / "uncached_decode.int8.onnx"),
    cached_decoder=str(root / "cached_decode.int8.onnx"),
    tokens=str(root / "tokens.txt"),
    num_threads=2,
    provider="cpu",
    debug=False,
    )
print(json.dumps({"ready": True}), flush=True)
for line in sys.stdin:
    try:
        request = json.loads(line)
        if speaking:
            text = request['text']
            if not isinstance(text, str) or not 0 < len(text) <= 500:
                raise ValueError('Invalid speech text')
            result = speaker.generate(text=text, sid=speaker_id, speed=1.0)
            output = io.BytesIO()
            with wave.open(output, 'wb') as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(result.sample_rate)
                wav.writeframes((np.clip(result.samples, -1, 1) * 32767).astype('<i2').tobytes())
            print(json.dumps({'audio': base64.b64encode(output.getvalue()).decode('ascii')}), flush=True)
            continue
        pcm = base64.b64decode(request["pcm"], validate=True)
        if not 0 < len(pcm) <= 16000 * 2 * 30 or len(pcm) % 2:
            raise ValueError("Invalid PCM")
        audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768
        if waking:
            if len(audio) > 8000:
                raise ValueError('Wake chunks must be at most half a second')
            if request.get('reset') or wake_stream is None:
                wake_stream = phrase_recognizer()
                wake_done = False
                wake_samples = 0
            wake_samples += len(audio)
            detected = False
            if not wake_done and wake_samples <= 48000:
                ended = wake_stream.AcceptWaveform(pcm)
                result = json.loads(wake_stream.Result() if ended else wake_stream.PartialResult())
                words = result.get('text', result.get('partial', '')).split()
                # Partial words acknowledge promptly; final phrase recognition
                # and the command buffer still gate every workflow effect.
                # The forced grammar maps almost any opening syllable onto its
                # one wake word: "Can you…" was a partial "computer" 250 ms in
                # and chimed (journal, 2026-10-17). Hold a partial until 0.6 s
                # of speech has been heard and it still says computer — about
                # the length of the word itself — unless the phrase has ended.
                first_speech = float(request.get('firstSpeechAt') or 0.25)
                heard = wake_samples / 16000 - first_speech
                detected = words[:1] == ['computer'] and (bool(ended) or heard >= 0.6)
                wake_done = detected or bool(ended)
            print(json.dumps({'detected': detected}), flush=True)
            continue
        stream = recognizer.create_stream()
        stream.accept_waveform(16000, audio)
        recognizer.decode_stream(stream)
        print(json.dumps({'text': stream.result.text.strip(), 'phrases': recognize_phrases(pcm)}), flush=True)
    except Exception:
        print(json.dumps({"error": "Local speech recognition failed."}), flush=True)
