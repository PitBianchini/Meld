import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WakeHead } from '../src/voice/wakeHead.ts';

test('matches the PyTorch outputs written by the training workflow', () => {
  const bin = readFileSync(new URL('../assets/hey_meld.bin', import.meta.url));
  const head = WakeHead.parse(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
  const lines = readFileSync(new URL('../../app/src/test/resources/heymeld/vectors.txt', import.meta.url), 'utf8').trim().split('\n');
  for (const line of lines) {
    const v = line.trim().split(' ').map(Number);
    const window: Float32Array[] = [];
    for (let i = 0; i < 16; i++) window.push(Float32Array.from(v.slice(1 + i * 96, 1 + (i + 1) * 96)));
    assert.ok(Math.abs(head.predict(window) - v[0]) < 1e-4, `${head.predict(window)} vs ${v[0]}`);
  }
  assert.ok(head.consecutive >= 1 && head.consecutive <= 5);
  assert.ok(head.threshold > 0 && head.threshold < 1);
});
