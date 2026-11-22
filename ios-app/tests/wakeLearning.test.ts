import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WakeHead, type Layer } from '../src/voice/wakeHead.ts';
import { WakeTrainer, type Example } from '../src/voice/wakeTrainer.ts';
import { WakeLearner, type LearnerIO } from '../src/voice/wakeLearner.ts';

let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const rand = (n: number, scale = 0.5) => Float32Array.from({ length: n }, () => (rnd() * 2 - 1) * scale);

function smallHead(frames = 2, dim = 3, threshold = 0.5): WakeHead {
  const input = frames * dim;
  const layers: Layer[] = [[input, 4], [4, 4]].map(([i, o]) => ({
    inSize: i, outSize: o, w: rand(i * o), b: rand(o), gamma: Float32Array.from({ length: o }, () => 1 + rnd() * 0.2), beta: rand(o, 0.1),
  }));
  return new WakeHead(frames, dim, layers, rand(4), 0.1, threshold, 1);
}

/** Same array order as WakeTrainer.gradient(): all W, all b, all gamma, all beta, outW, then outB. */
function perturbed(h: WakeHead, array: number, index: number, delta: number): WakeHead {
  const layers = h.layers.map((l) => ({ ...l, w: l.w.slice(), b: l.b.slice(), gamma: l.gamma.slice(), beta: l.beta.slice() }));
  const outW = h.outW.slice();
  let outB = h.outB;
  const all = [...layers.map((l) => l.w), ...layers.map((l) => l.b), ...layers.map((l) => l.gamma), ...layers.map((l) => l.beta), outW];
  if (array < all.length) all[array][index] += delta;
  else outB += delta;
  return new WakeHead(h.frames, h.dim, layers, outW, outB, h.threshold, h.consecutive);
}

test('gradient matches finite differences', () => {
  const base = smallHead();
  const trainer = new WakeTrainer(base);
  const point = perturbed(perturbed(base, 0, 3, 0.2), 8, 1, -0.3);
  const examples: Example[] = Array.from({ length: 6 }, (_, i) => ({ x: rand(6, 1), label: i % 2 ? 0 : 1, weight: i % 2 ? 3 : 1 }));
  const grads = trainer.gradient(point, examples, 0.01);
  let checked = 0;
  grads.forEach((g, a) => g.forEach((value, i) => {
    const eps = 1e-3;
    const num = (trainer.loss(perturbed(point, a, i, eps), examples, 0.01) - trainer.loss(perturbed(point, a, i, -eps), examples, 0.01)) / (2 * eps);
    assert.ok(Math.abs(num - value) < 2e-3 + 2e-2 * Math.abs(num), `array ${a} index ${i}: ${num} vs ${value}`);
    checked++;
  }));
  assert.ok(checked > 50);
});

test('training separates examples', async () => {
  const pos = Array.from({ length: 40 }, () => ({ x: Float32Array.from({ length: 6 }, () => 1 + rnd() * 0.3), label: 1, weight: 1 }));
  const neg = Array.from({ length: 40 }, () => ({ x: Float32Array.from({ length: 6 }, () => -1 - rnd() * 0.3), label: 0, weight: 1 }));
  const tuned = await new WakeTrainer(smallHead()).train([...pos, ...neg], { epochs: 60, lr: 1e-2, l2: 1e-4, batch: 8 });
  const avg = (l: Example[]) => l.reduce((s, e) => s + tuned.predictFlat(e.x), 0) / l.length;
  assert.ok(avg(pos) > 0.9 && avg(neg) < 0.1, `${avg(pos)} ${avg(neg)}`);
});

test('model bytes round trip', () => {
  const h = smallHead().withThreshold(0.8);
  const b = h.toBytes();
  const back = WakeHead.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
  const x = rand(6, 1);
  assert.ok(Math.abs(back.predictFlat(x) - h.predictFlat(x)) < 1e-7);
  assert.ok(Math.abs(back.threshold - 0.8) < 1e-6);
});

test('learner personalizes from confirmed detections and background', async () => {
  const files = new Map<string, unknown>();
  const io: LearnerIO = {
    loadList: (n) => (files.get(n) as Float32Array[]) ?? [],
    saveList: (n, l) => void files.set(n, l.slice()),
    loadBytes: (n) => (files.get(n) as Uint8Array) ?? null,
    saveBytes: (n, b) => void files.set(n, b),
    remove: (n) => void files.delete(n),
  };
  let now = 0;
  // a base model that only weakly reacts to the "voice" pattern
  const base = smallHead(2, 3, 0.9);
  const learner = new WakeLearner(base, io, { now: () => now, epochs: 40 });
  const voice = () => Float32Array.from({ length: 6 }, () => 1 + rnd() * 0.3);
  const background = () => Float32Array.from({ length: 6 }, () => -1 - rnd() * 0.3);
  for (let i = 0; i < 400; i++) {
    now += 46_000;
    learner.onChunk(background(), 0, false);
  }
  let model: WakeHead | null = null;
  learner.onNewModel = (h) => (model = h);
  for (let i = 0; i < 40; i++) {
    now += 6 * 60_000;
    learner.onChunk(voice(), 0.95, false);
    learner.confirmed(learner.snapshot());
    await new Promise((r) => setTimeout(r, 0));
  }
  assert.ok(model, 'a personal model was accepted');
  assert.ok(learner.loadPersonal(), 'it is saved for the next start');
  const m = model as unknown as WakeHead;
  const recall = Array.from({ length: 50 }, voice).filter((x) => m.predictFlat(x) >= m.threshold).length / 50;
  const fa = Array.from({ length: 50 }, background).filter((x) => m.predictFlat(x) >= m.threshold).length / 50;
  assert.ok(recall > 0.9 && fa < 0.05, `recall ${recall} false accepts ${fa}`);
  learner.reset();
  assert.equal(learner.loadPersonal(), null);
});
