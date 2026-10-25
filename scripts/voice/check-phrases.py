"""Synthetic local phrase/latency check. No microphone, network or model quota."""
import base64
import io
import json
import os
from pathlib import Path
import subprocess
import time
import wave

import numpy as np

home = os.environ.get('ARCO_HOME') or os.environ.get('ARCHON_HOME')
root = Path(os.environ.get('ARCO_VOICE_HOME') or os.environ.get('ARCHON_VOICE_HOME') or (Path(home) / 'voice' if home else Path.home() / '.archon' / 'voice'))
python = root / 'venv' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
script = Path(__file__).resolve().parents[2] / 'server/src/voice/recognizer.py'
children = []

def worker(model, mode):
    child = subprocess.Popen([str(python), '-u', str(script), str(root / model), mode],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, text=True)
    children.append(child)
    assert json.loads(child.stdout.readline()).get('ready')
    return child

def request(child, **body):
    child.stdin.write(json.dumps(body) + '\n')
    child.stdin.flush()
    result = json.loads(child.stdout.readline())
    assert 'error' not in result, result
    return result

try:
    speaker = worker('kokoro-multi-lang-v1_0', 'tts')
    waker = worker('vosk-model-small-en-us-0.15', 'wake')
    model = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8'
    if not (root / model / 'encoder.int8.onnx').is_file():
        model = 'sherpa-onnx-moonshine-tiny-en-int8'
    recognizer = worker(model, 'asr')
    for text in ['Computer.', 'Computer open the plan.', 'Hey computer.',
                 'A computer.', 'I told the computer to wait.', 'Can you bring up the plan.',
                 'End capture.',
                 'Cancel capture.', "Let's leave it there for now. End capture."]:
        result = request(speaker, text=text)
        with wave.open(io.BytesIO(base64.b64decode(result['audio']))) as wav:
            rate = wav.getframerate()
            samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype='<i2').astype(np.float32)
        samples = np.interp(np.arange(int(len(samples) * 16000 / rate)) * rate / 16000,
                            np.arange(len(samples)), samples).astype('<i2')
        for speed, gain in ([(1, 1), (1.25, 0.12)] if text in ['Computer.', 'End capture.', 'Cancel capture.'] else [(1, 1)]):
            audio = (np.interp(np.arange(0, len(samples), speed), np.arange(len(samples)), samples) * gain).astype('<i2')
            pcm = np.concatenate([np.zeros(4000, dtype='<i2'), audio, np.zeros(16000, dtype='<i2')])
            detected_at = None
            for offset in range(0, len(pcm), 640):
                found = request(waker, pcm=base64.b64encode(pcm[offset:offset + 640].tobytes()).decode(), reset=offset == 0)
                if found.get('detected') and detected_at is None:
                    detected_at = (offset + 640) / 16000
            assert (detected_at is not None) == text.startswith('Computer'), (text, detected_at)
            started = time.monotonic()
            recognized = request(recognizer, pcm=base64.b64encode(pcm.tobytes()).decode())
            elapsed_ms = round((time.monotonic() - started) * 1000)
            if text.endswith('End capture.'):
                assert recognized['phrases'].endswith('end capture'), recognized
            if text == 'Cancel capture.':
                assert recognized['phrases'] == 'cancel capture', recognized
            blocks = [np.sqrt(np.mean(pcm[i:i + 128].astype(np.float32) ** 2)) for i in range(0, len(pcm), 128)]
            last_voice = int(np.where(np.array(blocks) > 0.006 * 32768)[0][-1]) * 128 / 16000
            print(json.dumps({'spoken': text, 'speed': speed, 'gain': gain,
                              'raw': recognized['text'], 'phrases': recognized['phrases'],
                              'recognizer': model, 'recognitionMs': elapsed_ms,
                              'wakeLagAfterLastVoiceMs': round((detected_at - last_voice) * 1000) if detected_at else None}), flush=True)
finally:
    for child in children:
        child.terminate()
    for child in children:
        child.wait(timeout=5)
