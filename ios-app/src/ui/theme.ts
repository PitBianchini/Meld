import { StyleSheet } from 'react-native';

/**
 * Palette: a record shelf. Vinyl black for surfaces, the ivory of old sleeve paper for text,
 * and the orange of a cassette label for the one thing you can press to play.
 */
export const C = {
  bg: '#121110',
  surface: '#1C1A18',
  line: '#2C2925',
  text: '#F2EADB',
  muted: '#A39A8B',
  faint: '#6E675D',
  accent: '#E8833A',
  accentText: '#1B1208',
  danger: '#E5675A',
};

export const S = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  h1: { color: C.text, fontSize: 32, fontWeight: '800', letterSpacing: -0.5 },
  h2: { color: C.text, fontSize: 19, fontWeight: '700' },
  body: { color: C.text, fontSize: 16 },
  small: { color: C.muted, fontSize: 13 },
  row: { flexDirection: 'row', alignItems: 'center' },
  input: {
    backgroundColor: C.surface,
    color: C.text,
    fontSize: 17,
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderRadius: 10,
  },
  button: { backgroundColor: C.accent, paddingHorizontal: 18, paddingVertical: 11, borderRadius: 22, alignItems: 'center' },
  buttonText: { color: C.accentText, fontSize: 16, fontWeight: '700' },
  ghost: { borderWidth: 1, borderColor: C.line, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 22, alignItems: 'center' },
  ghostText: { color: C.text, fontSize: 15, fontWeight: '600' },
  tabular: { fontVariant: ['tabular-nums'] },
});

export const fmtTime = (sec: number) => {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};
