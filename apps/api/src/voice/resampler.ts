/**
 * Streaming band-limited resampler for PCM16 mono (windowed sinc, Blackman-Harris window, table lookup).
 *
 * The pod sends agent audio at the voice's own rate (BlueV3 44.1 kHz, Piper 22.05 kHz); the phone gets one rate
 * (24 kHz). The research tester used soxr "HQ"; this is a dependency-free equivalent that is good enough for speech
 * (stop-band well below -80 dB with these settings, verified in test/resampler.test.ts).
 *
 * One instance per audio stream (per agent turn): it keeps the filter history between chunks so chunk boundaries are
 * seamless. `flush()` returns the last samples held back for the filter's look-ahead.
 */

const ZERO_CROSSINGS = 16; // half-width of the kernel, in zero crossings of the low-pass sinc
const TABLE_RES = 512; // kernel samples per zero crossing

let KERNEL: Float32Array | null = null;

function kernelTable(): Float32Array {
  if (KERNEL) return KERNEL;
  const n = ZERO_CROSSINGS * TABLE_RES + 2;
  const t = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i / TABLE_RES; // in zero crossings
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    // Blackman-Harris window over [-ZC, ZC]
    const w = x >= ZERO_CROSSINGS ? 0 : (() => {
      const p = (x / ZERO_CROSSINGS + 1) / 2; // 0..1 across the full window, x=0 -> 0.5
      const a = 2 * Math.PI * p;
      return 0.35875 - 0.48829 * Math.cos(a) + 0.14128 * Math.cos(2 * a) - 0.01168 * Math.cos(3 * a);
    })();
    t[i] = sinc * w;
  }
  KERNEL = t;
  return t;
}

export class StreamResampler {
  readonly inRate: number;
  readonly outRate: number;
  private readonly step: number; // input samples per output sample
  private readonly fc: number; // cut-off as a fraction of the input Nyquist (<= 1)
  private readonly half: number; // kernel half-width in input samples
  private buf: Float32Array = new Float32Array(0);
  private outCount = 0; // output samples produced so far
  private dropped = 0; // input samples (incl. the initial history) removed from the front of buf
  private flushed = false;

  constructor(inRate: number, outRate: number) {
    this.inRate = inRate;
    this.outRate = outRate;
    this.step = inRate / outRate;
    // keep a little margin below the lower Nyquist so the transition band is attenuated
    this.fc = Math.min(1, outRate / inRate) * 0.94;
    this.half = Math.ceil(ZERO_CROSSINGS / this.fc);
    // start with `half` zeros of history so the first output sample is aligned with the first input sample
    this.buf = new Float32Array(this.half);
  }

  /** position of the next output sample, in input samples relative to buf[0] (computed, not accumulated, so the
   * result does not depend on how the input was chunked) */
  private get pos(): number {
    return this.half + this.outCount * this.step - this.dropped;
  }

  /** Resample a chunk of PCM16 LE bytes; returns PCM16 LE bytes (may be empty while history fills). */
  push(pcm: Uint8Array): Uint8Array {
    if (this.inRate === this.outRate) return pcm;
    const n = pcm.byteLength >> 1;
    const dv = new DataView(pcm.buffer, pcm.byteOffset, n * 2);
    const next = new Float32Array(this.buf.length + n);
    next.set(this.buf, 0);
    for (let i = 0; i < n; i++) next[this.buf.length + i] = dv.getInt16(i * 2, true) / 32768;
    this.buf = next;
    return this.drain(false);
  }

  /** Emit the samples still held back for look-ahead (pads with silence). Call once at the end of a stream. */
  flush(): Uint8Array {
    if (this.inRate === this.outRate || this.flushed) return new Uint8Array(0);
    this.flushed = true;
    const pad = new Float32Array(this.buf.length + this.half + 1);
    pad.set(this.buf, 0);
    const realEnd = this.buf.length; // do not produce output beyond the real input
    this.buf = pad;
    return this.drain(true, realEnd);
  }

  private drain(final: boolean, realEnd?: number): Uint8Array {
    const K = kernelTable();
    const buf = this.buf;
    const limit = final ? (realEnd ?? buf.length) : buf.length - this.half - 1;
    const out: number[] = [];
    const scale = this.fc * TABLE_RES;
    while (this.pos < limit) {
      const center = this.pos;
      const lo = Math.max(0, Math.ceil(center - this.half));
      const hi = Math.min(buf.length - 1, Math.floor(center + this.half));
      let acc = 0;
      for (let k = lo; k <= hi; k++) {
        const d = Math.abs(center - k) * scale; // distance in table units
        const i = d | 0;
        if (i >= K.length - 1) continue;
        const f = d - i;
        acc += buf[k]! * (K[i]! + (K[i + 1]! - K[i]!) * f);
      }
      out.push(acc * this.fc);
      this.outCount++;
    }
    // drop input that no future output sample can reach
    const keepFrom = Math.max(0, Math.floor(this.pos - this.half) - 1);
    if (keepFrom > 0) {
      this.buf = this.buf.slice(keepFrom);
      this.dropped += keepFrom;
    }
    const bytes = new Uint8Array(out.length * 2);
    const odv = new DataView(bytes.buffer);
    for (let i = 0; i < out.length; i++) {
      const s = Math.max(-1, Math.min(1, out[i]!));
      odv.setInt16(i * 2, Math.round(s * 32767), true);
    }
    return bytes;
  }
}
