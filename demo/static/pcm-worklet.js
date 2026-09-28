// Live captions: mic (Float32, the context's rate) -> 16 kHz mono Int16 PCM, posted to the page
// in ~80 ms batches (1280 samples) that demo.js sends up /ws/live as binary messages.
// The page normally runs this in an AudioContext at 16 kHz (the browser resamples the mic), so
// the ratio is 1; where a 16 kHz context can't take the mic (Firefox), it runs at the native
// rate and each output sample is the mean of the input span it covers (a cheap low-pass).
class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.batch = new Int16Array(1280);
    this.n = 0;
    this.acc = 0;       // running sum / count of input samples for the current output sample
    this.cnt = 0;
    this.pos = 0;       // fractional input position of the next output sample boundary
    this.port.onmessage = (e) => { if (e.data === "flush") this.flush(); };
  }
  push(v) {
    const s = Math.max(-1, Math.min(1, v));
    this.batch[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    if (this.n === this.batch.length) this.flush();
  }
  flush() {
    if (!this.n) return;
    const out = this.batch.slice(0, this.n);
    this.port.postMessage(out.buffer, [out.buffer]);
    this.n = 0;
  }
  process(inputs) {
    const x = inputs[0] && inputs[0][0];
    if (!x) return true;
    if (this.ratio === 1) {
      for (let i = 0; i < x.length; i++) this.push(x[i]);
      return true;
    }
    for (let i = 0; i < x.length; i++) {
      this.acc += x[i]; this.cnt++;
      if (++this.pos >= this.ratio) {
        this.pos -= this.ratio;
        this.push(this.acc / this.cnt);
        this.acc = 0; this.cnt = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm-tap", PcmTap);
