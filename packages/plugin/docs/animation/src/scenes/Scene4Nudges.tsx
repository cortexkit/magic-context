import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import {
  COLORS,
  FONT_FAMILY,
  FONT_FAMILY_MONO,
  PANEL_W,
  PANEL_H,
  SCENE_4_DURATION,
  INTRO_DURATION,
} from "../constants";
import { SkeletonMessage } from "../components/SkeletonMessage";
import { ContextBar } from "../components/ContextBar";
import { SceneCaption } from "../components/SceneCaption";
import { NudgeBanner } from "../components/NudgeBanner";
import { CommandChip } from "../components/CommandChip";

// Scene 4: Nudge Escalation (690-870 frames, 6s)
// "Progressive pressure, not surprise failures."

export const Scene4Nudges: React.FC = () => {
  const globalFrame = useCurrentFrame();
  const frame = globalFrame - INTRO_DURATION;

  // UI fade in
  const uiOpacity = interpolate(
    frame,
    [0, 15],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Frame ranges
  const MSG1_ENTER = 20;
  const MSG2_ENTER = 50;
  const MSG3_ENTER = 80;
  const INJECT_START = 120;

  // Injection animation
  const injectProgress = interpolate(
    frame,
    [INJECT_START, INJECT_START + 20],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Panel position
  const panelLeft = (1280 - PANEL_W) / 2;
  const panelTop = 100;

  return (
    <AbsoluteFill style={{ background: COLORS.bg }}>
      {/* Scene caption (Title Card) */}
      <SceneCaption
        text="Agent gets reminders about previously taken notes and nudges to drop unnecessary context."
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
          Nudge System
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
          opacity: uiOpacity,
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
        <div style={{ padding: "18px 20px", overflow: "hidden", display: "flex", flexDirection: "column", gap: 12 }}>
          {frame >= MSG1_ENTER && (
            <SkeletonMessage widthPercent={62} role="user" enterFrame={MSG1_ENTER} tag={1} />
          )}
          {frame >= MSG2_ENTER && (
            <SkeletonMessage widthPercent={88} role="assistant" enterFrame={MSG2_ENTER} tag={2} />
          )}

          {/* Third message (grows to show system injection) */}
          {frame >= MSG3_ENTER && (
            <div style={{
              alignSelf: "flex-end",
              width: "75%",
              background: COLORS.userBar,
              borderRadius: 8,
              padding: "12px",
              display: "flex",
              flexDirection: "column",
              gap: 8,
              opacity: interpolate(frame, [MSG3_ENTER, MSG3_ENTER + 10], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
              transform: `translateY(${interpolate(frame, [MSG3_ENTER, MSG3_ENTER + 10], [10, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })}px)`,
            }}>
              {/* Original user message bar */}
              <div style={{ width: "80%", height: 16, background: "rgba(255,255,255,0.2)", borderRadius: 4 }} />

              {/* System Injection Expandable Area */}
              {frame >= INJECT_START && (
                <div style={{
                  background: "rgba(0,0,0,0.3)",
                  borderRadius: 6,
                  borderLeft: `3px solid ${COLORS.contextAmber}`,
                  padding: "8px 12px",
                  marginTop: 4,
                  overflow: "hidden",
                  height: interpolate(injectProgress, [0, 1], [0, 60]),
                  opacity: injectProgress,
                }}>
                  <div style={{ fontFamily: FONT_FAMILY_MONO, fontSize: 10, color: COLORS.contextAmber, marginBottom: 6, fontWeight: 600 }}>
                    [SYSTEM REMINDER]
                  </div>
                  <div style={{ fontFamily: FONT_FAMILY, fontSize: 11, color: COLORS.textSecondary, lineHeight: 1.4 }}>
                    Context at 80%. Please use ctx_reduce to drop old logs.
                    <br />
                    Note: Migration to Postgres is in progress.
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </AbsoluteFill>
  );
};
