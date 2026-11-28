import { Audio } from "@remotion/media";
import { Sequence, staticFile, useCurrentFrame } from "remotion";
import { FPS, type Line } from "../lib/timeline";
import { progress } from "../lib/motion";
import { C, F } from "../lib/theme";

// A scene's voice (one track per sentence, at its frame) and its captions: the whole sentence, the
// word being said lit in the signal colour. Word timings from ElevenLabs when the manifest has
// them, else an estimate by characters (Piper).
export const Voice: React.FC<{ lines: Line[] }> = ({ lines }) => {
  const frame = useCurrentFrame();
  return (
    <>
      {lines.map((l) => (
        <Sequence key={l.file} from={l.from} durationInFrames={l.durationInFrames} layout="none">
          <Audio src={staticFile(l.file)} />
        </Sequence>
      ))}
      {lines.map((l) => {
        const end = l.from + l.durationInFrames;
        if (frame < l.from - 4 || frame > end + 8) return null;
        const a = progress(frame, l.from - 4, 6) * (1 - progress(frame, end + 2, 6));
        const words = l.text.split(" ");
        const total = l.text.length;
        let acc = 0;
        const t = (frame - l.from) / l.durationInFrames;
        const sec = (frame - l.from) / FPS;
        return (
          <div key={l.file} style={{ position: "absolute", left: 0, right: 0, bottom: 54, display: "flex", justifyContent: "center", opacity: a }}>
            <div
              style={{
                fontFamily: F.sans,
                fontSize: 36,
                fontWeight: 500,
                lineHeight: 1.35,
                maxWidth: 1480,
                textAlign: "center",
                padding: "12px 28px",
                borderRadius: 14,
                background: "rgba(0,20,13,0.72)",
                border: `1px solid ${C.line}`,
                translate: `0px ${(1 - a) * 10}px`,
              }}
            >
              {words.map((w, i) => {
                const start = acc / total;
                acc += w.length + 1;
                const stamp = l.words?.[i];
                const on = stamp ? sec >= stamp.start && sec < (l.words?.[i + 1]?.start ?? stamp.end + 0.3) : t >= start && t < acc / total;
                const said = stamp ? sec >= stamp.end && !on : t >= acc / total;
                return (
                  <span key={i} style={{ color: on ? C.signal : said ? C.fg : "rgba(255,255,255,0.5)" }}>
                    {w}
                    {i < words.length - 1 ? " " : ""}
                  </span>
                );
              })}
            </div>
          </div>
        );
      })}
    </>
  );
};
