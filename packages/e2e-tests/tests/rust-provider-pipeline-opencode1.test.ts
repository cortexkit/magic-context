import { test } from "bun:test";
import { providerHostLane } from "../src/provider-pipeline-host-lane";

test("OpenCode 1 1.18.x provider pipeline commits tags and preserves the served prefix", () => providerHostLane("opencode"), 600000);
