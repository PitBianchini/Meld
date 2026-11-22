import { AudioModule, requestRecordingPermissionsAsync } from 'expo-audio';
import * as Speech from 'expo-speech';
import { ExpoSpeechRecognitionModule } from 'expo-speech-recognition';
import { Directory, File, Paths } from 'expo-file-system';
import { useEffect, useState } from 'react';
import * as player from '../player/player';
import { store } from '../storage/store';
import { execute } from './executor';
import { CommandLearner, meta, type Meta } from './commandLearner';
import { parseBest, clean, type VoiceCommand } from './parser';
import { WakeLearner, type LearnerIO, type Snapshot } from './wakeLearner';
import { CHUNK, SAMPLE_RATE, WakeWordDetector } from './wakeWord';

/**
 * "Hey Meld" on iPhone: openWakeWord on the microphone stream while the app is open or playing,
 * then Apple's speech recognizer (it-IT) for the command, then a spoken reply.
 */
type Status = 'off' | 'listening' | 'command' | 'muted' | 'error';
let status: Status = 'off';
let lastHeard = '';
const listeners = new Set<() => void>();
const setStatus = (s: Status) => {
  status = s;
  listeners.forEach((l) => l());
};

export function useHeyMeld() {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((x) => x + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return {
    status,
    lastHeard,
    learnedPhrases: commands.size,
    voiceExamples: wakeLearner?.examplesCount ?? 0,
    personalized: !!detector && detector.head !== detector.baseHead,
  };
}

// --------------------------------------------------------------------------- self learning

const learnDir = new Directory(Paths.document, 'heymeld');

/** Example windows as [count int32][length int32][floats], like WakeLearner.kt. */
const fileIO: LearnerIO = {
  loadList(name) {
    try {
      const f = new File(learnDir, `${name}.bin`);
      if (!f.exists) return [];
      const bytes = f.bytesSync();
      const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const n = v.getInt32(0, true);
      const len = v.getInt32(4, true);
      const all = new Float32Array(bytes.buffer.slice(bytes.byteOffset + 8, bytes.byteOffset + 8 + n * len * 4));
      return Array.from({ length: n }, (_, i) => all.slice(i * len, (i + 1) * len));
    } catch {
      return [];
    }
  },
  saveList(name, list) {
    const len = list[0]?.length ?? 0;
    const out = new Uint8Array(8 + list.length * len * 4);
    const v = new DataView(out.buffer);
    v.setInt32(0, list.length, true);
    v.setInt32(4, len, true);
    const floats = new Float32Array(out.buffer, 8);
    list.forEach((w, i) => floats.set(w, i * len));
    this.saveBytes(`${name}.bin`, out);
  },
  loadBytes(name) {
    try {
      const f = new File(learnDir, name);
      return f.exists ? f.bytesSync() : null;
    } catch {
      return null;
    }
  },
  saveBytes(name, bytes) {
    try {
      if (!learnDir.exists) learnDir.create({ intermediates: true, idempotent: true });
      new File(learnDir, name).write(bytes).catch((e: unknown) => console.warn('[heyMeld] save failed', name, e));
    } catch (e) {
      console.warn('[heyMeld] save failed', name, e);
    }
  },
  remove(name) {
    for (const n of [name, `${name}.bin`]) {
      try {
        const f = new File(learnDir, n);
        if (f.exists) f.delete();
      } catch {}
    }
  },
};

const commands = new CommandLearner(store.get().learned, (items) => store.setLearned(items));
let wakeLearner: WakeLearner | null = null;
const yieldToApp = () => new Promise<void>((r) => setTimeout(r, 0));

// with loud music the wake word scores lower: accept it more easily and stay silent on the false
// triggers this causes (the speech recognizer finds no command after them)
const LOUD_RMS = 1000;
const LOUD_THRESHOLD_DROP = 0.25;
const LOUD_MIN_THRESHOLD = 0.6;
let loudness = 0;

const SPEECH_CATEGORY = {
  category: 'playAndRecord',
  categoryOptions: ['defaultToSpeaker', 'allowBluetoothA2DP'],
  mode: 'default',
} as const;

let detector: WakeWordDetector | null = null;
let stream: any = null;
let pending = new Int16Array(0);
let above = 0;
let cooldownUntil = 0;
let busy = false;

export async function startHeyMeld(): Promise<string | null> {
  if (store.get().settings.heyMeldMuted) {
    setStatus('muted');
    return null;
  }
  try {
    const mic = await requestRecordingPermissionsAsync();
    if (!mic.granted) return 'Serve il permesso del microfono';
    const sr = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!sr.granted) return 'Serve il permesso del riconoscimento vocale';
    await player.setupAudio(true);
    if (!detector) {
      detector = await WakeWordDetector.load();
      wakeLearner = new WakeLearner(detector.baseHead, fileIO, { pause: yieldToApp });
      const personal = wakeLearner.loadPersonal();
      if (personal) {
        detector.useHead(personal);
        wakeLearner.current = personal;
      }
      wakeLearner.onNewModel = (h) => {
        detector?.useHead(h);
        listeners.forEach((l) => l());
      };
    }
    await openStream();
    setStatus('listening');
    return null;
  } catch (e: any) {
    setStatus('error');
    return String(e?.message ?? e);
  }
}

