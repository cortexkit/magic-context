import { expect, test } from "bun:test";
import { piCheckPreparedDispatch } from "./pi-dispatch-acceptance";
import {
	createPiForeignSessionIndex,
	piForeignEvidence,
	piProtectPreparedRows,
} from "./pi-dispatch-foreign";
import { piPreparedStructure } from "./pi-dispatch-structure";

const model = { api: "anthropic-messages", provider: "test", id: "test" };
const prompt = { role: "user", content: "latest prompt", timestamp: 1 };
const managed = { ...prompt, content: "§1§ latest prompt" };
const prepared = piPreparedStructure([managed], model);
const image = { type: "image", mimeType: "image/png", data: "AAAA" };

function fixture(entry: Record<string, unknown>) {
	const index = createPiForeignSessionIndex();
	let entries = [entry];
	const source = { getEntries: () => entries };
	const check = (text: string) => {
		const evidence = piForeignEvidence(source, [prompt], index);
		piProtectPreparedRows(evidence, [managed], prepared);
		return (
			piCheckPreparedDispatch(
				{
					system: "system",
					messages: [{ role: "user", content: text }, managed],
				},
				prepared,
				evidence,
			).mismatch ?? "accepted"
		);
	};
	expect(check("foreign bootstrap")).toBe("accepted");
	return {
		index,
		check,
		removeEntries: () => {
			entries = [];
		},
	};
}

function preserved(
	f: ReturnType<typeof fixture>,
	before: string,
	after: string,
) {
	expect(f.check(after)).toContain("session-content");
	expect(f.check(before)).toContain("session-content");
	// The lifetime protection is a digest, not an old full-text cache key.
	expect(f.index.currentTexts.has(before)).toBe(false);
}

test("native in-place shake content replacement protects new and old text", () => {
	const before = "assistant text before shake";
	const after = "[Content elided; read artifact://shake/0 for the original]";
	const body = {
		role: "assistant",
		content: [{ type: "text", text: before }],
		timestamp: 0,
	};
	const f = fixture({ type: "message", id: "entry", message: body });
	body.content = [{ type: "text", text: after }];
	preserved(f, before, after);
});

test("native in-place custom image removal protects new and old text", () => {
	const before =
		"Images attached to illustration.\n[image omitted: the active model does not support image input]";
	const entry: Record<string, unknown> = {
		type: "custom_message",
		id: "entry",
		customType: "illustration",
		content: [image],
		display: false,
		timestamp: 0,
	};
	const f = fixture(entry);
	entry.content = [{ type: "text", text: "[image removed]" }];
	preserved(f, before, "[image removed]");
});

test("native in-place pruning protects the new native placeholder and old output", () => {
	const before = "read output before native pruning";
	// Oh My Pi advisor/tool-result-eviction.ts createEvictionNotice(1200).
	const after = "[Stale result elided - 1200 tokens]";
	const body: Record<string, unknown> = {
		role: "toolResult",
		toolCallId: "read1",
		toolName: "read",
		content: [{ type: "text", text: before }],
		timestamp: 0,
	};
	const f = fixture({ type: "message", id: "entry", message: body });
	body.content = [{ type: "text", text: after }];
	body.prunedAt = 2;
	preserved(f, before, after);
});

test("native in-place file image removal observes nested fields on the same files array", () => {
	const files: Record<string, unknown>[] = [
		{ path: "a.png", image },
		{ path: "b.txt", content: "body" },
	];
	const body = { role: "fileMention", files, timestamp: 0 };
	const f = fixture({ type: "message", id: "entry", message: body });
	files[0].image = undefined;
	preserved(
		f,
		'<file path="a.png">\n</file>\n[image omitted: the active model does not support image input]',
		'<file path="a.png">\n</file>\n<file path="b.txt">\nbody\n</file>',
	);
});

test("native in-place text edits observe strings inside a retained block and array", () => {
	const before = "text before a block rewrite",
		after = "text after a block rewrite";
	const block = { type: "text", text: before };
	const body = { role: "assistant", content: [block], timestamp: 0 };
	const f = fixture({ type: "message", id: "entry", message: body });
	block.text = after;
	preserved(f, before, after);
});

test("native in-place argument edits observe nested long strings without relying on argument identity", () => {
	const before = "a".repeat(64),
		after = "b".repeat(64);
	const args = { nested: { body: before } };
	const body = {
		role: "assistant",
		content: [
			{ type: "toolCall", id: "write1", name: "write", arguments: args },
		],
		timestamp: 0,
	};
	const f = fixture({ type: "message", id: "entry", message: body });
	args.nested.body = after;
	preserved(f, before, after);
});

test("native in-place unreadable shape changes disable the allowance after a warm cache", () => {
	const body = {
		role: "assistant",
		content: [{ type: "text", text: "before" }],
		timestamp: 0,
	};
	const f = fixture({ type: "message", id: "entry", message: body });
	body.content = [{ type: "unknown-block", text: "after" }];
	expect(f.check("foreign bootstrap")).toContain("unreadable-branch");
	expect(f.check("foreign bootstrap")).toContain("unreadable-branch");
});

test("native in-place throwing fields fail closed and do not poison later valid rewrites", () => {
	const before = "content before the throwing getter",
		after = "content after the getter is repaired";
	const body = { role: "user", content: before, timestamp: 0 };
	const f = fixture({ type: "message", id: "entry", message: body });
	Object.defineProperty(body, "content", {
		configurable: true,
		get: () => {
			throw new Error("unreadable");
		},
	});
	expect(f.check("foreign bootstrap")).toContain("unreadable-branch");
	Object.defineProperty(body, "content", {
		configurable: true,
		writable: true,
		value: after,
	});
	preserved(f, before, after);
});

test("removing an entry releases old text keys but never its lifetime session fingerprint", () => {
	const before = "text from an entry removed by a whole-session rewrite";
	const f = fixture({
		type: "message",
		id: "entry",
		message: { role: "user", content: before, timestamp: 0 },
	});
	f.removeEntries();
	expect(f.check(before)).toContain("session-content");
	expect(f.index.currentTexts.has(before)).toBe(false);
	expect(f.index.entries.size).toBe(0);
});
