"""Install CPU speech dependencies/assets without starting Arco or listening.

Run through `npm run voice:setup` (scripts/voice/run.mjs), which supplies a
Python through uv on Linux, macOS and Windows. Every component is downloaded
from its upstream source at the operator's request, verified against a pinned
SHA-256 and listed in NOTICES.md inside the voice home. Arco does not
redistribute any of them.
"""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile

if sys.version_info < (3, 12):
    raise SystemExit('Voice setup needs Python 3.12 or newer; run it with npm run voice:setup.')


def voice_home() -> Path:
    # ARCO_VOICE_HOME, then <Arco home>/voice, where the Arco home is
    # ARCO_HOME, then ~/.arco.
    explicit = os.environ.get('ARCO_VOICE_HOME')
    if explicit:
        return Path(explicit).expanduser().resolve()
    home = os.environ.get('ARCO_HOME')
    return (Path(home).expanduser().resolve() if home else Path.home() / '.arco') / 'voice'


root = voice_home()
root.mkdir(parents=True, exist_ok=True)
venv = root / 'venv'
python = venv / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')

PACKAGES = [
    ('sherpa-onnx==1.13.3', 'sherpa-onnx speech runtime (bundles ONNX Runtime)', 'Apache-2.0 (sherpa-onnx); MIT (ONNX Runtime)',
     'https://github.com/k2-fsa/sherpa-onnx'),
    ('numpy==2.2.6', 'NumPy', 'BSD-3-Clause', 'https://numpy.org'),
    ('vosk==0.3.45', 'Vosk speech recognition library', 'Apache-2.0', 'https://github.com/alphacep/vosk-api'),
]

# Asset IDs identify uploaded bytes; replacing an asset under a release name
# creates a new ID. Keep the digest check even for these pinned downloads.
SHERPA_ASSETS = 'https://api.github.com/repos/k2-fsa/sherpa-onnx/releases/assets'
MODELS = [
    {
        'name': 'sherpa-onnx-moonshine-tiny-en-int8', 'marker': 'tokens.txt', 'kind': 'tar',
        'url': f'{SHERPA_ASSETS}/201857349',
        'sha256': 'd5fe6ec4334fef36255b2a4010412cad4c007e33103fec62fb5d17cad88086f2',
        'title': 'Moonshine tiny English speech recognition (int8, ~108 MB)',
        'license': 'MIT (Useful Sensors)', 'upstream': 'https://github.com/usefulsensors/moonshine',
        'message': 'Downloading local English speech model (~108 MB). No audio is captured.',
    },
    {
        'name': 'kokoro-multi-lang-v1_0', 'marker': 'model.onnx', 'kind': 'tar',
        'url': f'{SHERPA_ASSETS}/677610079',
        'sha256': '60703707bc05ccd48d60e1eb723f38b07d6e474795a0b6a588d7220400e0f7a4',
        'title': 'Kokoro-82M v1.0 multi-language speech output voices (~350 MB)',
        'license': 'Apache-2.0 (Kokoro-82M); bundled espeak-ng phoneme data is GPL-3.0-or-later',
        'upstream': 'https://huggingface.co/hexgrad/Kokoro-82M',
        'message': 'Downloading local speech output voices (~350 MB). No audio is captured.',
    },
    {
        'name': 'vosk-model-small-en-us-0.15', 'marker': 'am/final.mdl', 'kind': 'zip',
        # Vosk publishes a versioned upstream ZIP, without a revision endpoint.
        # Keep its known digest rather than switching to a third-party mirror.
        'url': 'https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip',
        'sha256': '30f26242c4eb449f948e42cb302dd7a686cb29a3423a8367f99ff41780942498',
        'title': 'Vosk small US English model for wake and reserved phrases (~41 MB)',
        'license': 'Apache-2.0 (Alpha Cephei)', 'upstream': 'https://alphacephei.com/vosk/models',
        'message': 'Downloading a local English reserved-phrase model (~41 MB). No audio is captured.',
    },
    {
        # The ONNX Parakeet decoder can return empty finals on Windows, where
        # the recognizer keeps Moonshine (server/src/voice/localRecognizer.ts).
        'name': 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8', 'marker': 'encoder.int8.onnx', 'kind': 'tar',
        'url': f'{SHERPA_ASSETS}/283097583',
        'sha256': '5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf',
        'title': 'NVIDIA Parakeet TDT 0.6B v3 speech recognition (int8, ~487 MB)',
        'license': 'CC-BY-4.0 (NVIDIA)', 'upstream': 'https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3',
        'message': 'Downloading higher-accuracy CPU Parakeet v3 (~487 MB). No audio is captured.',
        'skip': os.name == 'nt',
    },
]


