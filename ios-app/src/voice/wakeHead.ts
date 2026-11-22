/** The "Hey Meld" classifier head (same binary format and math as WakeWordDetector.WakeHead on Android). */
export type Layer = { inSize: number; outSize: number; w: Float32Array; b: Float32Array; gamma: Float32Array; beta: Float32Array };

export class WakeHead {
  readonly frames: number;
  readonly dim: number;
  readonly threshold: number;
  readonly consecutive: number;
  readonly layers: Layer[];
  readonly outW: Float32Array;
  readonly outB: number;

  constructor(frames: number, dim: number, layers: Layer[], outW: Float32Array, outB: number, threshold: number, consecutive: number) {
    this.frames = frames;
    this.dim = dim;
    this.layers = layers;
    this.outW = outW;
    this.outB = outB;
    this.threshold = threshold;
    this.consecutive = consecutive;
  }

  static parse(buffer: ArrayBuffer): WakeHead {
    const v = new DataView(buffer);
    let o = 0;
    const magic = String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3));
    if (magic !== 'HMW1') throw new Error('Not a Hey Meld model');
    o = 4;
    const int = () => {
      const x = v.getInt32(o, true);
      o += 4;
      return x;
    };
    const floats = (n: number) => {
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++, o += 4) out[i] = v.getFloat32(o, true);
      return out;
    };
    const frames = int();
    const dim = int();
    const count = int();
    const layers: Layer[] = [];
    for (let l = 0; l < count; l++) {
      const inSize = int();
      const outSize = int();
      layers.push({ inSize, outSize, w: floats(inSize * outSize), b: floats(outSize), gamma: floats(outSize), beta: floats(outSize) });
    }
    const lastIn = int();
    const outW = floats(lastIn);
    const outB = floats(1)[0];
    const threshold = buffer.byteLength - o >= 4 ? floats(1)[0] : 0.5;
    const consecutive = buffer.byteLength - o >= 4 ? Math.min(5, Math.max(1, int())) : 1;
    return new WakeHead(frames, dim, layers, outW, outB, threshold, consecutive);
  }

  /** @param window `frames` embeddings of `dim` floats each, oldest first. */
  predict(window: Float32Array[]): number {
    const x = new Float32Array(this.frames * this.dim);
    window.forEach((f, i) => x.set(f, i * this.dim));
    return this.predictFlat(x);
  }

  /** @param input the window flattened to `frames * dim` floats. */
  predictFlat(input: Float32Array): number {
    let x = input;
    for (const l of this.layers) {
      const y = new Float32Array(l.outSize);
      for (let j = 0; j < l.outSize; j++) {
        let s = l.b[j];
        const row = j * l.inSize;
        for (let i = 0; i < l.inSize; i++) s += l.w[row + i] * x[i];
        y[j] = s;
      }
      let mean = 0;
      for (const v of y) mean += v;
      mean /= y.length;
      let variance = 0;
      for (const v of y) variance += (v - mean) * (v - mean);
      variance /= y.length;
      const inv = 1 / Math.sqrt(variance + 1e-5);
      for (let j = 0; j < y.length; j++) y[j] = Math.max(0, (y[j] - mean) * inv * l.gamma[j] + l.beta[j]);
      x = y;
    }
    let s = this.outB;
    for (let i = 0; i < x.length; i++) s += this.outW[i] * x[i];
    return 1 / (1 + Math.exp(-s));
  }

  withThreshold(t: number): WakeHead {
    return new WakeHead(this.frames, this.dim, this.layers, this.outW, this.outB, t, this.consecutive);
  }

  /** Same layout that [parse] reads (and WakeHead.toBytes() on Android writes). */
  toBytes(): Uint8Array {
    const size = 16 + this.layers.reduce((n, l) => n + 8 + 4 * (l.inSize * l.outSize + 3 * l.outSize), 0) + 4 + 4 * this.outW.length + 12;
    const buf = new ArrayBuffer(size);
    const v = new DataView(buf);
    let o = 0;
    for (const c of 'HMW1') v.setUint8(o++, c.charCodeAt(0));
    const int = (x: number) => {
      v.setInt32(o, x, true);
      o += 4;
    };
    const float = (x: number) => {
      v.setFloat32(o, x, true);
      o += 4;
    };
    int(this.frames);
    int(this.dim);
    int(this.layers.length);
    for (const l of this.layers) {
      int(l.inSize);
      int(l.outSize);
      for (const a of [l.w, l.b, l.gamma, l.beta]) a.forEach(float);
    }
    int(this.outW.length);
    this.outW.forEach(float);
    float(this.outB);
    float(this.threshold);
    int(this.consecutive);
    return new Uint8Array(buf);
  }
}
