import { AbsoluteFill, Sequence } from "remotion";
import {
  COLORS,
  SCENE_0_DURATION,
  SCENE_1_DURATION,
  SCENE_2_DURATION,
  SCENE_3_DURATION,
  SCENE_4_DURATION,
  SCENE_5_DURATION,
  SCENE_6_DURATION,
  SCENE_7_DURATION,
} from "./constants";

// Import all scenes
import { Scene0Hook } from "./scenes/Scene0Hook";
import { Scene1Tagging } from "./scenes/Scene1Tagging";
import { Scene2Reduce } from "./scenes/Scene2Reduce";
import { Scene3Historian } from "./scenes/Scene3Historian";
import { Scene4Nudges } from "./scenes/Scene4Nudges";
import { Scene5Memory } from "./scenes/Scene5Memory";
import { Scene6Dreamer } from "./scenes/Scene6Dreamer";
import { Scene7Resolution } from "./scenes/Scene7Resolution";

// Scene start frames (cumulative)
const SCENE_0_START = 0;
const SCENE_1_START = SCENE_0_START + SCENE_0_DURATION;
const SCENE_2_START = SCENE_1_START + SCENE_1_DURATION;
const SCENE_3_START = SCENE_2_START + SCENE_2_DURATION;
const SCENE_4_START = SCENE_3_START + SCENE_3_DURATION;
const SCENE_5_START = SCENE_4_START + SCENE_4_DURATION;
const SCENE_6_START = SCENE_5_START + SCENE_5_DURATION;
const SCENE_7_START = SCENE_6_START + SCENE_6_DURATION;

export const MagicContextAnimation: React.FC = () => {
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

      {/* Scene 3: Historian (360-690) */}
      <Sequence from={SCENE_3_START} durationInFrames={SCENE_3_DURATION}>
        <Scene3Historian />
      </Sequence>

      {/* Scene 4: Nudge Escalation (690-870) */}
      <Sequence from={SCENE_4_START} durationInFrames={SCENE_4_DURATION}>
        <Scene4Nudges />
      </Sequence>

      {/* Scene 5: Cross-Session Memory (870-1110) */}
      <Sequence from={SCENE_5_START} durationInFrames={SCENE_5_DURATION}>
        <Scene5Memory />
      </Sequence>

      {/* Scene 6: Dreamer (1110-1230) */}
      <Sequence from={SCENE_6_START} durationInFrames={SCENE_6_DURATION}>
        <Scene6Dreamer />
      </Sequence>

      {/* Scene 7: Resolution (1230-1350) */}
      <Sequence from={SCENE_7_START} durationInFrames={SCENE_7_DURATION}>
        <Scene7Resolution />
      </Sequence>
    </AbsoluteFill>
  );
};
