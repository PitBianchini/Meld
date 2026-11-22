import { File } from 'expo-file-system';
import { audioStream } from '../yt/youtube';
import { toYouTube } from '../spotify/match';
import type { Track } from '../player/types';
import { downloadsDir, store } from './store';

/** Offline copies are the same AAC stream the player uses, saved as .m4a in Documents/downloads. */
const active = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
export const onDownloadsChanged = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export function localFile(id: string): File | null {
  const d = store.download(id);
  if (!d) return null;
  const f = new File(downloadsDir, d.file);
  return f.exists ? f : null;
}

export function isDownloading(id: string) {
  return active.has(id);
}

export function downloadTrack(track: Track): Promise<void> {
  const key = track.id || track.spotifyId || track.title;
  const running = active.get(key);
  if (running) return running;
  const job = (async () => {
    const yt = await toYouTube(track);
    if (!yt) throw new Error(`Non trovo ${track.title} su YouTube`);
    if (localFile(yt.id)) return;
    if (!downloadsDir.exists) downloadsDir.create({ intermediates: true });
    const stream = await audioStream(yt.id);
    const name = `${yt.id}.m4a`;
    const dest = new File(downloadsDir, name);
    if (dest.exists) dest.delete();
    await File.downloadFileAsync(stream.url, dest);
    store.setDownload(yt, name);
  })().finally(() => {
    active.delete(key);
    listeners.forEach((l) => l());
  });
  active.set(key, job);
  listeners.forEach((l) => l());
  return job;
}

export function deleteDownload(id: string) {
  localFile(id)?.delete();
  store.removeDownload(id);
  listeners.forEach((l) => l());
}

export function downloadedTracks(): Track[] {
  return Object.values(store.get().downloads)
    .sort((a, b) => a.at - b.at)
    .map((d) => d.track)
    .filter((t) => localFile(t.id));
}
