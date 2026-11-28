import { Activity, Box, Cpu, Disc3, HardDrive, Keyboard, Monitor, Network, Save, Speaker, Terminal, Usb, Watch, Zap } from "lucide-react";
import { useCurrentFrame } from "remotion";
import type { ChapterMeta, SceneComponent } from "../components/Chapter";
import { Appear, Arrow, At, Block, Pill, Serif } from "../components/ui";
import { mix, progress } from "../lib/motion";
import { C, F } from "../lib/theme";
import { cue, makeTimeline } from "../lib/timeline";
import voiceover from "./voiceover.json";

export const meta: ChapterMeta = {
  n: 3,
  title: "*Firecracker*",
  lede: "Why the program that pretends the hardware matters, and why ours pretends so little.",
  next: "Why a sandbox *holds*",
};

export const timeline = makeTimeline(voiceover, {}, { venom: 1.4, snapshot: 1.6 });

const Vm: React.FC<{ danger?: number }> = ({ danger = 0 }) => (
  <div
    style={{
      height: "100%",
      boxSizing: "border-box",
      borderRadius: 24,
      border: `4px solid ${danger > 0.05 ? C.danger : C.ok}`,
      background: "rgba(110,231,183,0.07)",
      padding: 24,
      display: "flex",
      flexDirection: "column",
      gap: 16,
    }}
  >
    <div style={{ fontFamily: F.mono, fontSize: 24, color: C.muted, letterSpacing: "0.1em" }}>THE VIRTUAL MACHINE</div>
    <div style={{ flex: 1, borderRadius: 14, border: `1px solid ${C.line}`, display: "grid", placeItems: "center", fontFamily: F.sans, fontSize: 28, color: C.muted }}>the code</div>
    <div style={{ height: 70 }}>
      <Block label="its kernel" tone="signal" size={26} />
    </div>
  </div>
);

const Vmm: SceneComponent = ({ lines }) => {
  const kvm = cue(lines, "KVM");
  const disk = cue(lines, "disk");
  const nic = cue(lines, "network card");
  const mon = cue(lines, "monitor");
  return (
    <>
      <At x={200} y={170} w={620} h={450}>
        <Vm />
      </At>
      {[
        { icon: HardDrive, label: "disk", at: disk, y: 250 },
        { icon: Network, label: "network card", at: nic, y: 400 },
      ].map((d) => (
        <At key={d.label} x={860} y={d.y} w={330} h={100}>
          <Appear at={d.at} pop>
            <div style={{ height: 100 }}>
              <Block icon={d.icon} label={d.label} sub="pretend" tone="dashed" size={28} />
            </div>
          </Appear>
        </At>
      ))}
      <Arrow x1={1200} y1={300} x2={1330} y2={370} at={mon} />
      <Arrow x1={1200} y1={450} x2={1330} y2={400} at={mon} />
      <At x={1340} y={290} w={420} h={190}>
        <Appear at={mon} pop>
          <div style={{ height: 190 }}>
            <Block label="Virtual machine monitor" sub="an ordinary program, on the host" tone="tone" size={30} row={false} />
          </div>
        </Appear>
      </At>
      <At x={200} y={680} w={1560} h={110}>
        <Block label="The host's kernel" tone="signal" size={34}>
          <div style={{ marginLeft: 26, opacity: progress(useCurrentFrame(), kvm, 10), display: "flex", alignItems: "center", gap: 14 }}>
            <Pill tone="tone">KVM</Pill>
            <span style={{ fontFamily: F.sans, fontSize: 26 }}>runs the processor and the memory</span>
          </div>
        </Block>
      </At>
      <Arrow x1={510} y1={622} x2={510} y2={676} at={kvm} />
    </>
  );
};

const QEMU_DEVICES = [
  { icon: Usb, label: "USB" },
  { icon: Speaker, label: "Sound card" },
  { icon: Save, label: "Floppy drive" },
  { icon: Monitor, label: "VGA display" },
  { icon: Keyboard, label: "PS/2 keyboard" },
  { icon: HardDrive, label: "IDE disk" },
  { icon: HardDrive, label: "SCSI disk" },
  { icon: Terminal, label: "Serial port" },
  { icon: Terminal, label: "Parallel port" },
  { icon: Network, label: "e1000 network" },
  { icon: Disc3, label: "CD-ROM" },
  { icon: Cpu, label: "PCI bridge" },
  { icon: Speaker, label: "HD audio" },
  { icon: Monitor, label: "Tablet" },
  { icon: Watch, label: "Watchdog" },
  { icon: Box, label: "…and more" },
];
const FLOPPY = 2;

