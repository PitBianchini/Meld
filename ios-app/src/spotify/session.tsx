import React, { useEffect, useRef, useState } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * Spotify login works like Meld's: the user signs in on open.spotify.com in a WebView, then the
 * web-player access token is requested from inside that page, so the session cookie never has to
 * be read by the app. The TOTP the token endpoint needs is computed in the page with WebCrypto.
 */
export const LOGIN_URL = 'https://accounts.spotify.com/login?continue=https%3A%2F%2Fopen.spotify.com%2F';
const NUANCE_GIST = 'https://api.github.com/gists/22ed9c6ba463899e933427f7de1f0eef';

const TOKEN_JS = `
  const gist = await (await fetch(${JSON.stringify(NUANCE_GIST)})).json();
  const nuances = JSON.parse(Object.values(gist.files)[0].content);
  const nuance = nuances.reduce((a, b) => (b.v > a.v ? b : a));
  const serverTime = (await (await fetch('/api/server-time', { credentials: 'include' })).json()).serverTime;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '', key = [];
  for (const c of nuance.s.replace(/=+$/, '').toUpperCase()) {
    const v = alphabet.indexOf(c); if (v < 0) continue; bits += v.toString(2).padStart(5, '0');
  }
  for (let i = 0; i + 8 <= bits.length; i += 8) key.push(parseInt(bits.slice(i, i + 8), 2));
  const counter = Math.floor(serverTime / 30);
  const msg = new Uint8Array(8); let c = counter;
  for (let i = 7; i >= 0; i--) { msg[i] = c & 0xff; c = Math.floor(c / 256); }
  const k = await crypto.subtle.importKey('raw', new Uint8Array(key), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', k, msg));
  const o = h[h.length - 1] & 0xf;
  const code = (((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1000000;
  const totp = String(code).padStart(6, '0');
  const url = '/api/token?reason=transport&productType=web-player&totp=' + totp + '&totpServer=' + totp + '&totpVer=' + nuance.v;
  const token = await (await fetch(url, { credentials: 'include' })).json();
  return token;
`;

type Token = { accessToken: string; accessTokenExpirationTimestampMs: number; isAnonymous: boolean };
type Pending = { resolve: (t: Token) => void; reject: (e: Error) => void };

class SpotifySession {
  webView: { injectJavaScript(js: string): void; reload(): void } | null = null;
  private token: Token | null = null;
  private pending: Pending[] = [];
  private loaded = false;
  listeners = new Set<() => void>();
  loggedIn = false;

  onLoaded() {
    this.loaded = true;
    if (this.pending.length) this.requestToken();
  }

  private requestToken() {
    if (!this.webView || !this.loaded) return;
    this.webView.injectJavaScript(`(async function(){ try { const t = await (async function(){ ${TOKEN_JS} })();
      window.ReactNativeWebView.postMessage(JSON.stringify({ spotifyToken: t }));
    } catch (e) { window.ReactNativeWebView.postMessage(JSON.stringify({ spotifyError: String(e) })); } })(); true;`);
  }

  onMessage(data: string) {
    let msg: any;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    const waiting = this.pending.splice(0);
    if (msg.spotifyToken?.accessToken && !msg.spotifyToken.isAnonymous) {
      this.token = msg.spotifyToken;
      this.setLoggedIn(true);
      waiting.forEach((p) => p.resolve(this.token!));
    } else if (msg.spotifyToken || msg.spotifyError) {
      this.setLoggedIn(false);
      waiting.forEach((p) => p.reject(new Error(msg.spotifyError || 'Spotify: accesso non effettuato')));
    }
  }

  private setLoggedIn(v: boolean) {
    if (this.loggedIn !== v) {
      this.loggedIn = v;
      this.listeners.forEach((l) => l());
    }
  }

  async accessToken(): Promise<string> {
    if (this.token && this.token.accessTokenExpirationTimestampMs > Date.now() + 60_000) return this.token.accessToken;
    const t = await new Promise<Token>((resolve, reject) => {
      this.pending.push({ resolve, reject });
      setTimeout(() => reject(new Error('Spotify non risponde')), 20000);
      this.requestToken();
    });
    return t.accessToken;
  }

  invalidate() {
    this.token = null;
  }

  /** Called after the login page lands back on open.spotify.com. */
  refresh() {
    this.token = null;
    this.webView?.reload();
  }
}

export const spotify = new SpotifySession();

export function useSpotifyLoggedIn() {
  const [v, setV] = useState(spotify.loggedIn);
  useEffect(() => {
    const l = () => setV(spotify.loggedIn);
    spotify.listeners.add(l);
    return () => void spotify.listeners.delete(l);
  }, []);
  return v;
}

/** Invisible open.spotify.com page used for tokens. Mount once at the app root. */
export function SpotifyHost() {
  return (
    <View style={{ width: 0, height: 0, position: 'absolute', opacity: 0 }} pointerEvents="none">
      <WebView
        ref={(w: any) => {
          spotify.webView = w;
        }}
        source={{ uri: 'https://open.spotify.com/robots.txt' }}
        sharedCookiesEnabled
        onLoadEnd={() => {
          spotify.onLoaded();
          spotify.accessToken().catch(() => {});
        }}
        onMessage={(e) => spotify.onMessage(e.nativeEvent.data)}
      />
    </View>
  );
}

/** Full-screen Spotify sign-in. Closes itself once the web player is reached. */
export function SpotifyLogin({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const done = useRef(false);
  useEffect(() => {
    if (visible) done.current = false;
  }, [visible]);
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, paddingTop: insets.top, backgroundColor: '#121212' }}>
        <Pressable onPress={onClose} style={{ padding: 14 }}>
          <Text style={{ color: '#fff', fontSize: 16 }}>Chiudi</Text>
        </Pressable>
        <WebView
          source={{ uri: LOGIN_URL }}
          sharedCookiesEnabled
          onNavigationStateChange={(nav) => {
            if (!done.current && nav.url.startsWith('https://open.spotify.com')) {
              done.current = true;
              spotify.refresh();
              setTimeout(onClose, 800);
            }
          }}
        />
      </View>
    </Modal>
  );
}
