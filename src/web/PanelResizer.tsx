import { useState } from "preact/hooks";

export const INBOX_WIDTH = { key: "techtree.panelWidth", width: 440 };
export const OUTBOX_WIDTH = { key: "techtree.outboxWidth", width: 380 };
const MIN_WIDTH = 320;
const MAX_SHARE = 0.75;

function clamp(width: number): number {
  const max = Math.max(MIN_WIDTH, (globalThis.innerWidth ?? Infinity) * MAX_SHARE);
  return Math.round(Math.min(max, Math.max(MIN_WIDTH, width)));
}

/** A side panel's width, restored from and saved to localStorage under `key` (DESIGN "Panel width"). */
export function usePanelWidth({ key, width: fallback }: { key: string; width: number }): [number, (width: number | null) => void] {
  const [width, setWidth] = useState(() => {
    const saved = Number(globalThis.localStorage?.getItem(key));
    return saved ? clamp(saved) : fallback;
  });
  const update = (next: number | null) => {
    if (next === null) {
      globalThis.localStorage?.removeItem(key);
      setWidth(fallback);
    } else {
      const clamped = clamp(next);
      globalThis.localStorage?.setItem(key, String(clamped));
      setWidth(clamped);
    }
  };
  return [width, update];
}

export interface PanelResizerProps {
  /** Which of its panel's edges the handle sits on. */
  edge: "left" | "right";
  label: string;
  width: number;
  /** A new width, or null to reset to the default. */
  onResize(width: number | null): void;
  onResizeEnd(): void;
}

/** Drag handle on a panel's edge: dragging away from the panel widens it, double-click resets it. */
export function PanelResizer({ edge, label, width, onResize, onResizeEnd }: PanelResizerProps) {
  const [drag, setDrag] = useState<{ x: number; width: number } | null>(null);
  const outward = edge === "left" ? -1 : 1;
  return (
    <div
      class="panel-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      title="Drag to resize; double-click to reset"
      onPointerDown={(e) => {
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        setDrag({ x: e.clientX, width });
      }}
      onPointerMove={(e) => drag && onResize(drag.width + outward * (e.clientX - drag.x))}
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
