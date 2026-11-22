// Port of CommandLearner.kt: phrases the user taught Meld ("when I say X I mean <a known command>").
// A phrase containing the song/artist/playlist of the explanation becomes a template with a slot.
import { clean, type PlayKind, type VoiceCommand } from './parser.ts';
import { significantTokens, similarity } from './playlistMatch.ts';

export type Learned = { phrase: string; template: string | null; command: string };
export type Meta = 'FORGET_LAST' | 'FORGET_ALL' | 'FORGET_VOICE';

const QUERY = '{q}';
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function encode(c: VoiceCommand): string | null {
  switch (c.type) {
    case 'VolumeSet':
      return `VolumeSet|${c.percent}`;
    case 'Shuffle':
      return `Shuffle|${c.enabled}`;
    case 'Like':
      return `Like|${c.liked}`;
    case 'Play':
      return `Play|${c.kind}|${c.shuffle}|${c.query}`;
    case 'Enqueue':
      return `Enqueue|${c.next}|${c.query}`;
    case 'Unknown':
      return null;
    default:
      return c.type;
  }
}

const KINDS = new Set(['AUTO', 'SONG', 'ARTIST', 'ALBUM', 'PLAYLIST', 'LIKED', 'DOWNLOADED']);
const SIMPLE = new Set(['Next', 'Previous', 'Restart', 'Pause', 'Resume', 'VolumeUp', 'VolumeDown', 'WhatIsPlaying']);

/** Splits at the first `limit - 1` separators, like Kotlin's split(limit). */
const splitN = (s: string, limit: number) => {
  const parts = s.split('|');
  return parts.length <= limit ? parts : [...parts.slice(0, limit - 1), parts.slice(limit - 1).join('|')];
};

export function decode(s: string, query: string | null): VoiceCommand | null {
  const t = s.split(QUERY).join(query ?? '');
  const p = splitN(t, 4);
  if (SIMPLE.has(p[0])) return { type: p[0] } as VoiceCommand;
  switch (p[0]) {
    case 'VolumeSet': {
      const n = Number(p[1]);
      return Number.isInteger(n) ? { type: 'VolumeSet', percent: n } : null;
    }
    case 'Shuffle':
      return { type: 'Shuffle', enabled: p[1] === 'true' ? true : p[1] === 'false' ? false : null };
    case 'Like':
      return { type: 'Like', liked: p[1] === 'true' };
    case 'Play':
      return p.length === 4 && KINDS.has(p[1]) ? { type: 'Play', query: p[3], kind: p[1] as PlayKind, shuffle: p[2] === 'true' } : null;
    case 'Enqueue': {
      const e = splitN(t, 3);
      return e.length === 3 ? { type: 'Enqueue', query: e[2], next: e[1] === 'true' } : null;
    }
    default:
      return null;
  }
}

const FORGET_LAST = /^(?:dimentica|cancella|scordati) (?:l'|l |la |il )?(?:ultim[ao] (?:cosa|comando|frase)|quello che ti ho (?:appena )?insegnato)(?: che ti ho insegnato)?$/;
const FORGET_ALL = /^(?:dimentica|cancella|scordati) tutt[oi] (?:quello che ti ho insegnato|i comandi(?: che ti ho insegnato)?|le frasi(?: che ti ho insegnato)?)$/;
const FORGET_VOICE = /^(?:dimentica|cancella|scordati|resetta) (?:la mia voce|quello che hai imparato della mia voce)$/;

export function meta(alternatives: string[]): Meta | null {
  for (const a of alternatives) {
    const t = clean(a);
    if (FORGET_VOICE.test(t)) return 'FORGET_VOICE';
    if (FORGET_ALL.test(t)) return 'FORGET_ALL';
    if (FORGET_LAST.test(t)) return 'FORGET_LAST';
  }
  return null;
}

function same(a: string, b: string): boolean {
  if (a === b) return true;
  const x = significantTokens(a);
  const y = significantTokens(b);
  if (!x.size || !y.size || Math.abs(x.size - y.size) > 1) return false;
  return similarity(x, y) >= 0.9 && similarity(y, x) >= 0.9;
}

export class CommandLearner {
  private items: Learned[];
  private readonly persist: (items: Learned[]) => void;

  constructor(saved: Learned[] | undefined, persist: (items: Learned[]) => void) {
    this.persist = persist;
    this.items = (saved ?? []).filter((l) => l && typeof l.phrase === 'string' && l.phrase && typeof l.command === 'string');
  }

  get size() {
    return this.items.length;
  }

  match(alternatives: string[]): VoiceCommand | null {
    for (const alt of alternatives) {
      const t = clean(alt);
      if (!t) continue;
      for (let i = this.items.length - 1; i >= 0; i--) {
        const l = this.items[i];
        if (l.template) {
          const m = t.match(new RegExp(`^${l.template}$`));
          if (m) return decode(l.command, m[1].trim());
        } else if (same(t, l.phrase)) {
          return decode(l.command, null);
        }
      }
    }
    return null;
  }

  /** Remembers that [spoken] means [command]. Returns false for commands that can't be stored. */
  learn(spoken: string, command: VoiceCommand): boolean {
    const phrase = clean(spoken);
    const encoded = encode(command);
    if (!phrase || !encoded) return false;
    const query = command.type === 'Play' || command.type === 'Enqueue' ? command.query : '';
    let template: string | null = null;
    if (query) {
      const at = phrase.indexOf(query.toLowerCase());
      if (at > 0) template = `${escape(phrase.slice(0, at))}(.+?)${escape(phrase.slice(at + query.length))}`;
    }
    this.items = this.items.filter((l) => l.phrase !== phrase && !(template && l.template === template));
    this.items.push({ phrase, template, command: template ? encoded.split(query).join(QUERY) : encoded });
    this.persist(this.items.slice());
    return true;
  }

  forgetLast(): Learned | null {
    const l = this.items.pop() ?? null;
    if (l) this.persist(this.items.slice());
    return l;
  }

  forgetAll() {
    this.items = [];
    this.persist([]);
  }
}
