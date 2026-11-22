// Port of WakeLearner.kt: makes "Hey Meld" better at the user's own voice and surroundings over time.
// A detection followed by an understood command is a positive (and so are the almost-detections just
// before it, when the user had to repeat); a detection with nothing sensible after it while music is loud
// is a false trigger; now and then ordinary background is kept as a negative. Every few new examples the
// head is fine-tuned on the phone and kept only if it does at least as well on held-out examples.
import { WakeHead } from './wakeHead.ts';
import { WakeTrainer, type Example } from './wakeTrainer.ts';

export type Snapshot = { detection: Float32Array | null; nearMisses: Float32Array[] };

/** Where examples and the personal model are kept (files on the phone, memory in tests). */
export interface LearnerIO {
  loadList(name: string): Float32Array[];
  saveList(name: string, list: Float32Array[]): void;
  loadBytes(name: string): Uint8Array | null;
  saveBytes(name: string, bytes: Uint8Array): void;
  remove(name: string): void;
}

const RECENT_CHUNKS = 80;
const NEAR_MISS = 0.4;
const MAX_POSITIVES = 400;
// smaller than on Android: training runs on the JavaScript thread here
const MAX_NEGATIVES = 1200;
const MAX_HARD = 300;
const MIN_POSITIVES = 6;
const MIN_NEGATIVES = 150;
const THRESHOLDS = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.93, 0.95, 0.97];

/** Seeded PRNG so the held-out split stays the same between runs. */
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function signature(h: WakeHead): string {
  // FNV-1a over the model bytes
  let x = 0x811c9dc5;
  for (const b of h.toBytes()) x = Math.imul(x ^ b, 0x01000193) >>> 0;
  return x.toString(16);
}

export class WakeLearner {
  private positives: Float32Array[];
  private negatives: Float32Array[];
  private hard: Float32Array[];
  private recent: { window: Float32Array; score: number; at: number }[] = [];
  private lastBackground = 0;
  private newSinceTraining = 0;
  private training = false;
  private lastTraining = 0;
  private negativesDirty = 0;
  current: WakeHead;
  onNewModel: ((h: WakeHead) => void) | null = null;
  readonly base: WakeHead;
  private readonly io: LearnerIO;
  private readonly opts: { now?: () => number; pause?: () => Promise<void>; epochs?: number };

  constructor(base: WakeHead, io: LearnerIO, opts: { now?: () => number; pause?: () => Promise<void>; epochs?: number } = {}) {
    this.base = base;
    this.io = io;
    this.opts = opts;
    this.positives = io.loadList('positives');
    this.negatives = io.loadList('negatives');
    this.hard = io.loadList('false_triggers');
    this.current = base;
  }

