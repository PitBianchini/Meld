// Checks which YouTube clients give playable audio today (run on GitHub Actions).
import { Innertube, Platform } from 'youtubei.js';

Platform.shim.eval = async (data, env) => {
  const props = [];
  if (env.n) props.push(`n: exportedVars.nFunction("${env.n}")`);
  if (env.sig) props.push(`sig: exportedVars.sigFunction("${env.sig}")`);
  return new Function(`${data.output}\nreturn { ${props.join(', ')} }`)();
};

const VIDEO = process.argv[2] || 'BSTsnWoslP4'; // Queen - Bohemian Rhapsody (official audio)
const yt = await Innertube.create({ generate_session_locally: true });

const search = await yt.music.search('bohemian rhapsody queen', { type: 'song' });
console.log('music search ok:', search.contents?.[0]?.contents?.slice(0, 2).map(s => s.title + ' / ' + s.id));

for (const client of ['IOS', 'ANDROID_VR', 'TV', 'TV_SIMPLY', 'WEB_EMBEDDED', 'MWEB', 'YTMUSIC', 'WEB', 'VISIONOS', 'ANDROID']) {
  try {
    const info = await yt.getBasicInfo(VIDEO, { client });
    const ps = info.playability_status?.status + ' ' + (info.playability_status?.reason || '');
    if (!info.streaming_data) { console.log(`RESULT ${client}: no streaming data, playability=${ps}`); continue; }
    const fmt = info.chooseFormat({ type: 'audio', quality: 'best' });
    const url = await fmt.decipher(yt.session.player);
    const r = await fetch(url, { headers: { Range: 'bytes=0-65535' } });
    const body = await r.arrayBuffer();
    console.log(`RESULT ${client}: playability=${ps} itag=${fmt.itag} mime=${fmt.mime_type} http=${r.status} bytes=${body.byteLength}`);
  } catch (e) {
    console.log(`RESULT ${client}: ERROR ${String(e?.message || e).slice(0, 160)}`);
  }
}
