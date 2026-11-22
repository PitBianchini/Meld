import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { likedTracks, myPlaylists, playlistTracks, topTracks, type SpotifyPlaylist } from '../spotify/api';
import { SpotifyLogin, useSpotifyLoggedIn } from '../spotify/session';
import { downloadedTracks, onDownloadsChanged } from '../storage/downloads';
import { store } from '../storage/store';
import type { CollectionRef } from './Collection';
import { Icon } from './Icon';
import { Artwork } from './TrackRow';
import { C, S } from './theme';

function Entry({ title, subtitle, artwork, icon, onPress }: { title: string; subtitle?: string; artwork?: string; icon?: any; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [S.row, { paddingHorizontal: 16, paddingVertical: 8, gap: 12, opacity: pressed ? 0.6 : 1 }]}>
      {icon ? (
        <View style={{ width: 52, height: 52, borderRadius: 6, backgroundColor: C.surface, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name={icon} size={22} color={C.accent} />
        </View>
      ) : (
        <Artwork uri={artwork} size={52} />
      )}
      <View style={{ flex: 1 }}>
        <Text style={S.body} numberOfLines={1}>
          {title}
        </Text>
        {!!subtitle && (
          <Text style={S.small} numberOfLines={1}>
            {subtitle}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

export function LibraryScreen({ open }: { open: (c: CollectionRef) => void }) {
  const loggedIn = useSpotifyLoggedIn();
  const [login, setLogin] = useState(false);
  const [lists, setLists] = useState<SpotifyPlaylist[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, refresh] = useState(0);

  useEffect(() => onDownloadsChanged(() => refresh((x) => x + 1)), []);
  useEffect(() => store.subscribe(() => refresh((x) => x + 1)), []);
  useEffect(() => {
    if (!loggedIn) return;
    myPlaylists().then(setLists, (e) => setError(String(e?.message ?? e)));
  }, [loggedIn]);

  const likes = store.get().likes;
  const downloads = downloadedTracks();
  return (
    <ScrollView contentContainerStyle={{ paddingBottom: 120 }}>
      <Text style={[S.h1, { paddingHorizontal: 16, marginBottom: 8 }]}>Libreria</Text>
      <Entry
        icon="heart.fill"
        title="Mi piace"
        subtitle={likes.length ? `${likes.length} brani` : 'Tocca il cuore nel player per aggiungerne'}
        onPress={() => open({ title: 'Mi piace', load: async () => store.get().likes })}
      />
      <Entry
        icon="arrow.down.circle.fill"
        title="Scaricati"
        subtitle={downloads.length ? `${downloads.length} brani, si sentono anche senza internet` : 'Ancora nessun brano scaricato'}
        onPress={() => open({ title: 'Scaricati', load: async () => downloadedTracks() })}
      />

      <Text style={[S.h2, { paddingHorizontal: 16, marginTop: 24, marginBottom: 6 }]}>Spotify</Text>
      {!loggedIn ? (
        <View style={{ paddingHorizontal: 16, gap: 10 }}>
          <Text style={S.small}>Accedi con Spotify per vedere qui le tue playlist e i tuoi mi piace. Non serve Premium: l'audio arriva da YouTube Music.</Text>
          <Pressable style={[S.button, { alignSelf: 'flex-start' }]} onPress={() => setLogin(true)}>
            <Text style={S.buttonText}>Accedi a Spotify</Text>
          </Pressable>
        </View>
      ) : (
        <>
          <Entry icon="heart.circle" title="Brani che ti piacciono" subtitle="Da Spotify" onPress={() => open({ title: 'Brani che ti piacciono', subtitle: 'Spotify', load: likedTracks })} />
          <Entry icon="chart.bar.fill" title="I tuoi più ascoltati" subtitle="Ultimi mesi su Spotify" onPress={() => open({ title: 'I tuoi più ascoltati', subtitle: 'Spotify', load: topTracks })} />
          {error && <Text style={{ color: C.danger, paddingHorizontal: 16 }}>{error}</Text>}
          {!lists && !error && <Text style={[S.small, { paddingHorizontal: 16 }]}>Carico le playlist…</Text>}
          {lists?.map((pl) => (
            <Entry
              key={pl.id}
              title={pl.name}
              subtitle={pl.owner}
              artwork={pl.artwork}
              onPress={() => open({ title: pl.name, subtitle: pl.owner, artwork: pl.artwork, load: () => playlistTracks(pl.id) })}
            />
          ))}
        </>
      )}
      <SpotifyLogin visible={login} onClose={() => setLogin(false)} />
    </ScrollView>
  );
}
