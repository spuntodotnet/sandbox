#!/usr/bin/env python3
"""Synthesizes a narration (voiceover/<name>.json) → public/voice/<name>/ + src/<name>/voiceover.json.

One synthesis PER SENTENCE: each sentence's exact length is known, so the composition times its
scenes, animations and captions on it (src/lib/timeline.ts).

Two engines, picked by `"provider"` in the script:
- `piper` (default): a local neural TTS, free, for drafts. `say` fixes a pronunciation the
  displayed text would trip ("QEMU" → "kemu").
  python3 -m venv /tmp/tts && /tmp/tts/bin/pip install piper-tts
  cd /tmp/voices && /tmp/tts/bin/python -m piper.download_voices en_US-ryan-high
- `elevenlabs`: the real voice, ELEVENLABS_API_KEY. Sends the text as displayed (`sayElevenlabs`
  to fix it); the API returns each character's timing, so the manifest carries each word's and
  the captions follow the voice word by word. Responses are kept in .voice-cache/ (key = voice +
  request): running it again only pays for the sentences that changed.
  `"tempo"` speeds the voice up locally (ffmpeg atempo), without paying again.

Usage: python3 scripts/voice.py voiceover/kernel.json [more.json…] [--piper …] [--voices …]
"""
import base64
import hashlib
import json
import os
import subprocess
import sys
import urllib.request
import wave

args = sys.argv[1:]
opt = lambda k, d: args[args.index(k) + 1] if k in args else d  # noqa: E731
piper = opt("--piper", "/tmp/tts/bin/piper")
voices = opt("--voices", "/tmp/voices")

paths = [a for a in args if a.endswith(".json")]


def piper_line(text, dest):
    model = os.path.join(voices, f"{script['voice']}.onnx")
    subprocess.run([piper, "-m", model, "-f", dest, "--sentence-silence", "0",
                    "--length-scale", str(script.get("lengthScale", 1))],
                   input=text.encode(), check=True, capture_output=True)
    with wave.open(dest) as w:
        return w.getnframes() / w.getframerate(), None


def elevenlabs_line(text, dest):
    cfg = script["elevenlabs"]
    body = {"text": text, "model_id": cfg.get("model", "eleven_multilingual_v2"),
            "voice_settings": cfg.get("settings", {}), "language_code": cfg.get("language", "en")}
    # Cached by (voice, request body): every character is paid for, an unchanged sentence is never synthesized twice.
    key = hashlib.sha256(json.dumps([cfg["voiceId"], body], sort_keys=True).encode()).hexdigest()[:16]
    cached = os.path.join(".voice-cache", f"{key}.json")
    if os.path.exists(cached):
        res = json.load(open(cached))
    else:
        req = urllib.request.Request(
            f"https://api.elevenlabs.io/v1/text-to-speech/{cfg['voiceId']}/with-timestamps?output_format=mp3_44100_128",
            data=json.dumps(body).encode(),
            headers={"xi-api-key": os.environ["ELEVENLABS_API_KEY"], "Content-Type": "application/json"})
        res = json.load(urllib.request.urlopen(req))
        os.makedirs(".voice-cache", exist_ok=True)
        json.dump(res, open(cached, "w"))
    # tempo: speeds the voice up locally (atempo keeps the pitch), without paying for the synthesis again.
    tempo = cfg.get("tempo", 1)
    raw = dest + ".raw.mp3" if tempo != 1 else dest
    with open(raw, "wb") as f:
        f.write(base64.b64decode(res["audio_base64"]))
    if tempo != 1:
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", raw, "-filter:a", f"atempo={tempo}", "-b:a", "128k", dest], check=True)
        os.remove(raw)
    duration = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", dest],
                                    check=True, capture_output=True, text=True).stdout)
    # Characters → words: the first character's start, the last one's end.
    al = res.get("normalized_alignment") or res["alignment"]
    words, cur = [], None
    for ch, s, e in zip(al["characters"], al["character_start_times_seconds"], al["character_end_times_seconds"]):
        if ch.isspace():
            cur = None
            continue
        if cur is None:
            cur = {"start": s, "end": e}
            words.append(cur)
        cur["end"] = e
    return duration, [{"start": round(w["start"] / tempo, 3), "end": round(w["end"] / tempo, 3)} for w in words]


for path in paths:
    name = os.path.splitext(os.path.basename(path))[0]
    out_json = f"src/{name}/voiceover.json"
    out_dir = f"voice/{name}"
    script = json.load(open(path))
    provider = script.get("provider", "piper")
    os.makedirs(f"public/{out_dir}", exist_ok=True)
    os.makedirs(os.path.dirname(out_json), exist_ok=True)
    manifest = {"voice": script.get("voice") if provider == "piper" else script["elevenlabs"]["voiceId"], "provider": provider, "scenes": []}
    for scene in script["scenes"]:
        lines = []
        for i, line in enumerate(scene["lines"]):
            if provider == "elevenlabs":
                spoken = line.get("sayElevenlabs", line["text"])
                rel = f"{out_dir}/{scene['id']}-{i}.mp3"
                duration, words = elevenlabs_line(spoken, f"public/{rel}")
                # Word timings only when what is said is what is shown.
                if words and len(words) != len(line["text"].split()):
                    words = None
            else:
                rel = f"{out_dir}/{scene['id']}-{i}.wav"
                duration, words = piper_line(line.get("say", line["text"]), f"public/{rel}")
            entry = {"text": line["text"], "file": rel, "duration": round(duration, 3)}
            if words:
                entry["words"] = words
            lines.append(entry)
        manifest["scenes"].append({"id": scene["id"], "lines": lines})
        print(f"{scene['id']:8} " + " + ".join(f"{l['duration']:.2f}s" for l in lines))

    with open(out_json, "w") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
