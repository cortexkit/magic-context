import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { COLORS, FONT_FAMILY_MONO } from "../constants";

interface CommandChipProps {
  command: string;
  enterFrame: number;
  exitFrame?: number;
}

export const CommandChip: React.FC<CommandChipProps> = ({
  command,
  enterFrame,
  exitFrame,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const entered = spring({
    frame: frame - enterFrame,
    fps,
    config: { damping: 16, stiffness: 260 },
  });

  const opacity = entered;
  const scale = 0.9 + entered * 0.1;
  const translateY = (1 - entered) * 10;

  let exitOpacity = 1;
  if (exitFrame) {
    exitOpacity = interpolate(
      frame,
      [exitFrame - 15, exitFrame],
      [1, 0],
      { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
    );
  }

  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        background: COLORS.commandBg,
        border: `1px solid ${COLORS.commandBorder}`,
        borderRadius: 6,
        padding: "6px 10px",
        opacity: opacity * exitOpacity,
        transform: `translateY(${translateY}px) scale(${scale})`,
        transformOrigin: "center",
      }}
    >
      <span
        style={{
          fontFamily: FONT_FAMILY_MONO,
          fontSize: 11,
          color: COLORS.commandText,
        }}
      >
        {command}
      </span>
    </div>
  );
};
