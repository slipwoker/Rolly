import { describe, expect, it } from "vitest";
import { StreamResampler } from "../src/voice/resampler.ts";

function tone(freq: number, rate: number, seconds: number, amp = 0.5): Uint8Array {
  const n = Math.round(rate * seconds);
  const b = new Uint8Array(n * 2);
  const dv = new DataView(b.buffer);
  for (let i = 0; i < n; i++) dv.setInt16(i * 2, Math.round(amp * 32767 * Math.sin((2 * Math.PI * freq * i) / rate)), true);
  return b;
}

function samples(b: Uint8Array): Float64Array {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out = new Float64Array(b.byteLength >> 1);
  for (let i = 0; i < out.length; i++) out[i] = dv.getInt16(i * 2, true) / 32768;
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((s, p) => s + p.byteLength, 0);
  const o = new Uint8Array(n);
  let off = 0;
  for (const p of parts) { o.set(p, off); off += p.byteLength; }
  return o;
}

/** amplitude of `freq` in x (single-bin DFT), ignoring edges */
function amplitude(x: Float64Array, freq: number, rate: number): number {
  const a = Math.floor(x.length * 0.1), b = Math.floor(x.length * 0.9);
  let re = 0, im = 0;
  for (let i = a; i < b; i++) { re += x[i]! * Math.cos((2 * Math.PI * freq * i) / rate); im += x[i]! * Math.sin((2 * Math.PI * freq * i) / rate); }
  return (2 * Math.hypot(re, im)) / (b - a);
}

describe("StreamResampler", () => {
  for (const inRate of [44100, 22050]) {
    it(`${inRate} -> 24000 keeps a 1 kHz tone, length and amplitude`, () => {
      const r = new StreamResampler(inRate, 24000);
      const out = samples(concat([r.push(tone(1000, inRate, 1)), r.flush()]));
      expect(Math.abs(out.length - 24000)).toBeLessThanOrEqual(2);
      expect(amplitude(out, 1000, 24000)).toBeGreaterThan(0.49);
      expect(amplitude(out, 1000, 24000)).toBeLessThan(0.51);
    });
  }

  it("chunked and one-shot output are identical (no seams at chunk boundaries)", () => {
    const src = tone(440, 44100, 0.5);
    const one = new StreamResampler(44100, 24000);
    const a = concat([one.push(src), one.flush()]);
    const chunked = new StreamResampler(44100, 24000);
    const parts: Uint8Array[] = [];
    for (let off = 0; off < src.byteLength; off += 882 * 2 + 6) parts.push(chunked.push(src.subarray(off, Math.min(src.byteLength, off + 882 * 2 + 6))));
    parts.push(chunked.flush());
    const b = concat(parts);
    expect(b.byteLength).toBe(a.byteLength);
    const sa = samples(a), sb = samples(b);
    let maxDiff = 0;
    for (let i = 0; i < sa.length; i++) maxDiff = Math.max(maxDiff, Math.abs(sa[i]! - sb[i]!));
    expect(maxDiff).toBeLessThan(2 / 32768);
  });

  it("attenuates content above the output Nyquist (no aliasing)", () => {
    const r = new StreamResampler(44100, 24000);
    const out = samples(concat([r.push(tone(15000, 44100, 1)), r.flush()]));
    // 15 kHz would alias to 9 kHz at 24 kHz
    expect(amplitude(out, 9000, 24000)).toBeLessThan(0.5 * 1e-3); // < -60 dB relative to the input tone
  });

  it("is a no-op at equal rates", () => {
    const src = tone(1000, 24000, 0.1);
    const r = new StreamResampler(24000, 24000);
    expect(r.push(src)).toBe(src);
    expect(r.flush().byteLength).toBe(0);
  });
});
