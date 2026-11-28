// A chapter's timeline follows its voice: each scene lasts as long as its sentences, plus a breath,
// with a floor so that an animation has time to settle. Changing the words (voiceover/*.json →
// scripts/voice.py) re-times everything.

export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;
/** Overlap between two scenes (a fade). */
export const TRANSITION = 14;
/** The chapter's title card, before the first sentence, and its end card. */
export const TITLE_CARD = 78;
export const END_CARD = 120;

const LEAD_IN = 0.45;
const GAP = 0.35;
const TAIL = 0.9;

export interface Line {
  text: string;
  file: string;
  /** The sentence's start, in frames from the start of its scene. */
  from: number;
  durationInFrames: number;
  /** Start and end of each displayed word (s, from the sentence's start), when the engine gives them. */
  words?: { start: number; end: number }[];
}

export interface SceneTiming {
  id: string;
  lines: Line[];
  durationInFrames: number;
}

export interface Manifest {
  scenes: { id: string; lines: { text: string; file: string; duration: number; words?: { start: number; end: number }[] }[] }[];
}

export function makeTimeline(manifest: Manifest, minSeconds: Record<string, number> = {}, tails: Record<string, number> = {}) {
  const scenes: SceneTiming[] = manifest.scenes.map((s) => {
    let cursor = LEAD_IN;
    const lines = s.lines.map((l) => {
      const line: Line = { text: l.text, file: l.file, from: Math.round(cursor * FPS), durationInFrames: Math.ceil(l.duration * FPS), words: l.words };
      cursor += l.duration + GAP;
      return line;
    });
    const seconds = Math.max(minSeconds[s.id] ?? 4, cursor - GAP + (tails[s.id] ?? TAIL));
    return { id: s.id, lines, durationInFrames: Math.ceil(seconds * FPS) };
  });
  const total = TITLE_CARD + scenes.reduce((sum, s) => sum + s.durationInFrames, 0) + END_CARD - TRANSITION * (scenes.length + 1);
  return { scenes, total };
}

const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9'-]/g, "");

/** The frame (from the scene's start) a word is said at: the first occurrence of `word` (a word, or
    the start of several) at or after line `from`. A cue an animation lands on, whatever the voice. */
export function cue(lines: Line[], word: string, fromLine = 0): number {
  const want = word.split(" ").map(norm);
  for (let li = fromLine; li < lines.length; li++) {
    const l = lines[li];
    const words = l.text.split(" ");
    for (let i = 0; i + want.length <= words.length; i++) {
      if (want.every((w, k) => norm(words[i + k]).startsWith(w))) return wordFrame(l, i);
    }
  }
  throw new Error(`cue: "${word}" is not said in ${lines.map((l) => l.text).join(" | ")}`);
}

/** When word `i` of a line starts: its timestamp from ElevenLabs, or Piper's estimate by characters. */
export function wordFrame(l: Line, i: number): number {
  if (l.words?.[i]) return l.from + Math.round(l.words[i].start * FPS);
  const words = l.text.split(" ");
  const before = words.slice(0, i).join(" ").length + (i ? 1 : 0);
  return l.from + Math.round((before / l.text.length) * l.durationInFrames);
}

/** The frame a line ends at. */
export const lineEnd = (l: Line) => l.from + l.durationInFrames;
