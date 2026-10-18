import type { Phase } from "@atlastodo/shared";
import { Coffee, Timer, type LucideIcon } from "./icons";

/** Phase presentation the focus bar and the focus screen must agree on, kept out of both so neither imports the other. */

export const PHASE_KEY: Record<Phase, string> = {
  work: "focus.phaseWork",
  short_break: "focus.phaseShortBreak",
  long_break: "focus.phaseLongBreak",
};

export const PHASE_START_KEY: Record<Phase, string> = {
  work: "focus.start",
  short_break: "focus.startShortBreak",
  long_break: "focus.startLongBreak",
};

export const PHASE_ICON: Record<Phase, LucideIcon> = {
  work: Timer,
  short_break: Coffee,
  long_break: Coffee,
};

/** Emerald-600, the colour both breaks are drawn in. A literal hex because the ring's SVG `stroke` cannot resolve Tailwind classes or `var(--accent-*)`. */
const BREAK_HEX = "#059669";

export function phaseHex(phase: Phase, accentHex: string): string {
  return phase === "work" ? accentHex : BREAK_HEX;
}
