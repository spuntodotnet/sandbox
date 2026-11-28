import { Activity, AlertTriangle, Bot, Check, Cpu, Folder, Globe, HardDrive, MemoryStick, Network } from "lucide-react";
import { useCurrentFrame } from "remotion";
import type { ChapterMeta, SceneComponent } from "../components/Chapter";
import { Appear, At, Block, Crack, Pill, Serif, usePulse } from "../components/ui";
import { mix, progress } from "../lib/motion";
import { C, F } from "../lib/theme";
import { cue, makeTimeline } from "../lib/timeline";
import voiceover from "./voiceover.json";

export const meta: ChapterMeta = {
  n: 2,
  title: "Containers and *virtual machines*",
  lede: "Two ways to put code you don't trust in a box, and why they are not as strong.",
  next: "*Firecracker*",
};

export const timeline = makeTimeline(voiceover, {}, { untrusted: 1.6, house: 1.6 });

// The host: its hardware at the bottom, its kernel above. Boxes stand on it.
const HOST_X = 260;
const HOST_W = 1400;
const KERNEL_Y = 640;
const HW_Y = 790;

const Host: React.FC<{ kernelLabel: string; kernelSub?: string; kernelTone?: "signal" | "danger"; glow?: number; children?: React.ReactNode }> = ({
  kernelLabel,
  kernelSub,
  kernelTone = "signal",
  glow = 0,
  children,
}) => (
  <>
    <At x={HOST_X} y={KERNEL_Y} w={HOST_W} h={110}>
      <Block label={kernelLabel} sub={kernelSub} tone={kernelTone} size={34} glow={glow}>
        {children}
      </Block>
    </At>
    <At x={HOST_X} y={HW_Y} w={HOST_W} h={84}>
      <Block label="The hardware" tone="ghost" size={26} style={{ color: C.muted }}>
        <div style={{ display: "flex", gap: 22, marginLeft: 24, color: C.muted }}>
          <Cpu size={32} />
          <MemoryStick size={32} />
          <HardDrive size={32} />
          <Network size={32} />
        </div>
      </Block>
    </At>
  </>
);

const BOX_W = 420;
const BOX_X = (i: number) => HOST_X + i * (BOX_W + 70);
const BOX_Y = 170;
const BOX_H = 420;

const Code: React.FC<{ title: string; icon: typeof Globe; code: string[] }> = ({ title, icon: Icon, code }) => (
  <div style={{ borderRadius: 20, border: `2px solid ${C.line}`, background: "rgba(0,0,0,0.25)", overflow: "hidden" }}>
    <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "16px 24px", borderBottom: `1px solid ${C.line}`, fontFamily: F.sans, fontSize: 28, fontWeight: 600, color: C.fg }}>
      <Icon size={32} color={C.signal} /> {title}
      <AlertTriangle size={30} color={C.danger} style={{ marginLeft: "auto" }} />
    </div>
    <pre style={{ margin: 0, padding: "22px 26px", fontFamily: F.mono, fontSize: 26, lineHeight: 1.5, color: C.fg }}>{code.join("\n")}</pre>
  </div>
);

const Untrusted: SceneComponent = ({ lines }) => {
  const frame = useCurrentFrame();
  const box = cue(lines, "box", 1);
  const p = progress(frame, box, 22);
  return (
    <>
      <At x={200} y={240} w={700}>
        <Appear at={cue(lines, "script")}>
          <Code title="A script from the internet" icon={Globe} code={["curl -fsSL https://… | sh"]} />
        </Appear>
      </At>
      <At x={1000} y={240} w={720}>
        <Appear at={cue(lines, "agent")}>
          <Code title="Code an agent just wrote" icon={Bot} code={["import os", "os.system(cmd)", "upload(open('~/.ssh/id_ed25519'))"]} />
        </Appear>
      </At>
      <div
        style={{
          position: "absolute",
          left: mix(960, 150, p),
          right: mix(960, 150, p),
          top: mix(390, 170, p),
          bottom: mix(690, 330, p),
          border: `4px solid ${C.signal}`,
          borderRadius: 32,
          opacity: p,
        }}
      />
      <At x={150} y={770} w={1620}>
        <Appear at={box + 14}>
          <div style={{ textAlign: "center" }}>
            <Pill tone="signal" mono={false} size={32}>
              a box
            </Pill>
          </div>
        </Appear>
      </At>
    </>
  );
};

const INSIDE = [
  { icon: Folder, label: "its files", word: "files" },
  { icon: Activity, label: "its processes", word: "processes" },
  { icon: Network, label: "its network", word: "network" },
];

