// Resamples mic audio to 16 kHz mono PCM16 and posts ~40 ms chunks.
class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.t = 0;
    this.prev = 0;
    this.out = new Int16Array(640);
    this.n = 0;
  }
  process(inputs) {
    const s = inputs[0][0];
    if (!s) return true;
    let t = this.t, peak = 0;
    for (; t < s.length - 1; t += this.ratio) {
      const i = Math.floor(t), f = t - i;
      const a = i < 0 ? this.prev : s[i], b = s[i + 1];
      const v = Math.max(-1, Math.min(1, a + (b - a) * f));
      peak = Math.max(peak, Math.abs(v));
      this.out[this.n++] = v < 0 ? v * 32768 : v * 32767;
      if (this.n === 640) {
        this.port.postMessage({ pcm: this.out.buffer, peak }, [this.out.buffer]);
        this.out = new Int16Array(640);
        this.n = 0;
      }
    }
    this.t = t - s.length;
    this.prev = s[s.length - 1];
    return true;
  }
}
registerProcessor("capture", Capture);
