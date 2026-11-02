// Every test vector, run through the WebAssembly module from JavaScript, the
// way a JavaScript runner calls it. `build.sh` builds the module first.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { load } from "./index.mjs";

const vectors = JSON.parse(
	await readFile(
		new URL("../../compaction-view/vectors/cases.json", import.meta.url),
		"utf8",
	),
);

test("every vector gives its output through the WebAssembly module", async () => {
	const view = await load();
	assert.ok(vectors.length > 0);
	for (const vector of vectors) {
		assert.deepEqual(view.call(vector.function, vector.input), vector.output, vector.name);
	}
});

test("a malformed call answers with an error", async () => {
	const view = await load();
	assert.equal(typeof view.call("no_such_function", {}).error, "string");
	assert.equal(typeof view.call("plan", { entries: "not a list" }).error, "string");
});