/** Three containers on one host: what they see (their own files, processes, network). */
const Containers: React.FC<{ at?: number; insideAt?: number[]; danger?: number; tone?: (i: number) => number }> = ({ at = 0, insideAt = [0, 0, 0], danger = 0 }) => (
  <>
    {[0, 1, 2].map((i) => (
      <At key={i} x={BOX_X(i)} y={BOX_Y} w={BOX_W} h={BOX_H}>
        <Appear at={at + i * 4} pop style={{ height: "100%" }}>
          <div
            style={{
              height: "100%",
              boxSizing: "border-box",
              borderRadius: 24,
              border: `3px dashed ${danger > 0.05 ? C.danger : "rgba(255,255,255,0.5)"}`,
              background: `rgba(255,107,107,${0.18 * danger})`,
              padding: 26,
              display: "flex",
              flexDirection: "column",
              gap: 16,
            }}
          >
            <div style={{ fontFamily: F.mono, fontSize: 24, color: C.muted, letterSpacing: "0.1em" }}>CONTAINER {i + 1}</div>
            {INSIDE.map((x, k) => (
              <Appear key={x.label} at={insideAt[k] + i * 3}>
                <div style={{ height: 76 }}>
                  <Block icon={x.icon} label={x.label} size={26} style={{ justifyContent: "flex-start" }} />
                </div>
              </Appear>
            ))}
          </div>
        </Appear>
      </At>
    ))}
  </>
);

const Container: SceneComponent = ({ lines }) => (
  <>
    <Containers at={cue(lines, "container")} insideAt={INSIDE.map((x) => cue(lines, x.word, 1))} />
    <Appear at={0}>
      <Host kernelLabel="The host's kernel" />
    </Appear>
    <At x={1300} y={120} w={400}>
      <Appear at={cue(lines, "Docker")}>
        <div style={{ textAlign: "right" }}>
          <Pill>like Docker</Pill>
        </div>
      </Appear>
    </At>
  </>
);

const Shared: SceneComponent = ({ lines }) => {
  const frame = useCurrentFrame();
  const same = cue(lines, "same kernel");
  const bug = cue(lines, "bug", 1);
  const out = cue(lines, "out", 1);
  const spread = progress(frame, out, 24);
  return (
    <>
      <Containers danger={spread} />
      <Host kernelLabel="One kernel, shared by all" kernelSub={frame > bug ? "a bug in one system call…" : "the same for every container"} glow={usePulse(same, 40)} kernelTone={spread > 0.5 ? "danger" : "signal"} />
      {[0, 1, 2].map((i) => (
        <div key={i} style={{ position: "absolute", left: BOX_X(i) + BOX_W / 2 - 3, top: BOX_Y + BOX_H, width: 6, height: (KERNEL_Y - BOX_Y - BOX_H) * progress(frame, same + i * 4, 12), background: C.signal }} />
      ))}
      <Crack x1={HOST_X + 60} x2={HOST_X + HOST_W - 60} y={KERNEL_Y + 2} at={bug} />
    </>
  );
};

const VHW = [
  { icon: Cpu, word: "processor" },
  { icon: MemoryStick, word: "memory" },
  { icon: HardDrive, word: "disk" },
  { icon: Network, word: "network" },
];

/** Three VMs: each its own kernel, on pretend hardware. */
const Vms: React.FC<{ at?: number; kernelAt?: number; hwAt?: number[]; broken?: number }> = ({ at = 0, kernelAt = 0, hwAt = [0, 0, 0, 0], broken = 0 }) => (
  <>
    {[0, 1, 2].map((i) => (
      <At key={i} x={BOX_X(i)} y={BOX_Y} w={BOX_W} h={BOX_H}>
        <Appear at={at + i * 4} pop style={{ height: "100%" }}>
          <div
            style={{
              height: "100%",
              boxSizing: "border-box",
              borderRadius: 24,
              border: `4px solid ${i === 0 && broken > 0.05 ? C.danger : C.ok}`,
              background: "rgba(110,231,183,0.07)",
              padding: 24,
              display: "flex",
              flexDirection: "column",
              gap: 18,
            }}
          >
            <div style={{ fontFamily: F.mono, fontSize: 24, color: C.muted, letterSpacing: "0.1em" }}>VIRTUAL MACHINE {i + 1}</div>
            <div style={{ flex: 1, borderRadius: 14, border: `1px solid ${C.line}`, display: "grid", placeItems: "center", fontFamily: F.sans, fontSize: 26, color: C.muted }}>
              the code
            </div>
            <Appear at={kernelAt + i * 3}>
              <div style={{ height: 72, position: "relative" }}>
                <Block label="its own kernel" tone={i === 0 && broken > 0.5 ? "danger" : "signal"} size={26} />
              </div>
            </Appear>
            <div style={{ display: "flex", gap: 10 }}>
              {VHW.map((h, k) => (
                <Appear key={k} at={hwAt[k] + i * 2} style={{ flex: 1 }}>
                  <div style={{ height: 58, borderRadius: 12, border: `2px dashed ${C.faint}`, display: "grid", placeItems: "center", color: C.fg }}>
                    <h.icon size={30} />
                  </div>
                </Appear>
              ))}
            </div>
          </div>
        </Appear>
      </At>
    ))}
  </>
);

