// AudioWorklet: converts the audio graph's float samples (usually 48 kHz,
// possibly stereo) into 16 kHz mono signed 16-bit PCM, posting ~100 ms chunks
// together with their RMS level for the UI meter.
const TARGET_RATE = 16000;
const CHUNK = 1600; // 100 ms at 16 kHz

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // `sampleRate` is a global in the AudioWorklet scope.
    this.ratio = sampleRate / TARGET_RATE;
    this.out = new Int16Array(CHUNK);
    this.len = 0;
    this.acc = 0;
    this.accN = 0;
    this.pos = 0;
    this.sumSq = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels || channels.length === 0) return true;
    const n = channels[0].length;
    const count = channels.length;
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let c = 0; c < count; c++) s += channels[c][i];
      // Box-filter decimation: average the input samples that fall into one output sample.
      this.acc += s / count;
      this.accN++;
      this.pos++;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        const v = Math.max(-1, Math.min(1, this.acc / this.accN));
        this.acc = 0;
        this.accN = 0;
        this.sumSq += v * v;
        this.out[this.len++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        if (this.len === CHUNK) {
          const pcm = this.out.buffer;
          this.port.postMessage({ pcm, level: Math.sqrt(this.sumSq / CHUNK) }, [pcm]);
          this.out = new Int16Array(CHUNK);
          this.len = 0;
          this.sumSq = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
