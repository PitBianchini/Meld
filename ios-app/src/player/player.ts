import { createAudioPlaylist, setAudioModeAsync, type AudioPlaylist, type AudioPlaylistStatus } from 'expo-audio';
import { useEffect, useState } from 'react';
import { audioStream, radio } from '../yt/youtube';
import { toYouTube } from '../spotify/match';
import { localFile } from '../storage/downloads';
import { store } from '../storage/store';
import type { Track } from './types';

/**
 * Queue and playback. The native AudioPlaylist plays (and handles the lock screen's next/previous),
 * while this module keeps the full queue and feeds the playlist a few resolved tracks ahead, because
 * YouTube stream URLs have to be fetched one by one and expire after some hours.
 */
export type PlayerState = {
  queue: Track[];
  index: number;
  playing: boolean;
  buffering: boolean;
  position: number;
  duration: number;
  shuffle: boolean;
  title?: string;
  error?: string;
};

const AHEAD = 2;
let state: PlayerState = { queue: [], index: -1, playing: false, buffering: false, position: 0, duration: 0, shuffle: false };
const listeners = new Set<(s: PlayerState) => void>();
let playlist: AudioPlaylist | null = null;
/** queue indexes currently loaded in the native playlist, in order */
let loaded: number[] = [];
let generation = 0;
let radioSeed: string | null = null;
let volume = 1;

function set(patch: Partial<PlayerState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l(state));
}

export function usePlayer(): PlayerState {
  const [s, setS] = useState(state);
  useEffect(() => {
    listeners.add(setS);
    return () => void listeners.delete(setS);
  }, []);
  return s;
}
export const getPlayer = () => state;
export const current = (): Track | undefined => state.queue[state.index];

export async function setupAudio(recording: boolean) {
  await setAudioModeAsync({
    playsInSilentMode: true,
    shouldPlayInBackground: true,
    interruptionMode: 'doNotMix',
    allowsRecording: recording,
    shouldRouteThroughEarpiece: false,
  });
}

function native(): AudioPlaylist {
  if (!playlist) {
    playlist = createAudioPlaylist({ sources: [], loop: 'none', updateInterval: 500 });
    playlist.addListener('trackChanged', ({ currentIndex }) => onNativeTrack(currentIndex));
    playlist.addListener('playlistStatusUpdate', (s: AudioPlaylistStatus) => {
      set({ playing: s.playing, buffering: s.isBuffering, position: s.currentTime, duration: s.duration || current()?.durationSec || 0 });
      if (!s.playing && s.isLoaded && s.duration > 0 && s.currentTime >= s.duration - 0.6 && s.currentIndex === s.trackCount - 1) {
        // reached the end of what is loaded: continue with the next track of the queue
        if (state.index < state.queue.length - 1) void jumpTo(state.index + 1);
      }
    });
  }
  return playlist;
}

async function resolve(i: number): Promise<{ uri: string } | null> {
  let t = state.queue[i];
  if (!t) return null;
  if (!t.id) {
    const yt = await toYouTube(t);
    if (!yt) return null;
    t = yt;
    const q = [...state.queue];
    q[i] = t;
    set({ queue: q });
  }
  const file = localFile(t.id);
  if (file) return { uri: file.uri };
  const s = await audioStream(t.id);
  return { uri: s.url };
}

function lockScreen() {
  const t = current();
  if (!t || !playlist) return;
  playlist.setActiveForLockScreen(
    true,
    { title: t.title, artist: t.artist, albumTitle: t.album, artworkUrl: t.artwork },
    { showNextTrack: true, showPreviousTrack: true },
  );
}

function onNativeTrack(nativeIndex: number) {
  const qi = loaded[nativeIndex];
  if (qi === undefined || qi === state.index) return;
  set({ index: qi, position: 0, error: undefined });
  const t = current();
  if (t) store.addRecent(t);
  lockScreen();
  void fillAhead(generation);
}

async function fillAhead(gen: number) {
  const pl = native();
  while (gen === generation) {
    const last = loaded[loaded.length - 1] ?? state.index;
    const nativeCurrent = loaded.indexOf(state.index);
    if (loaded.length - 1 - nativeCurrent >= AHEAD) break;
    let next = last + 1;
    if (next >= state.queue.length) {
      if (!(await extendWithRadio())) break;
      continue;
    }
    let src: { uri: string } | null = null;
    while (next < state.queue.length && gen === generation) {
      try {
        src = await resolve(next);
      } catch (e) {
        console.warn('[player] skip', state.queue[next]?.title, e);
        src = null;
      }
      if (src) break;
      // drop tracks that can't be found or played
      const q = [...state.queue];
      q.splice(next, 1);
      set({ queue: q });
    }
    if (!src || gen !== generation) break;
    pl.add(src);
    loaded.push(next);
  }
}

