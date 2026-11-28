import { Check, Crown, Globe, Server, Boxes, Router, KeyRound, ArrowDownToLine, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useCurrentFrame } from "remotion";
import type { ChapterMeta, SceneComponent } from "../components/Chapter";
import { Appear, At, Kicker, Pill, Serif } from "../components/ui";
import { mix, progress } from "../lib/motion";
import { C, F } from "../lib/theme";
import { cue, makeTimeline, type Line } from "../lib/timeline";
import voiceover from "./voiceover.json";

export const meta: ChapterMeta = {
  n: 4,
  title: "Why a sandbox *holds*",
  lede: "Spunto Sandbox doesn't trust the code in a box. Five walls, one inside the other.",
  next: "What can *still go wrong*",
};

export const timeline = makeTimeline(voiceover, {}, { "wall-net": 1.6 });

// The walls, innermost first, around the code: one diagram for the whole chapter, a wall added per scene.
export const WALLS = ["The virtual machine", "Firecracker", "The jailer", "Limits", "The network"];
const CX = 620;
const CY = 520;
const CORE_W = 280;
const CORE_H = 130;
const STEP_X = 78;
const STEP_Y = 54;

const rect = (k: number) => ({ w: CORE_W + 2 * STEP_X * (k + 1), h: CORE_H + 2 * STEP_Y * (k + 1) });

/** The code, and walls 0..`upTo` (the last one drawn in from `at`). */
export const Walls: React.FC<{ upTo: number; at?: number; current?: number; scale?: number; x?: number; root?: number; broken?: number[]; harm?: number }> = ({
  upTo,
  at = 0,
  current = upTo,
  scale = 1,
  x = 0,
  root = 1,
  broken = [],
  harm = 0,
}) => {
  const frame = useCurrentFrame();
  return (
    <div style={{ position: "absolute", inset: 0, transformOrigin: `${CX}px ${CY}px`, scale: String(scale), translate: `${x}px 0px` }}>
      {WALLS.map((name, k) => {
        if (k > upTo) return null;
        const p = k === upTo ? progress(frame, at, 18) : 1;
        const { w, h } = rect(k);
        const on = k === current;
        const hurt = broken.includes(k) && harm > 0.05;
        const ww = mix(rect(k - 1).w, w, p);
        const hh = mix(rect(k - 1).h, h, p);
        return (
          <div
            key={name}
            style={{
              position: "absolute",
              left: CX - ww / 2,
              top: CY - hh / 2,
              width: ww,
              height: hh,
              boxSizing: "border-box",
              borderRadius: 26 + k * 8,
              border: `${on || hurt ? 5 : 3}px ${hurt ? "dashed" : "solid"} ${hurt ? C.danger : on ? C.signal : "rgba(255,255,255,0.32)"}`,
              background: on ? "rgba(255,194,197,0.06)" : "transparent",
              opacity: p,
              boxShadow: on ? "0 0 50px rgba(255,194,197,0.25)" : undefined,
            }}
          >
            <div style={{ position: "absolute", left: 22, top: -19, background: C.field, padding: "2px 12px", fontFamily: F.mono, fontSize: 22, color: on ? C.signal : C.muted, whiteSpace: "nowrap" }}>
              {k + 1} · {name}
            </div>
          </div>
        );
      })}
      <div
        style={{
          position: "absolute",
          left: CX - CORE_W / 2,
          top: CY - CORE_H / 2,
          width: CORE_W,
          height: CORE_H,
          borderRadius: 20,
          background: "rgba(255,107,107,0.16)",
          border: `3px solid ${C.danger}`,
          display: "grid",
          placeItems: "center",
          fontFamily: F.sans,
          fontSize: 30,
          fontWeight: 600,
          color: C.fg,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          untrusted code
        </div>
        <div style={{ position: "absolute", top: -26, right: -26, opacity: root, scale: String(0.6 + 0.4 * root) }}>
          <Pill icon={Crown} tone="signal" size={22}>
            root
          </Pill>
        </div>
      </div>
    </div>
  );
};

/** The right column: which wall, and what it is made of, each item on its word. */
const Panel: React.FC<{ kicker: string; title: string; items: { text: string; at: number; icon?: LucideIcon }[]; note?: { text: string; at: number } }> = ({ kicker, title, items, note }) => (
  <At x={1300} y={190} w={540}>
    <Appear at={0}>
      <Kicker>{kicker}</Kicker>
      <div style={{ marginTop: 16 }}>
        <Serif text={title} size={64} />
      </div>
    </Appear>
    <div style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 36 }}>
      {items.map((it) => (
        <Appear key={it.text} at={it.at}>
          <div style={{ display: "flex", alignItems: "center", gap: 14, fontFamily: F.sans, fontSize: 32, color: C.fg }}>
            <Check size={32} color={C.ok} strokeWidth={3} /> {it.text}
          </div>
        </Appear>
      ))}
    </div>
    {note ? (
      <Appear at={note.at} style={{ marginTop: 40 }}>
        <div style={{ fontFamily: F.display, fontSize: 40, color: C.signal, lineHeight: 1.2 }}>{note.text}</div>
      </Appear>
    ) : null}
  </At>
);

