// Generate queued-tool replay shapes through the TypeScript pending-operation planner.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	applyNewToolDrop,
	RECENT_TOOL_SKELETON_WINDOW,
} from "../../../packages/plugin/src/hooks/magic-context/apply-operations";
import type { TagTarget } from "../../../packages/plugin/src/hooks/magic-context/tag-messages";

const tools = 21;
const newest = new Set(
	Array.from({ length: tools }, (_, i) => i + 1)
		.sort((a, b) => b - a)
		.slice(0, RECENT_TOOL_SKELETON_WINDOW),
);
const vectors = [1, 2].map((ordinal) => {
	const target: TagTarget = {
		setContent: () => true,
		prepareDrop: () => true,
		inputStringBytes: () => 4,
		skeletonReal: () => "truncated",
		drop: () => "removed",
	};
	const outcome = applyNewToolDrop(target, {
		inWindow: newest.has(ordinal),
		persist: () => {},
	});
	return { tools, ordinal, mode: outcome.mode };
});
const path = join(import.meta.dir, "../testdata/queued-tool-shapes.json");
const output = `${JSON.stringify(vectors, null, 2)}\n`;
if (process.argv.includes("--check")) {
	if (readFileSync(path, "utf8") !== output)
		throw new Error("queued-tool shapes are stale");
} else {
	writeFileSync(path, output);
}
console.log(`Queued-tool shapes: ${vectors.length} TypeScript planner vectors`);
