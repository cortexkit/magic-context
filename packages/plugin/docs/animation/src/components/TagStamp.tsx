import { spring, useCurrentFrame, useVideoConfig } from "remotion";
import { COLORS, FONT_FAMILY_MONO } from "../constants";

interface TagStampProps {
  tag: number;
  enterFrame: number;
}

export const TagStamp: React.FC<TagStampProps> = ({ tag, enterFrame }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const entered = spring({
    frame: frame - enterFrame,
    fps,
    config: { damping: 16, stiffness: 280 },
  });

  const opacity = entered;
  const translateX = (1 - entered) * 20;
  const scale = 0.8 + entered * 0.2;

  return (
    <div
      style={{
        fontFamily: FONT_FAMILY_MONO,
        fontSize: 9,
        color: COLORS.tagColor,
        background: COLORS.tagBg,
        padding: "2px 6px",
        borderRadius: 4,
        opacity,
        transform: `translateX(${translateX}px) scale(${scale})`,
        transformOrigin: "center",
        whiteSpace: "nowrap",
      }}
    >
      §{tag}§
    </div>
  );
};
