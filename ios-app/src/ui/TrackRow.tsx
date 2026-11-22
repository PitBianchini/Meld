import React from 'react';
import { Image, Pressable, Text, View } from 'react-native';
import type { Track } from '../player/types';
import { C, fmtTime, S } from './theme';
import { Icon } from './Icon';

export function Artwork({ uri, size, radius = 6 }: { uri?: string; size: number; radius?: number }) {
  return uri ? (
    <Image source={{ uri }} style={{ width: size, height: size, borderRadius: radius, backgroundColor: C.surface }} />
  ) : (
    <View style={{ width: size, height: size, borderRadius: radius, backgroundColor: C.surface, alignItems: 'center', justifyContent: 'center' }}>
      <Icon name="music.note" size={size * 0.4} color={C.faint} />
    </View>
  );
}

export function TrackRow({ track, onPress, active, right }: { track: Track; onPress: () => void; active?: boolean; right?: React.ReactNode }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [S.row, { paddingHorizontal: 16, paddingVertical: 8, gap: 12, opacity: pressed ? 0.6 : 1 }]}>
      <Artwork uri={track.artwork} size={48} />
      <View style={{ flex: 1 }}>
        <Text numberOfLines={1} style={[S.body, active && { color: C.accent, fontWeight: '700' }]}>
          {track.title}
        </Text>
        <Text numberOfLines={1} style={S.small}>
          {[track.artist, track.durationSec ? fmtTime(track.durationSec) : ''].filter(Boolean).join(' · ')}
        </Text>
      </View>
      {right}
    </Pressable>
  );
}
