// Builds what is published and installed:
//   dist/sandboxd.mjs   the daemon, one file          dist/sbx.mjs      the CLI, one file
//   dist/sbx-agent      the guest agent (Go, static)  dist/client.mjs   the SDK  ·  dist/engine.mjs  the engine
//   dist/types/         declarations of the SDK and the engine
// Needs Go (1.24+) for the agent, unless SBX_AGENT_FILE points at one built already.
import { execFileSync } from "node:child_process"
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { build } from "esbuild"

const pkg = JSON.parse(readFileSync("package.json", "utf8"))
rmSync("dist", { recursive: true, force: true })
mkdirSync("dist", { recursive: true })

if (process.env.SBX_AGENT_FILE) copyFileSync(process.env.SBX_AGENT_FILE, "dist/sbx-agent")
else
  execFileSync("go", ["build", "-trimpath", "-ldflags", `-s -w -X main.version=${pkg.version}`, "-o", "../dist/sbx-agent", "."], {
    cwd: "guest",
    stdio: "inherit",
    env: { ...process.env, CGO_ENABLED: "0", GOOS: "linux", GOARCH: "amd64" },
  })
chmodSync("dist/sbx-agent", 0o755)

const common = { bundle: true, platform: "node", target: "node22", format: "esm", logLevel: "warning", define: { "process.env.SBX_BUILD_VERSION": JSON.stringify(pkg.version) } }
// One file each, to run as they are (`node dist/sandboxd.mjs`): a require shim for bundled CJS.
const shim = "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"
await build({ ...common, entryPoints: ["src/daemon/main.ts"], outfile: "dist/sandboxd.mjs", banner: { js: `#!/usr/bin/env node\n${shim}` } })
await build({ ...common, entryPoints: ["src/cli/main.ts"], outfile: "dist/sbx.mjs", banner: { js: `#!/usr/bin/env node\n${shim}` } })
await build({ ...common, entryPoints: ["src/client/index.ts"], outfile: "dist/client.mjs" })
await build({ ...common, entryPoints: ["src/engine/index.ts"], outfile: "dist/engine.mjs" })
chmodSync("dist/sandboxd.mjs", 0o755)
chmodSync("dist/sbx.mjs", 0o755)

execFileSync("npx", ["tsc", "-p", "tsconfig.build.json"], { stdio: "inherit" })
console.log(`built ${pkg.name} ${pkg.version}`)
