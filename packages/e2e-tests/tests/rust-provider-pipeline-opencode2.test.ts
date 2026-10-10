import { test } from "bun:test";
import { providerHostLane } from "../src/provider-pipeline-host-lane";

test("OpenCode 2 2.0.x provider pipeline commits tags and preserves the served prefix", () => providerHostLane("opencode2"), 600000);
