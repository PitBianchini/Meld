import React, { useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, TextInput, View } from 'react-native';
import * as player from '../player/player';
import { albumTracks, artistTopTracks, playlistTracks, search, type Result, type SearchKind } from '../yt/youtube';
import type { CollectionRef } from './Collection';
import { Artwork, TrackRow } from './TrackRow';
import { C, S } from './theme';

const KINDS: [SearchKind, string][] = [
  ['song', 'Brani'],
  ['album', 'Album'],
  ['artist', 'Artisti'],
  ['playlist', 'Playlist'],
];

export function SearchScreen({ open }: { open: (c: CollectionRef) => void }) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<SearchKind>('song');
  const [results, setResults] = useState<Result[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastRun = useRef(0);
  const p = player.usePlayer();

  const run = async (q = query, k = kind) => {
    if (!q.trim()) return;
    const id = ++lastRun.current;
    setBusy(true);
    setError(null);
    try {
      const r = await search(q.trim(), k);
      if (id === lastRun.current) setResults(r);
    } catch (e: any) {
      if (id === lastRun.current) setError(`La ricerca non ha funzionato: ${e?.message ?? e}`);
    } finally {
      if (id === lastRun.current) setBusy(false);
    }
  };

  const openResult = (r: Result) => {
    if (r.kind === 'song') return;
    const load = r.kind === 'album' ? () => albumTracks(r.id) : r.kind === 'artist' ? () => artistTopTracks(r.id) : () => playlistTracks(r.id);
    open({ title: r.title, subtitle: r.subtitle, artwork: r.artwork, load, radioAfter: r.kind === 'artist' });
  };

  const current = p.queue[p.index];
  return (
    <View style={{ flex: 1 }}>
      <View style={{ paddingHorizontal: 16, gap: 12 }}>
        <Text style={S.h1}>Cerca</Text>
        <TextInput
          value={query}
          onChangeText={setQuery}
          onSubmitEditing={() => run()}
          placeholder="Brano, artista, album…"
          placeholderTextColor={C.faint}
          returnKeyType="search"
          autoCorrect={false}
          style={S.input}
        />
        <View style={[S.row, { gap: 8 }]}>
          {KINDS.map(([k, label]) => (
            <Pressable
              key={k}
              onPress={() => {
                setKind(k);
                void run(query, k);
              }}
              style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, backgroundColor: kind === k ? C.text : C.surface }}
            >
              <Text style={{ color: kind === k ? C.bg : C.text, fontWeight: '600' }}>{label}</Text>
            </Pressable>
          ))}
        </View>
      </View>
      {busy && <ActivityIndicator style={{ marginTop: 24 }} color={C.muted} />}
      {error && <Text style={{ color: C.danger, padding: 16 }}>{error}</Text>}
      <FlatList
        data={results}
        keyboardShouldPersistTaps="handled"
        keyExtractor={(r, i) => (r.kind === 'song' ? r.track.id : r.id) + i}
        contentContainerStyle={{ paddingTop: 8, paddingBottom: 120 }}
        ListEmptyComponent={
          !busy && !error && query.trim() === '' ? (
            <Text style={[S.small, { padding: 16 }]}>Scrivi cosa vuoi ascoltare. I brani partono subito e dopo continua con canzoni simili.</Text>
          ) : undefined
        }
        renderItem={({ item: r }) =>
          r.kind === 'song' ? (
            <TrackRow track={r.track} active={current?.id === r.track.id} onPress={() => player.playQueue([r.track], 0, { radioAfter: true })} />
          ) : (
            <Pressable onPress={() => openResult(r)} style={({ pressed }) => [S.row, { paddingHorizontal: 16, paddingVertical: 8, gap: 12, opacity: pressed ? 0.6 : 1 }]}>
              <Artwork uri={r.artwork} size={56} radius={r.kind === 'artist' ? 28 : 6} />
              <View style={{ flex: 1 }}>
                <Text numberOfLines={1} style={S.body}>
                  {r.title}
                </Text>
                {!!r.subtitle && (
                  <Text numberOfLines={1} style={S.small}>
                    {r.subtitle}
                  </Text>
                )}
              </View>
            </Pressable>
          )
        }
      />
    </View>
  );
}
