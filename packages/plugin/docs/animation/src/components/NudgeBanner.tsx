import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { COLORS, FONT_FAMILY } from "../constants";

type NudgeLevel = "gentle" | "bolder" | "critical";

interface NudgeBannerProps {
  level: NudgeLevel;
  pct: number;
  enterFrame: number;
  exitFrame: number;
}

const NUDGE_CONFIG: Record<NudgeLevel, { icon: string; bg: string; border: string; text: string }> = {
  gentle: {
    icon: "💡",
    bg: "rgba(245, 158, 11, 0.1)",
    border: "rgba(245, 158, 11, 0.3)",
    text: COLORS.nudgeAmber,
  },
  bolder: {
    icon: "⚠",
    bg: "rgba(245, 158, 11, 0.15)",
    border: "rgba(245, 158, 11, 0.5)",
    text: COLORS.nudgeAmber,
  },
  critical: {
    icon: "🛑",
    bg: "rgba(239, 68, 68, 0.15)",
    border: "rgba(239, 68, 68, 0.6)",
    text: COLORS.nudgeRed,
  },
};

export const NudgeBanner: React.FC<NudgeBannerProps> = ({
  level,
  pct,
  enterFrame,
  exitFrame,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const config = NUDGE_CONFIG[level];

  // Entrance animation (slide from top)
  const entered = spring({
    frame: frame - enterFrame,
    fps,
    config: { damping: 18, stiffness: 240 },
  });

  const translateY = interpolate(entered, [0, 1], [-30, 0]);
  const opacity = entered;

  // Exit animation
  const exitProgress = interpolate(
    frame,
    [exitFrame - 10, exitFrame],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Pulse for critical
  const pulse = level === "critical" ? Math.sin(frame * 0.25) * 0.15 + 0.85 : 1;

  const messages: Record<NudgeLevel, string> = {
    gentle: `Context at ${pct}% — consider compression`,
    bolder: `Context at ${pct}% — compression recommended`,
    critical: `STOP AND COMPRESS — context at ${pct}%`,
  };

  return (
    <div
      style={{
        position: "absolute",
        top: 80,
        left: "50%",
        transform: `translateX(-50%) translateY(${translateY}px)`,
        opacity: opacity * exitProgress,
        background: config.bg,
        border: `1.5px solid ${config.border}`,
        borderRadius: 8,
        padding: "10px 16px",
        display: "flex",
        alignItems: "center",
        gap: 8,
        boxShadow: level === "critical" ? `0 0 20px rgba(239,68,68,${pulse * 0.3})` : "none",
      }}
    >
      <span style={{ fontSize: 14 }}>{config.icon}</span>
      <span
        style={{
          fontFamily: FONT_FAMILY,
          fontSize: 13,
          fontWeight: level === "critical" ? 600 : 500,
          color: config.text,
          whiteSpace: "nowrap",
        }}
      >
        {messages[level]}
      </span>
    </div>
  );
};
