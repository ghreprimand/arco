// Short PCM chunks feed a local wake detector without waiting for silence.
// A full overlapping segment is retained so immediate follow-on words survive.
// Endpointing and wake detection never submit a workflow message.
class ArchonVoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = [];
    this.pre = [];
    this.silence = 0;
    this.voiced = 0;
    this.active = false;
    this.suspended = false;
    this.threshold = 0.0035;
    this.noise = 0.001;
    this.calibrationSamples = 0;
    this.meterSamples = 0;
    this.peak = 0;
    this.utterance = 0;
    this.wakeEnabled = false;
    this.wakeThisUtterance = false;
    this.wakeSamples = [];
    this.wakeSent = 0;
    this.port.onmessage = (e) => {
      if (typeof e.data?.wakeEnabled === 'boolean') {
        this.wakeEnabled = e.data.wakeEnabled;
        // Re-enabling mid-utterance must not wake on a later Computer.
        if (!this.wakeEnabled) { this.wakeThisUtterance = false; this.wakeSamples = []; }
        return;
      }
      if (typeof e.data?.threshold === 'number') {
        if (Number.isFinite(e.data.threshold) && e.data.threshold >= 0.001 && e.data.threshold <= 0.05) this.threshold = e.data.threshold;
        return;
      }
      if (e.data === 'flush') { this.flush(); return; }
      this.suspended = e.data === 'pause';
      this.reset();
    };
  }
  reset() {
    this.samples = []; this.pre = []; this.active = false; this.voiced = 0; this.silence = 0;
    this.wakeSamples = []; this.wakeThisUtterance = false;
  }
  // A manual END/CANCEL CAPTURE click arrives while the last words may still
  // be waiting for endpoint silence. Deliver them first, then confirm, so the
  // runtime can queue the control behind every segment instead of submitting
  // a directive that is missing its final phrase.
  flush() {
    if (this.active) this.emit(true);
    this.reset();
    this.port.postMessage({ type: 'flushed' });
  }
  emit(flushed) {
    // One softly spoken wake word must survive endpointing too.
    if (this.voiced > sampleRate * 0.10) {
      const pcm = this.pcm(this.samples);
      this.port.postMessage({ type: 'segment', utterance: this.utterance, endpointMs: Math.round(this.silence * 1000 / sampleRate), flushed, pcm }, [pcm]);
    } else this.port.postMessage({ type: 'discard', utterance: this.utterance });
  }
  alpha(seconds) { return Math.min(1, 128 / (sampleRate * seconds)); }
  pcm(input) {

    const ratio = sampleRate / 16000;
    const pcm = new Int16Array(Math.floor(input.length / ratio));
    for (let i = 0; i < pcm.length; i++) {
      const from = Math.floor(i * ratio), to = Math.min(input.length, Math.floor((i + 1) * ratio));
      let value = 0;
      for (let j = from; j < to; j++) value += input[j];
      pcm[i] = Math.max(-1, Math.min(1, value / Math.max(1, to - from))) * 32767;
    }
    return pcm.buffer;
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel || this.suspended) return true;
    let sum = 0;
    for (const value of channel) sum += value * value;
    // A lower release threshold keeps soft word endings in the segment.
    const rms = Math.sqrt(sum / channel.length);
    // Learn quiet room/fan noise on enable before treating it as an entire
    // utterance. A real word is still retained by the pre-roll during this
    // brief calibration; stronger speech is never learned as background.
    if (this.calibrationSamples < sampleRate * 0.16) {
      this.calibrationSamples += channel.length;
      if (rms < 0.008) this.noise += (rms - this.noise) * 0.2;
    } else if (rms < this.noise) {
      // Fast downward tracking (50 ms): any gap between words resets the floor.
      this.noise += (rms - this.noise) * this.alpha(0.05);
    } else {
      // Slow upward tracking (1.3 s idle, 2.5 s while a segment is open).
      // The earlier symmetric 135 ms tracker learned sub-threshold breath and
      // lip noise just before a word as "room noise", which raised the onset
      // above ordinary quiet speech — synthetic samples with digital silence
      // never showed it. Steady fan noise is still absorbed within a few
      // seconds, even mid-segment, so it cannot hold a segment open until the
      // 22-second cap; the in-segment cap keeps loud speakers' soft endings
      // inside the release threshold. Time constants, not per-frame factors:
      // a 128-sample frame is 2.7 ms at 48 kHz but 8 ms in the 16 kHz tests.
      const target = Math.min(rms, this.active ? 0.006 : 0.015);
      if (target > this.noise) this.noise += (target - this.noise) * this.alpha(this.active ? 2.5 : 1.3);
    }
    // Fixed release thresholds could treat steady room/fan noise as speech
    // forever, hiding a standalone Computer until the 22-second hard cap.
    const onset = Math.max(this.threshold, this.noise * 2.2);
    const release = Math.max(this.threshold * 0.65, this.noise * 1.6);
    const speech = rms > (this.active ? release : onset);
    this.meterSamples += channel.length;
    this.peak = Math.max(this.peak, rms);
    if (this.meterSamples >= sampleRate / 10) {
      this.meterSamples = 0;
      // Floor/onset are diagnostics for the operator: a quiet word whose peak
      // sits under the onset line is exactly the case that needs a lower
      // onset threshold, and nothing else shows it.
      this.port.postMessage({ type: 'level', rms, peak: this.peak, noise: this.noise, onset, active: this.active });
      this.peak = 0;
    }
    if (!this.active) {
      this.pre.push(...channel);
      if (this.pre.length > sampleRate * 0.4) this.pre.splice(0, channel.length);
      if (!speech) return true;
      this.active = true; this.samples = this.pre; this.pre = [];
      ++this.utterance; this.wakeSent = 0; this.wakeThisUtterance = this.wakeEnabled;
      this.firstSpeechAt = Math.max(0, (this.samples.length - channel.length) / sampleRate);
      this.wakeSamples = this.wakeThisUtterance ? this.samples.slice() : [];
    } else {
      this.samples.push(...channel);
      if (this.wakeThisUtterance) this.wakeSamples.push(...channel);
    }
    const chunkSize = Math.round(sampleRate * 0.04);
    while (this.wakeThisUtterance && this.wakeSamples.length >= chunkSize && this.wakeSent < sampleRate * 3) {
      const pcm = this.pcm(this.wakeSamples.splice(0, chunkSize)); this.wakeSent += chunkSize;
      this.port.postMessage({ type: 'wake', utterance: this.utterance, firstSpeechAt: this.firstSpeechAt, pcm }, [pcm]);
    }
    if (this.wakeSent >= sampleRate * 3) { this.wakeThisUtterance = false; this.wakeSamples = []; }
    if (speech) { this.silence = 0; this.voiced += channel.length; }
    else this.silence += channel.length;
    // This only delivers a transcription segment. The command stays open
    // through arbitrarily many segments until explicit End/Cancel capture.
    if (this.silence > sampleRate * 0.35 || this.samples.length >= sampleRate * 22) {
      this.emit(false);
      this.reset();
    }
    return true;
  }
}
registerProcessor('archon-voice-capture', ArchonVoiceCapture);
