// KAWK PWA: dependency-free Float32 -> PCM16 mono resampler with fixed-size chunk output.
// Adapted from our own perception-lab prototype pattern: windowed-sinc lowpass at the input
// rate, then linear interpolation at fractional positions. Filter history and fractional
// phase carry across process() calls so AudioWorklet 128-frame blocks do not matter.
// Output chunks are exactly `chunkSamples` Int16 little-endian samples at `outRate`.

export function designLowpass(inRate, outRate, taps) {
  const nyquist = Math.min(inRate, outRate) / 2;
  const cutoff = nyquist * 0.9;
  const fc = cutoff / inRate;
  const h = new Float32Array(taps);
  const mid = (taps - 1) / 2;
  let sum = 0;
  for (let n = 0; n < taps; n++) {
    const k = n - mid;
    const sinc = k === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * k) / (Math.PI * k);
    const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (taps - 1));
    h[n] = sinc * window;
    sum += h[n];
  }
  for (let n = 0; n < taps; n++) h[n] /= sum;
  return h;
}

export class Resampler {
  constructor(inRate, outRate = 16000, chunkSamples = 512, taps = 63) {
    if (!(inRate > 0) || !(outRate > 0)) throw new Error("Sample rates must be positive");
    this.inRate = inRate;
    this.outRate = outRate;
    this.chunkSamples = chunkSamples;
    this.step = inRate / outRate;
    this.passthrough = inRate === outRate;
    this.taps = this.passthrough ? 1 : taps;
    this.coeffs = this.passthrough ? null : designLowpass(inRate, outRate, this.taps);
    this.history = new Float32Array(this.taps - 1);
    this.phase = 0;
    this.prevFiltered = 0;
    this.hasPrev = false;
    this.chunk = new Int16Array(chunkSamples);
    this.fill = 0;
    this.totalIn = 0;
    this.totalOut = 0;
  }

  /** Returns an array of ArrayBuffers, each exactly chunkSamples * 2 bytes of PCM16-LE. */
  process(input) {
    const out = [];
    const n = input.length;
    if (n === 0) return out;
    this.totalIn += n;

    let filtered;
    if (this.passthrough) {
      filtered = input;
    } else {
      const T = this.taps;
      const H = T - 1;
      const buf = new Float32Array(H + n);
      buf.set(this.history, 0);
      buf.set(input, H);
      filtered = new Float32Array(n);
      const c = this.coeffs;
      for (let i = 0; i < n; i++) {
        let acc = 0;
        for (let k = 0; k < T; k++) acc += c[k] * buf[i + k];
        filtered[i] = acc;
      }
      if (n >= H) this.history.set(buf.subarray(n, H + n));
      else {
        this.history.copyWithin(0, n);
        this.history.set(buf.subarray(H, H + n), H - n);
      }
    }

    const step = this.step;
    let pos = this.phase;
    const get = (i) => (i < 0 ? this.prevFiltered : filtered[i]);
    if (!this.hasPrev && pos < 0) pos = 0;
    while (pos <= n - 1) {
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      const sample = frac === 0 ? get(i0) : get(i0) + (get(i0 + 1) - get(i0)) * frac;
      this._push(sample, out);
      pos += step;
    }
    this.phase = pos - n;
    this.prevFiltered = filtered[n - 1];
    this.hasPrev = true;
    return out;
  }

  _push(sample, out) {
    let v = sample;
    if (v > 1) v = 1;
    else if (v < -1) v = -1;
    this.chunk[this.fill++] = v < 0 ? Math.round(v * 32768) : Math.round(v * 32767);
    this.totalOut += 1;
    if (this.fill === this.chunkSamples) {
      out.push(this.chunk.buffer);
      this.chunk = new Int16Array(this.chunkSamples);
      this.fill = 0;
    }
  }
}

export function rms(input) {
  let acc = 0;
  for (let i = 0; i < input.length; i++) acc += input[i] * input[i];
  return input.length ? Math.sqrt(acc / input.length) : 0;
}