async function openStream() {
  if (!stream) {
    stream = new (AudioModule as any).AudioStream({ sampleRate: SAMPLE_RATE, channels: 1, encoding: 'int16' });
    stream.addListener('audioStreamBuffer', (b: { data: ArrayBuffer }) => onAudio(new Int16Array(b.data)));
  }
  detector?.reset();
  pending = new Int16Array(0);
  above = 0;
  await stream.start();
}

function closeStream() {
  try {
    stream?.stop();
  } catch {}
}

export function setHeyMeldMuted(muted: boolean) {
  store.setSetting('heyMeldMuted', muted);
  if (muted) {
    closeStream();
    setStatus('muted');
  } else {
    void startHeyMeld();
  }
}

function onAudio(samples: Int16Array) {
  if (!detector || busy || status !== 'listening') return;
  const merged = new Int16Array(pending.length + samples.length);
  merged.set(pending);
  merged.set(samples, pending.length);
  let offset = 0;
  while (merged.length - offset >= CHUNK) {
    const chunk = merged.subarray(offset, offset + CHUNK);
    const p = detector.process(chunk);
    offset += CHUNK;
    const musicPlaying = player.getPlayer().playing;
    wakeLearner?.onChunk(detector.lastWindow(), p, musicPlaying);
    let sum = 0;
    for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
    loudness = 0.95 * loudness + 0.05 * Math.sqrt(sum / chunk.length);
    const base = detector.head.threshold;
    const threshold = musicPlaying && loudness > LOUD_RMS ? Math.max(LOUD_MIN_THRESHOLD, base - LOUD_THRESHOLD_DROP) : base;
    above = p >= threshold ? above + 1 : 0;
    if (above >= detector.head.consecutive && Date.now() >= cooldownUntil) {
      above = 0;
      const snapshot = wakeLearner?.snapshot() ?? { detection: null, nearMisses: [] };
      void onWake(snapshot, p < base);
      pending = new Int16Array(0);
      return;
    }
  }
  pending = merged.slice(offset);
}

function listenOnce(): Promise<string[] | null> {
  return new Promise((resolve) => {
    const subs: { remove(): void }[] = [];
    let done = false;
    const finish = (v: string[] | null) => {
      if (done) return;
      done = true;
      subs.forEach((s) => s.remove());
      resolve(v);
    };
    subs.push(
      ExpoSpeechRecognitionModule.addListener('result', (e) => {
        if (e.isFinal) finish(e.results.map((r) => r.transcript).filter(Boolean));
      }),
      ExpoSpeechRecognitionModule.addListener('nomatch', () => finish(null)),
      ExpoSpeechRecognitionModule.addListener('error', () => finish(null)),
      ExpoSpeechRecognitionModule.addListener('end', () => setTimeout(() => finish(null), 300)),
    );
    ExpoSpeechRecognitionModule.start({
      lang: 'it-IT',
      interimResults: false,
      maxAlternatives: 5,
      continuous: false,
      addsPunctuation: false,
      contextualStrings: ['Hey Meld', 'canzone successiva', 'precedente', 'playlist', 'metti in coda', 'mi piace'],
      iosCategory: SPEECH_CATEGORY as any,
    });
    setTimeout(() => {
      ExpoSpeechRecognitionModule.stop();
      setTimeout(() => finish(null), 1500);
    }, 7000);
  });
}

