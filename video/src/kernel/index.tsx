import { Check, Cpu, FileText, Globe, HardDrive, MemoryStick, Music, Network, Server, Smartphone, Terminal, X } from "lucide-react";
import { useCurrentFrame } from "remotion";
import type { ChapterMeta, SceneComponent } from "../components/Chapter";
import { Appear, Arrow, At, Block, Pill, Serif, Travel, usePulse } from "../components/ui";
import { progress } from "../lib/motion";
import { C, F } from "../lib/theme";
import { cue, lineEnd, makeTimeline } from "../lib/timeline";
import voiceover from "./voiceover.json";

export const meta: ChapterMeta = {
  n: 1,
  title: "What a *kernel* is",
  lede: "The one program on your computer that every other program has to ask.",
  next: "Containers and *virtual machines*",
};

export const timeline = makeTimeline(voiceover, {}, { linux: 1.6 });

// One machine, drawn the same in every scene: programs on top, the kernel in the middle, the
// hardware at the bottom.
const APPS = [
  { icon: Globe, label: "Browser", x: 290 },
  { icon: Music, label: "Music player", x: 770 },
  { icon: Terminal, label: "Terminal", x: 1250 },
];
const APP_W = 380;
const APP_Y = 180;
const APP_H = 130;
const KERNEL_Y = 450;
const KERNEL_H = 130;
const HW = [
  { icon: Cpu, label: "Processor", word: "processor's" },
  { icon: MemoryStick, label: "Memory", word: "memory" },
  { icon: HardDrive, label: "Disk", word: "disk" },
  { icon: Network, label: "Network", word: "network" },
];
const HW_W = 300;
const HW_X = (i: number) => 300 + i * (HW_W + 40);
const HW_Y = 700;
const HW_H = 120;
const appCenter = (i: number) => APPS[i].x + APP_W / 2;

const Apps: React.FC<{ at?: number[] }> = ({ at = [0, 0, 0] }) => (
  <>
    {APPS.map((a, i) => (
      <At key={a.label} x={a.x} y={APP_Y} w={APP_W} h={APP_H}>
        <Appear at={at[i]} pop>
          <div style={{ height: APP_H }}>
            <Block icon={a.icon} label={a.label} sub="a program" />
          </div>
        </Appear>
      </At>
    ))}
  </>
);

const Hardware: React.FC<{ at?: number; glow?: (i: number) => number }> = ({ at = 0, glow }) => (
  <>
    {HW.map((h, i) => (
      <At key={h.label} x={HW_X(i)} y={HW_Y} w={HW_W} h={HW_H}>
        <Appear at={at + i * 3}>
          <div style={{ height: HW_H }}>
            <Block icon={h.icon} label={h.label} tone={glow && glow(i) > 0.05 ? "signal" : "ghost"} glow={glow?.(i) ?? 0} />
          </div>
        </Appear>
      </At>
    ))}
    <At x={300} y={HW_Y + HW_H + 14} w={1320}>
      <Appear at={at + 10}>
        <div style={{ fontFamily: F.mono, fontSize: 22, color: C.faint, textAlign: "center", letterSpacing: "0.12em" }}>THE HARDWARE</div>
      </Appear>
    </At>
  </>
);

const Kernel: React.FC<{ at?: number; glow?: number; children?: React.ReactNode }> = ({ at = 0, glow = 0, children }) => (
  <At x={290} y={KERNEL_Y} w={1340} h={KERNEL_H}>
    <Appear at={at} pop>
      <div style={{ height: KERNEL_H, position: "relative" }}>
        <Block label="The kernel" sub="one program with every right" tone="signal" size={40} glow={glow}>
          {children}
        </Block>
      </div>
    </Appear>
  </At>
);

const Programs: SceneComponent = ({ lines }) => {
  const frame = useCurrentFrame();
  const no = cue(lines, "Not", 1);
  const xs = progress(frame, no + 12, 10);
  return (
    <>
      <Apps at={[cue(lines, "browser"), cue(lines, "music"), cue(lines, "terminal")]} />
      <Hardware at={cue(lines, "terminal") + 12} />
      {APPS.map((_, i) => (
        <Arrow key={i} x1={appCenter(i)} y1={APP_Y + APP_H + 12} x2={appCenter(i)} y2={HW_Y - 16} at={no + i * 3} dashed color={C.faint} />
      ))}
      {APPS.map((_, i) => (
        <div key={i} style={{ position: "absolute", left: appCenter(i) - 36, top: 470, width: 72, height: 72, borderRadius: 36, background: C.danger, display: "grid", placeItems: "center", opacity: xs, scale: String(0.6 + 0.4 * xs) }}>
          <X size={46} color={C.field} strokeWidth={3} />
        </div>
      ))}
    </>
  );
};

const KernelScene: SceneComponent = ({ lines }) => {
  const k = cue(lines, "kernel");
  const glow = usePulse(k, 40);
  const pulses = HW.map((h) => cue(lines, h.word, 1));
  const frame = useCurrentFrame();
  const lit = (i: number) => progress(frame, pulses[i], 8) * (1 - progress(frame, pulses[i] + 22, 10));
  return (
    <>
      <Apps />
      <Hardware glow={lit} />
      <Kernel at={k} glow={glow} />
    </>
  );
};

