import { useState, useEffect, useCallback } from "react";
import { btnStyle, tagStyle } from "./styles";
import { PNG_SCALE_OPTIONS, DEFAULT_PNG_SCALE } from "../utils/export-png";

export interface ExportModalProps {
  open: boolean;
  onClose: () => void;
  onExportSVG: () => void;
  onExportPNG: (theme: "light" | "dark", scale: number) => void;
  currentTheme: "auto" | "light" | "dark";
}

function resolveTheme(theme: "auto" | "light" | "dark"): "light" | "dark" {
  if (theme !== "auto") return theme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

const STORAGE_KEY = "hatch3d-png-scale";

function loadScale(): number {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v) {
      const n = Number(v);
      if (PNG_SCALE_OPTIONS.some((o) => o.value === n)) return n;
    }
  } catch { /* ignore */ }
  return DEFAULT_PNG_SCALE;
}

export function ExportModal({ open, onClose, onExportSVG, onExportPNG, currentTheme }: ExportModalProps) {
  const [pngScale, setPngScale] = useState(loadScale);
  const [pngTheme, setPngTheme] = useState<"light" | "dark">(resolveTheme(currentTheme));

  // Sync default PNG theme when app theme changes
  useEffect(() => {
    setPngTheme(resolveTheme(currentTheme));
  }, [currentTheme]);

  // Persist scale preference
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, String(pngScale));
  }, [pngScale]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  const handleExportPNG = useCallback(() => {
    onExportPNG(pngTheme, pngScale);
    onClose();
  }, [onExportPNG, pngTheme, pngScale, onClose]);

  const handleExportSVG = useCallback(() => {
    onExportSVG();
    onClose();
  }, [onExportSVG, onClose]);

  if (!open) return null;

  const resolved = resolveTheme(currentTheme);

  const labelStyle: React.CSSProperties = {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: "0.08em",
    color: "var(--fg-dim)",
    marginBottom: 6,
  };

  const sectionStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: 4,
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.4)",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          padding: "24px 28px",
          minWidth: 320,
          maxWidth: 400,
          fontFamily: "inherit",
          color: "var(--fg)",
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.08em" }}>EXPORT</span>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              color: "var(--fg-dim)",
              cursor: "pointer",
              fontSize: 16,
              fontFamily: "inherit",
              padding: "2px 6px",
            }}
          >
            &times;
          </button>
        </div>

        {/* SVG section */}
        <div style={{ ...sectionStyle, marginBottom: 20 }}>
          <div style={labelStyle}>SVG</div>
          <button
            onClick={handleExportSVG}
            style={{ ...btnStyle, width: "100%", background: "var(--fg)", color: "var(--bg-canvas)" }}
          >
            EXPORT SVG
          </button>
        </div>

        {/* PNG section */}
        <div style={sectionStyle}>
          <div style={labelStyle}>PNG</div>

          {/* Theme */}
          <div style={{ fontSize: 10, color: "var(--fg-muted)", marginBottom: 2 }}>Theme</div>
          <div style={{ display: "flex", gap: 3, marginBottom: 10 }}>
            {(["light", "dark"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setPngTheme(t)}
                style={{
                  ...tagStyle,
                  background: pngTheme === t ? "var(--fg)" : "transparent",
                  color: pngTheme === t ? "var(--bg-canvas)" : "var(--fg)",
                }}
              >
                {t === "light" ? "Light" : "Dark"}
                {t === resolved && " (current)"}
              </button>
            ))}
          </div>

          {/* Resolution */}
          <div style={{ fontSize: 10, color: "var(--fg-muted)", marginBottom: 2 }}>Resolution</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginBottom: 14 }}>
            {PNG_SCALE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setPngScale(opt.value)}
                style={{
                  ...tagStyle,
                  background: pngScale === opt.value ? "var(--fg)" : "transparent",
                  color: pngScale === opt.value ? "var(--bg-canvas)" : "var(--fg)",
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <button
            onClick={handleExportPNG}
            style={{ ...btnStyle, width: "100%", background: "var(--fg)", color: "var(--bg-canvas)" }}
          >
            EXPORT PNG
          </button>
        </div>

      </div>
    </div>
  );
}
