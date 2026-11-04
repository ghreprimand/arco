"""One-shot local TTS audition. GPU engines run in their own venv; nothing is
saved except the WAV written to --out. Timing goes to stderr as JSON.

Engines:
  chatterbox        Resemble Chatterbox (English), built-in voice or --ref clone
  chatterbox-turbo  Chatterbox Turbo (needs --ref)
  qwen-design       Qwen3-TTS VoiceDesign: a voice described by --instruct
  qwen-clone        Qwen3-TTS Base: clone --ref (with --ref-text transcript)
"""
import argparse
import json
import sys
import time
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--engine', required=True, choices=['chatterbox', 'chatterbox-turbo', 'qwen-design', 'qwen-clone'])
parser.add_argument('--text', required=True)
parser.add_argument('--out', required=True)
parser.add_argument('--ref', help='reference WAV for cloning')
parser.add_argument('--ref-text', help='transcript of the reference clip (qwen-clone)')
parser.add_argument('--instruct', default='A warm, calm British woman with a Received Pronunciation accent, speaking conversationally at a natural pace.')
parser.add_argument('--size', default='1.7B', choices=['0.6B', '1.7B'])
parser.add_argument('--xvec', action='store_true', help='qwen-clone: speaker embedding only (no in-context transcript)')
parser.add_argument('--full-text', action='store_true', help='qwen: pass the whole text up front (non_streaming_mode)')
parser.add_argument('--repeat', type=int, default=1, help='generate N times in one process; per-call times show warm vs cold')
parser.add_argument('--exaggeration', type=float, default=0.5, help='chatterbox expressiveness (0.3 flatter, 0.7 livelier)')
parser.add_argument('--cfg', type=float, default=0.5, help='chatterbox cfg weight (lower = closer to reference pacing)')
args = parser.parse_args()
if not 0 < len(args.text) <= 600:
    sys.exit('text must be 1-600 characters')
if args.engine in ('chatterbox-turbo', 'qwen-clone') and not (args.ref and Path(args.ref).is_file()):
    sys.exit('this engine needs --ref <clip.wav>')

t0 = time.perf_counter()
import torch  # noqa: E402
device = 'cuda' if torch.cuda.is_available() else 'cpu'
if args.engine.startswith('chatterbox'):
    import soundfile as sf  # torchaudio 2.11 needs torchcodec to save; soundfile does not
    if args.engine == 'chatterbox-turbo':
        from chatterbox.tts_turbo import ChatterboxTurboTTS as Model
    else:
        from chatterbox.tts import ChatterboxTTS as Model
    model = Model.from_pretrained(device=device)
    t1 = time.perf_counter()
    kwargs = {'audio_prompt_path': args.ref} if args.ref else {}
    if args.engine == 'chatterbox': kwargs.update(exaggeration=args.exaggeration, cfg_weight=args.cfg)
    calls = []
    for _ in range(args.repeat):
        c0 = time.perf_counter(); wav = model.generate(args.text, **kwargs); calls.append(round((time.perf_counter() - c0) * 1000))
    t2 = time.perf_counter()
    sf.write(args.out, wav.squeeze(0).cpu().numpy(), model.sr)
    duration = wav.shape[-1] / model.sr
else:
    import soundfile as sf
    from qwen_tts import Qwen3TTSModel
    name = f'Qwen/Qwen3-TTS-12Hz-{args.size}-' + ('VoiceDesign' if args.engine == 'qwen-design' else 'Base')
    model = Qwen3TTSModel.from_pretrained(name, device_map=device, dtype=torch.bfloat16)
    t1 = time.perf_counter()
    # A 16-character reply once ran away for 14 minutes / 655 s of audio: the
    # autoregressive decoder never emitted EOS. Cap tokens by text length
    # (12 Hz codec: ~12 tokens per second of speech; this allows ~3 s + 1 s
    # per 12 characters, roughly twice the natural length).
    limit = {'max_new_tokens': int(12 * (3 + len(args.text) / 12)), **({'non_streaming_mode': True} if args.full_text else {})}
    calls = []
    if args.engine == 'qwen-design':
        for _ in range(args.repeat):
            c0 = time.perf_counter(); wavs, sr = model.generate_voice_design(text=args.text, language='English', instruct=args.instruct, **limit); calls.append(round((time.perf_counter() - c0) * 1000))
    else:
        ref_text = args.ref_text
        if not ref_text and args.ref and Path(args.ref).with_suffix('.txt').is_file():
            ref_text = Path(args.ref).with_suffix('.txt').read_text().strip()
        # A resident speaker would build the clone prompt once per session.
        prompt = model.create_voice_clone_prompt(ref_audio=args.ref, ref_text=None if args.xvec else ref_text, x_vector_only_mode=args.xvec or not ref_text)
        for _ in range(args.repeat):
            c0 = time.perf_counter(); wavs, sr = model.generate_voice_clone(text=args.text, language='English', voice_clone_prompt=prompt, **limit); calls.append(round((time.perf_counter() - c0) * 1000))
    t2 = time.perf_counter()
    sf.write(args.out, wavs[0], sr)
    duration = len(wavs[0]) / sr
print(json.dumps({'engine': args.engine, 'device': device, 'loadMs': round((t1 - t0) * 1000), 'generateMs': round((t2 - t1) * 1000), 'callsMs': calls, 'audioSec': round(duration, 2),
                  'gpu': torch.cuda.get_device_name(0) if device == 'cuda' else None}), file=sys.stderr, flush=True)
