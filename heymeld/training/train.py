"""Trains the "Hey Meld" wake word head for openWakeWord features and exports hey_meld.bin.

Runs on GitHub Actions (CPU only). Positive and confusable negative clips are synthesized with
Piper TTS in many English and Italian voices, mixed with music/noise/speech backgrounds, turned
into openWakeWord embeddings, and combined with openWakeWord's large precomputed negative set.

    python train.py --out OUT_DIR            # full run
    python train.py --out OUT_DIR --smoke    # offline pipeline check with synthetic audio
"""

import argparse
import json
import os
import random
import struct
import sys
import time
from pathlib import Path

import numpy as np

SR = 16_000
CLIP = 32_000  # 2.0 s -> exactly 16 embedding frames
FRAMES = 16
DIM = 96

POSITIVE_EN = ["hey meld", "hey meld", "hey, meld", "hey meld!", "hey meld?", "hey melld", "hay meld", "heymeld"]
POSITIVE_IT = ["ehi meld", "ehi meld", "hei meld", "ehi, meld", "ehi mèld", "ei meld", "hey meld"]

CONFUSABLE_EN = [
    "hey mel", "hey melt", "hey mall", "hey mild", "hey mold", "hey male", "hey man", "hey max", "hey mark",
    "hey meg", "hey met", "hey well", "hey bell", "hey field", "hey held", "hey world", "hey help", "hey melody",
    "meld", "melt", "held", "weld", "hey", "hey there", "hey Siri", "okay Google", "Alexa", "hey Google",
    "they melt", "the meld", "a meld", "in the field", "hello", "help me", "well done", "hey mom",
]
CONFUSABLE_IT = [
    "ehi mela", "ehi mel", "ehi melo", "e meglio", "è meglio", "ehi Michele", "ehi Mattia", "ehi bello", "ehi ciao",
    "ehi tu", "ehi mamma", "ehi merda", "ehi Marco", "ehi Melissa", "ehi merlo", "ehi mille", "ehi molto",
    "mela", "melone", "metti", "mettila", "meldola", "melodia", "e meld", "e mel", "hai messo", "ai miei",
    "e il mondo", "ehi", "ehi ragazzi", "ehi guarda", "è mezzogiorno", "ei mi senti", "ehi Alexa", "ok Google",
]
SENTENCES_IT = """
passa la canzone successiva per favore
oggi a pranzo mangiamo la pasta al forno
domani devo andare a scuola presto
hai visto la partita ieri sera
metti un po' di musica rilassante
che ore sono adesso
la verifica di elettronica è andata bene
devo finire il progetto del rover
in Valtellina fa freddo d'inverno
mi passi il caricabatterie
questa canzone mi piace un sacco
stasera usciamo con gli amici
il professore ha spiegato le resistenze in serie
ricordati di comprare il latte
alza un po' il volume della tv
ho dimenticato le chiavi in macchina
andiamo a fare una passeggiata in montagna
la batteria del telefono è quasi scarica
mi hanno chiamato al telefono prima
non trovo più il quaderno di storia
che bello questo pezzo
il treno per Sondrio è in ritardo
abbiamo vinto la partita due a uno
mangiamo la pizza stasera
la mamma ha detto di apparecchiare
ci vediamo dopo la lezione
ho saldato i led sulla millefori
il condensatore si è bruciato
facciamo una pausa
non ho capito cosa hai detto
""".strip().splitlines()
SENTENCES_EN = """
I think we should leave in a few minutes
can you hear the music from the other room
the weather is really nice today
this song is one of my favorites
turn it up a little bit
we melted the chocolate in the pan
the field was covered with snow
let me know when you are ready
I held the door for him
that was a great concert last night
""".strip().splitlines()

VOICES = {
    # name: max speakers to sample (multi-speaker voices give accent/timbre variety)
    "en_US-libritts_r-medium": 900,
    "en_GB-vctk-medium": 109,
    "en_US-lessac-medium": 1,
    "en_US-ryan-high": 1,
    "en_GB-alan-medium": 1,
    "it_IT-paola-medium": 1,
    "it_IT-riccardo-x_low": 1,
    "es_ES-davefx-medium": 1,
    "de_DE-thorsten-medium": 1,
    "fr_FR-siwis-medium": 1,
}
ITALIAN_VOICES = {"it_IT-paola-medium", "it_IT-riccardo-x_low"}


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


