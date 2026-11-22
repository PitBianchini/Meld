import React, { useState } from 'react';
import { Pressable, ScrollView, Switch, Text, View } from 'react-native';
import { setHeyMeldMuted, startHeyMeld, useHeyMeld } from '../voice/heyMeld';
import { audioStream, search, streamLog } from '../yt/youtube';
import { useSpotifyLoggedIn } from '../spotify/session';
import { store } from '../storage/store';
import { C, S } from './theme';

const STATUS: Record<string, string> = {
  off: 'Spento',
  listening: 'In ascolto: di\' «Hey Meld» e poi il comando',
  command: 'Ti ascolto…',
  muted: 'In pausa',
  error: 'Non riesce a usare il microfono',
};

export function SettingsScreen() {
  const hey = useHeyMeld();
  const spotifyOk = useSpotifyLoggedIn();
  const [muted, setMuted] = useState(store.get().settings.heyMeldMuted);
  const [diag, setDiag] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [heyError, setHeyError] = useState<string | null>(null);

  const runDiagnostics = async () => {
    setRunning(true);
    const out: string[] = [];
    const log = (l: string) => {
      out.push(l);
      setDiag([...out]);
    };
    try {
      const r = await search('bohemian rhapsody queen', 'song');
      log(`Ricerca YouTube Music: ok (${r.length} risultati)`);
      const first = r.find((x) => x.kind === 'song');
      if (first && first.kind === 'song') {
        const s = await audioStream(first.track.id);
        log(`Audio: ok con il client ${s.client}`);
      }
    } catch (e: any) {
      log(`Errore: ${e?.message ?? e}`);
    }
    log(`Spotify: ${spotifyOk ? 'collegato' : 'non collegato'}`);
    out.push('', 'Ultimi tentativi audio:', ...streamLog.slice(0, 15));
    setDiag([...out]);
    setRunning(false);
  };

  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 120, gap: 14 }}>
      <Text style={S.h1}>Impostazioni</Text>

      <View style={{ backgroundColor: C.surface, borderRadius: 10, padding: 14, gap: 8 }}>
        <View style={[S.row, { justifyContent: 'space-between' }]}>
          <Text style={S.h2}>Hey Meld</Text>
          <Switch
            value={!muted}
            onValueChange={(on) => {
              setMuted(!on);
              setHeyMeldMuted(!on);
            }}
            trackColor={{ true: C.accent, false: C.line }}
          />
        </View>
        <Text style={S.small}>{STATUS[hey.status]}</Text>
        {hey.status === 'error' && (
          <Pressable style={[S.ghost, { alignSelf: 'flex-start' }]} onPress={async () => setHeyError(await startHeyMeld())}>
            <Text style={S.ghostText}>Riprova</Text>
          </Pressable>
        )}
        {heyError && <Text style={{ color: C.danger }}>{heyError}</Text>}
        {!!hey.lastHeard && <Text style={S.small}>Ultimo comando sentito: «{hey.lastHeard}»</Text>}
        <Text style={[S.small, { color: C.faint }]}>
          Su iPhone ascolta mentre l'app è aperta o sta suonando. Se la chiudi dal multitasking smette.
        </Text>
      </View>

      <View style={{ backgroundColor: C.surface, borderRadius: 10, padding: 14, gap: 8 }}>
        <Text style={S.h2}>Diagnostica</Text>
        <Text style={S.small}>Se la musica non parte, tocca qui e mandami una foto di quello che compare.</Text>
        <Pressable style={[S.ghost, { alignSelf: 'flex-start' }]} onPress={runDiagnostics} disabled={running}>
          <Text style={S.ghostText}>{running ? 'Controllo…' : 'Controlla YouTube e Spotify'}</Text>
        </Pressable>
        {diag.map((l, i) => (
          <Text key={i} style={[S.small, { fontFamily: 'Menlo', fontSize: 12 }]}>
            {l}
          </Text>
        ))}
      </View>
    </ScrollView>
  );
}
