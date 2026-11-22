import React, { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as player from '../player/player';
import type { Track } from '../player/types';
import { downloadTrack } from '../storage/downloads';
import { Icon } from './Icon';
import { Artwork, TrackRow } from './TrackRow';
import { C, S } from './theme';

export type CollectionRef = { title: string; subtitle?: string; artwork?: string; load: () => Promise<Track[]>; radioAfter?: boolean };

export function Collection({ item, onBack }: { item: CollectionRef; onBack: () => void }) {
  const insets = useSafeAreaInsets();
  const [tracks, setTracks] = useState<Track[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const p = player.usePlayer();

  useEffect(() => {
    let alive = true;
    item.load().then((t) => alive && setTracks(t), (e) => alive && setError(String(e?.message ?? e)));
    return () => {
      alive = false;
    };
  }, [item]);

  const saveAll = async () => {
    if (!tracks) return;
    for (let i = 0; i < tracks.length; i++) {
      setSaving(`Scarico ${i + 1} di ${tracks.length}…`);
      await downloadTrack(tracks[i]).catch(() => {});
    }
    setSaving('Fatto: i brani sono in Libreria › Scaricati');
  };

  const current = p.queue[p.index];
  return (
    <View style={[S.screen, { paddingTop: insets.top }]}>
      <Pressable onPress={onBack} style={[S.row, { padding: 12, gap: 4 }]} accessibilityLabel="Indietro">
        <Icon name="chevron.left" size={20} color={C.accent} />
        <Text style={{ color: C.accent, fontSize: 17 }}>Indietro</Text>
      </Pressable>
      <FlatList
        data={tracks ?? []}
        keyExtractor={(t, i) => `${t.id || t.spotifyId}-${i}`}
        contentContainerStyle={{ paddingBottom: 120 }}
        ListHeaderComponent={
          <View style={{ padding: 16, gap: 14 }}>
            <View style={[S.row, { gap: 16 }]}>
              <Artwork uri={item.artwork} size={112} radius={8} />
              <View style={{ flex: 1 }}>
                <Text style={S.h2} numberOfLines={3}>
                  {item.title}
                </Text>
                {!!item.subtitle && <Text style={[S.small, { marginTop: 4 }]}>{item.subtitle}</Text>}
                {tracks && <Text style={[S.small, { marginTop: 4 }]}>{tracks.length} brani</Text>}
              </View>
            </View>
            {tracks && tracks.length > 0 && (
              <View style={[S.row, { gap: 10, flexWrap: 'wrap' }]}>
                <Pressable style={S.button} onPress={() => player.playQueue(tracks, 0, { title: item.title, radioAfter: item.radioAfter })}>
                  <Text style={S.buttonText}>Riproduci</Text>
                </Pressable>
                <Pressable style={S.ghost} onPress={() => player.playQueue(tracks, 0, { title: item.title, shuffle: true })}>
                  <Text style={S.ghostText}>Casuale</Text>
                </Pressable>
                <Pressable style={S.ghost} onPress={saveAll}>
                  <Text style={S.ghostText}>Scarica tutti</Text>
                </Pressable>
              </View>
            )}
            {saving && <Text style={S.small}>{saving}</Text>}
            {!tracks && !error && <ActivityIndicator color={C.muted} />}
            {error && <Text style={{ color: C.danger }}>{error}</Text>}
          </View>
        }
        renderItem={({ item: t, index }) => (
          <TrackRow
            track={t}
            active={!!current && ((t.id && t.id === current.id) || (!!t.spotifyId && t.spotifyId === current.spotifyId))}
            onPress={() => player.playQueue(tracks!, index, { title: item.title, radioAfter: item.radioAfter })}
          />
        )}
      />
    </View>
  );
}
