import { test } from 'node:test';
import assert from 'node:assert/strict';
import { score } from '../src/voice/playlistMatch.ts';

test('same playlist scores as Android', () => {
  assert.equal(score('miei migliori 50', 'I miei migliori 50'), 1);
  assert.equal(score('estate 2024', 'Estate 2024 🔥'), 1);
  assert.equal(score('la playlist per correre', 'Per correre'), 1);
  assert.ok(Math.abs(score('rock italiano', 'Rock Italiano anni 90') - 0.85) < 1e-9);
  assert.ok(score('rock', 'Rock Italiano anni 90') < 0.85);
  assert.ok(score('vasco rossi', 'Lo-fi per studiare') < 0.3);
});