const Rule: SceneComponent = ({ lines }) => {
  const frame = useCurrentFrame();
  const root = progress(frame, cue(lines, "root", 1), 12);
  const walls = cue(lines, "stacks", 1);
  return (
    <>
      <Walls upTo={-1} root={root} />
      {WALLS.map((_, k) => {
        const { w, h } = rect(k);
        return (
          <div key={k} style={{ position: "absolute", left: CX - w / 2, top: CY - h / 2, width: w, height: h, borderRadius: 26 + k * 8, border: "2px dashed rgba(255,255,255,0.3)", opacity: progress(frame, walls + k * 4, 10) }} />
        );
      })}
      <At x={1300} y={240} w={540}>
        <Appear at={cue(lines, "not trusted")}>
          <Serif text="The code in a box is *not trusted*." size={60} />
        </Appear>
        <Appear at={cue(lines, "Outside", 1)} style={{ marginTop: 36 }}>
          <div style={{ fontFamily: F.sans, fontSize: 32, color: C.muted, lineHeight: 1.4 }}>Root inside its box. Outside: nothing.</div>
        </Appear>
      </At>
    </>
  );
};

const wallScene = (k: number, panel: (lines: Line[]) => React.ComponentProps<typeof Panel>): SceneComponent => {
  const Scene: SceneComponent = ({ lines }) => (
    <>
      <Walls upTo={k} at={8} />
      <Panel {...panel(lines)} />
    </>
  );
  return Scene;
};

const WallVm = wallScene(0, (l) => ({
  kicker: "Wall 1",
  title: "The *virtual machine*",
  items: [
    { text: "its own kernel", at: cue(l, "kernel") },
    { text: "its own disks", at: cue(l, "disks") },
    { text: "KVM between it and the hardware", at: cue(l, "KVM") },
  ],
}));

const WallFc = wallScene(1, (l) => ({
  kicker: "Wall 2",
  title: "*Firecracker*",
  items: [
    { text: "a handful of devices", at: cue(l, "few") },
    { text: "a filter on its system calls", at: cue(l, "filter") },
  ],
}));

const WallJail = wallScene(2, (l) => ({
  kicker: "Wall 3",
  title: "The *jailer*",
  items: [
    { text: "a folder of its own", at: cue(l, "folder") },
    { text: "a user of its own", at: cue(l, "user") },
    { text: "no special right", at: cue(l, "special") },
  ],
  note: { text: "Out of the VM: an empty cell.", at: cue(l, "empty", 1) },
}));

const WallLimits = wallScene(3, (l) => ({
  kicker: "Wall 4",
  title: "*Limits*",
  items: [
    { text: "its share of processor", at: cue(l, "processor") },
    { text: "its share of memory", at: cue(l, "memory") },
    { text: "its share of the network", at: cue(l, "network") },
  ],
}));

const ROUTES: { icon: LucideIcon; label: string; ok: boolean; word: string; line?: number }[] = [
  { icon: Globe, label: "the internet", ok: true, word: "internet" },
  { icon: Server, label: "the host", ok: false, word: "host" },
  { icon: Boxes, label: "the other boxes", ok: false, word: "other" },
  { icon: Router, label: "your local network", ok: false, word: "local" },
  { icon: KeyRound, label: "the cloud's metadata server", ok: false, word: "metadata" },
  { icon: ArrowDownToLine, label: "anything coming in", ok: false, word: "nothing", line: 1 },
];

const WallNet: SceneComponent = ({ lines }) => (
  <>
    <Walls upTo={4} at={8} scale={0.78} x={-80} />
    <At x={1150} y={190} w={700}>
      <Appear at={0}>
        <Kicker>Wall 5</Kicker>
        <div style={{ marginTop: 16 }}>
          <Serif text="The *network*" size={64} />
        </div>
      </Appear>
      <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 34 }}>
        {ROUTES.map((r) => (
          <Appear key={r.label} at={cue(lines, r.word, r.line ?? 0)}>
            <div style={{ display: "flex", alignItems: "center", gap: 18, fontFamily: F.sans, fontSize: 32, color: C.fg }}>
              <div style={{ width: 46, height: 46, borderRadius: 23, background: r.ok ? C.ok : C.danger, display: "grid", placeItems: "center" }}>
                {r.ok ? <Check size={30} color={C.field} strokeWidth={3} /> : <X size={30} color={C.field} strokeWidth={3} />}
              </div>
              <r.icon size={34} color={C.muted} />
              {r.label}
            </div>
          </Appear>
        ))}
      </div>
    </At>
  </>
);

export const components: Record<string, SceneComponent> = { rule: Rule, "wall-vm": WallVm, "wall-fc": WallFc, "wall-jail": WallJail, "wall-limits": WallLimits, "wall-net": WallNet };