def download(url: str, target: Path, expected: str) -> None:
    digest = hashlib.sha256()
    request = urllib.request.Request(url, headers={'Accept': 'application/octet-stream'})
    with urllib.request.urlopen(request) as response, open(target, 'wb') as out:
        while chunk := response.read(1 << 20):
            digest.update(chunk)
            out.write(chunk)
    if digest.hexdigest() != expected:
        raise SystemExit(f'Checksum mismatch for {url}: expected {expected}, got {digest.hexdigest()}. '
                         'Nothing was installed from it; the upstream file may have changed.')


def install(model: dict) -> None:
    print(model['message'], flush=True)
    with tempfile.TemporaryDirectory(prefix='arco-voice-install-') as tmp:
        base = Path(tmp).resolve()
        archive = base / ('archive.zip' if model['kind'] == 'zip' else 'archive.tar.bz2')
        download(model['url'], archive, model['sha256'])
        if model['kind'] == 'zip':
            with zipfile.ZipFile(archive) as bundle:
                if any(not (base / item.filename).resolve().is_relative_to(base) for item in bundle.infolist()):
                    raise SystemExit(f'Invalid archive for {model["name"]}')
                bundle.extractall(base)
        else:
            with tarfile.open(archive) as bundle:
                bundle.extractall(base, filter='data')
        shutil.move(str(base / model['name']), root / model['name'])


INVENTORY = """
import importlib.metadata as m, json
rows = []
for d in m.distributions():
    md = d.metadata
    lic = md.get('License-Expression') or '; '.join(c.split('::')[-1].strip() for c in (md.get_all('Classifier') or []) if c.startswith('License ::'))
    rows.append([md['Name'], d.version, lic or (md.get('License') or 'not declared').split(chr(10))[0][:80]])
print(json.dumps(sorted(rows, key=lambda r: r[0].lower())))
"""


def venv_packages() -> list[list[str]]:
    import json
    out = subprocess.run([str(python), '-c', INVENTORY], check=True, capture_output=True, text=True).stdout
    return json.loads(out)


def write_notices(installed: list[dict]) -> None:
    lines = ['# Voice components installed by npm run voice:setup', '',
             'Downloaded from their upstream sources at the operator\'s request. Arco does not redistribute them.', '',
             '| Component | License | Upstream |', '|---|---|---|',
             '| Python 3.12 runtime (installed by uv when missing) | PSF-2.0 | https://www.python.org |']
    lines += [f'| {title} (`{spec}`) | {license} | {upstream} |' for spec, title, license, upstream in PACKAGES]
    lines += [f'| {m["title"]} (`{m["name"]}`, sha256 `{m["sha256"]}`) | {m["license"]} | {m["upstream"]}; download: {m["url"]} |' for m in installed]
    lines += ['', 'Python packages in the voice environment (the pinned packages above and their dependencies), with the', 'license each package declares:', '', '| Package | Version | Declared license |', '|---|---|---|']
    lines += [f'| {name} | {version} | {license} |' for name, version, license in venv_packages()]
    text = '\n'.join(lines) + '\n'
    (root / 'NOTICES.md').write_text(text, encoding='utf-8')
    print('\n' + text, flush=True)
    print(f'Notices written to {root / "NOTICES.md"}.', flush=True)


if not python.exists():
    subprocess.run(['uv', 'venv', '--python', '3.12', str(venv)], check=True)
subprocess.run(['uv', 'pip', 'install', '--python', str(python), *[spec for spec, *_ in PACKAGES]], check=True)
installed = []
for model in MODELS:
    if model.get('skip'):
        continue
    if not (root / model['name'] / model['marker']).is_file():
        install(model)
    installed.append(model)
write_notices(installed)
print(f'Local speech is installed at {root}. Models only run while a test or hands-free session is enabled; nothing is listening.')
