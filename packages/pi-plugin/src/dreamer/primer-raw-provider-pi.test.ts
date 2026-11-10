import { afterEach, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildPrimerSeed,
	buildPrimerSeedAsync,
} from "@magic-context/core/features/magic-context/dreamer/primer-seed";
import { runMigrations } from "@magic-context/core/features/magic-context/migrations";
import { initializeDatabase } from "@magic-context/core/features/magic-context/storage-db";
import {
	createPrimer,
	getActivePrimers,
	insertPrimerCandidates,
} from "@magic-context/core/features/magic-context/storage-primers";
import {
	readSessionChunk,
	visitRawSessionMessages,
	withRawMessageProvider,
} from "@magic-context/core/hooks/magic-context/read-session-chunk";
import { extractToolCallSummaries } from "@magic-context/core/hooks/magic-context/read-session-formatting";
import { Database } from "@magic-context/core/shared/sqlite";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import { convertEntriesToRawMessages } from "../read-session-pi";
import { createPiPrimerRawProviderFactory } from "./primer-raw-provider-pi";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function store(entries: unknown[]) {
	const dir = createTestTempDirFromPath(join(tmpdir(), "mc-primer-pi-pages-"));
	dirs.push(dir);
	writeFileSync(
		join(dir, "session.jsonl"),
		[{ type: "session", version: 3, id: "origin" }, ...entries]
			.map((e) => JSON.stringify(e))
			.join("\n"),
	);
	return dir;
}
const entry = (id: string, message: unknown) => ({
	type: "message",
	id,
	timestamp: "2026-01-01T00:00:00Z",
	message,
});

test("Pi paged primer seed is byte-identical to full conversion below the token cap", async () => {
	const entries: unknown[] = [{ type: "model_change" }];
	for (let i = 0; i < 35; i++) {
		entries.push(
			entry(`u${i}`, {
				role: "user",
				content: [
					{ type: "text", text: `question ${i} café 🦉` },
					{ type: "image", data: "ignored" },
				],
			}),
		);
		entries.push(
			entry(`a${i}`, {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "ignored" },
					{
						type: "toolCall",
						id: `c${i}`,
						name: "read",
						arguments: {
							filePath: `/src/File${i}.kt`,
							content: "not a summary argument",
						},
					},
				],
			}),
		);
		entries.push(
			entry(`t${i}`, {
				role: "toolResult",
				toolCallId: `c${i}`,
				toolName: "read",
				content: [{ type: "text", text: "large output".repeat(2000) }],
			}),
		);
		if (i % 2 === 0)
			entries.push(
				entry(`next${i}`, {
					role: "assistant",
					content: [{ type: "text", text: "old conclusion" }],
				}),
			);
	}
	entries.push(
		entry("long-user", { role: "user", content: "a".repeat(9_000) }),
	);
	entries.push(
		entry("long-tool", {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "long",
					name: "bash",
					arguments: { description: "d".repeat(700) },
				},
			],
		}),
	);
	entries.push(entry("system", { role: "system", content: "hidden" }));
	const dir = store(entries);
	const provider = await createPiPrimerRawProviderFactory({ sessionDir: dir })(
		"origin",
	);
	expect(provider).not.toBeNull();
	if (!provider?.readMessagePage) throw new Error("Missing bounded provider");
	expect(JSON.stringify(provider.readMessagePage(0, 50, 100))).not.toContain(
		"large output",
	);
	const full = convertEntriesToRawMessages(entries);
	const db = new Database(":memory:");
	initializeDatabase(db);
	runMigrations(db);
	try {
		const ids = insertPrimerCandidates(db, [
			{
				projectPath: "same",
				harness: "pi",
				sessionId: "origin",
				question: "Q?",
				sourceCompartmentStart: 1,
				sourceCompartmentEnd: full.length,
				sourceMessageTime: 1,
				sourceStartMessageId: "u0",
				sourceEndMessageId: "system",
			},
		]);
		createPrimer(db, {
			projectPath: "same",
			question: "Q?",
			totalSupport: 1,
			lastObservedAt: 1,
			sourceCandidateIds: ids,
		});
		const primer = getActivePrimers(db, "same")[0];
		const oldSeed = withRawMessageProvider(
			"origin",
			{ readMessages: () => full },
			() => buildPrimerSeed(db, primer),
		);
		const newSeed = withRawMessageProvider("origin", provider, () =>
			buildPrimerSeed(db, primer),
		);
		expect(newSeed).toEqual(oldSeed);
		const asyncSeed = await withRawMessageProvider(
			"origin",
			{
				...provider,
				iterateMessageRange() {
					throw new Error("Background seed must not use the sync reader");
				},
				readMessagePage() {
					throw new Error("Background seed must not use sync pages");
				},
			},
			() => buildPrimerSeedAsync(db, primer),
		);
		expect(asyncSeed).toEqual(oldSeed);
		expect(newSeed.orientation).not.toContain("truncated");
		const ordinals: number[] = [];
		withRawMessageProvider("origin", provider, () =>
			visitRawSessionMessages(
				"origin",
				48,
				full.length,
				(m) => {
					ordinals.push(m.ordinal);
					return true;
				},
				{ summary: true },
			),
		);
		expect(ordinals).toEqual(
			full.filter((m) => m.ordinal >= 48).map((m) => m.ordinal),
		);
	} finally {
		db.close();
	}
});

