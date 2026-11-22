import { bridge } from '../web/bridge';

/** Port of Meld's PoTokenWebView/PoTokenGenerator: mints YouTube "proof of origin" tokens with BotGuard. */
const REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo';
const GOOGLE_API_KEY = 'AIzaSyDyT5W0Jh49F30Pqqtyfdf7pDLFKLJoAnw';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';

async function botguardRequest(url: string, body: string): Promise<string> {
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Accept: 'application/json',
      'Content-Type': 'application/json+protobuf',
      'x-goog-api-key': GOOGLE_API_KEY,
      'x-user-agent': 'grpc-web-javascript/0.1',
    },
    body,
  });
  const text = await r.text();
  if (r.status !== 200 || !text) throw new Error(`BotGuard ${url.split('/').pop()} failed (${r.status})`);
  return text;
}

function b64ToBytes(b64: string): number[] {
  const s = b64.replace(/-/g, '+').replace(/_/g, '/').replace(/\./g, '=');
  const bin = globalThis.atob(s);
  return Array.from(bin, (c) => c.charCodeAt(0));
}

export function bytesToPoToken(bytes: number[]): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b & 0xff);
  return globalThis.btoa(bin).replace(/\+/g, '-').replace(/\//g, '_');
}

export function parseChallengeData(raw: string): Record<string, unknown> {
  const scrambled = JSON.parse(raw);
  let data: any[];
  if (scrambled.length > 1 && typeof scrambled[1] === 'string') {
    const bytes = b64ToBytes(scrambled[1]).map((b) => (b + 97) & 0xff);
    data = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes)));
  } else {
    data = scrambled[0];
  }
  const pick = (v: unknown) => (Array.isArray(v) ? v.find((x) => typeof x === 'string') ?? null : null);
  return {
    messageId: data[0],
    interpreterJavascript: {
      privateDoNotAccessOrElseSafeScriptWrappedValue: pick(data[1]),
      privateDoNotAccessOrElseTrustedResourceUrlWrappedValue: pick(data[2]),
    },
    interpreterHash: data[3],
    program: data[4],
    globalName: data[5],
    clientExperimentsStateBlob: data[7],
  };
}

let minterReadyUntil = 0;
let creating: Promise<void> | null = null;
let streamingToken: { visitorData: string; token: string } | null = null;

async function ensureMinter() {
  if (Date.now() < minterReadyUntil) return;
  if (creating) return creating;
  creating = (async () => {
    const challenge = parseChallengeData(await botguardRequest('https://www.youtube.com/api/jnn/v1/Create', `[ "${REQUEST_KEY}" ]`));
    const botguardResponse = await bridge.run<string>(
      `var r = await runBotGuard(${JSON.stringify(challenge)}); window.webPoSignalOutput = r.webPoSignalOutput; return r.botguardResponse;`,
      20000,
    );
    const it = JSON.parse(
      await botguardRequest('https://www.youtube.com/api/jnn/v1/GenerateIT', `[ "${REQUEST_KEY}", "${botguardResponse}" ]`),
    );
    const integrity = b64ToBytes(it[0]);
    const lifetimeSec = Number(it[1]) || 3600;
    await bridge.run(
      `window.integrityToken = new Uint8Array([${integrity.join(',')}]); await createPoTokenMinter(window.webPoSignalOutput, window.integrityToken); return true;`,
      20000,
    );
    minterReadyUntil = Date.now() + Math.max(60, lifetimeSec - 600) * 1000;
    streamingToken = null;
  })();
  try {
    await creating;
  } finally {
    creating = null;
  }
}

async function mint(identifier: string): Promise<string> {
  const bytes = Array.from(new TextEncoder().encode(identifier));
  const out = await bridge.run<string>(
    `var t = await obtainPoToken(new Uint8Array([${bytes.join(',')}])); return Array.from(t).join(',');`,
    10000,
  );
  return bytesToPoToken(out.split(',').map(Number));
}

/** Session-bound ("streaming") token, minted once per visitor data. */
export async function streamingPoToken(visitorData: string): Promise<string | undefined> {
  try {
    await ensureMinter();
    if (streamingToken?.visitorData !== visitorData) {
      streamingToken = { visitorData, token: await mint(visitorData) };
    }
    return streamingToken.token;
  } catch (e) {
    minterReadyUntil = 0;
    console.warn('[poToken] streaming token failed', e);
    return undefined;
  }
}

/** Content-bound token for one video's player request. */
export async function playerPoToken(videoId: string): Promise<string | undefined> {
  try {
    await ensureMinter();
    return await mint(videoId);
  } catch (e) {
    minterReadyUntil = 0;
    console.warn('[poToken] player token failed', e);
    return undefined;
  }
}
