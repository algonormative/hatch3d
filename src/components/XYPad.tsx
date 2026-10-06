import { useRef, useCallback } from "react";
import { denormalizeXY, normalizeXY } from "../controls/geometry.js";

export function XYPad({
  valueX,
  valueY,
  onChangeX,
  onChangeY,
  min = -3,
  max = 3,
  size = 120,
}: {
  valueX: number;
  valueY: number;
  onChangeX: (v: number) => void;
  onChangeY: (v: number) => void;
  min?: number;
  max?: number;
  size?: number;
}) {
  const padRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const { x: normX, y: normY } = normalizeXY(valueX, valueY, min, max, min, max);

  const updateFromEvent = useCallback(
    (clientX: number, clientY: number) => {
      const el = padRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const next = denormalizeXY((clientX - rect.left) / rect.width, (clientY - rect.top) / rect.height, min, max, min, max);
      onChangeX(+next.x.toFixed(2));
      onChangeY(+next.y.toFixed(2));
    },
    [min, max, onChangeX, onChangeY],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      draggingRef.current = true;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      updateFromEvent(e.clientX, e.clientY);
    },
    [updateFromEvent],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!draggingRef.current) return;
      e.preventDefault();
      updateFromEvent(e.clientX, e.clientY);
    },
    [updateFromEvent],
  );

  const handlePointerUp = useCallback(() => {
    draggingRef.current = false;
  }, []);

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onChangeX(0);
      onChangeY(0);
    },
    [onChangeX, onChangeY],
  );

  return (
    <div
      ref={padRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onDoubleClick={handleDoubleClick}
      style={{
        width: size,
        height: size,
        border: "1px solid var(--fg)",
        position: "relative",
        cursor: "crosshair",
        touchAction: "none",
        flexShrink: 0,
      }}
    >
      {/* Crosshair lines */}
      <div
        style={{
          position: "absolute",
          left: `${normX * 100}%`,
          top: 0,
          bottom: 0,
          width: 1,
          background: "var(--border-light)",
          pointerEvents: "none",
        }}
      />
      <div
        style={{
          position: "absolute",
          top: `${normY * 100}%`,
          left: 0,
          right: 0,
          height: 1,
          background: "var(--border-light)",
          pointerEvents: "none",
        }}
      />
      {/* Center crosshair (origin) */}
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: 0,
          bottom: 0,
          width: 1,
          background: "var(--border-light)",
          opacity: 0.3,
          pointerEvents: "none",
        }}
      />
      <div
        style={{
          position: "absolute",
          top: "50%",
          left: 0,
          right: 0,
          height: 1,
          background: "var(--border-light)",
          opacity: 0.3,
          pointerEvents: "none",
        }}
      />
      {/* Position dot */}
      <div
        style={{
          position: "absolute",
          left: `${normX * 100}%`,
          top: `${normY * 100}%`,
          width: 8,
          height: 8,
          borderRadius: 4,
          background: "var(--fg)",
          transform: "translate(-50%, -50%)",
          pointerEvents: "none",
        }}
      />
    </div>
  );
}
