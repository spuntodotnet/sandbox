import { loadFont } from "@remotion/fonts";
import { staticFile } from "remotion";

// Served from public/fonts (scripts/fonts.mjs): loadFont() holds the render until they are ready,
// so no frame goes out in a fallback face. Called from Root.tsx.
export const loadBrandFonts = () =>
  Promise.all([
    loadFont({ family: "Young Serif", url: staticFile("fonts/young-serif.woff2") }),
    loadFont({ family: "Geist", url: staticFile("fonts/geist.woff2"), weight: "100 900" }),
    loadFont({ family: "JetBrains Mono", url: staticFile("fonts/jetbrains-mono.woff2"), weight: "100 800" }),
  ]);
