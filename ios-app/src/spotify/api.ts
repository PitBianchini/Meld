import { spotify } from './session';
import type { Track } from '../player/types';

/** Spotify's web-player GraphQL API, as used by Meld (persisted-query hashes from Meld's registry). */
const GQL_URL = 'https://api-partner.spotify.com/pathfinder/v2/query';
const HASHES_URL = 'https://francescograzioso.github.io/Meld/spotify-gql-hashes.json';
const FALLBACK: Record<string, string> = {
  libraryV3: '973e511ca44261fda7eebac8b653155e7caee3675abb4fb110cc1b8c78b091c3',
  fetchPlaylist: '346811f856fb0b7e4f6c59f8ebea78dd081c6e2fb01b77c954b26259d5fc6763',
  fetchLibraryTracks: '087278b20b743578a6262c2b0b4bcd20d879c503cc359a2285baf083ef944240',
};

let hashes: Promise<Record<string, string[]>> | null = null;
function loadHashes() {
  if (!hashes) {
    hashes = fetch(HASHES_URL)
      .then((r) => r.json())
      .then((j) => {
        const out: Record<string, string[]> = {};
        for (const [op, v] of Object.entries<any>(j.operations ?? {})) out[op] = [v.hash, v.previous_hash].filter(Boolean);
        return out;
      })
      .catch(() => ({}));
  }
  return hashes;
}

async function gql(operationName: string, variables: object): Promise<any> {
  const known = await loadHashes();
  const candidates = [...(known[operationName] ?? []), FALLBACK[operationName]].filter(Boolean);
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await spotify.accessToken();
    for (const sha256Hash of candidates) {
      const r = await fetch(GQL_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json;charset=UTF-8',
          'app-platform': 'WebPlayer',
          Origin: 'https://open.spotify.com',
          Referer: 'https://open.spotify.com/',
          Accept: 'application/json',
        },
        body: JSON.stringify({ variables, operationName, extensions: { persistedQuery: { version: 1, sha256Hash } } }),
      });
      if (r.status === 401) break;
      if (r.status === 412) continue;
      const j = await r.json();
      if (j.errors?.[0]?.message?.includes('PersistedQueryNotFound')) continue;
      if (j.errors?.length) throw new Error(`Spotify: ${j.errors[0].message}`);
      return j;
    }
    spotify.invalidate();
  }
  throw new Error(`Spotify: ${operationName} non disponibile`);
}

export type SpotifyPlaylist = { id: string; name: string; artwork?: string; owner?: string };

const image = (sources: any[] | undefined) =>
  [...(sources ?? [])].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]?.url as string | undefined;

function parseTrack(data: any, uri?: string): Track {
  const id = (uri ?? data?.uri ?? data?._uri ?? '').split(':').pop();
  return {
    id: '',
    spotifyId: id,
    title: data?.name ?? '',
    artist: (data?.artists?.items ?? []).map((a: any) => a?.profile?.name).filter(Boolean).join(', '),
    album: data?.albumOfTrack?.name,
    artwork: image(data?.albumOfTrack?.coverArt?.sources),
    durationSec: Math.round((data?.duration?.totalMilliseconds ?? data?.trackDuration?.totalMilliseconds ?? 0) / 1000) || undefined,
  };
}

export async function myPlaylists(): Promise<SpotifyPlaylist[]> {
  const out: SpotifyPlaylist[] = [];
  for (let offset = 0; offset < 500; offset += 50) {
    const j = await gql('libraryV3', {
      filters: ['Playlists'], order: null, textFilter: '', features: ['LIKED_SONGS', 'YOUR_EPISODES_V2', 'PRERELEASES', 'EVENTS'],
      limit: 50, offset, flatten: true, expandedFolders: [], folderUri: null, includeFoldersWhenFlattening: false,
    });
    const lib = j?.data?.me?.libraryV3;
    const items: any[] = lib?.items ?? [];
    for (const it of items) {
      const w = it?.item;
      if (!w || !String(w.__typename ?? '').includes('Playlist') || w.data?.__typename !== 'Playlist') continue;
      out.push({
        id: String(w._uri ?? '').split(':').pop()!,
        name: w.data.name ?? '',
        artwork: image(w.data.images?.items?.[0]?.sources),
        owner: w.data.ownerV2?.data?.name,
      });
    }
    if (items.length < 50 || out.length >= (lib?.totalCount ?? 0)) break;
  }
  return out;
}

export async function playlistTracks(playlistId: string): Promise<Track[]> {
  const out: Track[] = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const j = await gql('fetchPlaylist', { uri: `spotify:playlist:${playlistId}`, offset, limit: 100, enableWatchFeedEntrypoint: false });
    const content = j?.data?.playlistV2?.content;
    const items: any[] = content?.items ?? [];
    for (const el of items) {
      const w = el?.itemV2;
      if (w?.data?.__typename && w.data.__typename !== 'Track') continue;
      if (w?.data) out.push(parseTrack(w.data, w._uri ?? w.uri));
    }
    if (items.length < 100 || out.length >= (content?.totalCount ?? 0)) break;
  }
  return out;
}

export async function likedTracks(): Promise<Track[]> {
  const out: Track[] = [];
  for (let offset = 0; offset < 2000; offset += 50) {
    const j = await gql('fetchLibraryTracks', { offset, limit: 50 });
    const tracks = j?.data?.me?.library?.tracks;
    const items: any[] = tracks?.items ?? [];
    for (const el of items) if (el?.track?.data) out.push(parseTrack(el.track.data, el.track._uri ?? el.track.uri));
    if (items.length < 50 || out.length >= (tracks?.totalCount ?? 0)) break;
  }
  return out;
}

/** The user's most played tracks (REST endpoint, as in Meld). */
export async function topTracks(): Promise<Track[]> {
  const token = await spotify.accessToken();
  const r = await fetch('https://api.spotify.com/v1/me/top/tracks?time_range=medium_term&limit=50', {
    headers: { Authorization: `Bearer ${token}`, 'app-platform': 'WebPlayer', Origin: 'https://open.spotify.com', Referer: 'https://open.spotify.com/' },
  });
  if (!r.ok) throw new Error(`Spotify top tracks ${r.status}`);
  const j = await r.json();
  return (j.items ?? []).map((t: any) => ({
    id: '',
    spotifyId: t.id,
    title: t.name,
    artist: (t.artists ?? []).map((a: any) => a.name).join(', '),
    album: t.album?.name,
    artwork: image(t.album?.images),
    durationSec: Math.round((t.duration_ms ?? 0) / 1000) || undefined,
  }));
}