  private now() {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  get examplesCount() {
    return this.positives.length;
  }

  /** The personalized head, if it was trained on top of the current base model. */
  loadPersonal(): WakeHead | null {
    try {
      const sig = this.io.loadBytes('personal.base');
      const bin = this.io.loadBytes('personal.bin');
      if (!sig || !bin || String.fromCharCode(...sig) !== signature(this.base)) return null;
      const h = WakeHead.parse(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer);
      return h.frames === this.base.frames && h.dim === this.base.dim ? h : null;
    } catch {
      return null;
    }
  }

  /** Every audio chunk while listening for the wake word. */
  onChunk(window: Float32Array, score: number, musicPlaying: boolean) {
    const now = this.now();
    this.recent.push({ window, score, at: now });
    if (this.recent.length > RECENT_CHUNKS) this.recent.shift();
    const every = musicPlaying ? 15_000 : 45_000;
    if (score < 0.2 && now - this.lastBackground > every) {
      this.lastBackground = now;
      this.add(this.negatives, window, MAX_NEGATIVES);
      if (++this.negativesDirty >= 20) {
        this.negativesDirty = 0;
        this.io.saveList('negatives', this.negatives);
      }
    }
  }

  /** At a detection: the window now and probable earlier attempts. */
  snapshot(): Snapshot {
    const now = this.now();
    const list = this.recent;
    const near: Float32Array[] = [];
    for (let i = 1; i < list.length - 1; i++) {
      const r = list[i];
      const age = now - r.at;
      if (age >= 800 && age <= 6000 && r.score >= NEAR_MISS && r.score >= list[i - 1].score && r.score >= list[i + 1].score) near.push(r.window);
    }
    return { detection: list.length ? list[list.length - 1].window : null, nearMisses: near.slice(-3) };
  }

  confirmed(s: Snapshot) {
    if (!s.detection) return;
    this.add(this.positives, s.detection, MAX_POSITIVES);
    s.nearMisses.forEach((w) => this.add(this.positives, w, MAX_POSITIVES));
    this.io.saveList('positives', this.positives);
    this.newSinceTraining += 1 + s.nearMisses.length;
    void this.maybeTrain();
  }

  falseTrigger(s: Snapshot) {
    if (!s.detection) return;
    this.add(this.hard, s.detection, MAX_HARD);
    this.io.saveList('false_triggers', this.hard);
    this.newSinceTraining++;
    void this.maybeTrain();
  }

  reset() {
    this.positives = [];
    this.hard = [];
    ['positives', 'false_triggers', 'personal.bin', 'personal.base'].forEach((n) => this.io.remove(n));
    this.current = this.base;
  }

  /** Resolves with the new head when one was trained and accepted (also passed to [onNewModel]). */
  async maybeTrain(): Promise<WakeHead | null> {
    const now = this.now();
    if (this.training || this.positives.length < MIN_POSITIVES || this.negatives.length + this.hard.length < MIN_NEGATIVES) return null;
    if (this.newSinceTraining < 3 || now - this.lastTraining < 5 * 60_000) return null;
    this.training = true;
    this.lastTraining = now;
    this.newSinceTraining = 0;
    try {
      const result = await this.fineTune(this.positives.slice(), this.negatives.slice(), this.hard.slice());
      if (result) {
        this.io.saveBytes('personal.bin', result.toBytes());
        this.io.saveBytes('personal.base', Uint8Array.from(signature(this.base), (c) => c.charCodeAt(0)));
        this.current = result;
        this.onNewModel?.(result);
      }
      return result;
    } catch (e) {
      console.warn('[heyMeld] personalization failed', e);
      return null;
    } finally {
      this.training = false;
    }
  }

  private async fineTune(pos: Float32Array[], neg: Float32Array[], hardNeg: Float32Array[]): Promise<WakeHead | null> {
    const split = mulberry32(1);
    const holdOut = (list: Float32Array[]) => {
      const tr: Float32Array[] = [];
      const val: Float32Array[] = [];
      list.forEach((x) => (Math.floor(split() * 5) !== 0 ? tr : val).push(x));
      return [tr, val];
    };
    const [posTr, posVal] = holdOut(pos);
    const [negTr, negVal] = holdOut(neg);
    const [hardTr, hardVal] = holdOut(hardNeg);
    if (!posVal.length || !negVal.length) return null;

    const examples: Example[] = [
      ...posTr.map((x) => ({ x, label: 1, weight: 2 })),
      ...negTr.map((x) => ({ x, label: 0, weight: 1 })),
      ...hardTr.map((x) => ({ x, label: 0, weight: 4 })),
    ];
    const tuned = await new WakeTrainer(this.base).train(examples, { epochs: this.opts.epochs ?? 8, pause: this.opts.pause });

    const old = this.current;
    const share = (h: WakeHead, t: number, l: Float32Array[]) => (l.length ? l.filter((x) => h.predictFlat(x) >= t).length / l.length : 0);
    const oldRecall = share(old, old.threshold, posVal);
    const oldNeg = share(old, old.threshold, negVal);
    const oldHard = share(old, old.threshold, hardVal);
    // the most permissive threshold that doesn't accept more background than the current model
    let best: { t: number; recall: number } | null = null;
    for (const t of THRESHOLDS) {
      if (share(tuned, t, negVal) > Math.max(oldNeg, 0.003)) continue;
      if (share(tuned, t, hardVal) > Math.max(oldHard, 0.1)) continue;
      const recall = share(tuned, t, posVal);
      if (!best || recall > best.recall) best = { t, recall };
    }
    if (!best || best.recall < oldRecall) return null;
    console.log(`[heyMeld] personal model: recall ${oldRecall.toFixed(2)} -> ${best.recall.toFixed(2)} at threshold ${best.t}`);
    return tuned.withThreshold(best.t);
  }

  private add(list: Float32Array[], x: Float32Array, cap: number) {
    if (list.length < cap) list.push(x);
    else list[Math.floor(Math.random() * cap)] = x;
  }
}
