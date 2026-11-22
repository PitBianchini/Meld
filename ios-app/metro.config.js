const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
// openWakeWord models and the "Hey Meld" head are bundled as assets
config.resolver.assetExts.push('tflite', 'bin');
module.exports = config;
