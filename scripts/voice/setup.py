"""Install CPU speech dependencies/assets without starting Arco or listening."""
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
import zipfile

root = Path(os.environ.get('ARCO_VOICE_HOME') or os.environ.get('ARCHON_VOICE_HOME') or Path.home() / '.archon' / 'voice')
root.mkdir(parents=True, exist_ok=True)
venv = root / 'venv'
python = venv / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
if not python.exists():
    if not shutil.which('uv'):
        raise SystemExit('Install uv (https://docs.astral.sh/uv/) then run npm run voice:setup.')
    subprocess.run(['uv', 'venv', '--python', '3.12', str(venv)], check=True)
subprocess.run(['uv', 'pip', 'install', '--python', str(python), 'sherpa-onnx==1.13.3', 'numpy==2.2.6', 'vosk==0.3.45'], check=True)
name = 'sherpa-onnx-moonshine-tiny-en-int8'
model = root / name
if not (model / 'tokens.txt').is_file():
    print('Downloading local English speech model (~120 MB). No audio is captured.', flush=True)
    with tempfile.TemporaryDirectory(prefix='archon-voice-install-') as tmp:
        archive = Path(tmp) / 'model.tar.bz2'
        urllib.request.urlretrieve(f'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/{name}.tar.bz2', archive)
        with tarfile.open(archive) as tar:
            tar.extractall(tmp, filter='data')
        shutil.move(str(Path(tmp) / name), model)
print(f'Local speech installed at {root}. Nothing is listening. Deployment remains a separate step.')
name = 'kokoro-multi-lang-v1_0'
if not (root / name / 'model.onnx').is_file():
    print('Downloading local British female speech output voices. No audio is captured.', flush=True)
    with tempfile.TemporaryDirectory(prefix='archon-voice-install-') as tmp:
        archive = Path(tmp) / 'voice.tar.bz2'
        urllib.request.urlretrieve(f'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/{name}.tar.bz2', archive)
        with tarfile.open(archive) as tar:
            tar.extractall(tmp, filter='data')
        shutil.move(str(Path(tmp) / name), root / name)
print('Local speech recognition and output are ready; hands-free remains off.')
name = 'vosk-model-small-en-us-0.15'
if not (root / name / 'am' / 'final.mdl').is_file():
    print('Downloading a local English reserved-phrase model (~40 MB). No audio is captured.', flush=True)
    with tempfile.TemporaryDirectory(prefix='archon-phrase-install-') as tmp:
        archive = Path(tmp) / 'phrases.zip'
        urllib.request.urlretrieve(f'https://alphacephei.com/vosk/models/{name}.zip', archive)
        with zipfile.ZipFile(archive) as model_zip:
            base = Path(tmp).resolve()
            if any(not (base / item.filename).resolve().is_relative_to(base) for item in model_zip.infolist()):
                raise ValueError('Invalid phrase model archive')
            model_zip.extractall(tmp)
        shutil.move(str(Path(tmp) / name), root / name)
print('Fast local wake and reserved-phrase recognition are ready; nothing is listening.')
name = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8'
if os.name != 'nt' and not (root / name / 'encoder.int8.onnx').is_file():
    print('Downloading higher-accuracy CPU Parakeet v3 (~487 MB). No audio is captured.', flush=True)
    with tempfile.TemporaryDirectory(prefix='archon-parakeet-install-') as tmp:
        archive = Path(tmp) / 'model.tar.bz2'
        urllib.request.urlretrieve(f'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/{name}.tar.bz2', archive)
        with tarfile.open(archive) as tar:
            tar.extractall(tmp, filter='data')
        shutil.move(str(Path(tmp) / name), root / name)
print('Local speech is installed. Models only run while a test or hands-free session is enabled.')
