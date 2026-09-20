// KAWK PWA AudioWorkletProcessor: downmix to mono, resample to 16 kHz, emit exact
// 512-sample PCM16-LE chunks (1024 bytes, 32 ms) plus a ~50 ms RMS level meter.
// Output stays silent so the graph runs without echo. Chunk buffers are transferred.
import { Resampler, rms } from "./resampler.js";

class KawkPcmChunker extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    const inRate = opts.inputRate || sampleRate;
    const chunkSamples = opts.chunkSamples || 512;
    this.outRate = opts.outRate || 16000;
    this.resampler = new Resampler(inRate, this.outRate, chunkSamples);
    this.levelEvery = Math.max(1, Math.round((inRate * 0.05) / 128));
    this.blocks = 0;
    this.levelAcc = 0;
    this.levelCount = 0;
    this.mono = new Float32Array(128);
    this.running = true;
    this.port.onmessage = (event) => {
      if (event.data && event.data.type === "stop") this.running = false;
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
      this.port.postMessage({ type: "level", rms: Math.sqrt(this.levelAcc / this.levelCount) });
      this.levelAcc = 0;
      this.levelCount = 0;
    }
    const chunks = this.resampler.process(mono);
    for (const buffer of chunks) {
      // contextTime is the render time at which this block ended; the main thread uses it to
      // place the chunk's first sample on the corrected epoch clock.
      this.port.postMessage({ type: "chunk", buffer, contextTime: currentTime }, [buffer]);
    }
    return true;
  }
}

registerProcessor("kawk-pcm-chunker", KawkPcmChunker);
