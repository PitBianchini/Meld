import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Dimensions, Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as player from '../player/player';
import { deleteDownload, downloadTrack, isDownloading, localFile, onDownloadsChanged } from '../storage/downloads';
import { store } from '../storage/store';
import { Icon } from './Icon';
import { Artwork, TrackRow } from './TrackRow';
import { C, fmtTime, S } from './theme';

export function MiniPlayer({ onOpen }: { onOpen: () => void }) {
  const p = player.usePlayer();
  const t = p.queue[p.index];
  if (!t) return null;
  return (
    <Pressable onPress={onOpen} style={[S.row, { backgroundColor: C.surface, marginHorizontal: 8, borderRadius: 10, padding: 8, gap: 10 }]}>
      <Artwork uri={t.artwork} size={44} radius={5} />
      <View style={{ flex: 1 }}>
        <Text numberOfLines={1} style={[S.body, { fontWeight: '600' }]}>
          {t.title}
        </Text>
        <Text numberOfLines={1} style={S.small}>
          {p.error ?? t.artist}
        </Text>
      </View>
      {p.buffering && !p.playing ? (
        <ActivityIndicator color={C.muted} style={{ width: 40 }} />
      ) : (
        <Pressable onPress={player.toggle} hitSlop={10} style={{ padding: 8 }} accessibilityLabel={p.playing ? 'Pausa' : 'Riproduci'}>
          <Icon name={p.playing ? 'pause.fill' : 'play.fill'} size={24} />
        </Pressable>
      )}
      <Pressable onPress={() => player.next()} hitSlop={10} style={{ padding: 8 }} accessibilityLabel="Canzone successiva">
        <Icon name="forward.fill" size={22} />
      </Pressable>
    </Pressable>
  );
}

function Progress({ position, duration }: { position: number; duration: number }) {
  const [width, setWidth] = useState(1);
  const ratio = duration > 0 ? Math.min(1, position / duration) : 0;
  return (
    <View>
      <Pressable
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        onPress={(e) => duration > 0 && player.seek((e.nativeEvent.locationX / width) * duration)}
        style={{ height: 24, justifyContent: 'center' }}
        accessibilityLabel="Posizione nel brano"
      >
        <View style={{ height: 4, borderRadius: 2, backgroundColor: C.line }}>
          <View style={{ height: 4, borderRadius: 2, width: `${ratio * 100}%`, backgroundColor: C.text }} />
        </View>
      </Pressable>
      <View style={[S.row, { justifyContent: 'space-between' }]}>
        <Text style={[S.small, S.tabular]}>{fmtTime(position)}</Text>
        <Text style={[S.small, S.tabular]}>{fmtTime(duration)}</Text>
      </View>
    </View>
  );
}

export function FullPlayer({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const p = player.usePlayer();
  const [, refresh] = useState(0);
  useEffect(() => onDownloadsChanged(() => refresh((x) => x + 1)), []);
  useEffect(() => store.subscribe(() => refresh((x) => x + 1)), []);
  const t = p.queue[p.index];
  const size = Math.min(Dimensions.get('window').width - 48, 360);
  const liked = t ? store.isLiked(t.id) : false;
  const saved = t ? !!localFile(t.id) : false;
  const saving = t ? isDownloading(t.id) : false;
  const upcoming = p.queue.slice(p.index + 1, p.index + 21);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <ScrollView style={{ backgroundColor: C.bg }} contentContainerStyle={{ padding: 24, paddingBottom: insets.bottom + 24, gap: 18 }}>
        <Pressable onPress={onClose} hitSlop={12} style={{ alignSelf: 'center' }} accessibilityLabel="Chiudi player">
          <Icon name="chevron.down" size={26} color={C.muted} />
        </Pressable>
        {!t ? (
          <Text style={S.small}>Niente in riproduzione.</Text>
        ) : (
          <>
            <View style={{ alignItems: 'center' }}>
              <Artwork uri={t.artwork} size={size} radius={10} />
            </View>
            <View style={[S.row, { gap: 12 }]}>
              <View style={{ flex: 1 }}>
                <Text style={[S.h2, { fontSize: 22 }]} numberOfLines={2}>
                  {t.title}
                </Text>
                <Text style={[S.small, { fontSize: 16, marginTop: 2 }]} numberOfLines={1}>
                  {t.artist}
                </Text>
              </View>
              <Pressable onPress={() => store.toggleLike(t)} hitSlop={10} accessibilityLabel={liked ? 'Togli mi piace' : 'Metti mi piace'}>
                <Icon name={liked ? 'heart.fill' : 'heart'} size={26} color={liked ? C.accent : C.text} />
              </Pressable>
            </View>
            {p.error && <Text style={{ color: C.danger }}>{p.error}</Text>}
            <Progress position={p.position} duration={p.duration} />
            <View style={[S.row, { justifyContent: 'space-between', paddingHorizontal: 4 }]}>
              <Pressable onPress={() => player.setShuffle(!p.shuffle)} hitSlop={10} accessibilityLabel="Casuale">
                <Icon name="shuffle" size={22} color={p.shuffle ? C.accent : C.muted} />
              </Pressable>
              <Pressable onPress={player.previous} hitSlop={10} accessibilityLabel="Canzone precedente">
                <Icon name="backward.fill" size={34} />
              </Pressable>
              <Pressable
                onPress={player.toggle}
                style={{ width: 72, height: 72, borderRadius: 36, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' }}
                accessibilityLabel={p.playing ? 'Pausa' : 'Riproduci'}
              >
                {p.buffering && !p.playing ? <ActivityIndicator color={C.accentText} /> : <Icon name={p.playing ? 'pause.fill' : 'play.fill'} size={32} color={C.accentText} />}
              </Pressable>
              <Pressable onPress={() => player.next()} hitSlop={10} accessibilityLabel="Canzone successiva">
                <Icon name="forward.fill" size={34} />
              </Pressable>
              <Pressable
                onPress={() => (saved ? deleteDownload(t.id) : void downloadTrack(t).catch(() => {}))}
                hitSlop={10}
                accessibilityLabel={saved ? 'Elimina download' : 'Scarica'}
              >
                {saving ? <ActivityIndicator color={C.muted} /> : <Icon name={saved ? 'arrow.down.circle.fill' : 'arrow.down.circle'} size={24} color={saved ? C.accent : C.muted} />}
              </Pressable>
            </View>
            {upcoming.length > 0 && (
              <View style={{ marginHorizontal: -24, marginTop: 8 }}>
                <Text style={[S.h2, { paddingHorizontal: 16, marginBottom: 4 }]}>Dopo</Text>
                {upcoming.map((u, i) => (
                  <TrackRow key={`${u.id || u.spotifyId}-${i}`} track={u} onPress={() => player.jumpTo(p.index + 1 + i)} />
                ))}
              </View>
            )}
          </>
        )}
      </ScrollView>
    </Modal>
  );
}
