import React, { useRef } from 'react';
import { View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { PO_TOKEN_HTML } from './poTokenHtml';

/**
 * A hidden WebView with youtube.com as origin. It runs YouTube's BotGuard to mint PO tokens
 * (same approach as Meld's PoTokenWebView) and evaluates JavaScript that Hermes can't.
 */
type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

class Bridge {
  webView: { injectJavaScript(js: string): void } | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private readyResolve!: () => void;
  ready = new Promise<void>((r) => (this.readyResolve = r));

  onLoad() {
    this.readyResolve();
  }

  onMessage(e: WebViewMessageEvent) {
    let msg: { id: number; ok: boolean; value?: unknown; error?: string };
    try {
      msg = JSON.parse(e.nativeEvent.data);
    } catch {
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.value);
    else p.reject(new Error(msg.error || 'JS error'));
  }

  /** Runs `body` (an async function body that returns a JSON-serializable value) inside the page. */
  async run<T = unknown>(body: string, timeoutMs = 15000): Promise<T> {
    await this.ready;
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('WebView timeout'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const js = `(async function(){ try { var __v = await (async function(){ ${body} })();
        window.ReactNativeWebView.postMessage(JSON.stringify({id:${id},ok:true,value:__v}));
      } catch (e) { window.ReactNativeWebView.postMessage(JSON.stringify({id:${id},ok:false,error:String(e && e.stack || e)})); } })(); true;`;
      this.webView?.injectJavaScript(js);
    });
  }
}

export const bridge = new Bridge();

export function WebBridgeHost() {
  const ref = useRef<WebView>(null);
  return (
    <View style={{ width: 0, height: 0, position: 'absolute', opacity: 0 }} pointerEvents="none">
      <WebView
        ref={(w: any) => {
          (ref as any).current = w;
          bridge.webView = w;
        }}
        source={{ html: PO_TOKEN_HTML, baseUrl: 'https://www.youtube.com' }}
        originWhitelist={['*']}
        javaScriptEnabled
        onLoadEnd={() => bridge.onLoad()}
        onMessage={(e) => bridge.onMessage(e)}
        onContentProcessDidTerminate={() => ref.current?.reload()}
      />
    </View>
  );
}
