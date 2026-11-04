// Settings -> VOICE SETUP audio helpers. The microphone test and the test
// phrase capture Float32 frames at the AudioContext rate; the recognizer takes
// mono 16 kHz PCM16, so frames are averaged down and clamped here.

export const SETUP_PCM_RATE = 16000;
export const SETUP_PHRASE_SECONDS = 5;

export function downsampleToPcm16(chunks: readonly Float32Array[], fromRate: number, toRate = SETUP_PCM_RATE): Int16Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const input = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) { input.set(c, offset); offset += c.length; }
  if (!total || !(fromRate > 0)) return new Int16Array(0);
  const ratio = fromRate / toRate;
  const length = Math.floor(total / ratio);
  const out = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * ratio), end = Math.max(start + 1, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end && j < total; j++) sum += input[j];
    const v = Math.max(-1, Math.min(1, sum / (end - start)));
    out[i] = v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff);
  }
  return out;
}

export function peakLevel(frame: Float32Array): number {
  let peak = 0;
  for (const v of frame) { const a = Math.abs(v); if (a > peak) peak = a; }
  return Math.min(1, peak);
}

// Level meter scale: speech at ordinary distance peaks around 0.05-0.3, so a
// square-root curve keeps quiet microphones visibly moving.
export function meterPercent(peak: number): number {
  return Math.round(Math.sqrt(Math.max(0, Math.min(1, peak))) * 100);
}

export interface MicCapture { rate: number; stop: () => void }

// Opens the microphone with the same constraints as hands-free mode and
// forwards frames until stop(), which releases every track.
export async function openSetupMic(onFrame: (frame: Float32Array) => void): Promise<MicCapture> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone access requires localhost or HTTPS.');
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: false }, video: false });
  const audio = new AudioContext({ latencyHint: 'interactive' });
  try {
    await audio.audioWorklet.addModule('/voice-setup-capture.js');
    const node = new AudioWorkletNode(audio, 'arco-voice-setup-capture');
    node.port.onmessage = (e: MessageEvent<Float32Array>) => onFrame(e.data);
    const source = audio.createMediaStreamSource(stream);
    const mute = audio.createGain(); mute.gain.value = 0;
    source.connect(node); node.connect(mute); mute.connect(audio.destination);
    await audio.resume().catch(() => {});
    let stopped = false;
    return { rate: audio.sampleRate, stop: () => {
      if (stopped) return; stopped = true;
      node.port.onmessage = null; source.disconnect(); node.disconnect();
      stream.getTracks().forEach((t) => t.stop()); void audio.close().catch(() => {});
    } };
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop()); void audio.close().catch(() => {});
    throw e;
  }
}
