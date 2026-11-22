import * as player from '../player/player';
import { albumTracks, artistTopTracks, playlistTracks as ytPlaylistTracks, search, topResult, type Result } from '../yt/youtube';
import { likedTracks, myPlaylists, playlistTracks, topTracks } from '../spotify/api';
import { spotify } from '../spotify/session';
import { downloadedTracks } from '../storage/downloads';
import { store } from '../storage/store';
import type { Track } from '../player/types';
import type { VoiceCommand } from './parser';
import { score } from './playlistMatch';

/** Runs a voice command and returns the Italian sentence to say back (same replies as Android). */
export async function execute(c: VoiceCommand): Promise<string> {
  const s = player.getPlayer();
  switch (c.type) {
    case 'Next':
      return player.next() ? 'Canzone successiva' : 'Non ci sono altre canzoni in coda';
    case 'Previous':
      player.previous();
      return 'Canzone precedente';
    case 'Restart':
      player.restart();
      return 'Ricomincio da capo';
    case 'Pause':
      player.pause();
      return 'Musica in pausa';
    case 'Resume':
      if (s.index < 0) return "Non c'è niente da riprendere. Dimmi cosa vuoi ascoltare";
      player.play();
      return 'Riprendo';
    case 'VolumeUp':
      return `Volume al ${player.setVolume(player.getVolume() + 15)} per cento`;
    case 'VolumeDown':
      return `Volume al ${player.setVolume(player.getVolume() - 15)} per cento`;
    case 'VolumeSet':
      return `Volume al ${player.setVolume(c.percent)} per cento`;
    case 'Shuffle': {
      const on = c.enabled ?? !s.shuffle;
      player.setShuffle(on);
      return on ? 'Riproduzione casuale attivata' : 'Riproduzione casuale disattivata';
    }
    case 'WhatIsPlaying': {
      const t = player.current();
      if (!t) return 'Non sta suonando niente';
      return t.artist ? `Questa è ${t.title}, di ${t.artist}` : `Questa è ${t.title}`;
    }
    case 'Like': {
      const t = player.current();
      if (!t) return 'Non sta suonando niente';
      if (store.isLiked(t.id) === c.liked) return c.liked ? 'Ti piace già' : 'Non era tra i mi piace';
      store.toggleLike(t);
      return c.liked ? 'Aggiunta ai mi piace' : 'Tolta dai mi piace';
    }
    case 'Enqueue': {
      const song = (await search(c.query, 'song')).find((r) => r.kind === 'song');
      if (!song || song.kind !== 'song') return `Non ho trovato ${c.query}`;
      player.enqueue(song.track, c.next);
      return `${c.next ? 'Dopo questa metto' : 'Ho messo in coda'} ${describe(song.track)}`;
    }
    case 'Play':
      return play(c);
    case 'Unknown':
      return 'Non ho capito';
  }
}

const describe = (t: Track) => (t.artist ? `${t.title} di ${t.artist}` : t.title);
const TOP_WORDS = /migliori|top|più ascoltat|piu ascoltat|ascolto di più|ascolto di piu/;

async function play(c: Extract<VoiceCommand, { type: 'Play' }>): Promise<string> {
  const start = async (tracks: Track[], speech: string, radioAfter = false) => {
    if (!tracks.length) return null;
    await player.playQueue(tracks, 0, { shuffle: c.shuffle, radioAfter });
    return speech;
  };
  const q = c.query;
  switch (c.kind) {
    case 'LIKED': {
      const local = store.get().likes;
      if (local.length) return (await start(local, 'Metto i tuoi mi piace'))!;
      if (spotify.loggedIn) return (await start(await likedTracks(), 'Metto i brani che ti piacciono su Spotify')) ?? 'Non hai ancora brani tra i mi piace';
      return 'Non hai ancora brani tra i mi piace';
    }
    case 'DOWNLOADED':
      return (await start(downloadedTracks(), 'Metto i brani scaricati')) ?? 'Non hai brani scaricati';
    case 'PLAYLIST':
      return (await myPlaylist(q, 0.6, start)) ?? (await topIfAsked(q, start)) ?? (await fromResult(await firstOf(q, 'playlist'), start)) ?? `Non ho trovato ${q}`;
    case 'ALBUM':
      return (await fromResult(await firstOf(q, 'album'), start)) ?? `Non ho trovato ${q}`;
    case 'ARTIST':
      return (await fromResult(await firstOf(q, 'artist'), start)) ?? `Non ho trovato ${q}`;
    case 'SONG':
      return (await fromResult(await firstOf(q, 'song'), start)) ?? `Non ho trovato ${q}`;
    case 'AUTO':
      return (await myPlaylist(q, 0.85, start)) ?? (await topIfAsked(q, start)) ?? (await fromResult(await topResult(q), start)) ?? `Non ho trovato ${q}`;
  }
}

type Start = (tracks: Track[], speech: string, radioAfter?: boolean) => Promise<string | null>;

async function firstOf(q: string, kind: 'song' | 'album' | 'artist' | 'playlist') {
  return (await search(q, kind))[0] ?? null;
}

async function fromResult(r: Result | null, start: Start): Promise<string | null> {
  if (!r) return null;
  switch (r.kind) {
    case 'song':
      return start([r.track], `Riproduco ${describe(r.track)}`, true);
    case 'album':
      return start(await albumTracks(r.id), `Metto l'album ${r.title}${r.subtitle ? ` di ${r.subtitle}` : ''}`);
    case 'artist':
      return start(await artistTopTracks(r.id), `Metto i brani di ${r.title}`, true);
    case 'playlist':
      return start(await ytPlaylistTracks(r.id), `Metto la playlist ${r.title}`);
  }
}

async function myPlaylist(q: string, minScore: number, start: Start): Promise<string | null> {
  if (!spotify.loggedIn) return null;
  const lists = await myPlaylists().catch(() => []);
  const best = lists.map((p) => ({ p, s: score(q, p.name) })).sort((a, b) => b.s - a.s)[0];
  if (!best || best.s < minScore) return null;
  return start(await playlistTracks(best.p.id), `Metto la playlist ${best.p.name}`);
}

async function topIfAsked(q: string, start: Start): Promise<string | null> {
  if (!TOP_WORDS.test(q.toLowerCase()) || !spotify.loggedIn) return null;
  return start(await topTracks().catch(() => []), 'Metto i tuoi brani più ascoltati');
}
