import type { ReactNode } from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { C } from "../lib/theme";

// The night field every scene sits on: the product's deep emerald, a dot grid drifting up, and a
// glow that wanders with the frame (never a CSS animation: a render photographs frames).
export const Stage: React.FC<{ children: ReactNode }> = ({ children }) => {
  const frame = useCurrentFrame();
  const drift = Math.sin(frame / 60) * 70;
  return (
    <AbsoluteFill style={{ background: C.field, overflow: "hidden" }}>
      <AbsoluteFill
        style={{
          backgroundImage: "radial-gradient(rgba(255,255,255,0.09) 1.5px, transparent 1.5px)",
          backgroundSize: "36px 36px",
          backgroundPosition: `0px ${-frame * 0.3}px`,
        }}
      />
      <AbsoluteFill
        style={{
          background: `radial-gradient(1000px 700px at ${1450 + drift}px ${220 - drift / 2}px, rgba(4,114,82,0.55), transparent 70%),
            radial-gradient(800px 600px at ${300 - drift}px ${950 + drift / 3}px, rgba(255,194,197,0.10), transparent 70%)`,
        }}
      />
      {children}
    </AbsoluteFill>
  );
};
