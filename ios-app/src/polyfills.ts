// Web APIs youtubei.js expects, which React Native doesn't provide.
import 'react-native-get-random-values';
import 'react-native-url-polyfill/auto';
import 'event-target-polyfill';
import 'fast-text-encoding';
import { ReadableStream } from 'web-streams-polyfill';

const g = globalThis as any;
g.ReadableStream ??= ReadableStream;
g.CustomEvent ??= class CustomEvent extends Event {
  detail: unknown;
  constructor(type: string, init?: { detail?: unknown }) {
    super(type);
    this.detail = init?.detail;
  }
};
