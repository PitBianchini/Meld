/** Matching a spoken playlist name to the user's playlists (port of PlaylistResolver + VoiceSearchMatcher). */
const STOP_WORDS = new Set([
  'il', 'lo', 'la', 'i', 'gli', 'le', 'l', 'un', 'una', 'uno', 'mia', 'mio', 'mie', 'miei', 'tua', 'tuo',
  'di', 'del', 'della', 'dei', 'degli', 'delle', 'e', 'ed', 'the', 'my', 'a', 'of', 'playlist',
]);

export function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(' ').filter(Boolean));
}

export function jaroWinkler(s1: string, s2: string): number {
  if (s1 === s2) return 1;
  if (!s1 || !s2) return 0;
  const maxDist = Math.floor(Math.max(s1.length, s2.length) / 2) - 1;
  if (maxDist < 0) return 0;
  const m1 = new Array(s1.length).fill(false);
  const m2 = new Array(s2.length).fill(false);
  let matches = 0;
  for (let i = 0; i < s1.length; i++) {
    for (let j = Math.max(0, i - maxDist); j <= Math.min(s2.length - 1, i + maxDist); j++) {
      if (!m2[j] && s1[i] === s2[j]) {
        m1[i] = m2[j] = true;
        matches++;
        break;
      }
    }
  }
  if (!matches) return 0;
  let t = 0;
  let k = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!m1[i]) continue;
    while (!m2[k]) k++;
    if (s1[i] !== s2[k]) t++;
    k++;
  }
  const jaro = (matches / s1.length + matches / s2.length + (matches - t / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < Math.min(4, s1.length, s2.length) && s1[prefix] === s2[prefix]) prefix++;
  return jaro > 0.7 ? jaro + prefix * 0.1 * (1 - jaro) : jaro;
}

export function significantTokens(text: string): Set<string> {
  const all = tokenize(text.replace(/'/g, ' '));
  const kept = new Set([...all].filter((t) => !STOP_WORDS.has(t)));
  return kept.size ? kept : tokenize(text);
}

export function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  const close = (x: string, y: string) => x === y || (x.length > 3 && y.length > 3 && jaroWinkler(x, y) >= 0.88);
  const hits = [...a].filter((x) => [...b].some((y) => close(x, y))).length;
  const back = [...b].filter((y) => [...a].some((x) => close(x, y))).length;
  if (hits === a.size) return 0.7 + (0.3 * back) / b.size;
  return Math.min(hits / a.size, back / b.size);
}

export function score(spoken: string, name: string) {
  return similarity(significantTokens(spoken), significantTokens(name));
}
