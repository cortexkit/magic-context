import { interpolate, useCurrentFrame } from "remotion";
import { COLORS, FONT_FAMILY, FONT_FAMILY_MONO } from "../constants";

interface AgentPanelProps {
  type: "historian" | "dreamer";
  enterProgress: number;
  exitProgress: number;
  children?: React.ReactNode;
}

const AGENT_CONFIG = {
  historian: {
    icon: "◈",
    title: "Historian",
    subtitle: "hidden agent",
    accent: COLORS.historianAccent,
    bg: COLORS.historianBg,
    border: COLORS.historianBorder,
  },
  dreamer: {
    icon: "🌙",
    title: "Dreamer",
    subtitle: "night maintenance",
    accent: COLORS.dreamerAccent,
    bg: COLORS.dreamerBg,
    border: "#1e1b4b",
  },
};

export const AgentPanel: React.FC<AgentPanelProps> = ({
  type,
  enterProgress,
  exitProgress,
  children,
}) => {
  const frame = useCurrentFrame();
  const config = AGENT_CONFIG[type];

  const slideX = interpolate(enterProgress, [0, 1], [80, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const exitX = interpolate(exitProgress, [0, 1], [0, 110], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const enterOpacity = interpolate(enterProgress, [0, 0.4], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const exitOpacity = interpolate(exitProgress, [0.55, 1], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const spinDeg = type === "historian" ? (frame * 7) % 360 : 0;

  return (
    <div
      style={{
        width: type === "dreamer" ? 600 : 210,
        background: config.bg,
        border: `1.5px solid ${config.border}`,
        borderRadius: 14,
        padding: "14px 16px",
        opacity: enterOpacity * exitOpacity,
        transform: `translateX(${slideX + exitX}px)`,
        boxShadow: `0 4px 20px ${config.accent}20`,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          marginBottom: 10,
        }}
      >
        <div
          style={{
            width: 26,
            height: 26,
            borderRadius: 7,
            background: config.accent,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 13,
            color: "#fff",
          }}
        >
          {type === "historian" ? (
            <div
              style={{
                width: 13,
                height: 13,
                border: `2px solid ${config.border}`,
                borderTop: `2px solid ${config.accent}`,
                borderRadius: "50%",
                transform: `rotate(${spinDeg}deg)`,
              }}
            />
          ) : (
            config.icon
          )}
        </div>
        <div>
          <div
            style={{
              fontFamily: FONT_FAMILY,
              fontWeight: 700,
              fontSize: 12,
              color: config.accent,
            }}
          >
            {config.title}
          </div>
          <div
            style={{
              fontFamily: FONT_FAMILY,
              fontSize: 9,
              color: COLORS.textMuted,
            }}
          >
            {config.subtitle}
          </div>
        </div>
      </div>

      <div
        style={{
          height: 1,
          background: config.border,
          marginBottom: 10,
        }}
      />

      {/* Content */}
      {children}
    </div>
  );
};

// Sub-component for Historian progress lines
export const HistorianProgress: React.FC<{ localFrame: number }> = ({ localFrame }) => {
  const d1 = Math.sin(localFrame * 0.22) * 0.5 + 0.5;
  const d2 = Math.sin(localFrame * 0.22 + 2.1) * 0.5 + 0.5;
  const d3 = Math.sin(localFrame * 0.22 + 4.2) * 0.5 + 0.5;

  let stateText = "Summarising";
  let bottomText = "§1§–§5§ → summarise";

  if (localFrame > 140) {
    stateText = "Merging compartments";
    bottomText = "§1§–§24§ → merge & compact";
  } else if (localFrame > 70) {
    stateText = "Extracting facts";
    bottomText = "+3 project memories";
  }

  return (
    <>
      {/* Spinner + dots */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          marginBottom: 9,
        }}
      >
        <div
          style={{
            width: 13,
            height: 13,
            border: `2px solid ${COLORS.historianBorder}`,
            borderTop: `2px solid ${COLORS.historianAccent}`,
            borderRadius: "50%",
            transform: `rotate(${(localFrame * 7) % 360}deg)`,
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontFamily: FONT_FAMILY,
            fontSize: 11,
            color: COLORS.textSecondary,
          }}
        >
          {stateText}
        </span>
        <div style={{ display: "flex", gap: 3 }}>
          {[d1, d2, d3].map((d, i) => (
            <div
              key={i}
              style={{
                width: 3.5,
                height: 3.5,
                borderRadius: "50%",
                background: COLORS.historianAccent,
                opacity: 0.3 + d * 0.7,
              }}
            />
          ))}
        </div>
      </div>

      {/* Progress skeleton lines */}
      {[0.82, 0.55, 0.35].map((w, i) => (
        <div
          key={i}
          style={{
            height: 5,
            width: "100%",
            background: COLORS.historianBorder,
            borderRadius: 999,
            marginBottom: i < 2 ? 5 : 0,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${w * 100}%`,
              background: `${COLORS.historianAccent}45`,
              borderRadius: 999,
            }}
          />
        </div>
      ))}

      {/* Tag label */}
      <div
        style={{
          marginTop: 9,
          fontFamily: FONT_FAMILY_MONO,
          fontSize: 9,
          color: localFrame > 70 ? COLORS.contextGreen : COLORS.textMuted,
          background: `${COLORS.historianAccent}12`,
          padding: "3px 7px",
          borderRadius: 5,
        }}
      >
        {bottomText}
      </div>
    </>
  );
};
