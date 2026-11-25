import Link from 'next/link';

/*
 * The home page, for now. Spunto Sandbox's home is an edition of Spunto's brand kit
 * (`@spunto/brand-kit`, `src/home/editions/sandbox.json`): once that edition is published on npm,
 * this file becomes `<ProductHome product="sandbox" />` and nothing else.
 */

const terminal = [
  { cmd: 'sbx run ubuntu:24.04 --name hello', out: 'hello running (small, 2.5 s)' },
  { cmd: 'sbx exec hello -- python3 -m http.server 3000 &', out: '' },
  { cmd: 'sbx pause hello', out: 'hello paused in 819 ms — memory kept' },
  { cmd: 'sbx resume hello', out: 'hello running in 336 ms' },
  { cmd: 'sbx fork hello --name hello-2', out: 'hello-2 running (hello paused 63 ms)' },
];

const sdk = `import { Sandbox } from "@spunto/sandbox"

const box = await Sandbox.create({ image: "node:24" })
const { stdout } = await box.exec("node -v")

await box.pause()   // RAM kept, nothing runs
await box.resume()  // same processes, at once
const copy = await box.fork() // same memory`;

const numbers = [
  { value: '2.5 s', label: 'a new microVM from a cached image' },
  { value: '336 ms', label: 'a resume, processes and all, agent answering' },
  { value: '63 ms', label: 'how long a fork pauses its source' },
  { value: '55–77 ms', label: 'a resume on bare metal, daemon side' },
];

const features = [
  { title: 'Any OCI image', body: 'ubuntu, node, python, your own: pulled and unpacked inside a throwaway microVM. The host never untars an image.' },
  { title: 'A pause keeps the memory', body: 'Only the pages a box dirtied are written. A resume loads them back on demand: servers, shells and builds pick up where they were.' },
  { title: 'Fork a running VM', body: 'Memory and disks copied on write: a 1.5 GB box costs 14 MB more. The copy runs the same processes under its own identity.' },
  { title: 'Jailed, one by one', body: "Each VMM under Firecracker's jailer: its own chroot and uid, no capability. A network namespace per box, out to the internet only." },
  { title: 'Fair on a shared machine', body: 'An equal CPU weight and a quota per box, a network ceiling and equal shares when the uplink is full, memory admission before every start.' },
  { title: 'Our kernel, reproducible', body: 'Linux 6.18 with what Docker needs, built bit for bit the same by CI and pinned by sha256. Docker runs inside a box.' },
];

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col">
      <section className="mx-auto w-full max-w-6xl px-6 pt-20 pb-16 md:pt-28">
        <p className="mb-5 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs text-fd-muted-foreground">
          <span className="size-1.5 rounded-full bg-fd-primary" /> Open source · Apache-2.0 · the engine behind Spunto Cloud
        </p>
        <h1 className="max-w-4xl text-4xl font-semibold tracking-tight md:text-6xl">
          Firecracker microVMs on your own machine. <span className="text-fd-primary">A pause keeps the memory.</span>
        </h1>
        <p className="mt-6 max-w-2xl text-lg text-fd-muted-foreground">
          Give your agents sandboxes you host: an OCI image in, a microVM in seconds. Pause one and every process waits in its RAM; resume it in milliseconds; fork a running one into two.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <code className="rounded-lg border bg-fd-card px-4 py-3 font-mono text-sm">curl -fsSL https://sandbox.spunto.net/install.sh | sudo sh</code>
          <Link href="/docs/quickstart" className="rounded-lg bg-fd-primary px-5 py-3 text-sm font-medium text-fd-primary-foreground">
            Quickstart
          </Link>
          <Link href="/docs" className="rounded-lg border px-5 py-3 text-sm font-medium">
            Read the docs
          </Link>
        </div>
      </section>

      <section className="mx-auto grid w-full max-w-6xl gap-6 px-6 pb-20 lg:grid-cols-2">
        <div className="overflow-hidden rounded-xl border bg-neutral-950 text-neutral-100 shadow-sm">
          <div className="flex gap-1.5 border-b border-white/10 px-4 py-3">
            <span className="size-2.5 rounded-full bg-white/20" />
            <span className="size-2.5 rounded-full bg-white/20" />
            <span className="size-2.5 rounded-full bg-white/20" />
          </div>
          <pre className="overflow-x-auto p-5 font-mono text-[13px] leading-6">
            {terminal.map((l) => (
              <div key={l.cmd}>
                <span className="text-teal-300">$ </span>
                {l.cmd}
                {l.out && <div className="text-neutral-400">{l.out}</div>}
              </div>
            ))}
          </pre>
        </div>
        <div className="overflow-hidden rounded-xl border bg-fd-card shadow-sm">
          <div className="border-b px-4 py-3 font-mono text-xs text-fd-muted-foreground">agent.ts</div>
          <pre className="overflow-x-auto p-5 font-mono text-[13px] leading-6">{sdk}</pre>
        </div>
      </section>

      <section className="border-y bg-fd-card/50">
        <div className="mx-auto grid w-full max-w-6xl grid-cols-2 gap-px px-6 py-12 md:grid-cols-4">
          {numbers.map((n) => (
            <div key={n.label} className="p-4">
              <div className="text-3xl font-semibold tracking-tight text-fd-primary">{n.value}</div>
              <div className="mt-1 text-sm text-fd-muted-foreground">{n.label}</div>
            </div>
          ))}
        </div>
        <p className="mx-auto max-w-6xl px-10 pb-8 text-xs text-fd-muted-foreground">
          Measured on a GCP n2-standard-8 with nested virtualization, and on a bare-metal server for the last one. <Link className="underline" href="/docs/benchmarks">How</Link>.
        </p>
      </section>

      <section className="mx-auto w-full max-w-6xl px-6 py-20">
        <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">A real VM, as cheap to keep as a stopped container</h2>
        <div className="mt-10 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {features.map((f) => (
            <div key={f.title} className="rounded-xl border p-6">
              <h3 className="font-medium">{f.title}</h3>
              <p className="mt-2 text-sm text-fd-muted-foreground">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto grid w-full max-w-6xl gap-6 px-6 pb-24 md:grid-cols-2">
        <div className="rounded-xl border p-8">
          <h3 className="text-lg font-medium">What it needs</h3>
          <ul className="mt-4 space-y-2 text-sm text-fd-muted-foreground">
            <li>Linux x86_64 with KVM — bare metal, or a cloud VM with nested virtualization</li>
            <li>systemd and cgroup v2</li>
            <li>ZFS: a pool of yours, or one in a file to try it (<code>--create-pool 100G</code>)</li>
            <li>Not macOS, not ARM — not yet</li>
          </ul>
        </div>
        <div className="rounded-xl border bg-fd-primary/5 p-8">
          <h3 className="text-lg font-medium">Don&apos;t want to run machines?</h3>
          <p className="mt-4 text-sm text-fd-muted-foreground">Spunto Cloud runs this engine for you: the same microVMs, by the minute, a pause that stops the meter.</p>
          <a href="https://spunto.net" className="mt-6 inline-block text-sm font-medium text-fd-primary">
            spunto.net →
          </a>
        </div>
      </section>
    </main>
  );
}
