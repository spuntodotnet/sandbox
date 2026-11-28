// Contact sheet of a composition: stills at given frames (or N evenly spread), for checking a
// chapter without watching it. node scripts/stills.mjs <composition> [frames…|--every N] → out/<comp>-<frame>.png
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";
import { mkdirSync } from "node:fs";

const [id, ...rest] = process.argv.slice(2);
const serveUrl = await bundle({ entryPoint: "src/index.ts" });
const composition = await selectComposition({ serveUrl, id });
let frames = rest.filter((x) => /^\d+$/.test(x)).map(Number);
const every = rest.indexOf("--every");
if (every >= 0) {
  const n = Number(rest[every + 1]);
  frames = Array.from({ length: n }, (_, i) => Math.round(((i + 0.5) * composition.durationInFrames) / n));
}
mkdirSync("out", { recursive: true });
for (const frame of frames) {
  const output = `out/${id}-${String(frame).padStart(5, "0")}.png`;
  await renderStill({ serveUrl, composition, frame, output, scale: 0.4 });
  console.log(output);
}
