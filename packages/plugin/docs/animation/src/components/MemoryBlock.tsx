import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { COLORS, FONT_FAMILY, FONT_FAMILY_MONO } from "../constants";

interface MemoryBlockProps {
  items: string[];
  enterFrame: number;
}

export const MemoryBlock: React.FC<MemoryBlockProps> = ({ items, enterFrame }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const entered = spring({
    frame: frame - enterFrame,
    fps,
    config: { damping: 16, stiffness: 220 },
  });

  const opacity = interpolate(entered, [0, 0.3], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const translateY = interpolate(entered, [0, 1], [20, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        background: COLORS.memoryBg,
        border: `1.5px solid ${COLORS.memoryAccent}30`,
        borderLeft: `4px solid ${COLORS.memoryAccent}`,
        borderRadius: 10,
        padding: "14px 16px",
        marginBottom: 16,
        opacity,
        transform: `translateY(${translateY}px)`,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 12,
        }}
      >
        <span style={{ fontSize: 14 }}>🧠</span>
        <span
          style={{
            fontFamily: FONT_FAMILY,
            fontWeight: 600,
            fontSize: 12,
            color: COLORS.memoryAccent,
          }}
        >
          Project Memory
        </span>
        <span
          style={{
            fontFamily: FONT_FAMILY_MONO,
            fontSize: 10,
            color: COLORS.textMuted,
          }}
        >
          · {items.length} memories loaded
        </span>
      </div>

      {/* Items */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {items.map((item, i) => {
          const itemEnterFrame = enterFrame + 20 + i * 15;
          const itemEntered = spring({
            frame: frame - itemEnterFrame,
            fps,
            config: { damping: 18, stiffness: 240 },
          });

          const itemOpacity = interpolate(itemEntered, [0, 0.5], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });

          return (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 8,
                opacity: itemOpacity,
              }}
            >
              <span
                style={{
                  color: COLORS.memoryAccent,
                  fontSize: 11,
                  lineHeight: "1.5",
                }}
              >
                ·
              </span>
              <span
                style={{
                  fontFamily: FONT_FAMILY,
                  fontSize: 11,
                  color: COLORS.textSecondary,
                  lineHeight: "1.5",
                }}
              >
                {item}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};
