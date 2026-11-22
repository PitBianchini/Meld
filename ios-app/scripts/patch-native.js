// Audio session tweaks applied after `npm install` (expo-audio has no options for these):
// - keep Bluetooth headphones on high-quality A2DP while the microphone is open for "Hey Meld"
//   (expo-audio asks for the hands-free profile, which turns music into call-quality mono);
// - let the microphone stream share the session with music instead of switching it to record-only.
const fs = require('fs');
const path = require('path');

function patch(file, pairs) {
  const p = path.join(__dirname, '..', 'node_modules', file);
  let s = fs.readFileSync(p, 'utf8');
  for (const [a, b] of pairs) {
    if (!s.includes(a)) {
      if (s.includes(b)) continue;
      throw new Error(`patch-native: "${a.slice(0, 60)}" not found in ${file}`);
    }
    s = s.split(a).join(b);
  }
  fs.writeFileSync(p, s);
  console.log('patched', file);
}

patch('expo-audio/ios/AudioModule.swift', [
  ['categoryOptions.insert(.allowBluetoothHFP)', 'categoryOptions.insert(.allowBluetoothA2DP)'],
  ['categoryOptions.insert(.allowBluetooth)\n', 'categoryOptions.insert(.allowBluetoothA2DP)\n'],
]);
patch('expo-audio/ios/AudioStream.swift', [
  ['try session.setCategory(.record, mode: .measurement)', 'try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothA2DP])'],
  ['try session.setPreferredSampleRate(requestedSampleRate)\n', '\n'],
  ['        try? session.setActive(false)\n', '        _ = session\n'],
]);
