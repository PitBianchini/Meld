import { AudioModule, requestRecordingPermissionsAsync } from 'expo-audio';
import * as Speech from 'expo-speech';
import { ExpoSpeechRecognitionModule } from 'expo-speech-recognition';
import { useEffect, useState } from 'react';
import * as player from '../player/player';
import { store } from '../storage/store';
import { execute } from './executor';
import { parseBest } from './parser';
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
  return { status, lastHeard };
}

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
    detector ??= await WakeWordDetector.load();
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
    const p = detector.process(merged.subarray(offset, offset + CHUNK));
    offset += CHUNK;
    above = p >= detector.head.threshold ? above + 1 : 0;
    if (above >= detector.head.consecutive && Date.now() >= cooldownUntil) {
      above = 0;
      void onWake();
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

async function onWake() {
  busy = true;
  setStatus('command');
  player.setDuck(0.15);
  closeStream();
  try {
    const heard = await listenOnce();
    if (!heard?.length) {
      await say('Non ho sentito il comando, riprova');
      return;
    }
    lastHeard = heard[0];
    const command = parseBest(heard);
    if (command.type === 'Unknown') {
      await say(`Non ho capito. Ho sentito: ${heard[0]}`);
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