const SYSCALLS = ["read", "write", "openat", "close", "mmap", "socket", "connect", "sendto", "recvfrom", "clone", "execve", "kill", "futex", "ioctl", "poll", "brk", "pipe", "mount", "…"];

const Syscalls: SceneComponent = ({ lines }) => {
  const frame = useCurrentFrame();
  const open = cue(lines, "open");
  const send = cue(lines, "send");
  const call = cue(lines, "system call", 1);
  const many = cue(lines, "few", 1);
  const m = progress(frame, many, 14);
  return (
    <>
      <Apps />
      <Hardware />
      <Kernel>
        <div style={{ position: "absolute", inset: 0, display: "flex", flexWrap: "wrap", alignContent: "center", justifyContent: "center", gap: "6px 14px", padding: "10px 30px", opacity: m, background: C.signal, borderRadius: 20 }}>
          {SYSCALLS.map((s, i) => (
            <span key={s} style={{ fontFamily: F.mono, fontSize: 28, color: C.field, opacity: progress(frame, many + i * 2, 6) }}>
              {s}()
            </span>
          ))}
        </div>
      </Kernel>
      <Travel x1={appCenter(2)} y1={APP_Y + APP_H + 40} x2={appCenter(2)} y2={KERNEL_Y - 40} at={open} dur={22} fadeOut={false}>
        <div style={{ opacity: 1 - m }}>
          <Pill icon={FileText}>open("notes.txt")</Pill>
        </div>
      </Travel>
      <Travel x1={appCenter(0)} y1={APP_Y + APP_H + 40} x2={appCenter(0)} y2={KERNEL_Y - 40} at={send} dur={22} fadeOut={false}>
        <div style={{ opacity: 1 - m }}>
          <Pill icon={Globe}>send(…)</Pill>
        </div>
      </Travel>
      <At x={700} y={KERNEL_Y - 80} w={520}>
        <Appear at={call} out={many}>
          <div style={{ textAlign: "center" }}>
            <Pill tone="tone" mono={false}>
              a system call
            </Pill>
          </div>
        </Appear>
      </At>
    </>
  );
};

const Referee: SceneComponent = ({ lines }) => {
  const frame = useCurrentFrame();
  const ok = cue(lines, "may read");
  const no = cue(lines, "never");
  const end = lineEnd(lines[0]);
  const verdict = (at: number, good: boolean) => {
    const p = progress(frame, at + 22, 10);
    return (
      <div style={{ width: 64, height: 64, borderRadius: 32, background: good ? C.ok : C.danger, display: "grid", placeItems: "center", opacity: p, scale: String(0.6 + 0.4 * p) }}>
        {good ? <Check size={40} color={C.field} strokeWidth={3} /> : <X size={40} color={C.field} strokeWidth={3} />}
      </div>
    );
  };
  return (
    <>
      <Apps />
      <Hardware />
      <Kernel glow={usePulse(ok, 30) + usePulse(no, 30)} />
      <Travel x1={appCenter(0) - 40} y1={APP_Y + APP_H + 40} x2={appCenter(0) + 120} y2={KERNEL_Y - 42} at={ok - 18} dur={22} fadeOut={false}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, opacity: 1 - progress(frame, no - 10, 10) }}>
          <Pill icon={FileText}>read ~/notes.txt</Pill>
          {verdict(ok - 18, true)}
        </div>
      </Travel>
      <Travel x1={appCenter(1) + 120} y1={APP_Y + APP_H + 40} x2={appCenter(1) + 160} y2={KERNEL_Y - 42} at={no - 16} dur={22} fadeOut={false}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, opacity: 1 - progress(frame, end + 10, 10) }}>
          <Pill icon={MemoryStick} tone="danger">
            read the Terminal's memory
          </Pill>
          {verdict(no - 16, false)}
        </div>
      </Travel>
    </>
  );
};

const Linux: SceneComponent = ({ lines }) => {
  const second = lines[1].from;
  return (
    <>
      <At x={160} y={290} w={1600}>
        <Appear at={0} out={second - 6}>
          <Serif text="*Linux*" size={150} />
          <div style={{ display: "flex", gap: 24, marginTop: 50 }}>
            <Appear at={cue(lines, "servers")}>
              <Pill icon={Server} mono={false} size={34}>
                most servers on the internet
              </Pill>
            </Appear>
            <Appear at={cue(lines, "Android")}>
              <Pill icon={Smartphone} mono={false} size={34}>
                every Android phone
              </Pill>
            </Appear>
          </div>
        </Appear>
      </At>
      <At x={160} y={340} w={1600}>
        <Appear at={cue(lines, "whoever", 1)}>
          <Serif text="Whoever controls *the kernel* controls the machine." size={96} />
        </Appear>
      </At>
    </>
  );
};

export const components: Record<string, SceneComponent> = { programs: Programs, kernel: KernelScene, syscalls: Syscalls, referee: Referee, linux: Linux };
