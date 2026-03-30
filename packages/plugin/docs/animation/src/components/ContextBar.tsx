import { useCurrentFrame, interpolate } from "remotion";
import { COLORS, FONT_FAMILY_MONO, PANEL_W } from "../constants";

interface ContextBarProps {
  pct: number;
  showLabel?: boolean;
  labelText?: string;
  delta?: number; // Optional delta to show (e.g., -28%)
}

export const ContextBar: React.FC<ContextBarProps> = ({
  pct,
  showLabel = false,
  labelText,
  delta,
}) => {
  const frame = useCurrentFrame();

  // Determine color based on percentage
  const fillColor = pct < 50 ? COLORS.contextGreen : pct < 70 ? COLORS.contextAmber : COLORS.contextRed;

  // Pulse effect when in warning zone (58-82%)
  const pulse = pct >= 58 && pct <= 82 ? Math.sin(frame * 0.18) * 0.35 + 0.65 : 1;

  // Delta animation
  const showDelta = delta !== undefined && delta !== 0;
  const deltaOpacity = showDelta
    ? interpolate(frame % 60, [0, 10, 40, 50], [0, 1, 1, 0], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      })
    : 0;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, width: PANEL_W }}>
      <span
        style={{
          fontFamily: FONT_FAMILY_MONO,
          fontSize: 11,
          color: COLORS.textMuted,
          whiteSpace: "nowrap",
        }}
      >
        Context
      </span>
      <div
        style={{
          flex: 1,
          height: 8,
          background: COLORS.contextTrack,
          borderRadius: 999,
          position: "relative",
          overflow: "visible",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: `${Math.min(100, Math.max(0, pct))}%`,
            background: fillColor,
            borderRadius: 999,
            opacity: pulse,
            transition: "width 0.3s ease-out",
          }}
        />
        {/* Threshold marker at 65% */}
        <div
          style={{
            position: "absolute",
            left: "65%",
            top: -4,
            bottom: -4,
            width: 1.5,
            background: "rgba(239,68,68,0.45)",
            borderRadius: 999,
          }}
        />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span
          style={{
            fontFamily: FONT_FAMILY_MONO,
            fontSize: 11,
            fontWeight: 600,
            color: fillColor,
            minWidth: 34,
            textAlign: "right",
          }}
        >
          {Math.round(pct)}%
        </span>
        {showDelta && (
          <span
            style={{
              fontFamily: FONT_FAMILY_MONO,
              fontSize: 10,
              fontWeight: 600,
              color: delta && delta < 0 ? COLORS.contextGreen : COLORS.contextRed,
              opacity: deltaOpacity,
            }}
          >
            {delta > 0 ? "+" : ""}{delta}%
          </span>
        )}
      </div>
      {showLabel && labelText && (
        <span
          style={{
            fontFamily: FONT_FAMILY_MONO,
            fontSize: 9,
            color: COLORS.textMuted,
            marginLeft: 8,
          }}
        >
          {labelText}
        </span>
      )}
    </div>
  );
};
