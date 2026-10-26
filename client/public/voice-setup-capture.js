// Settings -> VOICE SETUP capture: forwards raw mono frames in ~2048-sample
// batches for the level meter and the test phrase. No endpointing, no wake.
class ArcoVoiceSetupCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buffer = new Float32Array(2048); this.filled = 0; }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        this.buffer[this.filled++] = channel[i];
        if (this.filled === this.buffer.length) { this.port.postMessage(this.buffer.slice()); this.filled = 0; }
      }
    }
    return true;
  }
}
registerProcessor('arco-voice-setup-capture', ArcoVoiceSetupCapture);