function say(text: string): Promise<void> {
  return new Promise((resolve) => {
    Speech.speak(text, { language: 'it-IT', onDone: () => resolve(), onError: () => resolve(), onStopped: () => resolve() });
    setTimeout(resolve, 12000);
  });
}

const CANCEL = /lascia (?:perdere|stare)|niente|annulla|non importa/;

/** Asks what an unknown phrase means and remembers the answer for next time. */
async function teach(heard: string) {
  const shown = clean(heard) || heard;
  await say(`Non conosco «${shown}». Dimmi cosa devo fare con un comando che conosco, oppure di' lascia perdere.`);
  const answer = await listenOnce();
  if (!answer?.length) {
    await say('Va bene, lascio perdere');
    return;
  }
  if (answer.some((a) => CANCEL.test(a.toLowerCase()))) {
    await say('Va bene');
    return;
  }
  const meant: VoiceCommand = commands.match(answer) ?? parseBest(answer);
  if (meant.type === 'Unknown') {
    await say('Non ho capito neanche questo, lascio perdere');
    return;
  }
  commands.learn(heard, meant);
  listeners.forEach((l) => l());
  const reply = await execute(meant);
  await say(`Ok, d'ora in poi «${shown}» vorrà dire questo. ${reply}`);
}

function forget(m: Meta): string {
  switch (m) {
    case 'FORGET_LAST': {
      const l = commands.forgetLast();
      return l ? `Ho dimenticato «${l.phrase}»` : 'Non mi hai ancora insegnato niente';
    }
    case 'FORGET_ALL':
      commands.forgetAll();
      return 'Ho dimenticato tutte le frasi che mi hai insegnato';
    case 'FORGET_VOICE':
      wakeLearner?.reset();
      if (detector) detector.useHead(detector.baseHead);
      return 'Ho dimenticato quello che avevo imparato della tua voce';
  }
}

/**
 * @param lenient the wake word was accepted below the normal threshold (loud music): if no command
 * follows, it was most likely a false trigger, so Meld stays silent and learns from it.
 */
async function onWake(snapshot: Snapshot, lenient: boolean) {
  busy = true;
  setStatus('command');
  player.setDuck(0.15);
  closeStream();
  try {
    const heard = await listenOnce();
    if (!heard?.length) {
      if (!lenient) await say('Non ho sentito il comando, riprova');
      return;
    }
    lastHeard = heard[0];
    const m = meta(heard);
    if (m) {
      wakeLearner?.confirmed(snapshot);
      await say(forget(m));
      return;
    }
    // what the user taught comes first: it is how they actually talk
    const command = commands.match(heard) ?? parseBest(heard);
    if (command.type === 'Unknown' && lenient) {
      wakeLearner?.falseTrigger(snapshot);
      return;
    }
    wakeLearner?.confirmed(snapshot);
    if (command.type === 'Unknown') {
      await teach(heard[0]);
      return;
    }
    const reply = await execute(command);
    await say(reply);
  } catch (e) {
    console.warn('[heyMeld]', e);
    await say('Qualcosa è andato storto');
  } finally {
    player.setDuck(1);
    cooldownUntil = Date.now() + 1000;
    busy = false;
    if (store.get().settings.heyMeldMuted) setStatus('muted');
    else {
      try {
        await openStream();
        setStatus('listening');
      } catch {
        setStatus('error');
      }
    }
  }
}
