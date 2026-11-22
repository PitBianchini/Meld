import React from 'react';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { C } from './theme';

export function Icon({ name, size = 22, color = C.text }: { name: SFSymbol; size?: number; color?: string }) {
  return <SymbolView name={name} size={size} tintColor={color} resizeMode="scaleAspectFit" style={{ width: size, height: size }} />;
}
