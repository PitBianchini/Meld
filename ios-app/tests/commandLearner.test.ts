import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommandLearner, decode, encode, meta, type Learned } from '../src/voice/commandLearner.ts';
import type { VoiceCommand } from '../src/voice/parser.ts';

let stored: Learned[] = [];
const learner = () => new CommandLearner(JSON.parse(JSON.stringify(stored)), (items) => (stored = items));

test('remembers exact phrases', () => {
  stored = [];
  learner().learn('Hey Meld, cambia aria', { type: 'Next' });
  assert.deepEqual(learner().match(['cambia aria']), { type: 'Next' });
  assert.deepEqual(learner().match(["ehi meld cambia l'aria"]), { type: 'Next' });
  assert.equal(learner().match(['cambia playlist']), null);
});

test('turns phrases with a name into templates', () => {
  stored = [];
  learner().learn("sparami un po' di vasco rossi", { type: 'Play', query: 'vasco rossi', kind: 'ARTIST', shuffle: false });
  assert.deepEqual(learner().match(["sparami un po' di ultimo"]), { type: 'Play', query: 'ultimo', kind: 'ARTIST', shuffle: false });
  assert.deepEqual(learner().match(["Hey Meld sparami un po' di Vasco Rossi"]), { type: 'Play', query: 'vasco rossi', kind: 'ARTIST', shuffle: false });
});

test('forgets the last lesson', () => {
  stored = [];
  const l = learner();
  l.learn('cambia aria', { type: 'Next' });
  l.learn('zitto un attimo', { type: 'Pause' });
  l.forgetLast();
  assert.equal(learner().match(['zitto un attimo']), null);
  assert.deepEqual(learner().match(['cambia aria']), { type: 'Next' });
});

test('recognizes forget requests', () => {
  assert.equal(meta(["Hey Meld dimentica l'ultima cosa che ti ho insegnato"]), 'FORGET_LAST');
  assert.equal(meta(['dimentica tutto quello che ti ho insegnato']), 'FORGET_ALL');
  assert.equal(meta(['dimentica la mia voce']), 'FORGET_VOICE');
  assert.equal(meta(['passa alla prossima']), null);
});

test('encodes every command', () => {
  const all: VoiceCommand[] = [
    { type: 'Next' }, { type: 'VolumeSet', percent: 40 }, { type: 'Shuffle', enabled: null }, { type: 'Like', liked: false },
    { type: 'Play', query: 'estate | 2024', kind: 'PLAYLIST', shuffle: true }, { type: 'Enqueue', query: 'yellow', next: true },
  ];
  for (const c of all) assert.deepEqual(decode(encode(c)!, null), c);
});
