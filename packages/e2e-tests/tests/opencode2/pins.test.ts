import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pins from "../../src/opencode2-runner/sha256-pins.json";

test("v1_untouched and captured fixture bytes remain sha256 pinned", () => {
	const root = resolve(import.meta.dir, "../../../..");
	for (const [path, expected] of Object.entries(pins)) {
		let bytes = readFileSync(resolve(root, path), "utf8");
		if (path === "packages/plugin/src/index.ts") {
			// The dual-loader composition is additive. Keep the original whole
			// v1 entry golden after removing only those three exact additions.
			// The updated v1 entry records tool parameters when refusing input
			// that was dropped; the v2 loader does not add this behavior.
			// The pin was re-minted again when the v1 `chat.message` hook began
			// measuring tool definitions under the "default" agent key when
			// OpenCode 1 omits the agent (6a7158a407, "preserve LKG after host
			// adds empty summaries"); that is a deliberate v1 change, not v2 leakage.
			// It was re-minted once more when the v1 `config` hook began turning
			// off OpenCode 1's automatic compaction while Magic Context manages
			// compaction (8487f845c5, "keep the final step's usage and stop native
			// auto-compaction under Magic Context"); also a deliberate v1 change.
			bytes = bytes
				.replace('import { setup } from "./v2/server";\n', "")
				.replace("PluginModule & { setup: typeof setup }", "PluginModule")
				.replace("    server,\n    setup,", "    server,");
		}
		expect(createHash("sha256").update(bytes).digest("hex"), path).toBe(
			expected,
		);
	}
});
