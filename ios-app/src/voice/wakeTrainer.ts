// Port of WakeTrainer.kt: fine-tunes the "Hey Meld" head on the phone with the user's own examples,
// starting from the shipped model and pulled back towards it (L2), so a few bad examples can't wreck it.
import { WakeHead, type Layer } from './wakeHead.ts';

export type Example = { x: Float32Array; label: number; weight: number };

type Params = { w: Float32Array[]; b: Float32Array[]; g: Float32Array[]; be: Float32Array[]; outW: Float32Array; outB: number };
type Trace = { inputs: Float32Array[]; normed: Float32Array[]; invStd: number[]; pre: Float32Array[]; logit: number };

const EPS = 1e-5;
const B1 = 0.9;
const B2 = 0.999;
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

const fromHead = (h: WakeHead): Params => ({
  w: h.layers.map((l) => l.w.slice()),
  b: h.layers.map((l) => l.b.slice()),
  g: h.layers.map((l) => l.gamma.slice()),
  be: h.layers.map((l) => l.beta.slice()),
  outW: h.outW.slice(),
  outB: h.outB,
});
const zero = (p: Params): Params => ({
  w: p.w.map((a) => new Float32Array(a.length)),
  b: p.b.map((a) => new Float32Array(a.length)),
  g: p.g.map((a) => new Float32Array(a.length)),
  be: p.be.map((a) => new Float32Array(a.length)),
  outW: new Float32Array(p.outW.length),
  outB: 0,
});
/** Same order as WakeTrainer.Params.arrays() on Android: all W, all b, all gamma, all beta, outW. */
const arrays = (p: Params) => [...p.w, ...p.b, ...p.g, ...p.be, p.outW];

export class WakeTrainer {
  private readonly sizes: [number, number][];
  private readonly baseParams: Params;
  private readonly base: WakeHead;

  constructor(base: WakeHead) {
    this.base = base;
    this.sizes = base.layers.map((l) => [l.inSize, l.outSize]);
    this.baseParams = fromHead(base);
  }

  private forward(p: Params, x: Float32Array): Trace {
    const n = this.sizes.length;
    const inputs: Float32Array[] = [];
    const normed: Float32Array[] = [];
    const pre: Float32Array[] = [];
    const invStd: number[] = [];
    let h = x;
    for (let l = 0; l < n; l++) {
      const [inS, outS] = this.sizes[l];
      inputs.push(h);
      const z = new Float32Array(outS);
      const w = p.w[l];
      for (let o = 0; o < outS; o++) {
        let s = p.b[l][o];
        const row = o * inS;
        for (let i = 0; i < inS; i++) s += w[row + i] * h[i];
        z[o] = s;
      }
      let mean = 0;
      for (let o = 0; o < outS; o++) mean += z[o];
      mean /= outS;
      let variance = 0;
      for (let o = 0; o < outS; o++) variance += (z[o] - mean) * (z[o] - mean);
      variance /= outS;
      const inv = 1 / Math.sqrt(variance + EPS);
      invStd.push(inv);
      const y = new Float32Array(outS);
      const a = new Float32Array(outS);
      const next = new Float32Array(outS);
      for (let o = 0; o < outS; o++) {
        y[o] = (z[o] - mean) * inv;
        a[o] = y[o] * p.g[l][o] + p.be[l][o];
        next[o] = Math.max(0, a[o]);
      }
      normed.push(y);
      pre.push(a);
      h = next;
    }
    inputs.push(h);
    let logit = p.outB;
    for (let i = 0; i < h.length; i++) logit += p.outW[i] * h[i];
    return { inputs, normed, invStd, pre, logit };
  }

  private backward(p: Params, t: Trace, dLogit: number, grad: Params) {
    const n = this.sizes.length;
    const last = t.inputs[n];
    let dh = new Float32Array(last.length);
    for (let i = 0; i < last.length; i++) {
      dh[i] = p.outW[i] * dLogit;
      grad.outW[i] += last[i] * dLogit;
    }
    grad.outB += dLogit;
    for (let l = n - 1; l >= 0; l--) {
      const [inS, outS] = this.sizes[l];
      const y = t.normed[l];
      const dy = new Float32Array(outS);
      let meanDy = 0;
      let meanDyY = 0;
      for (let o = 0; o < outS; o++) {
        const da = t.pre[l][o] > 0 ? dh[o] : 0;
        grad.g[l][o] += da * y[o];
        grad.be[l][o] += da;
        dy[o] = da * p.g[l][o];
        meanDy += dy[o];
        meanDyY += dy[o] * y[o];
      }
      meanDy /= outS;
      meanDyY /= outS;
      const input = t.inputs[l];
      const w = p.w[l];
      const gw = grad.w[l];
      const dIn = new Float32Array(inS);
      for (let o = 0; o < outS; o++) {
        const g = (dy[o] - meanDy - y[o] * meanDyY) * t.invStd[l];
        if (g === 0) continue;
        grad.b[l][o] += g;
        const row = o * inS;
        for (let i = 0; i < inS; i++) {
          gw[row + i] += g * input[i];
          dIn[i] += w[row + i] * g;
        }
      }
      dh = dIn;
    }
  }

