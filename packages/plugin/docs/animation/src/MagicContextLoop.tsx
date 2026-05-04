import { AbsoluteFill, Sequence } from "remotion";
import {
  COLORS,
  SCENE_0_DURATION,
  SCENE_1_DURATION,
  SCENE_2_DURATION,
} from "./constants";

// Import scenes 0-2 for the GIF loop
import { Scene0Hook } from "./scenes/Scene0Hook";
import { Scene1Tagging } from "./scenes/Scene1Tagging";
import { Scene2Reduce } from "./scenes/Scene2Reduce";

// Scene start frames (cumulative)
const SCENE_0_START = 0;
const SCENE_1_START = SCENE_0_START + SCENE_0_DURATION;
const SCENE_2_START = SCENE_1_START + SCENE_1_DURATION;

// This is the hero GIF loop - Scenes 0-2 only
// Designed to loop seamlessly from end back to beginning
export const MagicContextLoop: React.FC = () => {
  return (
    <AbsoluteFill style={{ background: COLORS.bg }}>
      {/* Scene 0: The Hook (0-90) */}
      <Sequence from={SCENE_0_START} durationInFrames={SCENE_0_DURATION}>
        <Scene0Hook />
      </Sequence>

      {/* Scene 1: Tagging (90-210) */}
      <Sequence from={SCENE_1_START} durationInFrames={SCENE_1_DURATION}>
        <Scene1Tagging />
      </Sequence>

      {/* Scene 2: Surgical Dropping (210-360) */}
      <Sequence from={SCENE_2_START} durationInFrames={SCENE_2_DURATION}>
        <Scene2Reduce />
      </Sequence>
    </AbsoluteFill>
  );
};
