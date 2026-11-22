import { Innertube, Platform } from 'youtubei.js/react-native';
import { bridge } from '../web/bridge';
import { playerPoToken, streamingPoToken } from './poToken';
import type { Track } from '../player/types';

// youtubei.js needs a JavaScript evaluator to decipher stream URLs.
let hermesEvalWorks: boolean | null = null;
Platform.shim.eval = async (data: { output: string }, env: Record<string, unknown>) => {
  const props: string[] = [];
  if (env.n) props.push(`n: exportedVars.nFunction(${JSON.stringify(env.n)})`);
  if (env.sig) props.push(`sig: exportedVars.sigFunction(${JSON.stringify(env.sig)})`);
  const code = `${data.output}\nreturn { ${props.join(', ')} }`;
  if (hermesEvalWorks !== false) {
    try {
      const out = new Function(code)();
      hermesEvalWorks = true;
      return out;
    } catch (e) {
      hermesEvalWorks = false;
      console.warn('[yt] Function() unavailable, deciphering in WebView', e);
    }
  }
  return bridge.run(code, 15000);
};

let ytPromise: Promise<Innertube> | null = null;

export function yt(): Promise<Innertube> {
  if (!ytPromise) {
    ytPromise = (async () => {
      const base = await Innertube.create({ lang: 'it', location: 'IT', retrieve_player: true });
      const visitorData = base.session.context.client.visitorData;
      const pot = visitorData ? await streamingPoToken(visitorData) : undefined;
      if (!pot) return base;
      return Innertube.create({ lang: 'it', location: 'IT', retrieve_player: true, visitor_data: visitorData, po_token: pot });
    })().catch((e) => {
      ytPromise = null;
      throw e;
    });
  }
  return ytPromise;
}

export function resetYouTube() {
  ytPromise = null;
}

// --------------------------------------------------------------------------- browsing

const text = (v: any): string => (v == null ? '' : typeof v === 'string' ? v : v.toString?.() ?? String(v));
const bestThumb = (thumbs: any): string | undefined => {
  const list: any[] = Array.isArray(thumbs) ? thumbs : thumbs?.contents ?? [];
  const sorted = [...list].sort((a, b) => (b?.width ?? 0) - (a?.width ?? 0));
  return sorted[0]?.url;
};
const artistsOf = (item: any): string =>
  (item?.artists ?? item?.authors ?? []).map((a: any) => text(a.name)).filter(Boolean).join(', ') || text(item?.author?.name ?? item?.subtitle);

export function toTrack(item: any): Track | null {
  const id = item?.id ?? item?.video_id ?? item?.endpoint?.payload?.videoId;
  if (!id) return null;
  return {
    id,
    title: text(item.title ?? item.name),
    artist: artistsOf(item),
    album: text(item.album?.name),
    artwork: bestThumb(item.thumbnail ?? item.thumbnails),
    durationSec: item.duration?.seconds ?? item.duration_seconds ?? undefined,
  };
}

export type SearchKind = 'song' | 'album' | 'artist' | 'playlist';
export type Result =
  | { kind: 'song'; track: Track }
  | { kind: 'album' | 'artist' | 'playlist'; id: string; title: string; subtitle: string; artwork?: string };

export async function search(query: string, kind: SearchKind): Promise<Result[]> {
  const client = await yt();
  const res: any = await client.music.search(query, { type: kind });
  const items: any[] = res.contents?.flatMap((s: any) => s.contents ?? []) ?? [];
  return items
    .map((it): Result | null => {
      if (kind === 'song') {
        const t = toTrack(it);
        return t ? { kind: 'song', track: t } : null;
      }
      const id = it.id ?? it.endpoint?.payload?.browseId;
      if (!id) return null;
      return { kind, id, title: text(it.name ?? it.title), subtitle: artistsOf(it) || text(it.subtitle), artwork: bestThumb(it.thumbnail ?? it.thumbnails) };
    })
    .filter((x): x is Result => x !== null);
}