const Vm: SceneComponent = ({ lines }) => (
  <>
    <Vms at={cue(lines, "virtual machine")} kernelAt={cue(lines, "kernel", 1)} hwAt={VHW.map((h) => cue(lines, h.word, 1))} />
    <Host kernelLabel="The host's kernel" />
    <At x={1300} y={120} w={400}>
      <Appear at={cue(lines, "pretend")}>
        <div style={{ textAlign: "right" }}>
          <Pill>pretend hardware</Pill>
        </div>
      </Appear>
    </At>
  </>
);

const Kvm: SceneComponent = ({ lines }) => {
  const frame = useCurrentFrame();
  const kvm = cue(lines, "KVM");
  const wreck = cue(lines, "wreck", 1);
  const reach = cue(lines, "reach", 1);
  return (
    <>
      <Vms broken={progress(frame, wreck, 10)} />
      <Host kernelLabel="The host's kernel" glow={usePulse(reach, 40)}>
        <div style={{ marginLeft: 30, opacity: progress(frame, kvm, 10) }}>
          <Pill tone="tone" size={30}>
            KVM
          </Pill>
        </div>
        <div style={{ marginLeft: 20, opacity: progress(frame, reach, 10), display: "flex", alignItems: "center", gap: 10, fontFamily: F.sans, fontSize: 26, fontWeight: 600 }}>
          <Check size={34} strokeWidth={3} /> out of reach
        </div>
      </Host>
      <At x={1300} y={120} w={400}>
        <Appear at={cue(lines, "processors")}>
          <div style={{ textAlign: "right" }}>
            <Pill icon={Cpu}>almost full speed</Pill>
          </div>
        </Appear>
      </At>
    </>
  );
};

/** A house outline: a roof and `rooms` windows. */
const House: React.FC<{ w: number; rooms: number; lit?: number; color?: string }> = ({ w, rooms, lit = -1, color = C.fg }) => {
  const h = w * 0.62;
  const roof = w * 0.36;
  const room = (w - 40) / rooms;
  return (
    <svg width={w} height={h + roof} viewBox={`0 0 ${w} ${h + roof}`}>
      <polygon points={`6,${roof} ${w / 2},6 ${w - 6},${roof}`} fill="none" stroke={color} strokeWidth={5} strokeLinejoin="round" />
      <rect x={20} y={roof} width={w - 40} height={h - 6} fill="none" stroke={color} strokeWidth={5} />
      {Array.from({ length: rooms }, (_, i) => (
        <g key={i}>
          {i > 0 ? <line x1={20 + i * room} y1={roof} x2={20 + i * room} y2={roof + h - 6} stroke={color} strokeWidth={3} strokeDasharray="8 8" /> : null}
          <rect x={20 + i * room + room * 0.25} y={roof + h * 0.25} width={room * 0.5} height={h * 0.3} fill={i === lit ? C.signal : "transparent"} stroke={color} strokeWidth={3} />
        </g>
      ))}
    </svg>
  );
};

const HouseScene: SceneComponent = ({ lines }) => {
  const room = cue(lines, "room");
  const own = cue(lines, "virtual machine");
  return (
    <>
      <At x={170} y={200} w={760}>
        <Appear at={room - 6}>
          <House w={560} rooms={3} lit={1} />
          <div style={{ marginTop: 30 }}>
            <Serif text="A container: *a room* in a shared house." size={52} />
          </div>
        </Appear>
      </At>
      <At x={1030} y={200} w={760}>
        <Appear at={own}>
          <div style={{ display: "flex", gap: 22, alignItems: "flex-end", height: 548 }}>
            <House w={220} rooms={1} lit={0} />
            <House w={220} rooms={1} />
            <House w={220} rooms={1} />
          </div>
          <div style={{ marginTop: 30 }}>
            <Serif text="A virtual machine: *a house* of its own." size={52} />
          </div>
        </Appear>
      </At>
    </>
  );
};

export const components: Record<string, SceneComponent> = { untrusted: Untrusted, container: Container, shared: Shared, vm: Vm, kvm: Kvm, house: HouseScene };
