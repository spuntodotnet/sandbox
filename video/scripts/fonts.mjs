// The brand's three faces (Young Serif, Geist, JetBrains Mono), copied from @fontsource into public/fonts:
// a render never reaches for fonts.gstatic.com, which a worker cannot always reach.
import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("public/fonts", { recursive: true });
for (const [from, to] of [
  ["@fontsource/young-serif/files/young-serif-latin-400-normal.woff2", "young-serif.woff2"],
  ["@fontsource-variable/geist/files/geist-latin-wght-normal.woff2", "geist.woff2"],
  ["@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2", "jetbrains-mono.woff2"],
])
  copyFileSync(`node_modules/${from}`, `public/fonts/${to}`);
