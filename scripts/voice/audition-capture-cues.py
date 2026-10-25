"""Original capture-ready cues: rounded motion rather than clicks or bells.

python3 scripts/voice/audition-capture-cues.py --serve
Audition only: no microphone, service changes, external audio or model calls.
"""
import argparse
import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import math
from pathlib import Path
import random
import struct
import wave

RATE = 48000


def envelope(t, duration):
    # Zero slope at the edges, with enough attack to avoid a click.
    return math.sin(math.pi * max(0, min(1, t / duration))) ** 2


def render(kind):
    duration = {'rounded-rise': .18, 'airy-rise': .20, 'double-pulse': .23}[kind]
    rng = random.Random(42)
    samples = []
    phase = low = high = 0.0
    for i in range(round(RATE * duration)):
        t = i / RATE
        x = t / duration
        if kind == 'rounded-rise':
            frequency = 350 + 240 * x
            phase += 2 * math.pi * frequency / RATE
            value = envelope(t, duration) * (math.sin(phase) + .09 * math.sin(2 * phase))
        elif kind == 'airy-rise':
            frequency = 430 + 220 * x
            phase += 2 * math.pi * frequency / RATE
            noise = rng.uniform(-1, 1)
            high += (1 - math.exp(-2 * math.pi * (1000 + 900 * x) / RATE)) * (noise - high)
            low += (1 - math.exp(-2 * math.pi * 400 / RATE)) * (noise - low)
            value = envelope(t, duration) * (.65 * (high - low) + .16 * math.sin(phase))
        else:
            phase += 2 * math.pi * 470 / RATE
            pulses = envelope(t, .085) if t < .085 else 0
            if .105 <= t <= .23:
                pulses += .82 * envelope(t - .105, .125)
            value = pulses * (math.sin(phase) + .08 * math.sin(2 * phase))
        samples.append(value)
    peak = .10 if kind != 'airy-rise' else .12
    scale = peak / max(abs(v) for v in samples)
    return [v * scale for v in samples]


def write_wav(path, samples, gain=1):
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), 'wb') as wav:
        wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(RATE)
        wav.writeframes(b''.join(struct.pack('<h', round(v * gain * 32767)) for v in samples))


def generate(output):
    output.mkdir(parents=True, exist_ok=True)
    choices = [
        ('rounded-rise', 'Rounded rise', 'A soft “wup” that lifts slightly. My starting suggestion.'),
        ('airy-rise', 'Airy rise', 'A small, breathy “fwup”, with less of a pure tone.'),
        ('double-pulse', 'Soft double pulse', 'Two cushioned pulses at the same pitch: a clearer listening signal.'),
    ]
    info, cards = [], []
    for slug, name, description in choices:
        samples = render(slug)
        write_wav(output / f'{slug}.wav', samples)
        ms = round(len(samples) / RATE * 1000)
        info.append(dict(id=slug, name=name, durationMs=ms, peak=round(max(abs(v) for v in samples), 3)))
        cards.append(f'<article><h2>{name}</h2><p>{description}</p><button data-sound="{slug}">Play · {ms} ms</button></article>')
    (output / 'samples.json').write_text(json.dumps(info, indent=2) + '\n')
    page = '''<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Capture-ready sounds</title>
<style>
body{margin:0;background:#10141e;color:#e5ecf6;font:17px/1.6 system-ui,sans-serif}
main{max-width:850px;margin:45px auto;padding:0 24px}h1{line-height:1.2}h2{margin:0}
section{display:grid;gap:16px;margin-top:25px}article{background:#1b2231;border:1px solid #3e4b61;border-radius:12px;padding:22px}
p{color:#b5c2d6}button{background:#b8d0ef;color:#10141e;border:0;border-radius:8px;padding:9px 24px;font:inherit;cursor:pointer}
input{vertical-align:middle;margin:0 15px}output{font-variant-numeric:tabular-nums}
</style><main><h1>“I’m listening”</h1>
<p>These have a little more shape than a click: a brief rounded sound, without a bell attack or ringing tail.</p>
<label>Sample volume <input aria-label="Sample volume" id="volume" type="range" min="1" max="100" value="65"><output id="level">65%</output></label>
<section>__CARDS__</section><p>Audition only. Your microphone and Arco settings are unchanged.</p>
<div role="status" id="status"></div><script>
const players={};for(const id of ['rounded-rise','airy-rise','double-pulse']){players[id]=new Audio(id+'.wav');players[id].preload='auto'}
const slider=document.getElementById('volume');slider.oninput=()=>document.getElementById('level').textContent=slider.value+'%';
for(const b of document.querySelectorAll('button[data-sound]'))b.onclick=async()=>{
 for(const a of Object.values(players)){a.pause();a.currentTime=0}
 const a=players[b.dataset.sound];a.volume=Number(slider.value)/100;
 try{await a.play();document.getElementById('status').textContent='Played '+b.closest('article').querySelector('h2').textContent}
 catch{document.getElementById('status').textContent='Could not play sample'}
};</script></main></html>'''
    (output / 'index.html').write_text(page.replace('__CARDS__', ''.join(cards)))
    return info


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, default=Path.home() / '.arco/voice/audition-logs/capture-cues')
    parser.add_argument('--serve', action='store_true')
    parser.add_argument('--port', type=int, default=5197)
    parser.add_argument('--export-double-pulse', type=Path, help='export the selected cue at the preview’s default 65%% level')
    args = parser.parse_args()
    if args.export_double_pulse:
        write_wav(args.export_double_pulse, render('double-pulse'), gain=.65)
        print(f'Exported soft double pulse (230 ms, peak 0.065): {args.export_double_pulse}', flush=True)
        return
    print(json.dumps(generate(args.out)), flush=True)
    if args.serve:
        handler = functools.partial(SimpleHTTPRequestHandler, directory=str(args.out.resolve()))
        with ThreadingHTTPServer(('127.0.0.1', args.port), handler) as server:
            print(f'Listen at http://localhost:{args.port}/', flush=True)
            try:
                server.serve_forever()
            except KeyboardInterrupt:
                pass


if __name__ == '__main__':
    main()
