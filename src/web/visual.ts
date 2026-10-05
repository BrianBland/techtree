import type { Task, TaskPhase } from "../types.ts";

export const NO_SCORE = "#d4d4d4";
const HUE = 217;
const LIGHTEST = 92;
const DARKEST = 32;
const PHASES: TaskPhase[] = ["plan", "explore", "edit", "test", "pr"];

/** Maps 0..maxValue onto minOut..maxOut proportionally to √value. */
export function sqrtScale(maxValue: number, minOut: number, maxOut: number): (value: number) => number {
  const top = Math.sqrt(maxValue) || 1;
  return (value) => minOut + (maxOut - minOut) * (Math.sqrt(Math.max(0, value)) / top);
}

/** Single-hue fill normalised to the range of `values`; higher scores are darker. */
export function ramp(values: (number | null)[]): (value: number | null) => string {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v === null) continue;
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  const span = max - min;
  return (value) => {
    if (value === null) return NO_SCORE;
    const t = span > 0 ? Math.min(1, Math.max(0, (value - min) / span)) : 0.5;
    return `hsl(${HUE} 70% ${Math.round(LIGHTEST - (LIGHTEST - DARKEST) * t)}%)`;
  };
}

/** Checklist completion, or the phase's position when there is no checklist yet. */
export function taskCompletion(task: Task): number {
  if (task.checklist.length) return task.checklist.filter((item) => item.done).length / task.checklist.length;
  return PHASES.indexOf(task.phase) / PHASES.length;
}

/** Research bar stops as fractions of the 0..100 score axis. */
export function researchBar(task: Task): { solid: number; progress: number; planned: number } {
  const solid = task.plannedFrom / 100;
  const planned = Math.max(task.plannedFrom, task.plannedTo) / 100;
  return { solid, progress: round(solid + (planned - solid) * taskCompletion(task)), planned };
}

function round(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}
