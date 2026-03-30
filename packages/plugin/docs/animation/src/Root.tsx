import { Composition } from "remotion";
import { MagicContextAnimation } from "./MagicContextAnimation";
import { MagicContextLoop } from "./MagicContextLoop";
import {
  COMP_HEIGHT,
  COMP_WIDTH,
  FULL_DURATION_FRAMES,
  LOOP_DURATION_FRAMES,
  FPS,
} from "./constants";

// Import individual scenes for Studio testing
import { Scene0Hook } from "./scenes/Scene0Hook";
import { Scene1Tagging } from "./scenes/Scene1Tagging";
import { Scene2Reduce } from "./scenes/Scene2Reduce";
import { Scene3Historian } from "./scenes/Scene3Historian";
import { Scene4Nudges } from "./scenes/Scene4Nudges";
import { Scene5Memory } from "./scenes/Scene5Memory";
import { Scene6Dreamer } from "./scenes/Scene6Dreamer";
import { Scene7Resolution } from "./scenes/Scene7Resolution";

import {
  SCENE_0_DURATION,
  SCENE_1_DURATION,
  SCENE_2_DURATION,
  SCENE_3_DURATION,
  SCENE_4_DURATION,
  SCENE_5_DURATION,
  SCENE_6_DURATION,
  SCENE_7_DURATION,
} from "./constants";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      {/* Main full animation (45s) */}
      <Composition
        id="MagicContextAnimation"
        component={MagicContextAnimation}
        durationInFrames={FULL_DURATION_FRAMES}
        fps={FPS}
        width={COMP_WIDTH}
        height={COMP_HEIGHT}
      />

      {/* GIF loop (12s) - Scenes 0-2 */}
      <Composition
        id="MagicContextLoop"
        component={MagicContextLoop}
        durationInFrames={LOOP_DURATION_FRAMES}
        fps={FPS}
        width={COMP_WIDTH}
        height={COMP_HEIGHT}
      />

      {/* Individual scene compositions for Studio testing */}
      <Composition
        id="Scene0Hook"
        component={Scene0Hook}
        durationInFrames={SCENE_0_DURATION}
        fps={FPS}
        width={COMP_WIDTH}
        height={COMP_HEIGHT}
      />

      <Composition
        id="Scene1Tagging"
        component={Scene1Tagging}
        durationInFrames={SCENE_1_DURATION}
        fps={FPS}
        width={COMP_WIDTH}
        height={COMP_HEIGHT}
      />

      <Composition
        id="Scene2Reduce"
        component={Scene2Reduce}
        durationInFrames={SCENE_2_DURATION}
        fps={FPS}
        width={COMP_WIDTH}
        height={COMP_HEIGHT}
      />

      <Composition
        id="Scene3Historian"
        component={Scene3Historian}
        durationInFrames={SCENE_3_DURATION}
        fps={FPS}
        width={COMP_WIDTH}
        height={COMP_HEIGHT}
      />

      <Composition
        id="Scene4Nudges"
        component={Scene4Nudges}
        durationInFrames={SCENE_4_DURATION}
        fps={FPS}
        width={COMP_WIDTH}
        height={COMP_HEIGHT}
      />

      <Composition
        id="Scene5Memory"
        component={Scene5Memory}
        durationInFrames={SCENE_5_DURATION}
        fps={FPS}
        width={COMP_WIDTH}
        height={COMP_HEIGHT}
      />

      <Composition
        id="Scene6Dreamer"
        component={Scene6Dreamer}
        durationInFrames={SCENE_6_DURATION}
        fps={FPS}
        width={COMP_WIDTH}
        height={COMP_HEIGHT}
      />

      <Composition
        id="Scene7Resolution"
        component={Scene7Resolution}
        durationInFrames={SCENE_7_DURATION}
        fps={FPS}
        width={COMP_WIDTH}
        height={COMP_HEIGHT}
      />
    </>
  );
};
