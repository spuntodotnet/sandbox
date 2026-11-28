import type { ChapterMeta, SceneComponent } from "./components/Chapter";
import type { SceneTiming } from "./lib/timeline";
import * as boxes from "./boxes";
import * as firecracker from "./firecracker";
import * as kernel from "./kernel";
import * as risks from "./risks";
import * as walls from "./walls";

export type ChapterModule = { meta: ChapterMeta; timeline: { scenes: SceneTiming[]; total: number }; components: Record<string, SceneComponent> };

/** In order: the composition of chapter n is `<n>-<id>`. */
export const CHAPTERS: [string, ChapterModule][] = [
  ["kernel", kernel],
  ["boxes", boxes],
  ["firecracker", firecracker],
  ["walls", walls],
  ["risks", risks],
];
