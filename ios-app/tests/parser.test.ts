import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, parseBest, startsWithWakeWord } from '../src/voice/parser.ts';

const cases: [string, unknown][] = [
 [
  "Hey Meld, passa la canzone successiva",
  {
   "type": "Next"
  }
 ],
 [
  "hey meld passa alla prossima",
  {
   "type": "Next"
  }
 ],
 [
  "la canzone successiva",
  {
   "type": "Next"
  }
 ],
 [
  "prossima canzone",
  {
   "type": "Next"
  }
 ],
 [
  "salta",
  {
   "type": "Next"
  }
 ],
 [
  "avanti",
  {
   "type": "Next"
  }
 ],
 [
  "canzone precedente",
  {
   "type": "Previous"
  }
 ],
 [
  "torna alla canzone precedente",
  {
   "type": "Previous"
  }
 ],
 [
  "metti quella di prima",
  {
   "type": "Previous"
  }
 ],
 [
  "indietro",
  {
   "type": "Previous"
  }
 ],
 [
  "ricomincia",
  {
   "type": "Restart"
  }
 ],
 [
  "ricomincia la canzone da capo",
  {
   "type": "Restart"
  }
 ],
 [
  "dall'inizio",
  {
   "type": "Restart"
  }
 ],
 [
  "stoppa la musica",
  {
   "type": "Pause"
  }
 ],
 [
  "Hey Meld stop",
  {
   "type": "Pause"
  }
 ],
 [
  "metti in pausa",
  {
   "type": "Pause"
  }
 ],
 [
  "ferma la musica",
  {
   "type": "Pause"
  }
 ],
 [
  "basta",
  {
   "type": "Pause"
  }
 ],
 [
  "riprendi",
  {
   "type": "Resume"
  }
 ],
 [
  "continua",
  {
   "type": "Resume"
  }
 ],
 [
  "riproduci",
  {
   "type": "Resume"
  }
 ],
 [
  "fai ripartire la musica",
  {
   "type": "Resume"
  }
 ],
 [
  "alza il volume",
  {
   "type": "VolumeUp"
  }
 ],
 [
  "più forte",
  {
   "type": "VolumeUp"
  }
 ],
 [
  "abbassa il volume",
  {
   "type": "VolumeDown"
  }
 ],
 [
  "più piano",
  {
   "type": "VolumeDown"
  }
 ],
 [
  "volume al 50",
  {
   "type": "VolumeSet",
   "percent": 50
  }
 ],
 [
  "metti il volume al 30 per cento",
  {
   "type": "VolumeSet",
   "percent": 30
  }
 ],
 [
  "volume a cinquanta",
  {
   "type": "VolumeSet",
   "percent": 50
  }
 ],
 [
  "volume al massimo",
  {
   "type": "VolumeSet",
   "percent": 100
  }
 ],
 [
  "metti in coda Bohemian Rhapsody",
  {
   "type": "Enqueue",
   "query": "bohemian rhapsody",
   "next": false
  }
 ],
 [
  "aggiungi alla coda Thunderstruck",
  {
   "type": "Enqueue",
   "query": "thunderstruck",
   "next": false
  }
 ],
 [
  "metti dopo questa Imagine",
  {
   "type": "Enqueue",
   "query": "imagine",
   "next": true
  }
 ],
 [
  "metti subito dopo Yellow",
  {
   "type": "Enqueue",
   "query": "yellow",
   "next": true
  }
 ],
 [
  "riproduci la playlist allenamento",
  {
   "type": "Play",
   "query": "allenamento",
   "kind": "PLAYLIST",
   "shuffle": false
  }
 ],
 [
  "metti la playlist Rock in casuale",
  {
   "type": "Play",
   "query": "rock",
   "kind": "PLAYLIST",
   "shuffle": true
  }
 ],
 [
  "casuale",
  {
   "type": "Shuffle",
   "enabled": null
  }
 ],
 [
  "attiva la riproduzione casuale",
  {
   "type": "Shuffle",
   "enabled": true
  }
 ],
 [
  "disattiva casuale",
  {
   "type": "Shuffle",
   "enabled": false
  }
 ],
 [
  "che canzone è",
  {
   "type": "WhatIsPlaying"
  }
 ],
 [
  "che canzone è questa",
  {
   "type": "WhatIsPlaying"
  }
 ],
 [
  "chi canta questa canzone",
  {
   "type": "WhatIsPlaying"
  }
 ],
 [
  "come si chiama questa canzone",
  {
   "type": "WhatIsPlaying"
  }
 ],
 [
  "cosa sta suonando",
  {
   "type": "WhatIsPlaying"
  }
 ],
 [
  "metti mi piace",
  {
   "type": "Like",
   "liked": true
  }
 ],
 [
  "mi piace",
  {
   "type": "Like",
   "liked": true
  }
 ],
 [
  "aggiungi ai preferiti",
  {
   "type": "Like",
   "liked": true
  }
 ],
 [
  "togli mi piace",
  {
   "type": "Like",
   "liked": false
  }
 ],
 [
  "riproduci Bohemian Rhapsody dei Queen",
  {
   "type": "Play",
   "query": "bohemian rhapsody queen",
   "kind": "SONG",
   "shuffle": false
  }
 ],
 [
  "riproduci Blinding Lights",
  {
   "type": "Play",
   "query": "blinding lights",
   "kind": "AUTO",
   "shuffle": false
  }
 ],
 [
  "metti qualcosa dei Måneskin",
  {
   "type": "Play",
   "query": "måneskin",
   "kind": "ARTIST",
   "shuffle": false
  }
 ],
 [
  "fammi sentire le canzoni di Ultimo",
  {
   "type": "Play",
   "query": "ultimo",
   "kind": "ARTIST",
   "shuffle": false
  }
 ],
 [
  "riproduci l'album Random Access Memories",
  {
   "type": "Play",
   "query": "random access memories",
   "kind": "ALBUM",
   "shuffle": false
  }
 ],
 [
  "metti l'album dei Pink Floyd",
  {
   "type": "Play",
   "query": "pink floyd",
   "kind": "ALBUM",
   "shuffle": false
  }
 ],
 [
  "riproduci le mie canzoni preferite",
  {
   "type": "Play",
   "query": "",
   "kind": "LIKED",
   "shuffle": false
  }
 ],
 [
  "metti i miei mi piace",
  {
   "type": "Play",
   "query": "",
   "kind": "LIKED",
   "shuffle": false
  }
 ],
 [
  "per favore metti la canzone Bella ciao",
  {
   "type": "Play",
   "query": "bella ciao",
   "kind": "SONG",
   "shuffle": false
  }
 ],
 [
  "riproduci Vasco Rossi",
  {
   "type": "Play",
   "query": "vasco rossi",
   "kind": "AUTO",
   "shuffle": false
  }
 ],
 [
  "hey meld puoi passare alla prossima",
  {
   "type": "Next"
  }
 ],
 [
  "potresti alzare il volume",
  {
   "type": "VolumeUp"
  }
 ],
 [
  "mi metti Imagine di John Lennon",
  {
   "type": "Play",
   "query": "imagine john lennon",
   "kind": "SONG",
   "shuffle": false
  }
 ],
 [
  "ehi meld riproduci i Coldplay",
  {
   "type": "Play",
   "query": "coldplay",
   "kind": "AUTO",
   "shuffle": false
  }
 ],
 [
  "riproduci la canzone di Marinella",
  {
   "type": "Play",
   "query": "di marinella",
   "kind": "SONG",
   "shuffle": false
  }
 ],
 [
  "ciao come stai",
  {
   "type": "Unknown"
  }
 ],
 [
  "schippa la canzone",
  {
   "type": "Next"
  }
 ],
 [
  "skippa",
  {
   "type": "Next"
  }
 ],
 [
  "skippa questa canzone",
  {
   "type": "Next"
  }
 ],
 [
  "vai avanti",
  {
   "type": "Next"
  }
 ],
 [
  "passa questa",
  {
   "type": "Next"
  }
 ],
 [
  "torna indietro",
  {
   "type": "Previous"
  }
 ],
 [
  "torna indietro di una",
  {
   "type": "Previous"
  }
 ],
 [
  "torna alla canzone di prima",
  {
   "type": "Previous"
  }
 ],
 [
  "rimetti quella di prima",
  {
   "type": "Previous"
  }
 ],
 [
  "torna alla precedente",
  {
   "type": "Previous"
  }
 ],
 [
  "metti quelli che ho scaricato",
  {
   "type": "Play",
   "query": "",
   "kind": "DOWNLOADED",
   "shuffle": false
  }
 ],
 [
  "riproduci le canzoni scaricate",
  {
   "type": "Play",
   "query": "",
   "kind": "DOWNLOADED",
   "shuffle": false
  }
 ],
 [
  "metti la playlist dei download",
  {
   "type": "Play",
   "query": "",
   "kind": "DOWNLOADED",
   "shuffle": false
  }
 ],
 [
  "riproduci i miei migliori 50",
  {
   "type": "Play",
   "query": "miei migliori 50",
   "kind": "AUTO",
   "shuffle": false
  }
 ],
 [
  "metti la playlist i miei migliori 50",
  {
   "type": "Play",
   "query": "i miei migliori 50",
   "kind": "PLAYLIST",
   "shuffle": false
  }
 ],
 [
  "riproduci la mia playlist estate 2024",
  {
   "type": "Play",
   "query": "estate 2024",
   "kind": "PLAYLIST",
   "shuffle": false
  }
 ]
];

test('same results as the Android parser', () => {
  const failures = cases.filter(([input, expected]) => JSON.stringify(parse(input)) !== JSON.stringify(expected))
    .map(([input, expected]) => `${input} -> ${JSON.stringify(parse(input))} (expected ${JSON.stringify(expected)})`);
  assert.deepEqual(failures, []);
});

test('skips a misheard wake word', () => {
  assert.deepEqual(parseBest(['a mild passa la canzone successiva']), { type: 'Next' });
  assert.deepEqual(parseBest(['hey man stoppa la musica']), { type: 'Pause' });
  assert.deepEqual(parseBest(['ciao come stai oggi']), { type: 'Unknown' });
});

test('wake word detection in transcripts', () => {
  for (const t of ['Hey Meld passa', 'ehi Mel stop', 'e-mail riproduci Vasco']) assert.equal(startsWithWakeWord(t), true, t);
  for (const t of ['metti la mia canzone', 'hey you', 'melodia']) assert.equal(startsWithWakeWord(t), false, t);
});
