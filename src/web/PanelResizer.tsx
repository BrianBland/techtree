import { useState } from "preact/hooks";

const STORAGE_KEY = "techtree.panelWidth";
export const DEFAULT_PANEL_WIDTH = 440;
const MIN_WIDTH = 320;
const MAX_SHARE = 0.75;

function clamp(width: number): number {
  const max = Math.max(MIN_WIDTH, (globalThis.innerWidth ?? Infinity) * MAX_SHARE);
  return Math.round(Math.min(max, Math.max(MIN_WIDTH, width)));
}

/** The right panel's width, restored from and saved to localStorage (DESIGN "Panel width"). */
export function usePanelWidth(): [number, (width: number | null) => void] {
  const [width, setWidth] = useState(() => {
    const saved = Number(globalThis.localStorage?.getItem(STORAGE_KEY));
    return saved ? clamp(saved) : DEFAULT_PANEL_WIDTH;
  });
  const update = (next: number | null) => {
    if (next === null) {
      globalThis.localStorage?.removeItem(STORAGE_KEY);
      setWidth(DEFAULT_PANEL_WIDTH);
    } else {
      const clamped = clamp(next);
      globalThis.localStorage?.setItem(STORAGE_KEY, String(clamped));
      setWidth(clamped);
    }
  };
  return [width, update];
}

export interface PanelResizerProps {
  width: number;
  /** A new width, or null to reset to the default. */
  onResize(width: number | null): void;
  onResizeEnd(): void;
}

/** Drag handle on the panel's left edge: dragging left widens the panel, double-click resets it. */
export function PanelResizer({ width, onResize, onResizeEnd }: PanelResizerProps) {
  const [drag, setDrag] = useState<{ x: number; width: number } | null>(null);
  return (
    <div
      class="panel-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={width}
      title="Drag to resize; double-click to reset"
      onPointerDown={(e) => {
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        setDrag({ x: e.clientX, width });
      }}
      onPointerMove={(e) => drag && onResize(drag.width + drag.x - e.clientX)}
      onPointerUp={() => {
        if (!drag) return;
        setDrag(null);
        onResizeEnd();
      }}
      onDblClick={() => {
        onResize(null);
        onResizeEnd();
      }}
    />
  );
}
