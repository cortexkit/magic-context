import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { COLORS, FONT_FAMILY, FONT_FAMILY_MONO } from "../constants";

interface CompartmentCardProps {
  enterProgress: number;
}

export const CompartmentCard: React.FC<CompartmentCardProps> = ({
  enterProgress,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const entered = spring({
    frame: Math.round(enterProgress * 22),
    fps,
    config: { damping: 18, stiffness: 220 },
  });

  const opacity = interpolate(enterProgress, [0, 0.25], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const ty = interpolate(entered, [0, 1], [10, 0]);

  return (
    <div
      style={{
        background: COLORS.compartmentBg,
        border: `1.5px solid ${COLORS.compartmentBorder}`,
        borderLeft: `4px solid ${COLORS.compartmentAccent}`,
        borderRadius: 10,
        padding: "10px 14px",
        marginBottom: 10,
        opacity,
        transform: `translateY(${ty}px)`,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 7,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 12 }}>📦</span>
          <span
            style={{
              fontFamily: FONT_FAMILY,
              fontWeight: 700,
              fontSize: 12,
              color: COLORS.compartmentAccent,
            }}
          >
            Compartment
          </span>
        </div>
        <span
          style={{
            fontFamily: FONT_FAMILY_MONO,
            fontSize: 9,
            color: COLORS.compartmentAccent,
            background: "rgba(16,185,129,0.12)",
            padding: "2px 7px",
            borderRadius: 999,
          }}
        >
          §1§–§5§
        </span>
      </div>

      {/* Summary skeleton lines */}
      {[80, 58, 42].map((w, i) => (
        <div
          key={i}
          style={{
            width: `${w}%`,
            height: 5,
            borderRadius: 999,
            background: `rgba(16,185,129,${0.38 - i * 0.08})`,
            marginBottom: i < 2 ? 5 : 0,
          }}
        />
      ))}

      <div
        style={{
          marginTop: 7,
          fontFamily: FONT_FAMILY,
          fontSize: 9,
          color: COLORS.textMuted,
        }}
      >
        5 messages · compressed by historian
      </div>
    </div>
  );
};
