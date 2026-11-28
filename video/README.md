# The videos of « From zero »

Five chapters of about a minute, for [sandbox.spunto.net/docs/from-zero](https://sandbox.spunto.net/docs/from-zero):
what a kernel is, containers and virtual machines, Firecracker, why a sandbox holds, what can still go wrong.
In [Remotion](https://www.remotion.dev): every frame is a function of its number, the narration is a file per
sentence, and the scenes are cut on the voice.

```sh
npm ci                                  # also copies the brand's fonts into public/fonts
npm run dev                             # Remotion Studio: each chapter, and each scene alone (scenes/)
scripts/render.sh                       # → ../docs/public/videos/from-zero/<n>-<id>.mp4 + .jpg
scripts/render.sh 3-firecracker         # one chapter
```

A machine without a desktop needs ffmpeg and Chrome's libraries (`npx remotion browser ensure` fetches the browser).

## Where things are

| | |
|---|---|
| `voiceover/<id>.json` | **the words**: one entry per sentence, by scene; `say` / `sayElevenlabs` when the spoken form differs |
| `scripts/voice.py` | synthesizes them → `public/voice/<id>/` + `src/<id>/voiceover.json` (each sentence's length, each word's time) |
| `src/<id>/index.tsx` | a chapter: its title, its scenes, each drawn from words it cues on (`cue(lines, "kernel")`) |
| `src/components/` | the chapter frame (title card, header, end card), the captions, the diagram pieces |
| `src/lib/timeline.ts` | scene lengths follow the voice: change a sentence, everything re-times |
| `src/lib/theme.ts` | Spunto Sandbox's paint (emerald · coral) and faces, from `@spunto/brand-kit` |

## Changing the words

Edit `voiceover/<id>.json`, run `python3 scripts/voice.py voiceover/<id>.json`, check the scenes in the Studio,
render. With `"provider": "elevenlabs"` (ELEVENLABS_API_KEY), each response is kept in `.voice-cache/`: only the
sentences that changed are paid for. Animations land on spoken words (`cue`), so they follow; a `cue` on a word
that is no longer said fails loudly.

Every figure said is sourced on the docs page under the video.
