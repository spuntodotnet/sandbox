// Spunto Sandbox's paint (emerald · coral), in hex: a frame cannot read the design system's CSS
// variables. From @spunto/brand-kit, `surface("sandbox", "night" | "paper")`, on 2026-11-28.
export const C = {
  field: "#012f1f",
  signal: "#ffc2c5",
  tone: "#047252",
  fg: "#ffffff",
  muted: "rgba(255,255,255,0.68)",
  faint: "rgba(255,255,255,0.4)",
  line: "rgba(255,255,255,0.14)",
  panel: "rgba(255,255,255,0.06)",
  paper: "#f8fbf9",
  ink: "#121b17",
  /** Outside the brand's pair: what fails (a crack, a leak) and what holds (a check). */
  danger: "#ff6b6b",
  ok: "#6ee7b7",
};

/** The brand's three faces. Young Serif has a single weight, drawn heavy: never bold it. */
export const F = {
  display: "'Young Serif', Georgia, serif",
  sans: "Geist, ui-sans-serif, system-ui, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, monospace",
};
