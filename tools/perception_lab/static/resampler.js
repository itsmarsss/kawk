// Pure, dependency-free PCM resampler + chunker used by the AudioWorklet and by tests.
// Float32 mono in at any rate -> exact fixed-size Int16 little-endian chunks at outRate.
// Anti-aliasing: windowed-sinc lowpass FIR applied at the input rate, then linear
// interpolation at fractional positions. Fractional phase and filter history carry
// across process() blocks, so block size does not matter.

export function designLowpass(inRate, outRate, taps) {
  // Cutoff a little under the output Nyquist so the transition band stays below it.
  const nyquist = Math.min(inRate, outRate) / 2;
  const cutoff = nyquist * 0.9;
  const fc = cutoff / inRate; // normalized (cycles per input sample)
  const h = new Float32Array(taps);
  const mid = (taps - 1) / 2;
  let sum = 0;
  for (let n = 0; n < taps; n++) {
    const k = n - mid;
    const sinc = k === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * k) / (Math.PI * k);
    const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (taps - 1)); // Hamming
    h[n] = sinc * window;
    sum += h[n];
  }
  for (let n = 0; n < taps; n++) h[n] /= sum; // unity DC gain
  return h;
}

export class Resampler {
  constructor(inRate, outRate = 16000, chunkSamples = 512, taps = 63) {
    if (!(inRate > 0) || !(outRate > 0)) throw new Error('Sample rates must be positive');
    this.inRate = inRate;
    this.outRate = outRate;
    this.chunkSamples = chunkSamples;
    this.step = inRate / outRate; // input samples per output sample
    this.passthrough = inRate === outRate;
    this.taps = this.passthrough ? 1 : taps;
    this.coeffs = this.passthrough ? null : designLowpass(inRate, outRate, this.taps);
    // Raw input history needed to filter the first samples of the next block.
    this.history = new Float32Array(this.taps - 1);
    // Position (in filtered-sample units) of the next output sample relative to the
    // start of the current filtered block; may be fractional and may exceed the block.
    this.phase = 0;
    // Last filtered sample of the previous block, for interpolation across the boundary.
    this.prevFiltered = 0;
    this.hasPrev = false;
    // Partially filled output chunk.
    this.chunk = new Int16Array(chunkSamples);
    this.fill = 0;
    this.totalIn = 0;
    this.totalOut = 0;
  }

  // Returns an array of ArrayBuffers, each exactly chunkSamples * 2 bytes of PCM16-LE.
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
      const hist = this.history;
      const H = T - 1;
      // Concatenate history + input so every filtered sample has full context.
      const buf = new Float32Array(H + n);
      buf.set(hist, 0);
      buf.set(input, H);
      filtered = new Float32Array(n);
      const c = this.coeffs;
      for (let i = 0; i < n; i++) {
        let acc = 0;
        // filtered[i] corresponds to input[i] delayed by H/2 samples (linear phase).
        for (let k = 0; k < T; k++) acc += c[k] * buf[i + k];
        filtered[i] = acc;
      }
      // Keep the last H raw samples for the next block.
      if (n >= H) hist.set(buf.subarray(H + n - H, H + n));
      else { hist.copyWithin(0, n); hist.set(buf.subarray(H, H + n), H - n); }
    }

    // Interpolate. Index -1 refers to prevFiltered (previous block's last sample).
    const step = this.step;
    let pos = this.phase;
    const get = (i) => (i < 0 ? this.prevFiltered : filtered[i]);
    // If no previous sample yet, skip interpolation into the void: start at 0.
    if (!this.hasPrev && pos < 0) pos = 0;
    while (pos <= n - 1) {
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      let sample;
      if (frac === 0) sample = get(i0);
      else sample = get(i0) + (get(i0 + 1) - get(i0)) * frac;
      this._push(sample, out);
      pos += step;
    }
    // Next block: positions are relative to the new block start; the last sample of this
    // block becomes index -1.
    this.phase = pos - n;
    this.prevFiltered = filtered[n - 1];
    this.hasPrev = true;
    return out;
  }

  _push(sample, out) {
    let v = sample;
    if (v > 1) v = 1; else if (v < -1) v = -1;
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