const DeviceGrid: React.FC<{ at: number; poke?: number; focus?: number }> = ({ at, poke, focus = 0 }) => {
  const frame = useCurrentFrame();
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 18 }}>
      {QEMU_DEVICES.map((d, i) => {
        const hot = poke === undefined ? 0 : progress(frame, poke + i * 2, 8);
        const dim = i === FLOPPY ? 1 : 1 - 0.75 * focus;
        return (
          <Appear key={d.label} at={at + i * 2}>
            <div style={{ height: 92, opacity: dim }}>
              <Block icon={d.icon} label={d.label} size={26} tone={(i === FLOPPY && focus > 0.5) || hot > 0.5 ? "danger" : "panel"} style={{ justifyContent: "flex-start" }} />
            </div>
          </Appear>
        );
      })}
    </div>
  );
};

const Qemu: SceneComponent = ({ lines }) => (
  <>
    <At x={200} y={150} w={1520}>
      <Appear at={cue(lines, "QEMU") - 4}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 26, marginBottom: 30 }}>
          <Serif text="QEMU" size={64} />
          <span style={{ fontFamily: F.sans, fontSize: 32, color: C.muted }}>pretends a whole PC</span>
        </div>
      </Appear>
      <DeviceGrid at={cue(lines, "whole")} poke={cue(lines, "poke", 1)} />
    </At>
  </>
);

