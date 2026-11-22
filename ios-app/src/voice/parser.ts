// Same logic as the Android VoiceCommandParser (Kotlin), using the same patterns.
import * as P from './patterns.ts';

export type PlayKind = 'AUTO' | 'SONG' | 'ARTIST' | 'ALBUM' | 'PLAYLIST' | 'LIKED' | 'DOWNLOADED';
export type VoiceCommand =
  | { type: 'Next' } | { type: 'Previous' } | { type: 'Restart' } | { type: 'Pause' } | { type: 'Resume' }
  | { type: 'VolumeUp' } | { type: 'VolumeDown' } | { type: 'VolumeSet'; percent: number }
  | { type: 'Shuffle'; enabled: boolean | null } | { type: 'WhatIsPlaying' } | { type: 'Like'; liked: boolean }
  | { type: 'Play'; query: string; kind: PlayKind; shuffle: boolean }
  | { type: 'Enqueue'; query: string; next: boolean }
  | { type: 'Unknown' };

// Kotlin's Regex.matches(): the whole string must match (with backtracking), unlike String.match().
const anchored = new Map<RegExp, RegExp>();
const fullMatch = (r: RegExp, t: string): RegExpMatchArray | null => {
  let a = anchored.get(r);
  if (!a) anchored.set(r, (a = new RegExp(`^(?:${r.source})$`)));
  return t.match(a);
};
const full = (r: RegExp, t: string) => fullMatch(r, t) !== null;
const stripArticle = (q: string) => q.trim().replace(P.ARTICLE, '').trim();

export function clean(raw: string): string {
  let t = raw.toLowerCase().normalize('NFC').replace(/’/g, "'").replace(/[,.!?;:"«»]/g, ' ').replace(/\s+/g, ' ').trim();
  t = t.replace(P.WAKE, '').trim();
  for (let i = 0; i < 3; i++) t = t.replace(P.POLITE_PREFIX, '').trim();
  const first = t.split(' ')[0];
  if (P.INFINITIVES[first]) t = P.INFINITIVES[first] + t.slice(first.length);
  return t.replace(P.POLITE_SUFFIX, '').trim();
}

export function startsWithWakeWord(raw: string): boolean {
  const t = raw.toLowerCase().replace(/[,.!?;:]/g, ' ').trim();
  const m = t.match(P.WAKE);
  return !!m && m[0].trim().length > 0;
}

function parseVolume(t: string): VoiceCommand | null {
  if (!t.includes('volume') && !t.includes('forte') && !t.includes('piano')) return null;
  if (full(P.VOLUME_MAX, t)) return { type: 'VolumeSet', percent: 100 };
  if (full(P.VOLUME_MIN, t)) return { type: 'VolumeSet', percent: 10 };
  const m = t.match(P.VOLUME_SET);
  if (m) {
    const n = /^\d+$/.test(m[1]) ? Number(m[1]) : P.ITALIAN_NUMBERS[m[1]];
    if (n !== undefined) return { type: 'VolumeSet', percent: Math.max(0, Math.min(100, n)) };
  }
  if (full(P.VOLUME_UP, t)) return { type: 'VolumeUp' };
  if (full(P.VOLUME_DOWN, t)) return { type: 'VolumeDown' };
  return null;
}

function buildPlay(rest: string): VoiceCommand {
  let q = rest.trim();
  let shuffle = false;
  const s = q.match(P.SHUFFLE_SUFFIX);
  if (s && s.index !== undefined) {
    shuffle = true;
    q = (q.slice(0, s.index) + q.slice(s.index + s[0].length)).trim();
  }
  if (!q) return { type: 'Resume' };
  if (full(P.LIKED, q)) return { type: 'Play', query: '', kind: 'LIKED', shuffle };
  if (full(P.DOWNLOADED, q)) return { type: 'Play', query: '', kind: 'DOWNLOADED', shuffle };
  for (const [r, kind] of P.KIND_PREFIXES) {
    const m = fullMatch(r, q);
    if (m && m[1]?.trim()) return { type: 'Play', query: m[1].trim(), kind: kind as PlayKind, shuffle };
  }
  q = stripArticle(q);
  const by = fullMatch(P.SONG_BY, q);
  if (by) return { type: 'Play', query: `${by[1].trim()} ${by[2].trim()}`, kind: 'SONG', shuffle };
  return { type: 'Play', query: q, kind: 'AUTO', shuffle };
}

export function parse(raw: string): VoiceCommand {
  const t = clean(raw);
  if (!t) return { type: 'Unknown' };
  const v = parseVolume(t);
  if (v) return v;
  for (const r of P.ENQUEUE_NEXT) {
    const m = fullMatch(r, t);
    if (m && m[1]?.trim()) return { type: 'Enqueue', query: stripArticle(m[1]), next: true };
  }
  for (const r of P.ENQUEUE) {
    const m = fullMatch(r, t);
    if (m && m[1]?.trim()) return { type: 'Enqueue', query: stripArticle(m[1]), next: false };
  }
  if (full(P.LIKE_OFF, t)) return { type: 'Like', liked: false };
  if (full(P.LIKE_ON, t)) return { type: 'Like', liked: true };
  if (full(P.WHAT, t)) return { type: 'WhatIsPlaying' };
  if (full(P.SHUFFLE_OFF, t)) return { type: 'Shuffle', enabled: false };
  if (full(P.SHUFFLE_ON, t)) return { type: 'Shuffle', enabled: true };
  if (full(P.SHUFFLE_TOGGLE, t)) return { type: 'Shuffle', enabled: null };
  if (full(P.PREVIOUS, t) || full(P.PREVIOUS_EXTRA, t)) return { type: 'Previous' };
  if (full(P.NEXT, t) || full(P.NEXT_EXTRA, t)) return { type: 'Next' };
  if (full(P.RESTART, t)) return { type: 'Restart' };
  if (full(P.PAUSE, t)) return { type: 'Pause' };
  if (full(P.RESUME, t)) return { type: 'Resume' };
  const m = fullMatch(P.PLAY, t);
  if (m) return buildPlay(m[1] ?? '');
  return { type: 'Unknown' };
}

export function parseBest(alternatives: string[]): VoiceCommand {
  for (const a of alternatives) {
    const c = parse(a);
    if (c.type !== 'Unknown') return c;
  }
  for (let drop = 1; drop <= 3; drop++) {
    for (const a of alternatives) {
      const words = a.trim().split(/\s+/);
      if (words.length > drop) {
        const c = parse(words.slice(drop).join(' '));
        if (c.type !== 'Unknown') return c;
      }
    }
  }
  return { type: 'Unknown' };
}
