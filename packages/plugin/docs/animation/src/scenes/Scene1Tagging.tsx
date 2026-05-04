import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import {
  COLORS,
  FONT_FAMILY,
  PANEL_W,
  PANEL_H,
  SCENE_1_DURATION,
  MESSAGE_STAGGER,
  SKELETON_MESSAGES,
  INTRO_DURATION,
} from "../constants";
import { SkeletonMessage } from "../components/SkeletonMessage";
import { ContextBar } from "../components/ContextBar";
import { SceneCaption } from "../components/SceneCaption";

// Scene 1: Tagging (90-210 frames, 4s)
// "Tag everything." — Messages appear with §N§ tags

export const Scene1Tagging: React.FC = () => {
  const globalFrame = useCurrentFrame();
  const frame = globalFrame - INTRO_DURATION; // internal UI frame

  // Calculate visible messages based on stagger
  const numVisible = SKELETON_MESSAGES.filter(
    (_, i) => frame >= i * MESSAGE_STAGGER
  ).length;

  // Context bar climbs 0% → 45%
  const contextPct = interpolate(
    numVisible,
    [0, SKELETON_MESSAGES.length],
    [0, 45],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Panel fade in
  const panelOpacity = interpolate(
    frame,
    [0, 15],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Panel position
  const panelLeft = (1280 - PANEL_W) / 2;
  const panelTop = 100;

  return (
    <AbsoluteFill style={{ background: COLORS.bg }}>
        {/* Title */}
        <div
          style={{
            position: "absolute",
            top: 30,
            left: 0,
            right: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 4,
            opacity: panelOpacity, // Fade in with the panel
          }}
        >
        <div
          style={{
            fontFamily: FONT_FAMILY,
            fontSize: 11,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            color: COLORS.textMuted,
            fontWeight: 600,
          }}
        >
          magic-context
        </div>
        <div
          style={{
            fontFamily: FONT_FAMILY,
            fontSize: 20,
            fontWeight: 700,
            color: COLORS.textPrimary,
          }}
        >
          Context Tagging
        </div>
      </div>

      {/* Main panel */}
      <div
        style={{
          position: "absolute",
          left: panelLeft,
          top: panelTop,
          width: PANEL_W,
          height: PANEL_H,
          background: COLORS.panelBg,
          border: `1.5px solid ${COLORS.panelBorder}`,
          borderRadius: 16,
          boxShadow: "0 2px 20px rgba(0,0,0,0.3)",
          overflow: "hidden",
          opacity: panelOpacity,
        }}
      >
        {/* Chrome bar */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            padding: "9px 12px",
            borderBottom: `1px solid ${COLORS.panelBorder}`,
            background: "#0f172a",
          }}
        >
          {["#ff5f57", "#ffbd2e", "#28c840"].map((c) => (
            <div key={c} style={{ width: 9, height: 9, borderRadius: "50%", background: c }} />
          ))}
          <span
            style={{
              fontFamily: FONT_FAMILY,
              fontSize: 10,
              color: COLORS.textMuted,
              marginLeft: 6,
            }}
          >
            active session
          </span>
        </div>

        {/* Message area */}
        <div style={{ padding: "18px 20px", overflow: "hidden" }}>
          {SKELETON_MESSAGES.slice(0, numVisible).map((msg, i) => (
            <SkeletonMessage
              key={msg.id}
              widthPercent={msg.barWidth}
              role={msg.role}
              enterFrame={i * MESSAGE_STAGGER}
              tag={msg.tag}
              isLarge={msg.isLarge}
              label={msg.label}
            />
          ))}
        </div>
      </div>

      {/* Context bar */}
      <div
        style={{
          position: "absolute",
          bottom: 42,
          left: "50%",
          transform: "translateX(-50%)",
          opacity: panelOpacity, // Fade in with the panel
        }}
      >
        <ContextBar
          pct={contextPct}
          showLabel={frame > 80}
          labelText="Cache-aware · mutations queue until free"
        />
      </div>

      {/* Scene caption (Title Card) */}
      <SceneCaption
        text="System tags all messages."
        frame={globalFrame}
      />
    </AbsoluteFill>
  );
};
