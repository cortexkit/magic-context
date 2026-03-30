import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { COLORS, FONT_FAMILY, FONT_FAMILY_MONO, Role } from "../constants";
import { TagStamp } from "./TagStamp";

type Props = {
  /** Width of the skeleton bar as % of container */
  widthPercent: number;
  role: Role;
  /** Frame (in parent sequence space) when this row enters */
  enterFrame: number;
  /** 0–1: fully visible → fully gone */
  dropProgress?: number;
  /** 0–1: highlight intensity for selection */
  selectionProgress?: number;
  /** Show §N§ tag label */
  tag?: number;
  /** Optional: mark as large (tool output) */
  isLarge?: boolean;
  /** Optional: label for tool outputs */
  label?: string;
};

export const SkeletonMessage: React.FC<Props> = ({
  widthPercent,
  role,
  enterFrame,
  dropProgress = 0,
  selectionProgress = 0,
  tag,
  isLarge = false,
  label,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const isUser = role === "user";

  // Entrance
  const entered = spring({
    frame: frame - enterFrame,
    fps,
    config: { damping: 22, stiffness: 220 },
  });
  const enteredClamped = Math.min(1, Math.max(0, entered));

  const enterOpacity = interpolate(
    frame,
    [enterFrame, enterFrame + 8],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const enterTranslateY = interpolate(enteredClamped, [0, 1], [20, 0]);

  // Drop
  const dropOpacity = interpolate(dropProgress, [0, 1], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const dropScale = interpolate(dropProgress, [0, 1], [1, 0.94], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const dropTranslateX = interpolate(dropProgress, [0, 1], [0, 10], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const dropHeight = interpolate(dropProgress, [0, 1], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Selection glow
  const selGlow = interpolate(selectionProgress, [0, 1], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Bar colors (dark theme)
  const barBase = isUser ? COLORS.userBar : COLORS.assistantBar;
  const barSelected = isUser
    ? `rgba(99,102,241,${0.5 + selGlow * 0.3})` // indigo tint
    : `rgba(99,102,241,${0.4 + selGlow * 0.35})`;
  const barColor = selGlow > 0.05 ? barSelected : barBase;

  // Inner shimmer line (simulates text lines)
  const innerW1 = widthPercent * 0.55;
  const innerColor = isUser
    ? `rgba(147,197,253,${0.5 - selGlow * 0.2})`
    : `rgba(148,163,184,${0.4 - selGlow * 0.15})`;

  const barHeight = isLarge ? 56 : 36;
  const marginBottom = isLarge ? 12 : 8;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: isUser ? "flex-end" : "flex-start",
        marginBottom: marginBottom * dropHeight,
        opacity: enterOpacity * dropOpacity,
        transform: `translateY(${enterTranslateY}px) translateX(${dropTranslateX}px) scale(${dropScale})`,
        height: barHeight * dropHeight,
        overflow: "hidden",
      }}
    >
      {/* Tag label (left of bar for assistant, right for user) */}
      {tag !== undefined && (
        <div
          style={{
            marginRight: isUser ? 0 : 8,
            marginLeft: isUser ? 8 : 0,
            order: isUser ? 2 : 0,
          }}
        >
          <TagStamp tag={tag} enterFrame={enterFrame + 5} />
        </div>
      )}

      {/* Skeleton bar */}
      <div
        style={{
          width: `${widthPercent}%`,
          height: barHeight,
          borderRadius: 8,
          background: barColor,
          border: selGlow > 0.05
            ? `1.5px solid rgba(99,102,241,${selGlow * 0.7})`
            : "none",
          boxShadow: selGlow > 0.15
            ? `0 0 0 2px rgba(99,102,241,${selGlow * 0.18})`
            : "none",
          display: "flex",
          flexDirection: "column",
          alignItems: isUser ? "flex-end" : "flex-start",
          justifyContent: "center",
          paddingLeft: isUser ? 0 : 12,
          paddingRight: isUser ? 12 : 0,
          paddingTop: isLarge ? 8 : 0,
          paddingBottom: isLarge ? 8 : 0,
          position: "relative",
          overflow: "hidden",
          flexShrink: 0,
        }}
      >
        {/* Label for large/tool outputs */}
        {isLarge && label && (
          <div
            style={{
              fontFamily: FONT_FAMILY_MONO,
              fontSize: 9,
              color: isUser ? "rgba(147,197,253,0.7)" : "rgba(148,163,184,0.7)",
              marginBottom: 4,
            }}
          >
            {label}
          </div>
        )}
        {/* Inner shimmer lines */}
        <div
          style={{
            width: `${innerW1}%`,
            height: 7,
            borderRadius: 999,
            background: innerColor,
          }}
        />
        {isLarge && (
          <div
            style={{
              width: `${innerW1 * 0.7}%`,
              height: 7,
              borderRadius: 999,
              background: innerColor,
              marginTop: 4,
            }}
          />
        )}
      </div>
    </div>
  );
};