# --------------------------------------------------------------------------- audio sources

class Tts:
    def __init__(self, voice_dir: Path):
        from piper import PiperVoice  # noqa
        self.voices = {}
        for name in VOICES:
            onnx = voice_dir / f"{name}.onnx"
            if onnx.exists():
                self.voices[name] = PiperVoice.load(str(onnx))
        if not self.voices:
            raise RuntimeError("no Piper voices available")
        log("TTS voices:", ", ".join(self.voices))

    def say(self, text: str, rng: random.Random, italian: bool | None = None) -> np.ndarray:
        from piper import SynthesisConfig
        from scipy.signal import resample_poly
        names = list(self.voices)
        if italian is True:
            names = [n for n in names if n in ITALIAN_VOICES] or names
        elif italian is False:
            names = [n for n in names if n not in ITALIAN_VOICES] or names
        name = rng.choice(names)
        voice = self.voices[name]
        speakers = min(VOICES[name], max(1, voice.config.num_speakers))
        cfg = SynthesisConfig(
            speaker_id=rng.randrange(speakers) if voice.config.num_speakers > 1 else None,
            length_scale=rng.uniform(0.75, 1.35),
            noise_scale=rng.uniform(0.4, 0.9),
            noise_w_scale=rng.uniform(0.5, 1.0),
        )
        audio = np.concatenate([c.audio_float_array for c in voice.synthesize(text, cfg)] or [np.zeros(1600, np.float32)])
        sr = voice.config.sample_rate
        if sr != SR:
            g = np.gcd(sr, SR)
            audio = resample_poly(audio, SR // g, sr // g).astype(np.float32)
        return trim(audio)


class SmokeTts:
    """Stand-in for --smoke: chirps for positives, noise bursts for negatives."""

    def say(self, text: str, rng: random.Random, italian=None) -> np.ndarray:
        n = int(SR * rng.uniform(0.5, 0.9))
        t = np.arange(n) / SR
        if "meld" in text and text.endswith("meld"):
            f0 = rng.uniform(180, 260)
            return (0.5 * np.sin(2 * np.pi * (f0 * t + 300 * t ** 2)) * np.hanning(n)).astype(np.float32)
        return (0.3 * np.random.default_rng(rng.randrange(1 << 30)).normal(0, 1, n) * np.hanning(n)).astype(np.float32)


def trim(a: np.ndarray, thr=0.02) -> np.ndarray:
    idx = np.where(np.abs(a) > thr)[0]
    if len(idx) == 0:
        return a
    return a[max(0, idx[0] - 800): idx[-1] + 800]


def synth_music(rng: np.random.Generator, seconds: float) -> np.ndarray:
    n = int(SR * seconds)
    t = np.arange(n) / SR
    out = np.zeros(n, np.float32)
    bpm = rng.uniform(70, 160)
    beat = 60 / bpm
    root = rng.uniform(80, 220)
    for start in np.arange(0, seconds, beat * 4):
        chord = root * np.array([1, rng.choice([1.25, 1.2]), 1.5, rng.choice([2, 1.78])])
        seg = (t >= start) & (t < start + beat * 4)
        for f in chord:
            out[seg] += 0.08 * np.sin(2 * np.pi * f * t[seg]) * np.exp(-(t[seg] - start) * 0.6)
    for start in np.arange(0, seconds, beat):
        k = (t >= start) & (t < start + 0.12)
        out[k] += 0.4 * np.sin(2 * np.pi * 55 * t[k]) * np.exp(-(t[k] - start) * 30)
        h = (t >= start + beat / 2) & (t < start + beat / 2 + 0.05)
        out[h] += 0.05 * rng.normal(0, 1, h.sum())
    vocal = (t * 0)
    for start in np.arange(0, seconds, rng.uniform(0.25, 0.6)):
        s = (t >= start) & (t < start + 0.3)
        vocal[s] = 0.15 * np.sin(2 * np.pi * root * rng.choice([2, 2.5, 3, 4]) * t[s])
    return (out + vocal).astype(np.float32)


def colored_noise(rng: np.random.Generator, n: int) -> np.ndarray:
    white = rng.normal(0, 1, n)
    kind = rng.integers(3)
    if kind == 0:
        x = white
    else:
        spec = np.fft.rfft(white)
        f = np.arange(len(spec)) + 1
        spec /= f ** (0.5 if kind == 1 else 1.0)
        x = np.fft.irfft(spec, n)
    return (x / (np.abs(x).max() + 1e-9)).astype(np.float32)


def load_music(out_dir: Path, limit_seconds: float, smoke: bool) -> list[np.ndarray]:
    """Real music for backgrounds when the Hugging Face dataset is reachable, synthetic otherwise."""
    rng = np.random.default_rng(7)
    clips = []
    if not smoke:
        try:
            from datasets import Audio, load_dataset
            ds = load_dataset("lewtun/music_genres_small", split="train", streaming=True, trust_remote_code=False)
            ds = ds.cast_column("audio", Audio(sampling_rate=SR))
            total = 0.0
            for row in ds:
                a = np.asarray(row["audio"]["array"], np.float32)
                if a.ndim > 1:
                    a = a.mean(axis=0)
                clips.append(a)
                total += len(a) / SR
                if total >= limit_seconds:
                    break
            log(f"music: {len(clips)} real clips, {total / 60:.0f} min")
        except Exception as e:  # noqa
            log("music dataset unavailable, using synthetic music:", repr(e)[:200])
    while sum(len(c) for c in clips) / SR < min(limit_seconds, 600):
        clips.append(synth_music(rng, 30))
    return clips


def load_rirs(smoke: bool) -> list[np.ndarray]:
    rirs = []
    if not smoke:
        try:
            from datasets import Audio, load_dataset
            ds = load_dataset("davidscripka/MIT_environmental_impulse_responses", split="train", streaming=True, trust_remote_code=False)
            ds = ds.cast_column("audio", Audio(sampling_rate=SR))
            for row in ds:
                rirs.append(np.asarray(row["audio"]["array"], np.float32))
            log(f"room impulse responses: {len(rirs)}")
        except Exception as e:  # noqa
            log("RIR dataset unavailable:", repr(e)[:200])
    if not rirs:
        rng = np.random.default_rng(3)
        for _ in range(40):
            n = int(SR * rng.uniform(0.15, 0.6))
            r = rng.normal(0, 1, n) * np.exp(-np.arange(n) / (SR * rng.uniform(0.03, 0.15)))
            r[0] = 1.0
            rirs.append(r.astype(np.float32))
    return rirs


# --------------------------------------------------------------------------- augmentation

def place(speech: np.ndarray, rng: np.random.Generator, end_at_tail: bool) -> np.ndarray:
    out = np.zeros(CLIP, np.float32)
    s = speech[-CLIP:]
    if end_at_tail:
        end = CLIP - int(rng.integers(0, int(0.25 * SR)))
    else:
        end = int(rng.integers(min(len(s), CLIP), CLIP + 1))
    start = max(0, end - len(s))
    out[start:end] = s[len(s) - (end - start):]
    return out


def augment(clip: np.ndarray, rng: np.random.Generator, music, babble, rirs) -> np.ndarray:
    x = clip.copy()
    if rng.random() < 0.5:
        r = rirs[int(rng.integers(len(rirs)))]
        x = np.convolve(x, r)[:CLIP]
    if rng.random() < 0.3:  # phone-mic / speaker-ish band limit
        from scipy.signal import butter, sosfilt
        sos = butter(4, [rng.uniform(150, 400), rng.uniform(3400, 7000)], btype="band", fs=SR, output="sos")
        x = sosfilt(sos, x).astype(np.float32)
    x /= np.abs(x).max() + 1e-9
    roll = rng.random()
    if roll < 0.45:
        bg = music[int(rng.integers(len(music)))]
    elif roll < 0.65:
        bg = babble[int(rng.integers(len(babble)))] if babble else colored_noise(rng, CLIP)
    elif roll < 0.9:
        bg = colored_noise(rng, CLIP)
    else:
        bg = None
    if bg is not None:
        if len(bg) < CLIP:
            bg = np.tile(bg, CLIP // max(1, len(bg)) + 1)
        o = int(rng.integers(0, len(bg) - CLIP + 1))
        bg = bg[o:o + CLIP].astype(np.float32)
        bg /= np.abs(bg).max() + 1e-9
        snr = rng.uniform(-3, 18)
        ps = np.mean(x ** 2) + 1e-9
        pb = np.mean(bg ** 2) + 1e-9
        x = x + bg * np.sqrt(ps / (pb * 10 ** (snr / 10)))
    x = x / (np.abs(x).max() + 1e-9) * rng.uniform(0.05, 0.95)
    return (x * 32767).astype(np.int16)


# --------------------------------------------------------------------------- features

def embed(features, clips: np.ndarray) -> np.ndarray:
    out = []
    for i in range(0, len(clips), 512):
        out.append(features.embed_clips(clips[i:i + 512], batch_size=128, ncpu=os.cpu_count() or 2))
    e = np.concatenate(out).astype(np.float32)
    return e[:, -FRAMES:, :]


def windows_from(arr, n: int, rng: np.random.Generator) -> np.ndarray:
    """Random (16, 96) windows from precomputed openWakeWord negatives of shape (N,16,96) or (N,96)."""
    if arr.ndim == 3:
        idx = np.sort(rng.choice(arr.shape[0], size=min(n, arr.shape[0]), replace=False))
        return np.asarray(arr[idx], np.float32)
    starts = np.sort(rng.integers(0, arr.shape[0] - FRAMES, size=n))
    return np.stack([np.asarray(arr[s:s + FRAMES], np.float32) for s in starts])


def streaming_windows(arr, max_windows: int) -> np.ndarray:
    if arr.ndim == 3:
        return np.asarray(arr[:max_windows], np.float32)
    n = min(arr.shape[0] - FRAMES, max_windows)
    return np.stack([np.asarray(arr[s:s + FRAMES], np.float32) for s in range(n)])


# --------------------------------------------------------------------------- model

def build_model(layer=48, blocks=1):
    import torch.nn as nn
    mods = [nn.Flatten(), nn.Linear(FRAMES * DIM, layer), nn.LayerNorm(layer), nn.ReLU()]
    for _ in range(blocks):
        mods += [nn.Linear(layer, layer), nn.LayerNorm(layer), nn.ReLU()]
    mods += [nn.Linear(layer, 1)]
    return nn.Sequential(*mods)


def train(model, pos, neg, hard_neg, steps, rng_seed=0):
    import torch
    torch.manual_seed(rng_seed)
    opt = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-2)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=2e-3, total_steps=steps)
    bce = torch.nn.BCEWithLogitsLoss(reduction="none")
    P, N, H = torch.from_numpy(pos), torch.from_numpy(neg), torch.from_numpy(hard_neg)
    g = torch.Generator().manual_seed(rng_seed)
    for step in range(steps):
        bp, bn, bh = 128, 320, 64
        xp = P[torch.randint(len(P), (bp,), generator=g)]
        xn = N[torch.randint(len(N), (bn,), generator=g)]
        xh = H[torch.randint(len(H), (bh,), generator=g)]
        x = torch.cat([xp, xn, xh])
        y = torch.cat([torch.ones(bp), torch.zeros(bn + bh)])
        w = torch.cat([torch.ones(bp), torch.full((bn,), 1.0 + 9.0 * step / steps), torch.full((bh,), 3.0)])
        logits = model(x).squeeze(1)
        loss = (bce(logits, y) * w).mean()
        opt.zero_grad()
        loss.backward()
        opt.step()
        sched.step()
        if step % 1000 == 0:
            log(f"step {step}/{steps} loss {loss.item():.4f}")
    return model


