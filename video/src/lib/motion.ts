import { Easing, interpolate } from "remotion";

// Le vocabulaire de mouvement de la vidéo — peu de courbes, réutilisées partout,
// pour que tout bouge « de la même main ».

/** Sortie franche, arrivée douce : l'entrée par défaut. */
export const EASE_OUT = Easing.bezier(0.16, 1, 0.3, 1);
/** Aller-retour symétrique : déplacements de caméra et de curseur. */
export const EASE_IN_OUT = Easing.bezier(0.65, 0, 0.35, 1);
/** Départ en douceur, sortie rapide : les éléments qui quittent l'écran. */
export const EASE_IN = Easing.bezier(0.5, 0, 0.75, 0);
/** Un ressort sans rebond, et un avec un léger dépassement. */
export const SPRING = Easing.spring({ damping: 200 });
export const SPRING_POP = Easing.spring({ damping: 12, mass: 0.6, stiffness: 180 });

const CLAMP = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/** 0 → 1 entre `from` et `from + duration` (frames), avec easing, borné. */
export const progress = (frame: number, from: number, duration: number, easing = EASE_OUT) =>
  interpolate(frame, [from, from + duration], [0, 1], { ...CLAMP, easing });

export const mix = (a: number, b: number, t: number) => a + (b - a) * t;
