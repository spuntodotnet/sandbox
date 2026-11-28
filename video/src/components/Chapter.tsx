import { linearTiming, TransitionSeries } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { useCurrentFrame } from "remotion";
import { Box } from "lucide-react";
import { END_CARD, TITLE_CARD, TRANSITION, type Line, type SceneTiming } from "../lib/timeline";
import { progress } from "../lib/motion";
import { C, F } from "../lib/theme";
import { Stage } from "./Stage";
import { Voice } from "./Voice";
import { Appear, Kicker, Serif } from "./ui";

export interface ChapterMeta {
  n: number;
  /** The chapter's title; `*stars*` mark the signal word. */
  title: string;
  /** One line under it, on the title card. */
  lede: string;
  /** The next chapter's title, on the end card (none for the last). */
  next?: string;
}

export const CHAPTERS = 5;

export type SceneComponent = React.FC<{ lines: Line[] }>;

const plain = (s: string) => s.replace(/\*/g, "");

/** The series' mark, top left, and where we are, top right: on every scene. */
const Header: React.FC<{ meta: ChapterMeta }> = ({ meta }) => (
  <>
    <div style={{ position: "absolute", left: 64, top: 48, display: "flex", alignItems: "center", gap: 14, fontFamily: F.sans, fontSize: 26, fontWeight: 600, color: C.fg }}>
      <Box size={30} color={C.signal} strokeWidth={2} />
      Spunto Sandbox <span style={{ color: C.faint, fontWeight: 400 }}>· from zero</span>
    </div>
    <div style={{ position: "absolute", right: 64, top: 52, fontFamily: F.mono, fontSize: 22, letterSpacing: "0.1em", color: C.muted, textTransform: "uppercase" }}>
      {meta.n} / {CHAPTERS} · {plain(meta.title)}
    </div>
  </>
);

const TitleCard: React.FC<{ meta: ChapterMeta }> = ({ meta }) => (
  <Stage>
    <div style={{ position: "absolute", left: 160, top: 330, width: 1600 }}>
      <Appear at={2}>
        <Kicker>
          Chapter {meta.n} of {CHAPTERS}
        </Kicker>
      </Appear>
      <Appear at={8} style={{ marginTop: 28 }}>
        <Serif text={meta.title} size={124} />
      </Appear>
      <Appear at={18} style={{ marginTop: 36 }}>
        <div style={{ fontFamily: F.sans, fontSize: 40, color: C.muted, maxWidth: 1300 }}>{meta.lede}</div>
      </Appear>
    </div>
  </Stage>
);

const EndCard: React.FC<{ meta: ChapterMeta }> = ({ meta }) => {
  const frame = useCurrentFrame();
  const bar = progress(frame, 10, END_CARD - 30);
  return (
    <Stage>
      <div style={{ position: "absolute", left: 160, top: 340, width: 1600 }}>
        {meta.next ? (
          <>
            <Appear at={4}>
              <Kicker>Next · chapter {meta.n + 1}</Kicker>
            </Appear>
            <Appear at={10} style={{ marginTop: 26 }}>
              <Serif text={meta.next} size={96} />
            </Appear>
          </>
        ) : (
          <>
            <Appear at={4}>
              <Kicker>That's the tour</Kicker>
            </Appear>
            <Appear at={10} style={{ marginTop: 26 }}>
              <Serif text="Now *try one*." size={110} />
            </Appear>
          </>
        )}
        <Appear at={20} style={{ marginTop: 48 }}>
          <div style={{ fontFamily: F.mono, fontSize: 34, color: C.fg }}>
            sandbox.spunto.net<span style={{ color: C.faint }}>/docs</span>
          </div>
        </Appear>
        <div style={{ marginTop: 56, width: 520, height: 4, borderRadius: 2, background: C.line }}>
          <div style={{ width: `${bar * 100}%`, height: 4, borderRadius: 2, background: C.signal }} />
        </div>
      </div>
    </Stage>
  );
};

/** A chapter: its title card, its scenes (each with its voice and captions), its end card, faded into each other. */
export const Chapter: React.FC<{ meta: ChapterMeta; scenes: SceneTiming[]; components: Record<string, SceneComponent> }> = ({ meta, scenes, components }) => {
  const timing = linearTiming({ durationInFrames: TRANSITION });
  const items = [
    <TransitionSeries.Sequence key="title" durationInFrames={TITLE_CARD}>
      <TitleCard meta={meta} />
    </TransitionSeries.Sequence>,
  ];
  for (const s of scenes) {
    const Scene = components[s.id];
    if (!Scene) throw new Error(`No component for scene "${s.id}"`);
    items.push(<TransitionSeries.Transition key={`t-${s.id}`} presentation={fade()} timing={timing} />);
    items.push(
      <TransitionSeries.Sequence key={s.id} durationInFrames={s.durationInFrames}>
        <Stage>
          <Scene lines={s.lines} />
          <Header meta={meta} />
          <Voice lines={s.lines} />
        </Stage>
      </TransitionSeries.Sequence>,
    );
  }
  items.push(<TransitionSeries.Transition key="t-end" presentation={fade()} timing={timing} />);
  items.push(
    <TransitionSeries.Sequence key="end" durationInFrames={END_CARD}>
      <EndCard meta={meta} />
    </TransitionSeries.Sequence>,
  );
  return <TransitionSeries>{items}</TransitionSeries>;
};
