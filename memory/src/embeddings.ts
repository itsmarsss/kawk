import type { Embedder } from './contracts.js';

export const DEFAULT_EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const EMBEDDING_DIMENSIONS = 384;

/** Lazy, real sentence embeddings. Tests inject an Embedder and never download weights. */
export class LocalEmbedder implements Embedder {
  readonly dimensions = EMBEDDING_DIMENSIONS;
  private extractor: Promise<(texts: string[]) => Promise<number[][]>> | null = null;

  constructor(readonly model = DEFAULT_EMBEDDING_MODEL) {}

  async warmup(): Promise<void> { await this.load(); }

  private load(): Promise<(texts: string[]) => Promise<number[][]>> {
    this.extractor ??= (async () => {
      const { pipeline } = await import('@huggingface/transformers');
      const extract = await pipeline('feature-extraction', this.model, { dtype: 'q8' });
      return async (texts: string[]) => {
        // MiniLM's short context must not silently discard the end of a long memory.
        const chunks: string[] = [];
        const owners: number[] = [];
        for (const [owner, text] of texts.entries()) {
          const tokens = extract.tokenizer.encode(text, { add_special_tokens: false });
          for (let offset = 0; offset < tokens.length; offset += 200) {
            chunks.push(extract.tokenizer.decode(tokens.slice(offset, offset + 200), { skip_special_tokens: true }));
            owners.push(owner);
          }
        }
        const vectors = texts.map(() => Array<number>(this.dimensions).fill(0));
        for (let offset = 0; offset < chunks.length; offset += 16) {
          const result = await extract(chunks.slice(offset, offset + 16), { pooling: 'mean', normalize: true });
          const batch = result.tolist() as number[][];
          for (const [index, vector] of batch.entries()) {
            if (vector.length !== this.dimensions || vector.some(x => !Number.isFinite(x)))
              throw new Error(`Embedding model ${this.model} returned invalid dimensions or values`);
            for (let axis = 0; axis < this.dimensions; axis++) vectors[owners[offset + index]][axis] += vector[axis];
          }
        }
        for (const vector of vectors) {
          const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
          if (!Number.isFinite(norm) || norm === 0) throw new Error('Embedding model returned an empty vector');
          for (let axis = 0; axis < vector.length; axis++) vector[axis] /= norm;
        }
        if (vectors.length !== texts.length)
          throw new Error(`Embedding model ${this.model} returned invalid dimensions or values`);
        return vectors;
      };
    })().catch(error => { this.extractor = null; throw error; });
    return this.extractor;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    if (texts.some(text => !text.trim())) throw new Error('Cannot embed empty text');
    return (await this.load())(texts);
  }
}

export { LocalEmbedder as MiniLMEmbedder };
