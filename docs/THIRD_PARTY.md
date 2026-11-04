# Third-party notices

This file identifies bundled assets and runtime components downloaded by `npm run voice:setup`. Components downloaded by voice setup are installed locally when requested. Arco does not redistribute those downloads. The generated `NOTICES.md` in the voice home lists the actual package versions and model archives installed on that machine.

## Fonts and images under `client/public`

Each font file listed below is distributed with its own license text.

| Asset | License and notice |
|---|---|
| `themes/victor-mono/VictorMono-Bold.otf`, `VictorMono-BoldOblique.otf`, `VictorMono-Medium.otf`, `VictorMono-MediumOblique.otf`, `VictorMono-Regular.otf`, `VictorMono-Oblique.otf`, `VictorMono-SemiBold.otf`, `VictorMono-SemiBoldOblique.otf` | SIL Open Font License 1.1. See [`themes/victor-mono/OFL.txt`](../client/public/themes/victor-mono/OFL.txt). |
| `phosphor-demo/jetbrains-mono-400.woff2`, `jetbrains-mono-700.woff2`, `jetbrains-mono-800.woff2` | SIL Open Font License 1.1. See [`phosphor-demo/OFL.txt`](../client/public/phosphor-demo/OFL.txt). |
| `themes/excalifont/Excalifont-Regular.woff2` | SIL Open Font License 1.1. Copyright 2024 Excalidraw; design and modification credits are recorded in [`themes/excalifont/OFL.txt`](../client/public/themes/excalifont/OFL.txt). Excalifont is an Excalidraw trademark. Source metadata: [Excalifont font metadata](https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/fonts/Excalifont/index.ts). |
| `backgrounds/odytty-dark-waves.webp` | GPL-3.0-only. The bundled [`backgrounds/LICENSE`](../client/public/backgrounds/LICENSE) records the original work and its attribution. The repository's root [`LICENSE`](../LICENSE) contains the GPL text. |
| `favicon.svg` | Arco project artwork, GPL-3.0-only under the root [`LICENSE`](../LICENSE). |
| `themes/deckle.svg` | Arco project artwork, GPL-3.0-only under the root [`LICENSE`](../LICENSE). |

The application also uses the Everforest color palette. Its MIT notice is [`licenses/Everforest-MIT.txt`](../client/public/licenses/Everforest-MIT.txt); the upstream palette is [Everforest](https://github.com/sainnhe/everforest). Font families loaded from Google Fonts are requested at runtime and are not bundled in this repository.

The vendored Odysseus image editor is MIT-licensed. Preserve its [`LICENSE`](../client/src/vendor/odysseus-editor/LICENSE) and [`VENDOR.md`](../client/src/vendor/odysseus-editor/VENDOR.md) with the source.

## npm dependencies

The lockfile contains 534 third-party package records. Its declared metadata includes permissive licenses and alternatives, including MIT-0, `(MIT OR WTFPL)`, and `(BSD-2-Clause OR MIT OR Apache-2.0)`. The `caniuse-lite` 1.0.30001819 development dependency declares CC BY 4.0 for its browser-support data; attribute the data to caniuse.com when redistributing it. See [caniuse-lite](https://github.com/browserslist/caniuse-lite) and the [source dataset license](https://github.com/Fyrd/caniuse). No GPL, LGPL, AGPL, MPL, EPL, SSPL, or source-available license is declared for a third-party npm package in the current lockfile. Workspace packages use the root project's GPL-3.0-only license. Lockfile metadata is an inventory aid; it does not replace review of the package's distributed files and notices.

## Integration registration provenance

## Optional Codex usage browser

The optional legacy Codex usage source uses separately installed [Camoufox](https://github.com/daijro/camoufox) and its Python dependencies and browser. Arco does not bundle or redistribute them. Installation and upstream license information are linked from [Codex usage](OPERATIONS.md#codex-usage).

## Voice setup downloads

`npm run voice:setup` downloads speech components into the configured voice home. The setup script writes a per-install `NOTICES.md` containing package metadata and each model's pinned name, SHA-256, license, and source URL. Python 3.12 is installed through `uv` when needed.

| Component | License | Source |
|---|---|---|
| Python 3.12 runtime | PSF-2.0 | [python.org](https://www.python.org/) |
| `sherpa-onnx` 1.13.3 speech runtime | Apache-2.0; bundles ONNX Runtime, MIT | [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx), [ONNX Runtime](https://github.com/microsoft/onnxruntime) |
| NumPy 2.2.6 | BSD-3-Clause | [NumPy](https://numpy.org/) |
| Vosk 0.3.45 speech library | Apache-2.0 | [vosk-api](https://github.com/alphacep/vosk-api) |
| Moonshine tiny English INT8 model, about 108 MB | MIT, Useful Sensors | [Moonshine](https://github.com/usefulsensors/moonshine), [pinned archive](https://api.github.com/repos/k2-fsa/sherpa-onnx/releases/assets/201857349) |
| Kokoro-82M v1.0 multilingual speech model and voices, about 350 MB | Apache-2.0; bundled eSpeak NG phoneme data is GPL-3.0-or-later | [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M), [eSpeak NG](https://github.com/espeak-ng/espeak-ng), [pinned archive](https://api.github.com/repos/k2-fsa/sherpa-onnx/releases/assets/677610079) |
| Vosk small US English model, about 41 MB | Apache-2.0 | [Vosk model list](https://alphacephei.com/vosk/models) |
| NVIDIA Parakeet TDT 0.6B v3 INT8 model, about 487 MB | CC BY 4.0 | [Parakeet model card](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3), [pinned archive](https://api.github.com/repos/k2-fsa/sherpa-onnx/releases/assets/283097583) |

The sherpa-onnx archives use upload-specific GitHub release asset IDs instead of replaceable release filenames. The setup request uses `Accept: application/octet-stream` to retrieve the archive bytes. SHA-256 verification remains mandatory. The Kokoro v1.0 archive uploaded on 2026-10-26 is 349,886,476 bytes; its replacement changed the archive checksum without changing the model version. Download URLs and checksums are included in the installed `NOTICES.md`.

Vosk remains the official versioned `vosk-model-small-en-us-0.15.zip` archive with its existing SHA-256. Its upstream does not provide a revision-addressed download URL; a third-party mirror is not substituted. A changed response still fails verification before extraction.

Parakeet is skipped on Windows; Moonshine remains the general English recognizer. Piper is not installed by the current setup script. No audio is recorded during setup. The capture-ready sound is a project-generated 230 ms, 48 kHz mono PCM16 double-pulse cue, synthesized from two tapered 470 Hz tones without a speech model or third-party recording. Its generation utility is not included in the public tree. The audio file is covered by GPL-3.0-only as project material.

For each voice setup run, consult its generated `NOTICES.md` for the complete installed Python package inventory. Model versions and archive hashes are defined in `scripts/voice/setup.py`.
