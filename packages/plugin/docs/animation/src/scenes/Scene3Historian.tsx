import { AbsoluteFill, interpolate, Easing, spring, useCurrentFrame, useVideoConfig } from "remotion";
import {
  COLORS,
  FONT_FAMILY,
  PANEL_W,
  PANEL_H,
  SCENE_3_DURATION,
  OLD_MESSAGES,
  RECENT_MESSAGES,
  INTRO_DURATION,
} from "../constants";
import { SkeletonMessage } from "../components/SkeletonMessage";
import { ContextBar } from "../components/ContextBar";
import { SceneCaption } from "../components/SceneCaption";
import { AgentPanel, HistorianProgress } from "../components/AgentPanel";
import { CompartmentCard } from "../components/CompartmentCard";

// Scene 3: Historian (360-690 frames, 11s)
// "Compress history in the background." — The centerpiece scene

export const Scene3Historian: React.FC = () => {
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
  const HISTORIAN_ENTER = 20;
  const HISTORIAN_EXIT = 280;
  const CHUNK_FLY_START = 40;
  const CHUNK_FLY_END = 120;
  const OLD_FADE_START = 200;
  const OLD_FADE_END = 240;
  const COMPARTMENT_ENTER = 240;
  const NEW_MESSAGES_START = 100;

  // Historian panel enter/exit progress
  const historianEnterP = spring({
    frame: frame - HISTORIAN_ENTER,
    fps,
    config: { damping: 200 },
  });
  const historianExitP = interpolate(
    frame,
    [HISTORIAN_EXIT - 30, HISTORIAN_EXIT],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Chunk ghost fly progress
  const chunkFlyP = interpolate(
    frame,
    [CHUNK_FLY_START, CHUNK_FLY_END],
    [0, 1],
    { easing: Easing.inOut(Easing.quad), extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Old messages fade out
  const oldOpacity = interpolate(
    frame,
    [OLD_FADE_START, OLD_FADE_END],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Compartment enter progress
  const compartmentEnterP = interpolate(
    frame,
    [COMPARTMENT_ENTER, COMPARTMENT_ENTER + 40],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Context bar: 58% → 24%
  const contextPct = interpolate(
    frame,
    [OLD_FADE_START, OLD_FADE_END + 20],
    [58, 24],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Panel position
  const panelLeft = (1280 - PANEL_W) / 2;
  const panelTop = 100;
  const historianLeft = panelLeft + PANEL_W + 48;
  const historianTop = panelTop + 96;

  // Chunk bracket
  const ROW_H = 44;
  const chunkBracketTop = panelTop + 30;
  const chunkBracketHeight = OLD_MESSAGES.length * ROW_H;

  // Bracket opacity
  const bracketOpacity = interpolate(
    frame,
    [10, 30],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  return (
    <AbsoluteFill style={{ background: COLORS.bg }}>
      {/* Scene caption (Title Card) */}
      <SceneCaption
        text="Historian runs on the background while main agent keeps working without interruption."
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
          Historian Compartmentalization
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
        <div style={{ padding: "18px 20px", overflow: "hidden" }}>
          {/* Compartment card (replaces old messages) */}
          {frame >= COMPARTMENT_ENTER && (
            <CompartmentCard
              enterProgress={compartmentEnterP}
            />
          )}

          {/* Old messages (fade out) */}
          {frame < OLD_FADE_END && (
            <div style={{ opacity: oldOpacity }}>
              {OLD_MESSAGES.map((msg, i) => (
                <SkeletonMessage
                  key={msg.id}
                  widthPercent={msg.barWidth}
                  role={msg.role}
                  enterFrame={0}
                  tag={msg.tag}
                />
              ))}
            </div>
          )}

          {/* Recent messages (continue during historian processing) */}
          {RECENT_MESSAGES.map((msg, i) => {
            const enterFrame = NEW_MESSAGES_START + i * 20;
            if (frame < enterFrame) return null;
            return (
              <SkeletonMessage
                key={msg.id}
                widthPercent={msg.barWidth}
                role={msg.role}
                enterFrame={enterFrame}
                tag={msg.tag}
              />
            );
          })}
        </div>
      </div>

      {/* Chunk bracket */}
      {frame >= 0 && frame < OLD_FADE_START + 20 && (
        <div
          style={{
            position: "absolute",
            left: panelLeft + PANEL_W - 1,
            top: chunkBracketTop,
            width: 26,
            height: chunkBracketHeight,
            opacity: bracketOpacity * oldOpacity * uiOpacity,
          }}
        >
          <div
            style={{
              position: "absolute",
              left: 10,
              top: 0,
              bottom: 0,
              width: 2.5,
              background: COLORS.selectionOutline,
              borderRadius: 999,
            }}
          />
          <div
            style={{
              position: "absolute",
              left: 10,
              top: 0,
              width: 12,
              height: 2.5,
              background: COLORS.selectionOutline,
            }}
          />
          <div
            style={{
              position: "absolute",
              left: 10,
              bottom: 0,
              width: 12,
              height: 2.5,
              background: COLORS.selectionOutline,
            }}
          />
        </div>
      )}

      {/* Flying chunk ghost */}
      {frame >= CHUNK_FLY_START && frame < CHUNK_FLY_END + 20 && (
        <div style={{ opacity: uiOpacity }}>
          <ChunkGhost
            flyProgress={chunkFlyP}
            startX={panelLeft + PANEL_W - 10}
            startY={chunkBracketTop + 8}
            targetX={historianLeft + 12}
            targetY={historianTop + 75}
          />
        </div>
      )}

      {/* Historian panel */}
      {frame >= HISTORIAN_ENTER && frame < HISTORIAN_EXIT && (
        <div style={{ position: "absolute", left: historianLeft, top: historianTop, opacity: uiOpacity }}>
          <AgentPanel
            type="historian"
            enterProgress={historianEnterP}
            exitProgress={historianExitP}
          >
            <HistorianProgress localFrame={Math.max(0, frame - HISTORIAN_ENTER)} />
          </AgentPanel>
        </div>
      )}
    </AbsoluteFill>
  );
};

// Chunk ghost component
const ChunkGhost: React.FC<{
  flyProgress: number;
  startX: number;
  startY: number;
  targetX: number;
  targetY: number;
}> = ({ flyProgress, startX, startY, targetX, targetY }) => {
  const x = interpolate(flyProgress, [0, 1], [startX, targetX], {
    easing: Easing.inOut(Easing.quad),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const y = interpolate(flyProgress, [0, 1], [startY, targetY], {
    easing: Easing.inOut(Easing.quad),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const scale = interpolate(flyProgress, [0, 0.5, 1], [1, 0.7, 0.44], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const opacity = interpolate(flyProgress, [0, 0.08, 0.82, 1], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const defs = [
    { w: 62, color: COLORS.userBar },
    { w: 88, color: COLORS.assistantBar },
    { w: 54, color: COLORS.userBar },
    { w: 84, color: COLORS.assistantBar },
    { w: 68, color: COLORS.userBar },
  ];

  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        opacity,
        transform: `scale(${scale})`,
        transformOrigin: "left top",
        width: 220,
        display: "flex",
        flexDirection: "column",
        gap: 5,
        pointerEvents: "none",
      }}
    >
      {defs.map((d, i) => (
        <div
          key={i}
          style={{
            width: `${d.w}%`,
            height: 22,
            borderRadius: 5,
            background: d.color,
            border: `1px solid ${COLORS.selectionOutline}55`,
          }}
        />
      ))}
    </div>
  );
};