async function extendWithRadio(): Promise<boolean> {
  const seed = radioSeed;
  if (!seed) return false;
  radioSeed = null;
  try {
    const more = (await radio(seed)).filter((t) => !state.queue.some((q) => q.id === t.id));
    if (!more.length) return false;
    set({ queue: [...state.queue, ...more] });
    return true;
  } catch {
    return false;
  }
}

/** Starts playing `queue` from `start`. With `radioAfter`, YouTube's radio continues after the queue. */
export async function playQueue(queue: Track[], start = 0, opts: { shuffle?: boolean; title?: string; radioAfter?: boolean } = {}) {
  let q = [...queue];
  if (opts.shuffle) {
    const first = q.splice(start, 1);
    for (let i = q.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [q[i], q[j]] = [q[j], q[i]];
    }
    q = [...first, ...q];
    start = 0;
  }
  radioSeed = opts.radioAfter ? (q[start]?.id || null) : null;
  set({ queue: q, title: opts.title, shuffle: !!opts.shuffle });
  await jumpTo(start);
}

export async function jumpTo(index: number) {
  const gen = ++generation;
  const pl = native();
  pl.pause();
  pl.clear();
  loaded = [];
  set({ index, position: 0, duration: state.queue[index]?.durationSec ?? 0, buffering: true, error: undefined });
  try {
    let src: { uri: string } | null = null;
    while (!src && state.index < state.queue.length) {
      src = await resolve(state.index);
      if (!src) {
        const q = [...state.queue];
        q.splice(state.index, 1);
        set({ queue: q });
      }
    }
    if (gen !== generation || !src) return;
    if (radioSeed === null && state.queue.length === 1) radioSeed = state.queue[state.index]?.id ?? null;
    pl.add(src);
    loaded = [state.index];
    pl.volume = volume * duck;
    pl.play();
    const t = current();
    if (t) store.addRecent(t);
    lockScreen();
    void fillAhead(gen);
  } catch (e: any) {
    if (gen === generation) set({ buffering: false, error: String(e?.message ?? e) });
  }
}

export function play() {
  if (state.index < 0) return;
  if (!loaded.length) void jumpTo(state.index);
  else native().play();
}
export function pause() {
  native().pause();
}
export function toggle() {
  state.playing ? pause() : play();
}

export function next() {
  if (state.index >= state.queue.length - 1 && !radioSeed) return false;
  const ni = loaded.indexOf(state.index);
  if (ni >= 0 && ni < loaded.length - 1) native().next();
  else void jumpTo(state.index + 1);
  return true;
}

export function previous() {
  if (state.position > 4 || state.index === 0) {
    void native().seekTo(0);
    return;
  }
  const ni = loaded.indexOf(state.index);
  if (ni > 0) native().previous();
  else void jumpTo(state.index - 1);
}

export function restart() {
  void native().seekTo(0);
  native().play();
}

export function seek(sec: number) {
  void native().seekTo(sec);
}

export function setShuffle(on: boolean) {
  if (on === state.shuffle || state.index < 0) return set({ shuffle: on });
  const head = state.queue.slice(0, state.index + 1);
  const tail = state.queue.slice(state.index + 1);
  if (on) {
    for (let i = tail.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [tail[i], tail[j]] = [tail[j], tail[i]];
    }
  }
  set({ shuffle: on, queue: [...head, ...tail] });
  void reloadAhead();
}

/** Inserts a track right after the current one, or at the end of the queue. */
export function enqueue(t: Track, nextUp: boolean) {
  if (state.index < 0) return void playQueue([t], 0, { radioAfter: true });
  const q = [...state.queue];
  q.splice(nextUp ? state.index + 1 : q.length, 0, t);
  set({ queue: q });
  if (nextUp) void reloadAhead();
}

/** Drops the preloaded upcoming items so the new queue order is used. */
async function reloadAhead() {
  const pl = native();
  const ni = loaded.indexOf(state.index);
  for (let i = loaded.length - 1; i > ni; i--) pl.remove(i);
  loaded = loaded.slice(0, ni + 1);
  const gen = ++generation;
  void fillAhead(gen);
}

let duck = 1;
/** Temporary volume for Hey Meld (ducking while listening and speaking). */
export function setDuck(factor: number) {
  duck = factor;
  if (playlist) playlist.volume = volume * duck;
}

/** App volume 0..100 (iOS doesn't let apps change the system volume). */
export function getVolume() {
  return Math.round(volume * 100);
}
export function setVolume(percent: number) {
  volume = Math.max(0.05, Math.min(1, percent / 100));
  if (playlist) playlist.volume = volume * duck;
  return getVolume();
}
