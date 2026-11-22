import { search } from '../yt/youtube';
import type { Track } from '../player/types';
import { store } from '../storage/store';

/** Finds the YouTube Music version of a Spotify track (simplified port of Meld's SpotifyMapper). */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\((feat|ft)\..*?\)/g, '')
    .replace(/\[.*?]/g, '')
    .replace(/\(.*?remaster.*?\)/g, '')
    .replace(/ - .*remaster.*$/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

export function similarity(a: string, b: string): number {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const A = bigrams(x);
  const B = bigrams(y);
  let hit = 0;
  A.forEach((g) => B.has(g) && hit++);
  return (2 * hit) / (A.size + B.size || 1);
}

export function score(spotify: Track, candidate: Track): number {
  const title = similarity(spotify.title, candidate.title);
  const artist = Math.max(
    similarity(spotify.artist.split(',')[0] ?? '', candidate.artist),
    similarity(spotify.artist, candidate.artist),
  );
  let duration = 0.5;
  if (spotify.durationSec && candidate.durationSec) {
    const d = Math.abs(spotify.durationSec - candidate.durationSec);
    duration = d <= 3 ? 1 : d <= 10 ? 0.7 : d <= 30 ? 0.3 : 0;
  }
  return title * 0.55 + artist * 0.3 + duration * 0.15;
}

const memo = new Map<string, Track>();

export async function toYouTube(track: Track): Promise<Track | null> {
  if (track.id) return track;
  const key = track.spotifyId ?? `${track.artist}|${track.title}`;
  const hit = memo.get(key) ?? (await store.getMatch(key));
  if (hit) {
    memo.set(key, hit);
    return { ...track, id: hit.id, durationSec: track.durationSec ?? hit.durationSec };
  }
  const query = `${track.artist.split(',')[0] ?? ''} ${track.title}`.trim();
  const results = (await search(query, 'song')).flatMap((r) => (r.kind === 'song' ? [r.track] : [])).slice(0, 8);
  let best: Track | null = null;
  let bestScore = 0;
  for (const c of results) {
    const s = score(track, c);
    if (s > bestScore) {
      best = c;
      bestScore = s;
    }
  }
  if (!best || bestScore < 0.45) return null;
  memo.set(key, best);
  store.setMatch(key, best);
  return { ...track, id: best.id };
}
