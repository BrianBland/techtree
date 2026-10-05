import type { Layout } from "./layout.ts";

/** Screen transform: screen = world · k + (x, y). */
export interface View {
  x: number;
  y: number;
  k: number;
}

const MIN_SCALE = 0.05;
const MAX_SCALE = 8;

export function fitView(bounds: Layout["bounds"], width: number, height: number, padding = 40): View {
  const w = Math.max(1, bounds.maxX - bounds.minX);
  const h = Math.max(1, bounds.maxY - bounds.minY);
  const k = clamp(Math.min((width - 2 * padding) / w, (height - 2 * padding) / h, 1.5));
  return {
    k,
    x: width / 2 - ((bounds.minX + bounds.maxX) / 2) * k,
    y: height / 2 - ((bounds.minY + bounds.maxY) / 2) * k,
  };
}

/** Scale by `factor` around the screen point (px, py). */
export function zoomAt(view: View, px: number, py: number, factor: number): View {
  const k = clamp(view.k * factor);
  return { k, x: px - ((px - view.x) / view.k) * k, y: py - ((py - view.y) / view.k) * k };
}

function clamp(k: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, k));
}