def predict(model, x: np.ndarray) -> np.ndarray:
    import torch
    model.eval()
    out = []
    with torch.no_grad():
        for i in range(0, len(x), 4096):
            out.append(torch.sigmoid(model(torch.from_numpy(x[i:i + 4096]))).squeeze(1).numpy())
    return np.concatenate(out) if out else np.zeros(0)


def false_accepts(scores: np.ndarray, thr: float) -> int:
    """Counts detections in a streaming score sequence, merging hits closer than 1.5 s (as the app's cooldown)."""
    hits, last = 0, -10_000
    for i in np.where(scores >= thr)[0]:
        if i - last > 19:
            hits += 1
        last = i
    return hits


# --------------------------------------------------------------------------- export

def export(model, threshold: float, path: Path):
    import torch.nn as nn
    linears = [m for m in model if isinstance(m, nn.Linear)]
    norms = [m for m in model if isinstance(m, nn.LayerNorm)]
    hidden = list(zip(linears[:-1], norms))
    with open(path, "wb") as f:
        f.write(b"HMW1")
        f.write(struct.pack("<iii", FRAMES, DIM, len(hidden)))
        for lin, ln in hidden:
            f.write(struct.pack("<ii", lin.in_features, lin.out_features))
            for t in (lin.weight, lin.bias, ln.weight, ln.bias):
                f.write(t.detach().numpy().astype("<f4").tobytes())
        last = linears[-1]
        f.write(struct.pack("<i", last.in_features))
        f.write(last.weight.detach().numpy().astype("<f4").reshape(-1).tobytes())
        f.write(last.bias.detach().numpy().astype("<f4").tobytes())
        f.write(struct.pack("<f", threshold))


