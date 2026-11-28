import type { CSSProperties, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { useCurrentFrame } from "remotion";
import { EASE_IN_OUT, mix, progress, SPRING_POP } from "../lib/motion";
import { C, F } from "../lib/theme";

// The pieces every diagram is drawn with. Positions are absolute, in the 1920×1080 frame; times are
// frames from the scene's start (usually a `cue` on a spoken word).

/** Fades and slides in at `at`, and out at `out` if given. */
export const Appear: React.FC<{ at: number; out?: number; dy?: number; pop?: boolean; style?: CSSProperties; children: ReactNode }> = ({
  at,
  out,
  dy = 24,
  pop,
  style,
  children,
}) => {
  const frame = useCurrentFrame();
  const p = progress(frame, at, pop ? 16 : 14, pop ? SPRING_POP : undefined);
  const q = out === undefined ? 0 : progress(frame, out, 10);
  const a = Math.min(1, p) * (1 - q);
  return (
    <div style={{ opacity: a, translate: `0px ${(1 - p) * dy}px`, scale: pop ? String(mix(0.85, 1, p)) : undefined, ...style }}>{children}</div>
  );
};

/** At (x, y), absolutely. */
export const At: React.FC<{ x: number; y: number; w?: number; h?: number; children: ReactNode; style?: CSSProperties }> = ({ x, y, w, h, children, style }) => (
  <div style={{ position: "absolute", left: x, top: y, width: w, height: h, ...style }}>{children}</div>
);

export const Kicker: React.FC<{ children: ReactNode; color?: string }> = ({ children, color = C.signal }) => (
  <div style={{ fontFamily: F.mono, fontSize: 24, letterSpacing: "0.14em", textTransform: "uppercase", color }}>{children}</div>
);

/** Young Serif; `*stars*` put a word in the signal colour. */
export const Serif: React.FC<{ text: string; size?: number; style?: CSSProperties }> = ({ text, size = 72, style }) => (
  <div style={{ fontFamily: F.display, fontSize: size, lineHeight: 1.12, color: C.fg, letterSpacing: "-0.01em", ...style }}>
    {text.split(/(\*[^*]+\*)/).map((part, i) =>
      part.startsWith("*") ? (
        <span key={i} style={{ color: C.signal }}>
          {part.slice(1, -1)}
        </span>
      ) : (
        <span key={i}>{part}</span>
      ),
    )}
  </div>
);

export type Tone = "panel" | "signal" | "tone" | "dashed" | "danger" | "ok" | "ghost";

const toneStyle = (tone: Tone): CSSProperties => {
  switch (tone) {
    case "signal":
      return { background: C.signal, color: C.field, border: `2px solid ${C.signal}` };
    case "tone":
      return { background: C.tone, color: C.fg, border: `2px solid rgba(255,255,255,0.22)` };
    case "dashed":
      return { background: "rgba(255,255,255,0.03)", color: C.fg, border: `2px dashed rgba(255,255,255,0.45)` };
    case "danger":
      return { background: "rgba(255,107,107,0.16)", color: C.fg, border: `2px solid ${C.danger}` };
    case "ok":
      return { background: "rgba(110,231,183,0.12)", color: C.fg, border: `2px solid ${C.ok}` };
    case "ghost":
      return { background: "transparent", color: C.fg, border: `2px solid ${C.line}` };
    default:
      return { background: C.panel, color: C.fg, border: `2px solid ${C.line}` };
  }
};

/** A labelled box: a layer, a device, a program. */
export const Block: React.FC<{
  icon?: LucideIcon;
  label?: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
  size?: number;
  row?: boolean;
  glow?: number;
  style?: CSSProperties;
  children?: ReactNode;
}> = ({ icon: Icon, label, sub, tone = "panel", size = 30, row = true, glow = 0, style, children }) => (
  <div
    style={{
      ...toneStyle(tone),
      borderRadius: 20,
      display: "flex",
      flexDirection: row ? "row" : "column",
      alignItems: "center",
      justifyContent: "center",
      gap: row ? 16 : 10,
      padding: "18px 26px",
      boxSizing: "border-box",
      width: "100%",
      height: "100%",
      boxShadow: glow ? `0 0 ${60 * glow}px rgba(255,194,197,${0.45 * glow})` : undefined,
      ...style,
    }}
  >
    {Icon ? <Icon size={size * 1.3} strokeWidth={1.8} /> : null}
    {label || sub ? (
      <div style={{ display: "flex", flexDirection: "column", alignItems: row ? "flex-start" : "center", gap: 4 }}>
        {label ? <div style={{ fontFamily: F.sans, fontWeight: 600, fontSize: size, lineHeight: 1.1, textAlign: row ? "left" : "center" }}>{label}</div> : null}
        {sub ? <div style={{ fontFamily: F.mono, fontSize: size * 0.62, opacity: 0.75, textAlign: row ? "left" : "center" }}>{sub}</div> : null}
      </div>
    ) : null}
    {children}
  </div>
);

/** A small pill: a word on an arrow, a fact. */
export const Pill: React.FC<{ children: ReactNode; tone?: Tone; mono?: boolean; size?: number; icon?: LucideIcon; style?: CSSProperties }> = ({
  children,
  tone = "panel",
  mono = true,
  size = 26,
  icon: Icon,
  style,
}) => (
  <div
    style={{
      ...toneStyle(tone),
      display: "inline-flex",
      alignItems: "center",
      gap: 10,
      borderRadius: 999,
      padding: "8px 20px",
      fontFamily: mono ? F.mono : F.sans,
      fontSize: size,
      fontWeight: mono ? 500 : 600,
      whiteSpace: "nowrap",
      ...style,
    }}
  >
    {Icon ? <Icon size={size * 1.1} strokeWidth={2} /> : null}
    {children}
  </div>
);

/** An arrow from (x1, y1) to (x2, y2), drawn from `at` over `dur` frames. */
export const Arrow: React.FC<{ x1: number; y1: number; x2: number; y2: number; at: number; dur?: number; color?: string; width?: number; dashed?: boolean; head?: boolean; out?: number }> = ({
  x1,
  y1,
  x2,
  y2,
  at,
  dur = 16,
  color = C.signal,
  width = 4,
  dashed,
  head = true,
  out,
}) => {
  const frame = useCurrentFrame();
  const p = progress(frame, at, dur, EASE_IN_OUT);
  const q = out === undefined ? 0 : progress(frame, out, 10);
  if (p <= 0) return null;
  const x = mix(x1, x2, p);
  const y = mix(y1, y2, p);
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const hs = 16;
  return (
    <svg style={{ position: "absolute", inset: 0, overflow: "visible", opacity: 1 - q }} width={1920} height={1080}>
      <line x1={x1} y1={y1} x2={x} y2={y} stroke={color} strokeWidth={width} strokeLinecap="round" strokeDasharray={dashed ? "10 12" : undefined} />
      {head ? (
        <polygon
          points={`${x},${y} ${x - hs * Math.cos(ang - 0.45)},${y - hs * Math.sin(ang - 0.45)} ${x - hs * Math.cos(ang + 0.45)},${y - hs * Math.sin(ang + 0.45)}`}
          fill={color}
        />
      ) : null}
    </svg>
  );
};

/** Something travelling from (x1, y1) to (x2, y2) between `at` and `at + dur`, centred on the path. */
export const Travel: React.FC<{ x1: number; y1: number; x2: number; y2: number; at: number; dur?: number; children: ReactNode; fadeOut?: boolean }> = ({
  x1,
  y1,
  x2,
  y2,
  at,
  dur = 24,
  children,
  fadeOut = true,
}) => {
  const frame = useCurrentFrame();
  if (frame < at) return null;
  const p = progress(frame, at, dur, EASE_IN_OUT);
  const a = progress(frame, at, 6) * (fadeOut ? 1 - progress(frame, at + dur + 6, 8) : 1);
  return (
    <div style={{ position: "absolute", left: mix(x1, x2, p), top: mix(y1, y2, p), translate: "-50% -50%", opacity: a }}>{children}</div>
  );
};

/** A jagged crack along a horizontal line at y, from x1 to x2, drawn from `at`. */
export const Crack: React.FC<{ x1: number; x2: number; y: number; at: number; color?: string }> = ({ x1, x2, y, at, color = C.danger }) => {
  const frame = useCurrentFrame();
  const p = progress(frame, at, 14);
  if (p <= 0) return null;
  const n = 14;
  const pts = Array.from({ length: n + 1 }, (_, i) => `${mix(x1, x2, i / n)},${y + (i % 2 ? -18 : 14) * (i % 3 ? 1 : 0.5)}`).join(" ");
  const len = (x2 - x1) * 1.3;
  return (
    <svg style={{ position: "absolute", inset: 0, overflow: "visible" }} width={1920} height={1080}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={6} strokeLinejoin="round" strokeDasharray={len} strokeDashoffset={len * (1 - p)} />
    </svg>
  );
};

/** A pulse, 0 → 1 → 0, around frame `at` — for a highlight. */
export const usePulse = (at: number, dur = 30) => {
  const frame = useCurrentFrame();
  return progress(frame, at, dur / 2) * (1 - progress(frame, at + dur / 2, dur / 2));
};

/** 0 → 1 from `at` on, held. */
export const useOn = (at: number, dur = 14) => progress(useCurrentFrame(), at, dur);
