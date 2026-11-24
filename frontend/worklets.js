// AudioWorklet processors for the Rolly test client.
// capture: microphone -> 16 kHz PCM16 frames of 20 ms (resamples if the context is not 16 kHz)
// player : 24 kHz PCM16 chunks -> speaker, with instant flush for barge-in

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.acc = 0; this.sum = 0; this.count = 0;
    this.frame = new Int16Array(320); this.n = 0;
    this.muted = false;
    this.port.onmessage = (e) => { if (e.data.type === 'mute') this.muted = e.data.value; };
  }
  push(v) {
    const s = Math.max(-1, Math.min(1, v));
    this.frame[this.n++] = s < 0 ? s * 32768 : s * 32767;
    if (this.n === 320) {
      const out = this.frame.slice(0);
      this.port.postMessage(out.buffer, [out.buffer]);
      this.n = 0;
    }
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      // box-filter decimation: average the input samples that fall into one output sample
      this.sum += this.muted ? 0 : ch[i]; this.count++; this.acc += 1;
      if (this.acc >= this.ratio) { this.push(this.sum / this.count); this.acc -= this.ratio; this.sum = 0; this.count = 0; }
    }
    return true;
  }
}

class PlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = []; // {seq, data: Float32Array, pos}
    this.step = 24000 / sampleRate; // input samples per output sample
    this.frac = 0;
    this.playingSeq = 0; this.playedSamples = 0; this.wasIdle = true; this.underruns = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'audio') {
        const pcm = new Int16Array(m.pcm); const f = new Float32Array(pcm.length);
        for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 32768;
        this.queue.push({ seq: m.seq, data: f, pos: 0 });
      } else if (m.type === 'flush') {
        const dropped = this.queue.reduce((a, q) => a + (q.data.length - q.pos), 0);
        this.queue = []; this.frac = 0;
        this.port.postMessage({ type: 'flushed', seq: this.playingSeq, playedMs: this.playedSamples / 24, droppedMs: dropped / 24, t: currentTime });
        this.wasIdle = true;
      }
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0][0];
    for (let i = 0; i < out.length; i++) {
      let q = this.queue[0];
      while (q && q.pos >= q.data.length - 1) { this.queue.shift(); q = this.queue[0]; this.frac = 0; }
      if (!q) {
        out[i] = 0;
        if (!this.wasIdle) { this.wasIdle = true; this.port.postMessage({ type: 'idle', seq: this.playingSeq, playedMs: this.playedSamples / 24 }); }
        continue;
      }
      if (this.wasIdle || q.seq !== this.playingSeq) {
        if (q.seq !== this.playingSeq) { this.playedSamples = 0; this.port.postMessage({ type: 'started', seq: q.seq, t: currentTime }); }
        else if (this.wasIdle) { this.underruns++; this.port.postMessage({ type: 'underrun', seq: q.seq, count: this.underruns }); }
        this.playingSeq = q.seq; this.wasIdle = false;
      }
      const a = q.data[q.pos], b = q.data[Math.min(q.pos + 1, q.data.length - 1)];
      out[i] = a + (b - a) * this.frac;
      this.frac += this.step;
      while (this.frac >= 1) { this.frac -= 1; q.pos++; this.playedSamples++; }
    }
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
    return true;
  }
}

registerProcessor('capture', CaptureProcessor);
registerProcessor('player', PlayerProcessor);