const Venom: SceneComponent = ({ lines }) => {
  const frame = useCurrentFrame();
  const venom = cue(lines, "VENOM");
  const out = cue(lines, "host");
  const f = progress(frame, 0, 20);
  return (
    <>
      <At x={200} y={150} w={1520}>
        <div style={{ opacity: 1 - 0.6 * progress(frame, venom - 10, 14) }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 26, marginBottom: 30 }}>
            <Serif text="QEMU" size={64} />
            <span style={{ fontFamily: F.sans, fontSize: 32, color: C.muted }}>pretends a whole PC</span>
          </div>
          <DeviceGrid at={-100} focus={f} />
        </div>
      </At>
      <At x={560} y={330} w={800}>
        <Appear at={venom} pop>
          <div style={{ borderRadius: 28, background: C.field, border: `3px solid ${C.danger}`, padding: "36px 44px", boxShadow: "0 30px 80px rgba(0,0,0,0.5)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
              <Save size={64} color={C.danger} />
              <div>
                <div style={{ fontFamily: F.display, fontSize: 64, color: C.fg }}>VENOM</div>
                <div style={{ fontFamily: F.mono, fontSize: 26, color: C.muted }}>CVE-2015-3456 · the virtual floppy drive</div>
              </div>
            </div>
            <Appear at={out} style={{ marginTop: 26 }}>
              <Pill tone="danger" mono={false} size={30}>
                inside the VM → onto the host
              </Pill>
            </Appear>
            <Appear at={cue(lines, "floppy", 1)} style={{ marginTop: 16 }}>
              <div style={{ fontFamily: F.sans, fontSize: 28, color: C.muted }}>A device almost nobody used, there by default.</div>
            </Appear>
          </div>
        </Appear>
      </At>
    </>
  );
};

const FC_DEVICES = [
  { icon: HardDrive, label: "a disk", word: "disk" },
  { icon: Network, label: "a network card", word: "network" },
  { icon: Terminal, label: "a console", word: "console" },
];

const Fc: SceneComponent = ({ lines }) => (
  <>
    <At x={200} y={170} w={1520}>
      <Appear at={0}>
        <Serif text="*Firecracker*" size={120} />
      </Appear>
      <div style={{ display: "flex", gap: 20, marginTop: 34 }}>
        <Appear at={cue(lines, "Rust")}>
          <Pill size={30}>written in Rust</Pill>
        </Appear>
        <Appear at={cue(lines, "Lambda")}>
          <Pill size={30}>made for AWS Lambda</Pill>
        </Appear>
        <Appear at={cue(lines, "open-sourced")}>
          <Pill size={30}>open source · 2018</Pill>
        </Appear>
      </div>
    </At>
    <At x={200} y={560} w={1520}>
      <div style={{ display: "flex", gap: 22 }}>
        {FC_DEVICES.map((d) => (
          <Appear key={d.label} at={cue(lines, d.word, 1)} pop style={{ width: 360 }}>
            <div style={{ height: 110 }}>
              <Block icon={d.icon} label={d.label} tone="ok" size={30} />
            </div>
          </Appear>
        ))}
        <Appear at={cue(lines, "little else", 1)} style={{ width: 360 }}>
          <div style={{ height: 110, display: "grid", placeItems: "center", fontFamily: F.sans, fontSize: 32, color: C.muted }}>…and little else.</div>
        </Appear>
      </div>
    </At>
  </>
);

const Count: React.FC<{ at: number; to: number; unit: string; prefix?: string; label: string }> = ({ at, to, unit, prefix = "", label }) => {
  const frame = useCurrentFrame();
  const v = Math.round(to * progress(frame, at, 24));
  return (
    <Appear at={at}>
      <div style={{ fontFamily: F.display, fontSize: 150, color: C.signal, lineHeight: 1 }}>
        {prefix}
        {v}
        <span style={{ fontSize: 70, color: C.fg }}> {unit}</span>
      </div>
      <div style={{ fontFamily: F.sans, fontSize: 32, color: C.muted, marginTop: 14 }}>{label}</div>
    </Appear>
  );
};

const Micro: SceneComponent = ({ lines }) => (
  <>
    <At x={200} y={330} w={1520}>
      <Appear at={0} out={cue(lines, "125") - 8}>
        <Serif text="Less to pretend: *less to attack*," size={84} />
        <Appear at={cue(lines, "wait")} style={{ marginTop: 14 }}>
          <Serif text="and *less to wait for*." size={84} />
        </Appear>
      </Appear>
    </At>
    <At x={200} y={210} w={760}>
      <Count at={cue(lines, "125")} to={125} unit="ms" prefix="~" label="to start a machine's code" />
    </At>
    <At x={1000} y={210} w={760}>
      <Count at={cue(lines, "five")} to={5} unit="MiB" prefix="< " label="of memory overhead per machine" />
    </At>
    <At x={200} y={560} w={1500}>
      <Appear at={cue(lines, "microVM", 1)}>
        <Serif text="A *microVM*." size={96} />
      </Appear>
    </At>
    <At x={200} y={740} w={1500}>
      <Appear at={cue(lines, "125") + 20}>
        <div style={{ fontFamily: F.mono, fontSize: 22, color: C.faint }}>Firecracker's own specification (github.com/firecracker-microvm/firecracker)</div>
      </Appear>
    </At>
  </>
);

const Snapshot: SceneComponent = ({ lines }) => {
  const frame = useCurrentFrame();
  const freeze = cue(lines, "freeze");
  const back = cue(lines, "back");
  const built = lines[1].from;
  const toDisk = progress(frame, freeze + 6, 18) * (1 - progress(frame, back, 18));
  const pulse = 0.5 + 0.5 * Math.sin(frame / 5);
  const running = toDisk < 0.5;
  return (
    <>
      <div style={{ opacity: 1 - progress(frame, built - 4, 12) }}>
        <At x={mix(260, 760, toDisk)} y={mix(200, 300, toDisk)} w={mix(620, 400, toDisk)} h={mix(420, 240, toDisk)}>
          <div style={{ height: "100%", boxSizing: "border-box", borderRadius: 24, border: `4px solid ${running ? C.ok : C.signal}`, background: running ? "rgba(110,231,183,0.08)" : "rgba(255,194,197,0.08)", display: "grid", placeItems: "center" }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16, fontFamily: F.sans, fontSize: 32, color: C.fg }}>
              {running ? <Activity size={70} color={C.ok} style={{ opacity: 0.4 + 0.6 * pulse }} /> : <Save size={70} color={C.signal} />}
              {running ? "a running machine" : "its memory, on disk"}
            </div>
          </div>
        </At>
        <At x={1180} y={260} w={540}>
          <Appear at={back + 10}>
            <Pill icon={Zap} tone="signal" size={34}>
              back in milliseconds
            </Pill>
            <div style={{ fontFamily: F.sans, fontSize: 28, color: C.muted, marginTop: 20 }}>every process where it was</div>
          </Appear>
        </At>
      </div>
      <At x={200} y={330} w={1520}>
        <Appear at={built + 4}>
          <Serif text="*Spunto Sandbox* is built on it." size={96} />
        </Appear>
      </At>
    </>
  );
};

export const components: Record<string, SceneComponent> = { vmm: Vmm, qemu: Qemu, venom: Venom, fc: Fc, micro: Micro, snapshot: Snapshot };
