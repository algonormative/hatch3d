import { useRef, useCallback } from "react";
import { CUBE_AXIS_TIPS, CUBE_EDGES, CUBE_VERTICES, cubeAxisOpacity, cubeEdgeOpacity, projectCubePoint } from "../controls/geometry.js";

export function OrbitCube({
  theta,
  phi,
  onChangeTheta,
  onChangePhi,
  size = 120,
}: {
  theta: number;
  phi: number;
  onChangeTheta: (v: number) => void;
  onChangePhi: (v: number) => void;
  size?: number;
}) {
  const draggingRef = useRef(false);
  const startRef = useRef({ x: 0, y: 0, theta: 0, phi: 0 });

  const projected = CUBE_VERTICES.map(([x, y, z]) => projectCubePoint(x, y, z, theta, phi, size));
  const projectedAxes = CUBE_AXIS_TIPS.map(({ label, pos: [x, y, z] }) => ({
    label, ...projectCubePoint(x, y, z, theta, phi, size),
  }));

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      draggingRef.current = true;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      startRef.current = { x: e.clientX, y: e.clientY, theta, phi };
    },
    [theta, phi],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!draggingRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      const dx = e.clientX - startRef.current.x;
      const dy = e.clientY - startRef.current.y;
      onChangeTheta(startRef.current.theta + dx * 0.008);
      onChangePhi(Math.max(-1.4, Math.min(1.4, startRef.current.phi + dy * 0.008)));
    },
    [onChangeTheta, onChangePhi],
  );

  const handlePointerUp = useCallback(() => {
    draggingRef.current = false;
  }, []);

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onChangeTheta(0.6);
      onChangePhi(0.35);
    },
    [onChangeTheta, onChangePhi],
  );

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onDoubleClick={handleDoubleClick}
      style={{
        border: "1px solid var(--fg)",
        cursor: "grab",
        touchAction: "none",
        flexShrink: 0,
      }}
    >
      {CUBE_EDGES.map(([a, b], i) => {
        const avgZ = (projected[a].z + projected[b].z) / 2;
        const opacity = cubeEdgeOpacity(avgZ);
        return (
          <line
            key={i}
            x1={projected[a].x}
            y1={projected[a].y}
            x2={projected[b].x}
            y2={projected[b].y}
            stroke="var(--fg)"
            strokeWidth={1}
            opacity={opacity}
          />
        );
      })}
      {projectedAxes.map((ax) => (
        <text
          key={ax.label}
          x={ax.x}
          y={ax.y}
          fill="var(--fg)"
          fontSize={9}
          fontFamily="inherit"
          fontWeight={600}
          textAnchor="middle"
          dominantBaseline="central"
          opacity={cubeAxisOpacity(ax.z)}
          style={{ pointerEvents: "none" }}
        >
          {ax.label}
        </text>
      ))}
    </svg>
  );
}