def numpy_head(path: Path):
    """Independent re-implementation of WakeWordDetector.WakeHead, to check the exported file."""
    b = path.read_bytes()
    assert b[:4] == b"HMW1"
    o = 4
    def ints(n):
        nonlocal o
        v = struct.unpack_from("<%di" % n, b, o); o += 4 * n; return v
    def floats(n):
        nonlocal o
        v = np.frombuffer(b, "<f4", n, o); o += 4 * n; return v
    frames, dim, count = ints(3)
    layers = []
    for _ in range(count):
        i, j = ints(2)
        layers.append((floats(i * j).reshape(j, i), floats(j), floats(j), floats(j)))
    (last_in,) = ints(1)
    w, bias = floats(last_in), floats(1)[0]
    thr = floats(1)[0]
    def run(x):
        h = x.reshape(-1)
        for W, bb, g, be in layers:
            y = W @ h + bb
            y = (y - y.mean()) / np.sqrt(y.var() + 1e-5) * g + be
            h = np.maximum(y, 0)
        return 1 / (1 + np.exp(-(w @ h + bias)))
    return run, float(thr)


# --------------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--voices", default="voices")
    ap.add_argument("--negatives", default="", help="openWakeWord ACAV100M feature .npy")
    ap.add_argument("--validation", default="", help="openWakeWord validation_set_features.npy")
    ap.add_argument("--positives", type=int, default=12000)
    ap.add_argument("--confusables", type=int, default=9000)
    ap.add_argument("--steps", type=int, default=25000)
    ap.add_argument("--smoke", action="store_true")
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    if a.smoke:
        a.positives, a.confusables, a.steps = 300, 300, 300

    from openwakeword.utils import AudioFeatures
    features = AudioFeatures(inference_framework="onnx", ncpu=os.cpu_count() or 2)
    py = random.Random(1)
    rng = np.random.default_rng(1)
    tts = SmokeTts() if a.smoke else Tts(Path(a.voices))

    music = load_music(out, 3 * 3600, a.smoke)
    rirs = load_rirs(a.smoke)

    log("synthesizing speech backgrounds")
    babble = []
    for _ in range(60 if a.smoke else 400):
        s = [tts.say(py.choice(SENTENCES_IT + SENTENCES_EN), py) for _ in range(3)]
        babble.append(np.concatenate(s))

    def make(n, texts_en, texts_it, tail):
        clips = np.zeros((n, CLIP), np.int16)
        for i in range(n):
            italian = py.random() < 0.35
            text = py.choice(texts_it if italian else texts_en)
            clips[i] = augment(place(tts.say(text, py, italian), rng, tail), rng, music, babble, rirs)
            if i % 2000 == 0:
                log(f"  {i}/{n}")
        return clips

    log("positive clips")
    pos_clips = make(a.positives, POSITIVE_EN, POSITIVE_IT, tail=True)
    log("confusable negative clips")
    conf_clips = make(a.confusables, CONFUSABLE_EN, CONFUSABLE_IT, tail=True)
    log("sentence negatives")
    sent_clips = make(a.confusables // 2, SENTENCES_EN, SENTENCES_IT, tail=False)
    log("pure background negatives")
    bg_clips = np.stack([augment(np.zeros(CLIP, np.float32) + 1e-4 * rng.normal(0, 1, CLIP).astype(np.float32), rng, music, babble, rirs)
                         for _ in range(a.confusables // 2)])

    log("embedding")
    pos = embed(features, pos_clips)
    hard = embed(features, conf_clips)
    neg_local = np.concatenate([embed(features, sent_clips), embed(features, bg_clips)])

    if a.negatives and Path(a.negatives).exists():
        acav = np.load(a.negatives, mmap_mode="r")
        log("ACAV negatives", acav.shape, acav.dtype)
        neg = np.concatenate([windows_from(acav, 400_000, rng), neg_local])
    else:
        neg = neg_local

    # hold out 10 % of positives and confusables for evaluation
    def split(x):
        k = max(1, len(x) // 10)
        return x[k:], x[:k]
    pos_tr, pos_te = split(pos)
    hard_tr, hard_te = split(hard)

    import torch
    model = build_model()
    log(f"training on {len(pos_tr)} positives, {len(neg)} negatives, {len(hard_tr)} confusables")
    train(model, pos_tr, neg, hard_tr, a.steps)

    p_pos = predict(model, pos_te)
    p_hard = predict(model, hard_te)
    if a.validation and Path(a.validation).exists():
        val = streaming_windows(np.load(a.validation, mmap_mode="r"), 600_000)
        hours = len(val) * 0.08 / 3600
    else:
        val = neg_local[: max(1, len(neg_local) // 5)]
        hours = len(val) * 2.0 / 3600
    p_val = predict(model, val)

    report = {"hours_validation": hours, "candidates": []}
    best = None
    for thr in [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95]:
        fa = false_accepts(p_val, thr)
        row = {
            "threshold": thr,
            "recall": float((p_pos >= thr).mean()),
            "confusable_accept": float((p_hard >= thr).mean()),
            "false_accepts_per_hour": fa / max(hours, 1e-6),
        }
        report["candidates"].append(row)
        log(row)
        if best is None and row["false_accepts_per_hour"] <= 0.5 and row["confusable_accept"] <= 0.05:
            best = row
    best = best or report["candidates"][-1]
    report["chosen"] = best

    bin_path = out / "hey_meld.bin"
    export(model, best["threshold"], bin_path)
    run, thr = numpy_head(bin_path)
    sample = pos_te[:64]
    ref = predict(model, sample)
    mine = np.array([run(x) for x in sample])
    report["export_max_abs_diff"] = float(np.abs(ref - mine).max())
    assert report["export_max_abs_diff"] < 1e-4, report["export_max_abs_diff"]

    # test vectors for WakeHeadTest.kt: "<expected> <1536 inputs>" per line
    lines = [" ".join([f"{ref[i]:.7f}"] + [f"{v:.7f}" for v in sample[i].reshape(-1)]) for i in range(8)]
    (out / "vectors.txt").write_text("\n".join(lines) + "\n")
    (out / "report.json").write_text(json.dumps(report, indent=2))
    log("done:", json.dumps(best))


if __name__ == "__main__":
    sys.exit(main())