/** "Top result" of a plain search, used by voice commands to guess song vs artist vs album. */
export async function topResult(query: string): Promise<Result | null> {
  const client = await yt();
  const res: any = await client.music.search(query);
  const top = res.contents?.find((s: any) => s.type === 'MusicCardShelf')?.title
    ? res.contents.find((s: any) => s.type === 'MusicCardShelf')
    : null;
  const endpoint = top?.on_tap?.payload ?? top?.title?.endpoint?.payload;
  if (endpoint?.videoId) {
    return { kind: 'song', track: { id: endpoint.videoId, title: text(top.title), artist: text(top.subtitle), artwork: bestThumb(top.thumbnail) } };
  }
  if (endpoint?.browseId) {
    const b: string = endpoint.browseId;
    const kind = b.startsWith('MPRE') ? 'album' : b.startsWith('VL') ? 'playlist' : 'artist';
    return { kind, id: b, title: text(top.title), subtitle: text(top.subtitle), artwork: bestThumb(top.thumbnail) };
  }
  const songs = await search(query, 'song');
  return songs[0] ?? null;
}

export async function albumTracks(browseId: string): Promise<Track[]> {
  const client = await yt();
  const album: any = await client.music.getAlbum(browseId);
  const art = bestThumb(album.header?.thumbnail);
  return (album.contents ?? []).map(toTrack).filter(Boolean).map((t: Track) => ({ ...t, artwork: t.artwork ?? art, album: text(album.header?.title) }));
}

export async function playlistTracks(id: string): Promise<Track[]> {
  const client = await yt();
  let pl: any = await client.music.getPlaylist(id.replace(/^VL/, ''));
  const out: Track[] = (pl.items ?? pl.contents ?? []).map(toTrack).filter(Boolean);
  for (let i = 0; i < 5 && pl.has_continuation; i++) {
    pl = await pl.getContinuation();
    out.push(...(pl.items ?? pl.contents ?? []).map(toTrack).filter(Boolean));
  }
  return out;
}

export async function artistTopTracks(browseId: string): Promise<Track[]> {
  const client = await yt();
  const artist: any = await client.music.getArtist(browseId);
  const shelf = artist.sections?.find((s: any) => s.type === 'MusicShelf') ?? artist.sections?.[0];
  return (shelf?.contents ?? []).map(toTrack).filter(Boolean);
}

/** Songs that follow `videoId` in YouTube Music's radio, used to keep playing after a single song. */
export async function radio(videoId: string): Promise<Track[]> {
  const client = await yt();
  const next: any = await client.music.getUpNext(videoId, true);
  return (next.contents ?? []).map(toTrack).filter(Boolean).filter((t: Track) => t.id !== videoId);
}

// --------------------------------------------------------------------------- streams

export type Stream = { url: string; client: string; expiresAt: number; mime: string };

const CLIENTS = ['IOS', 'WEB', 'MWEB', 'TV', 'ANDROID_VR', 'WEB_EMBEDDED'] as const;
const streamCache = new Map<string, Stream>();
export const streamLog: string[] = [];

function note(line: string) {
  streamLog.unshift(`${new Date().toLocaleTimeString()} ${line}`);
  streamLog.length = Math.min(streamLog.length, 60);
}

/** Finds a playable AAC (m4a) audio URL: AVPlayer on iPhone can't play YouTube's Opus/WebM. */
export async function audioStream(videoId: string, preferred?: string): Promise<Stream> {
  const cached = streamCache.get(videoId);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached;
  const client = await yt();
  const order = preferred ? [preferred, ...CLIENTS.filter((c) => c !== preferred)] : [...CLIENTS];
  let lastError = '';
  for (const name of order) {
    try {
      const pot = name.startsWith('WEB') || name === 'MWEB' ? await playerPoToken(videoId) : undefined;
      const info: any = await client.getBasicInfo(videoId, { client: name as any, po_token: pot });
      if (!info.streaming_data) {
        lastError = `${name}: ${info.playability_status?.status} ${info.playability_status?.reason ?? ''}`;
        note(lastError);
        continue;
      }
      const format = info.chooseFormat({ type: 'audio', quality: 'best', format: 'mp4' });
      const url: string = await format.decipher(client.session.player);
      const probe = await fetch(url, { headers: { Range: 'bytes=0-1023' } });
      if (probe.status !== 200 && probe.status !== 206) {
        lastError = `${name}: HTTP ${probe.status}`;
        note(lastError);
        continue;
      }
      const expire = Number(new URL(url).searchParams.get('expire')) * 1000 || Date.now() + 5 * 3600_000;
      const stream = { url, client: name, expiresAt: expire, mime: format.mime_type };
      streamCache.set(videoId, stream);
      note(`${name}: ok (${format.mime_type?.split(';')[0]})`);
      return stream;
    } catch (e: any) {
      lastError = `${name}: ${String(e?.message ?? e).slice(0, 120)}`;
      note(lastError);
    }
  }
  throw new Error(`Nessun flusso audio disponibile (${lastError})`);
}
