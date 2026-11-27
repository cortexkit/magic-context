import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { cleanupE2ETempDir, createE2ETempDir } from "./temp-dir";
import { writeJsonAtomically } from "./write-json-atomically";

test("a polling reader sees only complete JSON before and after each publication", () => {
	const root = createE2ETempDir("mc-atomic-json-");
	const path = join(root, "probe-result-1.json");
	const read = () => fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : undefined;
	const rename = fs.renameSync;
	let previous: { seq: number; text: string } | undefined;
	let next: typeof previous;
	const beforePublish = spyOn(fs, "renameSync").mockImplementation((from, to) => {
		// Run the reader after the bytes are staged, but before the final name changes.
		expect(dirname(String(from))).toBe(root);
		expect(String(to)).toBe(path);
		expect(fs.readdirSync(root).filter((file) => file.startsWith("probe-result-"))).toEqual(
			previous ? ["probe-result-1.json"] : [],
		);
		expect(read()).toEqual(previous);
		rename(from, to);
		expect(read()).toEqual(next);
	});
	try {
		for (let seq = 0; seq < 8; seq++) {
			next = { seq, text: `row ${seq}\n`.repeat(64 * 1024) };
			writeJsonAtomically(path, next);
			expect(read()).toEqual(next);
			previous = next;
		}
		expect(beforePublish).toHaveBeenCalledTimes(8);
		expect(fs.readdirSync(root)).toEqual(["probe-result-1.json"]);
	} finally {
		beforePublish.mockRestore();
		cleanupE2ETempDir(root);
	}
});