  loss(head: WakeHead, examples: Example[], l2: number): number {
    const p = fromHead(head);
    let total = 0;
    for (const e of examples) {
      const z = this.forward(p, e.x).logit;
      total += e.weight * (Math.max(z, 0) - z * e.label + Math.log(1 + Math.exp(-Math.abs(z))));
    }
    let reg = 0;
    const b0 = arrays(this.baseParams);
    arrays(p).forEach((a, k) => {
      for (let i = 0; i < a.length; i++) reg += (a[i] - b0[k][i]) ** 2;
    });
    return total / examples.length + l2 * reg;
  }

  /** Analytic gradient of [loss] (for the gradient-check test); outB comes last as a 1-element array. */
  gradient(head: WakeHead, examples: Example[], l2: number): Float32Array[] {
    const p = fromHead(head);
    const g = zero(p);
    for (const e of examples) {
      const t = this.forward(p, e.x);
      this.backward(p, t, (e.weight * (sigmoid(t.logit) - e.label)) / examples.length, g);
    }
    const ps = arrays(p);
    const b0 = arrays(this.baseParams);
    arrays(g).forEach((ga, k) => {
      for (let i = 0; i < ga.length; i++) ga[i] += 2 * l2 * (ps[k][i] - b0[k][i]);
    });
    return [...arrays(g), Float32Array.of(g.outB)];
  }

  /**
   * Mini-batch Adam from the base model. Awaits [pause] between batches so the app stays responsive
   * (all of this runs on the JavaScript thread on iPhone).
   */
  async train(
    examples: Example[],
    opts: { epochs?: number; lr?: number; l2?: number; batch?: number; seed?: number; pause?: () => Promise<void> } = {},
  ): Promise<WakeHead> {
    const { epochs = 12, lr = 1e-3, l2 = 1e-3, batch = 32, seed = 7, pause } = opts;
    const p = fromHead(this.base);
    const m = zero(p);
    const v = zero(p);
    let mB = 0;
    let vB = 0;
    let step = 0;
    let rnd = seed >>> 0 || 1;
    const random = () => {
      // xorshift32: deterministic shuffles for tests
      rnd ^= rnd << 13;
      rnd >>>= 0;
      rnd ^= rnd >>> 17;
      rnd ^= rnd << 5;
      rnd >>>= 0;
      return rnd / 4294967296;
    };
    const ps = arrays(p);
    const ms = arrays(m);
    const vs = arrays(v);
    const bs = arrays(this.baseParams);
    for (let epoch = 0; epoch < epochs; epoch++) {
      const order = examples.map((_, i) => i);
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      for (let start = 0; start < order.length; start += batch) {
        const idx = order.slice(start, start + batch);
        const g = zero(p);
        for (const i of idx) {
          const e = examples[i];
          const t = this.forward(p, e.x);
          this.backward(p, t, (e.weight * (sigmoid(t.logit) - e.label)) / idx.length, g);
        }
        step++;
        const b1c = 1 - B1 ** step;
        const b2c = 1 - B2 ** step;
        const gs = arrays(g);
        for (let k = 0; k < ps.length; k++) {
          const pa = ps[k];
          const ga = gs[k];
          const ma = ms[k];
          const va = vs[k];
          const b0 = bs[k];
          for (let i = 0; i < pa.length; i++) {
            const gi = ga[i] + 2 * l2 * (pa[i] - b0[i]);
            ma[i] = B1 * ma[i] + (1 - B1) * gi;
            va[i] = B2 * va[i] + (1 - B2) * gi * gi;
            pa[i] -= (lr * (ma[i] / b1c)) / (Math.sqrt(va[i] / b2c) + 1e-8);
          }
        }
        const gb = g.outB + 2 * l2 * (p.outB - this.baseParams.outB);
        mB = B1 * mB + (1 - B1) * gb;
        vB = B2 * vB + (1 - B2) * gb * gb;
        p.outB -= (lr * (mB / b1c)) / (Math.sqrt(vB / b2c) + 1e-8);
        if (pause) await pause();
      }
    }
    const layers: Layer[] = this.sizes.map(([inSize, outSize], l) => ({
      inSize,
      outSize,
      w: p.w[l].slice(),
      b: p.b[l].slice(),
      gamma: p.g[l].slice(),
      beta: p.be[l].slice(),
    }));
    return new WakeHead(this.base.frames, this.base.dim, layers, p.outW.slice(), p.outB, this.base.threshold, this.base.consecutive);
  }
}
