import { Directory, File, Paths } from 'expo-file-system';
import type { Track } from '../player/types';

/** Small JSON store in the app's Documents folder (no extra native dependency). */
type Data = {
  matches: Record<string, Track>;
  downloads: Record<string, { track: Track; file: string; at: number }>;
  likes: Track[];
  recent: Track[];
  settings: { heyMeld: boolean; heyMeldMuted: boolean };
};

const EMPTY: Data = { matches: {}, downloads: {}, likes: [], recent: [], settings: { heyMeld: true, heyMeldMuted: false } };
const file = new File(Paths.document, 'meld-store.json');
let data: Data | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function load(): Data {
  if (data) return data;
  try {
    data = file.exists ? { ...EMPTY, ...JSON.parse(file.textSync()) } : structuredClone(EMPTY);
  } catch {
    data = structuredClone(EMPTY);
  }
  return data!;
}

function changed() {
  listeners.forEach((l) => l());
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      file.write(JSON.stringify(data));
    } catch (e) {
      console.warn('[store] save failed', e);
    }
  }, 400);
}

export const downloadsDir = new Directory(Paths.document, 'downloads');

export const store = {
  subscribe(l: () => void) {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
  get: load,
  async getMatch(key: string) {
    return load().matches[key];
  },
  setMatch(key: string, t: Track) {
    load().matches[key] = t;
    changed();
  },
  isLiked(id: string) {
    return load().likes.some((t) => t.id === id);
  },
  toggleLike(t: Track): boolean {
    const d = load();
    const i = d.likes.findIndex((x) => x.id === t.id);
    if (i >= 0) d.likes.splice(i, 1);
    else d.likes.unshift(t);
    changed();
    return i < 0;
  },
  addRecent(t: Track) {
    const d = load();
    d.recent = [t, ...d.recent.filter((x) => x.id !== t.id)].slice(0, 50);
    changed();
  },
  download(id: string) {
    return load().downloads[id];
  },
  setDownload(t: Track, fileName: string) {
    load().downloads[t.id] = { track: t, file: fileName, at: Date.now() };
    changed();
  },
  removeDownload(id: string) {
    delete load().downloads[id];
    changed();
  },
  setSetting<K extends keyof Data['settings']>(k: K, v: Data['settings'][K]) {
    load().settings[k] = v;
    changed();
  },
};
