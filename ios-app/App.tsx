import React, { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebBridgeHost } from './src/web/bridge';
import { SpotifyHost } from './src/spotify/session';
import { setupAudio } from './src/player/player';
import { startHeyMeld } from './src/voice/heyMeld';
import { Collection, type CollectionRef } from './src/ui/Collection';
import { SearchScreen } from './src/ui/SearchScreen';
import { LibraryScreen } from './src/ui/LibraryScreen';
import { SettingsScreen } from './src/ui/SettingsScreen';
import { FullPlayer, MiniPlayer } from './src/ui/Player';
import { Icon } from './src/ui/Icon';
import { C, S } from './src/ui/theme';

type Tab = 'search' | 'library' | 'settings';
const TABS: [Tab, string, any][] = [
  ['search', 'Cerca', 'magnifyingglass'],
  ['library', 'Libreria', 'music.note.list'],
  ['settings', 'Impostazioni', 'gearshape'],
];

function Main() {
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<Tab>('search');
  const [stack, setStack] = useState<CollectionRef[]>([]);
  const [playerOpen, setPlayerOpen] = useState(false);

  useEffect(() => {
    setupAudio(true)
      .then(() => startHeyMeld())
      .catch((e) => console.warn('[app] audio setup', e));
  }, []);

  const open = (c: CollectionRef) => setStack((s) => [...s, c]);
  const top = stack[stack.length - 1];
  return (
    <View style={S.screen}>
      <StatusBar style="light" />
      <WebBridgeHost />
      <SpotifyHost />
      <View style={{ flex: 1, paddingTop: top ? 0 : insets.top + 8 }}>
        {top ? (
          <Collection item={top} onBack={() => setStack((s) => s.slice(0, -1))} />
        ) : tab === 'search' ? (
          <SearchScreen open={open} />
        ) : tab === 'library' ? (
          <LibraryScreen open={open} />
        ) : (
          <SettingsScreen />
        )}
      </View>
      <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, paddingBottom: insets.bottom, backgroundColor: C.bg, borderTopWidth: 1, borderTopColor: C.line }}>
        <View style={{ paddingTop: 8 }}>
          <MiniPlayer onOpen={() => setPlayerOpen(true)} />
        </View>
        <View style={[S.row, { justifyContent: 'space-around', paddingTop: 6 }]}>
          {TABS.map(([key, label, icon]) => {
            const active = tab === key && !top;
            return (
              <Pressable
                key={key}
                onPress={() => {
                  setStack([]);
                  setTab(key);
                }}
                style={{ alignItems: 'center', paddingVertical: 4, minWidth: 80 }}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
              >
                <Icon name={icon} size={22} color={active ? C.accent : C.muted} />
                <Text style={{ color: active ? C.accent : C.muted, fontSize: 11, marginTop: 2 }}>{label}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>
      <FullPlayer visible={playerOpen} onClose={() => setPlayerOpen(false)} />
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <Main />
    </SafeAreaProvider>
  );
}
