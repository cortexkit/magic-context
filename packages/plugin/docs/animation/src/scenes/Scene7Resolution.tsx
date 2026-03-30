import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import {
  COLORS,
  FONT_FAMILY,
  FONT_FAMILY_MONO,
  PANEL_W,
  PANEL_H,
  SCENE_7_DURATION,
} from "../constants";
import { ContextBar } from "../components/ContextBar";

// Scene 7: Resolution (1230-1350 frames, 4s)
// "Keep the plot. Lose the bloat." — Final lockup

export const Scene7Resolution: React.FC = () => {
  const frame = useCurrentFrame();
  const sceneStartFrame = 0;

  // Frame ranges
  const HOLD_START = 0;
  const DISSOLVE_START = 0;
  const LOCKUP_START = 0;

  // Clean session view hold
  const holdOpacity = interpolate(
    frame,
    [DISSOLVE_START, DISSOLVE_START + 20],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Lockup fade in
  const lockupOpacity = interpolate(
    frame,
    [LOCKUP_START, LOCKUP_START + 15],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Panel position
  const panelLeft = (1280 - PANEL_W) / 2;
  const panelTop = 100;

  return (
    <AbsoluteFill style={{ background: COLORS.bg }}>

      {/* Final lockup */}
      {frame >= LOCKUP_START && (
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            opacity: lockupOpacity,
            textAlign: "center",
          }}
        >
          <div
            style={{
              fontFamily: FONT_FAMILY_MONO,
              fontSize: 48,
              fontWeight: 700,
              color: COLORS.textPrimary,
              letterSpacing: "0.05em",
              marginBottom: 16,
            }}
          >
            magic-context
          </div>
          <div
            style={{
              width: 400,
              height: 1,
              background: COLORS.panelBorder,
              margin: "0 auto 16px",
            }}
          />
          <div
            style={{
              fontFamily: FONT_FAMILY,
              fontSize: 20,
              color: COLORS.textSecondary,
              marginBottom: 32,
            }}
          >
            Keep the plot. Lose the bloat.
          </div>
          <div
            style={{
              fontFamily: FONT_FAMILY_MONO,
              fontSize: 14,
              color: COLORS.textMuted,
              background: COLORS.panelBg,
              border: `1px solid ${COLORS.panelBorder}`,
              borderRadius: 6,
              padding: "10px 16px",
              display: "inline-block",
            }}
          >
            npm install @cortexkit/magic-context-opencode
          </div>
        </div>
      )}
    </AbsoluteFill>
  );
};
