import { loadTensorflowModel, type TfliteModel } from 'react-native-fast-tflite';
import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';
import { WakeHead } from './wakeHead';

/**
 * Streaming openWakeWord pipeline, same as WakeWordDetector.kt on Android:
 * 80 ms chunks (1280 samples @ 16 kHz) -> melspectrogram -> speech embedding -> "Hey Meld" head.
 * The melspectrogram model shipped here has its input fixed to 1760 samples (1280 + 3 x 160).
 */
export const SAMPLE_RATE = 16000;
export const CHUNK = 1280;
const RAW_WINDOW = CHUNK + 160 * 3;
const MEL_BINS = 32;
const EMB_WINDOW = 76;
const EMB_DIM = 96;
const WARMUP_CHUNKS = 5;

export class WakeWordDetector {
  private raw = new Float32Array(RAW_WINDOW);
  private mel: Float32Array[] = [];
  private features: Float32Array[] = [];
  private chunks = 0;
  private embInput = new Float32Array(EMB_WINDOW * MEL_BINS);

  private constructor(private melspec: TfliteModel, private embedding: TfliteModel, readonly head: WakeHead) {
    this.reset();
  }

  static async load(): Promise<WakeWordDetector> {
    const [melspec, embedding] = await Promise.all([
      loadTensorflowModel(require('../../assets/melspectrogram.tflite'), []),
      loadTensorflowModel(require('../../assets/embedding_model.tflite'), []),
    ]);
    const bin = await fetchAsset(require('../../assets/hey_meld.bin'));
    return new WakeWordDetector(melspec, embedding, WakeHead.parse(bin));
  }

  reset() {
    this.raw.fill(0);
    this.mel = Array.from({ length: EMB_WINDOW }, () => new Float32Array(MEL_BINS).fill(1));
    this.features = Array.from({ length: this.head.frames }, () => new Float32Array(EMB_DIM));
    this.chunks = 0;
  }

  /** @param chunk CHUNK samples as int16 values. @returns wake word probability. */
  process(chunk: Int16Array): number {
    this.raw.copyWithin(0, CHUNK);
    for (let i = 0; i < CHUNK; i++) this.raw[RAW_WINDOW - CHUNK + i] = chunk[i];
    const melOut = new Float32Array(this.melspec.runSync([this.raw.slice().buffer])[0]);
    for (let f = 0; f + MEL_BINS <= melOut.length; f += MEL_BINS) {
      const frame = new Float32Array(MEL_BINS);
      for (let b = 0; b < MEL_BINS; b++) frame[b] = melOut[f + b] / 10 + 2;
      this.mel.push(frame);
    }
    if (this.mel.length > EMB_WINDOW) this.mel.splice(0, this.mel.length - EMB_WINDOW);
    for (let f = 0; f < EMB_WINDOW; f++) this.embInput.set(this.mel[f], f * MEL_BINS);
    const emb = new Float32Array(this.embedding.runSync([this.embInput.slice().buffer])[0]);
    this.features.push(emb.slice(0, EMB_DIM));
    if (this.features.length > this.head.frames) this.features.shift();
    this.chunks++;
    if (this.chunks < WARMUP_CHUNKS) return 0;
    return this.head.predict(this.features);
  }
}

async function fetchAsset(moduleId: number): Promise<ArrayBuffer> {
  const asset = Asset.fromModule(moduleId);
  await asset.downloadAsync();
  const bytes = await new File(asset.localUri ?? asset.uri).bytes();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
