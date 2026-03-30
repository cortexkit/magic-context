import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import {
  COLORS,
  FONT_FAMILY,
  PANEL_W,
  PANEL_H,
  SCENE_2_DURATION,
  SCENE2_MESSAGES,
  INTRO_DURATION,
} from "../constants";
import { SkeletonMessage } from "../components/SkeletonMessage";
import { ContextBar } from "../components/ContextBar";
import { SceneCaption } from "../components/SceneCaption";
import { NudgeBanner } from "../components/NudgeBanner";
import { CommandChip } from "../components/CommandChip";

// Scene 2: Surgical Dropping (210-360 frames, 5s)
// "Drop bloat, not context." — Select and drop tool outputs

export const Scene2Reduce: React.FC = () => {
  const globalFrame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const frame = globalFrame - INTRO_DURATION;

  // Frame ranges (relative to scene start)
  const NUDGE_ENTER = 10;
  const NUDGE_EXIT = 80;
  const SELECTION_START = 25;
  const SELECTION_END = 50;
  const COMMAND_ENTER = 45;
  const DROP_START = 60;
  const DROP_END = 100;

  // Selection progress (glow on tool outputs)
  const selectionProgress = spring({
    frame: frame - SELECTION_START,
    fps,
    config: { damping: 200 },
  });
  const selP = frame >= SELECTION_START && frame < SELECTION_END + 20 ? selectionProgress : 0;

  // Drop progress for tool output messages (indices 5 and 7 in SCENE2_MESSAGES)
  const dropP = (i: number) => {
    if (i !== 5 && i !== 7) return 0;
    const delay = i === 5 ? 0 : 8;
    return interpolate(
      frame,
      [DROP_START + delay, DROP_END + delay],
      [0, 1],
      { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
    );
  };

  // Context bar: starts at 62%, drops to 34%
  const contextPct = interpolate(
    frame,
    [DROP_START, DROP_END + 20],
    [62, 34],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Delta label animation
  const showDelta = frame >= DROP_END && frame < DROP_END + 40;
  const deltaOpacity = showDelta
    ? interpolate(frame, [DROP_END, DROP_END + 10, DROP_END + 30, DROP_END + 40], [0, 1, 1, 0], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      })
    : 0;

  // UI fade in (since panel doesn't re-enter in Scene 2)
  const uiOpacity = interpolate(
    frame,
    [0, 15],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Panel position
  const panelLeft = (1280 - PANEL_W) / 2;
  const panelTop = 100;

  // UI fade out for seamless loop back to Scene 0 (for GIF)
  const sceneEndFade = interpolate(
    globalFrame,
    [SCENE_2_DURATION - 15, SCENE_2_DURATION],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  return (
    <AbsoluteFill style={{ background: COLORS.bg, opacity: sceneEndFade }}>
      {/* Scene caption (Title Card) */}
      <SceneCaption
        text="Agent chooses what to drop"
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
          Surgical Dropping
        </div>
      </div>

      {/* Nudge toast */}
      {frame >= NUDGE_ENTER && frame < NUDGE_EXIT && (
        <div style={{ opacity: uiOpacity }}>
          <NudgeBanner
            level="gentle"
            pct={62}
            enterFrame={NUDGE_ENTER}
            exitFrame={NUDGE_EXIT}
          />
        </div>
      )}

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
        <div style={{ padding: "18px 20px", overflow: "hidden" }}>
          {SCENE2_MESSAGES.map((msg, i) => (
            <SkeletonMessage
              key={msg.id}
              widthPercent={msg.barWidth}
              role={msg.role}
              enterFrame={0} // All visible at start
              dropProgress={dropP(i)}
              selectionProgress={msg.isLarge ? selP : 0}
              tag={msg.tag}
              isLarge={msg.isLarge}
              label={msg.label}
            />
          ))}
        </div>
      </div>

      {/* Command chip */}
      {frame >= COMMAND_ENTER && (
        <div
          style={{
            position: "absolute",
            top: panelTop + 200,
            left: panelLeft + PANEL_W / 2 - 60,
            opacity: uiOpacity,
          }}
        >
          <CommandChip
            command='ctx_reduce(drop="3,6")'
            enterFrame={COMMAND_ENTER}
            exitFrame={DROP_END + 30}
          />
        </div>
      )}

      {/* Context bar */}
      <div
        style={{
          position: "absolute",
          bottom: 42,
          left: "50%",
          transform: "translateX(-50%)",
          opacity: uiOpacity,
        }}
      >
        <ContextBar pct={contextPct} />
        {/* Delta label */}
        {showDelta && (
          <div
            style={{
              position: "absolute",
              right: -50,
              top: -2,
              fontFamily: FONT_FAMILY,
              fontSize: 11,
              fontWeight: 600,
              color: COLORS.contextGreen,
              opacity: deltaOpacity,
            }}
          >
            −28%
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
};
