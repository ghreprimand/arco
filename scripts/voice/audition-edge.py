"""Compare the existing Computer speech service's voices without changing it.

~/.archon/voice/venv/bin/python scripts/voice/audition-edge.py --serve
Only the fixed audition text goes to Edge. No microphone, model or GPU.
"""
import argparse
import asyncio
import functools
import html
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
import time

import edge_tts

VOICES = [
    ('jenny', 'Jenny', 'en-US-JennyNeural', 'American', 'Friendly, considerate, comforting'),
    ('ava', 'Ava', 'en-US-AvaNeural', 'American', 'Caring, pleasant, expressive'),
    ('clara', 'Clara', 'en-CA-ClaraNeural', 'Canadian', 'Friendly, positive'),
    ('michelle', 'Michelle', 'en-US-MichelleNeural', 'American', 'Friendly, pleasant'),
    ('sonia', 'Sonia', 'en-GB-SoniaNeural', 'British · current voice', 'Current Computer voice for comparison'),
]
TEXTS = {
    'short': 'Of course. What would you like to do next?',
    'conversation': 'Ready when you are. I can read the latest update, look something up, or help you send a message. Take your time. What would you like to do next?',
}


async def generate(output):
    available = {v['ShortName']: v for v in await edge_tts.list_voices()}
    samples = []
    for slug, name, voice, accent, description in VOICES:
        if voice not in available:
            raise RuntimeError(f'Voice is no longer available from Edge: {voice}')
        for kind, text in TEXTS.items():
            target = output / f'{slug}-{kind}.mp3'
            started = time.perf_counter()
            first = None
            # Same call and default prosody as recognizer.py's live Edge path.
            data = bytearray()
            async for chunk in edge_tts.Communicate(text, voice).stream():
                if chunk['type'] == 'audio':
                    if first is None:
                        first = round((time.perf_counter() - started) * 1000)
                    data.extend(chunk['data'])
            if not data:
                raise RuntimeError(f'No audio for {voice}')
            elapsed = round((time.perf_counter() - started) * 1000)
            target.write_bytes(data)
            seconds = float(subprocess.check_output([
                'ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                '-of', 'default=noprint_wrappers=1:nokey=1', str(target),
            ], text=True).strip())
            sample = dict(voice=voice, name=name, kind=kind, text=text, file=target.name,
                          firstAudioMs=first, generateMs=elapsed, audioSec=round(seconds, 2))
            samples.append(sample)
            print(json.dumps(sample), flush=True)
    (output / 'timings.json').write_text(json.dumps(samples, indent=2) + '\n')
    cards = []
    for slug, name, voice, accent, description in VOICES:
        players = ''.join(f'<label>{label}<audio controls preload="none" src="{slug}-{kind}.mp3"></audio></label>'
                          for kind, label in [('short', 'Short reply'), ('conversation', 'Conversation')])
        cards.append(f'<article><h2>{name}</h2><p>{accent}</p><p class="muted">{description}</p>{players}</article>')
    page = '''<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Computer voice comparison</title>
<style>
body{margin:0;background:#10141e;color:#e5ecf6;font:17px/1.6 system-ui,sans-serif}
main{max-width:1000px;margin:40px auto;padding:0 24px}h1{line-height:1.2}h2{margin:0}
.muted{color:#b5c2d6}section{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:18px}
article{background:#1b2231;border:1px solid #3e4b61;border-radius:12px;padding:24px}
article p{margin:5px 0 12px}label{display:block;font-size:14px;margin-top:18px}audio{display:block;width:100%;margin-top:6px}
blockquote{margin:24px 0;padding:12px 20px;border-left:3px solid #91b6f3;color:#cbd7eb}
</style><main><h1>A soothing voice for Computer</h1>
<p>Same speech service as Computer uses today. These samples keep the normal voice settings.</p>
<p class="muted">Listen to Jenny and Ava first, then compare Clara and Michelle. Sonia is the current voice.
This page only plays samples; it never enables your microphone or changes Computer.</p>
<blockquote>__TEXT__</blockquote><section>__CARDS__</section>
<script>
document.addEventListener('play',e=>{if(e.target.tagName==='AUDIO')for(const a of document.querySelectorAll('audio'))if(a!==e.target)a.pause()},true);
</script></main></html>'''
    (output / 'index.html').write_text(page.replace('__TEXT__', html.escape(TEXTS['conversation']))
                                     .replace('__CARDS__', ''.join(cards)))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, default=Path.home() / '.archon/voice/audition-logs/edge-comparison')
    parser.add_argument('--serve', action='store_true')
    parser.add_argument('--port', type=int, default=5196)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    asyncio.run(generate(args.out))
    print(f'Comparison saved to {args.out}', flush=True)
    if args.serve:
        handler = functools.partial(SimpleHTTPRequestHandler, directory=str(args.out.resolve()))
        with ThreadingHTTPServer(('127.0.0.1', args.port), handler) as server:
            print(f'Listen at http://localhost:{args.port}/ (no microphone or production changes)', flush=True)
            try:
                server.serve_forever()
            except KeyboardInterrupt:
                pass


if __name__ == '__main__':
    main()
