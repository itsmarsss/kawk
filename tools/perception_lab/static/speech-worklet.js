// AudioWorkletProcessor: meters RMS, resamples to 16 kHz, emits exact 512-sample PCM16 chunks.
// Output is silent (zeros) so the graph runs without echo. Buffers are transferred, not copied.
import { Resampler, rms } from './resampler.js';

class PcmChunker extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options.processorOptions || {};
    const inRate = opts.inputRate || sampleRate; // `sampleRate` is the worklet global: actual context rate
    this.resampler = new Resampler(inRate, opts.outRate || 16000, opts.chunkSamples || 512);
    this.levelEvery = Math.max(1, Math.round((inRate * 0.05) / 128)); // ~50 ms
    this.blocks = 0;
    this.levelAcc = 0;
    this.levelCount = 0;
    this.mono = new Float32Array(128);
    this.running = true;
    this.port.onmessage = (event) => {
      if (event.data?.type === 'stop') this.running = false;
    };
  }

  process(inputs) {
    if (!this.running) return false;
    const channels = inputs[0];
    if (!channels || channels.length === 0) return true;
    const frames = channels[0].length;
    let mono = channels[0];
    if (channels.length > 1) {
      if (this.mono.length !== frames) this.mono = new Float32Array(frames);
      mono = this.mono;
      mono.fill(0);
      for (const ch of channels) for (let i = 0; i < frames; i++) mono[i] += ch[i] / channels.length;
    }
    const level = rms(mono);
    this.levelAcc += level * level;
    this.levelCount += 1;
    this.blocks += 1;
    if (this.blocks % this.levelEvery === 0) {
      this.port.postMessage({ type: 'level', rms: Math.sqrt(this.levelAcc / this.levelCount) });
      this.levelAcc = 0;
      this.levelCount = 0;
    }
    const chunks = this.resampler.process(mono);
    for (const buffer of chunks) this.port.postMessage({ type: 'chunk', buffer }, [buffer]);
    return true; // outputs untouched: silence
  }
}

registerProcessor('pcm-chunker', PcmChunker);