test("Pi discovery reads headers only and early stop never parses a huge tail", async () => {
	const dir = store([entry("first", { role: "user", content: "hello" })]);
	const path = join(dir, "session.jsonl");
	const { appendFileSync } = await import("node:fs");
	appendFileSync(path, `\n${"x".repeat(2 * 1024 * 1024)}\n`);
	const provider = await createPiPrimerRawProviderFactory({ sessionDir: dir })(
		"origin",
	);
	expect(provider).not.toBeNull();
	if (!provider?.readMessagePage) throw new Error("Missing bounded provider");
	expect(provider.readMessagePage(0, 1, 1)[0].parts).toEqual([
		{ type: "text", text: "hello" },
	]);
	// Reading past the first message reaches the 2 MB line. It is not JSON, so
	// like Pi's own tolerant loader the bounded reader skips it (without
	// buffering it whole) and there is no second message.
	expect(provider.readMessagePage(1, 1, 2)).toEqual([]);
	expect(
		await createPiPrimerRawProviderFactory({ sessionDir: dir })("missing"),
	).toBeNull();
});

test("Pi primer default discovery uses the host agent directory and project subdirectories", async () => {
	const dir = store([entry("first", { role: "user", content: "hello" })]);
	const { mkdirSync, renameSync } = await import("node:fs");
	const { resolvePiCodingAgentModule } = await import("./pi-session-api");
	mkdirSync(join(dir, "sessions", "project"), { recursive: true });
	renameSync(
		join(dir, "session.jsonl"),
		join(dir, "sessions", "project", "session.jsonl"),
	);
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		const host = (await resolvePiCodingAgentModule()) as {
			getAgentDir: () => string;
		};
		// Refuse to run discovery if the host did not honor the throwaway root.
		expect(host.getAgentDir()).toBe(dir);
		if (host.getAgentDir() !== dir)
			throw new Error("Host session directory was not isolated");
		const provider = await createPiPrimerRawProviderFactory()("origin");
		expect(provider?.readMessagePage?.(0, 1, 1)[0].parts).toEqual([
			{ type: "text", text: "hello" },
		]);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});

test("Pi streaming ranges equal paged rows through folded tool results and close on early exit", async () => {
	const entries: unknown[] = [];
	for (let i = 0; i < 100; i++) {
		entries.push(entry(`u${i}`, { role: "user", content: `question ${i}` }));
		entries.push(
			entry(`a${i}`, {
				role: "assistant",
				content: [{ type: "text", text: `answer ${i}` }],
			}),
		);
		entries.push(
			entry(`t${i}`, {
				role: "toolResult",
				toolCallId: `c${i}`,
				toolName: "read",
				content: [{ type: "text", text: "output" }],
			}),
		);
		entries.push(
			entry(`b${i}`, {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
			}),
		);
	}
	const dir = store(entries);
	const provider = await createPiPrimerRawProviderFactory({ sessionDir: dir })(
		"origin",
	);
	if (!provider?.iterateMessageRange || !provider.readMessagePage)
		throw new Error("Missing streaming provider");
	for (const [from, to] of [
		[1, 400],
		[297, 400],
		[49, 261],
	]) {
		const expected = [];
		for (let after = from - 1; after < to; ) {
			const page = provider.readMessagePage(after, 7, to);
			expected.push(...page);
			after = page[page.length - 1].ordinal;
		}
		expect([...provider.iterateMessageRange(from, to)]).toEqual(expected);
	}
	const iterate = provider.iterateMessageRange;
	let closed = false;
	const source = {
		...provider,
		*iterateMessageRange(from: number, to: number) {
			try {
				yield* iterate(from, to);
			} finally {
				closed = true;
			}
		},
	};
	withRawMessageProvider("origin", source, () =>
		visitRawSessionMessages("origin", 1, 400, () => false),
	);
	expect(closed).toBe(true);
});

// Pi's bash tool takes no description, so its command is the only thing a
// summary line can say about the call. Both the historian chunk (full entries)
// and the bounded primer pages must keep it.
test("Pi bash calls keep their command in historian chunks and primer pages", async () => {
	const entries: unknown[] = [
		entry("u", { role: "user", content: "check the case" }),
		entry("a", {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "c1",
					name: "bash",
					arguments: { command: "cat PLAYBOOK.md" },
				},
			],
		}),
		entry("t", {
			role: "toolResult",
			toolCallId: "c1",
			toolName: "bash",
			content: [{ type: "text", text: "rule 1" }],
		}),
	];
	const full = convertEntriesToRawMessages(entries);
	const chunk = withRawMessageProvider(
		"pi-bash-command",
		{ readMessages: () => full },
		() => readSessionChunk("pi-bash-command", 10_000, 1),
	);
	expect(chunk.text).toContain("TC: bash(cat PLAYBOOK.md)");

	const provider = await createPiPrimerRawProviderFactory({
		sessionDir: store(entries),
	})("origin");
	if (!provider?.readMessagePage) throw new Error("Missing bounded provider");
	const summaries = (messages: Array<{ parts: unknown[] }>) =>
		messages.flatMap((message) => extractToolCallSummaries(message.parts));
	const paged = summaries(provider.readMessagePage(0, 50, 100));
	expect(paged).toContain("TC: bash(cat PLAYBOOK.md)");
	expect(paged).toEqual(summaries(full));
});
