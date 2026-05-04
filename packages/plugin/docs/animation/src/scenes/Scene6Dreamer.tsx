import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import {
  COLORS,
  FONT_FAMILY,
  FONT_FAMILY_MONO,
  SCENE_6_DURATION,
  DREAMER_PILLS,
  INTRO_DURATION,
} from "../constants";
import { ContextBar } from "../components/ContextBar";
import { SceneCaption } from "../components/SceneCaption";
import { AgentPanel } from "../components/AgentPanel";

// Scene 6: Dreamer (1110-1230 frames, 4s)
// "Overnight, Dreamer cleans house."

export const Scene6Dreamer: React.FC = () => {
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
  const NIGHT_START = 10;
  const NIGHT_END = 30;
  const DREAMER_ENTER = 30;
  const PILL_START = 50;
  const DREAMER_EXIT = 170;
  const DAY_START = 160;
  const DAY_END = 180;

  // Night mode transition
  const nightProgress = interpolate(
    frame,
    [NIGHT_START, NIGHT_END],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const dayProgress = interpolate(
    frame,
    [DAY_START, DAY_END],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Background color: normal → night → normal
  const bgColor = frame < DAY_START
    ? interpolate(nightProgress, [0, 1], [10, 5], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
    : interpolate(dayProgress, [0, 1], [5, 10], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const background = `rgb(${Math.round(bgColor)}, ${Math.round(bgColor * 1.2)}, ${Math.round(bgColor * 2.4)})`;

  // Dreamer panel enter/exit
  const dreamerEnterP = spring({
    frame: frame - DREAMER_ENTER,
    fps,
    config: { damping: 200 },
  });
  const dreamerExitP = interpolate(
    frame,
    [DREAMER_EXIT - 20, DREAMER_EXIT],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Memory quality bar
  const memoryQualityStart = 60;
  const memoryQuality = interpolate(
    frame,
    [memoryQualityStart, memoryQualityStart + 40],
    [72, 91],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Panel position
  const panelLeft = (1280 - 600) / 2;
  const panelTop = 200;

  return (
    <AbsoluteFill style={{ background }}>
      {/* Scene caption (Title Card) */}
      <SceneCaption
        text="Overnight maintenance while you sleep."
        subtitle="Dreamer consolidates, verifies, and improves project memories."
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
          Dreamer
        </div>
      </div>

      {/* Night indicator */}
      {frame >= NIGHT_START && frame < DAY_START && (
        <div
          style={{
            position: "absolute",
            top: 100,
            right: 100,
            display: "flex",
            alignItems: "center",
            gap: 8,
            opacity: nightProgress * uiOpacity,
          }}
        >
          <span style={{ fontSize: 20 }}>☾</span>
          <span
            style={{
              fontFamily: FONT_FAMILY_MONO,
              fontSize: 14,
              color: COLORS.textSecondary,
            }}
          >
            2:00 AM
          </span>
        </div>
      )}

      {/* Dreamer panel */}
      {frame >= DREAMER_ENTER && frame < DREAMER_EXIT + 20 && (
        <div style={{ position: "absolute", left: panelLeft, top: panelTop, opacity: uiOpacity }}>
          <AgentPanel
            type="dreamer"
            enterProgress={dreamerEnterP}
            exitProgress={dreamerExitP}
          >
            {/* Dreamer pills */}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {DREAMER_PILLS.map((pill, i) => {
                const pillEnterFrame = PILL_START + i * 15;
                const pillEntered = spring({
                  frame: frame - pillEnterFrame,
                  fps,
                  config: { damping: 20, stiffness: 180 },
                });
                const pillOpacity = interpolate(pillEntered, [0, 0.5], [0, 1], {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                });
                const pillTranslateX = interpolate(pillEntered, [0, 1], [-20, 0], {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                });

                const pillColors: Record<string, string> = {
                  success: COLORS.contextGreen,
                  archive: COLORS.contextGreen,
                };

                return (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      background: `${pillColors[pill.type]}15`,
                      border: `1px solid ${pillColors[pill.type]}30`,
                      borderRadius: 999,
                      padding: "6px 12px",
                      opacity: pillOpacity,
                      transform: `translateX(${pillTranslateX}px)`,
                    }}
                  >
                    <span style={{ fontSize: 14, color: pillColors[pill.type] }}>
                      {pill.icon}
                    </span>
                    <span
                      style={{
                        fontFamily: FONT_FAMILY,
                        fontSize: 10,
                        color: COLORS.textSecondary,
                      }}
                    >
                      {pill.text}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Memory quality bar */}
            {frame >= PILL_START + DREAMER_PILLS.length * 15 && (
              <div style={{ marginTop: 16 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: 6,
                }}
              >
                <span
                  style={{
                    fontFamily: FONT_FAMILY,
                    fontSize: 10,
                    color: COLORS.textMuted,
                  }}
                >
                  Memory quality
                </span>
                <span
                  style={{
                    fontFamily: FONT_FAMILY_MONO,
                    fontSize: 10,
                    color: COLORS.dreamerAccent,
                  }}
                >
                  {Math.round(memoryQuality)}%
                </span>
              </div>
              <div
                style={{
                  height: 4,
                  background: COLORS.panelBorder,
                  borderRadius: 999,
                  overflow: "hidden",
                }}
              >
                  <div
                    style={{
                      height: "100%",
                      width: `${memoryQuality}%`,
                      background: COLORS.dreamerAccent,
                      borderRadius: 999,
                    }}
                  />
                </div>
              </div>
            )}
          </AgentPanel>
        </div>
      )}
    </AbsoluteFill>
  );
};
