import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import {
  COLORS,
  FONT_FAMILY,
  PANEL_W,
  PANEL_H,
  SCENE_5_DURATION,
  MEMORY_ITEMS,
  INTRO_DURATION,
} from "../constants";
import { SkeletonMessage } from "../components/SkeletonMessage";
import { ContextBar } from "../components/ContextBar";
import { SceneCaption } from "../components/SceneCaption";
import { MemoryBlock } from "../components/MemoryBlock";

// Scene 5: Cross-Session Memory (870-1110 frames, 8s)
// "New sessions start with memory."

export const Scene5Memory: React.FC = () => {
  const globalFrame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const frame = globalFrame - INTRO_DURATION;

  // UI fade in
  const uiOpacity = interpolate(
    frame,
    [0, 15],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Frame ranges
  const SESSION_CLOSE_START = 20;
  const SESSION_CLOSE_END = 60;
  const SESSION_OPEN_START = 90;
  const SESSION_OPEN_END = 130;
  const MEMORY_ENTER = 140;
  const MESSAGE_ENTER = 280;

  // Session close animation
  const closeProgress = interpolate(
    frame,
    [SESSION_CLOSE_START, SESSION_CLOSE_END],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Session open animation
  const openProgress = interpolate(
    frame,
    [SESSION_OPEN_START, SESSION_OPEN_END],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const panelOpacity = 1 - closeProgress * 0.9 + openProgress * 0.9;
  const panelScale = 1 - closeProgress * 0.05 + openProgress * 0.05;

  // "Session ended" label
  const sessionEndedOpacity = interpolate(
    frame,
    [SESSION_CLOSE_END - 10, SESSION_CLOSE_END, SESSION_CLOSE_END + 3, SESSION_OPEN_START - 5],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // "New session" label
  const newSessionOpacity = interpolate(
    frame,
    [SESSION_OPEN_END - 10, SESSION_OPEN_END],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Context bar at healthy 12%
  const contextPct = 12;

  // Panel position
  const panelLeft = (1280 - PANEL_W) / 2;
  const panelTop = 100;

  return (
    <AbsoluteFill style={{ background: COLORS.bg }}>
      {/* Scene caption (Title Card) */}
      <SceneCaption 
        text="New sessions start with memory." 
        subtitle="Important facts and memories are injected to all sessions for the project."
        frame={globalFrame} 
      />

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
          opacity: uiOpacity,
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
          Cross-Session Memory
        </div>
      </div>

      {/* Session ended label */}
      <div
        style={{
          position: "absolute",
          top: panelTop + PANEL_H / 2,
          left: "50%",
          transform: "translate(-50%, -50%)",
          opacity: sessionEndedOpacity * uiOpacity,
        }}
      >
        <span
          style={{
            fontFamily: FONT_FAMILY,
            fontSize: 14,
            color: COLORS.textMuted,
            letterSpacing: "0.1em",
          }}
        >
          Session ended
        </span>
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
          opacity: panelOpacity * uiOpacity,
          transform: `scale(${panelScale})`,
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
            {frame >= SESSION_OPEN_END ? "new session" : "active session"}
          </span>
        </div>

        {/* Message area */}
        <div style={{ padding: "18px 20px", overflow: "hidden" }}>
          {/* Memory block */}
          {frame >= MEMORY_ENTER && (
            <MemoryBlock items={MEMORY_ITEMS} enterFrame={MEMORY_ENTER} />
          )}

          {/* First message referencing memory */}
          {frame >= MESSAGE_ENTER && (
            <div style={{ marginTop: 20 }}>
              <SkeletonMessage
                widthPercent={85}
                role="assistant"
                enterFrame={MESSAGE_ENTER}
                tag={1}
              />
              <div
                style={{
                  marginTop: 8,
                  marginLeft: 20,
                  fontFamily: FONT_FAMILY,
                  fontSize: 12,
                  color: COLORS.textSecondary,
                  lineHeight: 1.5,
                }}
              >
                "Continuing with the JWT auth setup we established..."
              </div>
            </div>
          )}
        </div>
      </div>
    </AbsoluteFill>
  );
};
