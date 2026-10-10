import { expect, test } from "bun:test";
import { isLiveConfigKey } from "./live-config-key";

test("dashboard live marker follows the bundled generated schema rather than field labels", () => {
  expect(isLiveConfigKey("historian.opencode.model")).toBe(true);
  expect(isLiveConfigKey("dreamer.pi.tasks")).toBe(true);
  expect(isLiveConfigKey("dreamer.tasks.verify.schedule")).toBe(true);
  expect(isLiveConfigKey("mural.model")).toBe(false);
  expect(isLiveConfigKey("toast_duration_ms")).toBe(true);
  expect(isLiveConfigKey("protected_tokens")).toBe(false);
  expect(isLiveConfigKey("language")).toBe(false);
  expect(isLiveConfigKey("historian.top_p")).toBe(false);
});
