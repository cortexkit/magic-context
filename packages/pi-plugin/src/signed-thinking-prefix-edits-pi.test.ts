// Regression guards for signed thinking in Pi compaction-off mode on a
// prefix-bound model: a fold must not change the head in front of kept signed
// thinking. `withSession` below follows
// compaction-off-first-render-strip-pi.test.ts, with a `user` helper added.
// Cases for defects that are still open run only with
// MC_SIGNED_THINKING_OPEN_DEFECTS=1; each names its defect.
import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertMemory } from "@magic-context/core/features/magic-context/memory/storage-memory";
import {
	getOrCreateSessionMeta,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { clearCachedM0M1 } from "@magic-context/core/features/magic-context/storage-meta-shared";
import { sessionRenderCacheSelect } from "@magic-context/core/features/magic-context/storage-session-cache";
import { sessionMetaCollectionSelect } from "@magic-context/core/features/magic-context/storage-session-collections";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { bumpEpochsForWorkspaceMembers } from "@magic-context/core/features/magic-context/workspaces";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	type PiMessage,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

const MODEL = "claude-opus-5-5";

async function withSession(
	sessionId: string,
	body: (s: {
		db: ReturnType<typeof createTestDb>;
		step: (n: number) => void;
		pass: () => Promise<unknown[]>;
		restart: () => void;
		user: (text: string) => void;
		editMemory: (content: string) => void;
		bumpMemoryEpoch: () => void;
		shiftFirstTimestamp: (by: number) => void;
	}) => Promise<void>,
) {
	const xdg = createTestTempDirFromPath(join(tmpdir(), "mc-pi-spe-"));
	const originalXdg = process.env.XDG_DATA_HOME;
	process.env.XDG_DATA_HOME = xdg;
	const db = createTestDb();
	try {
		getOrCreateSessionMeta(db, sessionId);
		updateSessionMeta(db, sessionId, {
			piStableIdScheme: 1,
			lastResponseTime: Date.now(),
			cacheTtl: "59m",
		});
		const register = () => {
			const fake = createFakePi();
			registerPiContextHandler(
				fake.pi as never,
				{
					db,
					tagger: createTagger(),
					compactionOff: true,
					injection: {
						injectionBudgetTokens: 2000,
						memoryEnabled: true,
						injectDocs: false,
					},
					scheduler: { executeThresholdPercentage: 65 },
				} as never,
			);
			return fake.handlers.get("context")!;
		};
		let handler = register();
		const source: PiMessage[] = [userMessage("task", 1)];
		const ids = ["task"];
		const projectIdentity = () =>
			(
				db
					.prepare(
						"SELECT cached_m0_project_identity AS id FROM session_meta WHERE session_id = ?",
					)
					.get(sessionId) as { id: string | null }
			).id as string;
		await body({
			db,
			step: (n) => {
				source.push(
					assistantMessage("", 10 + 2 * n, {
						provider: "anthropic",
						model: MODEL,
						api: "anthropic-messages",
						content: [
							{
								type: "thinking",
								thinking: `thought ${n}`,
								thinkingSignature: `sig-${n}`,
							},
							{
								type: "toolCall",
								id: `call-${n}`,
								name: "read",
								arguments: { path: `${n}.ts` },
							},
						],
					}),
					toolResultMessage(`call-${n}`, `result ${n}`, 11 + 2 * n),
				);
				ids.push(`step-${n}`, `result-${n}`);
			},
			pass: async () => {
				const messages = structuredClone(source);
				const ctx = {
					...fakeContext(sessionId, process.cwd(), [...ids], messages),
					model: {
						provider: "anthropic",
						id: MODEL,
						api: "anthropic-messages",
						contextWindow: 200_000,
					},
					getContextUsage: () => ({
						tokens: 20_000,
						percent: 10,
						contextWindow: 200_000,
					}),
				};
				return (
					(await handler({ messages } as never, ctx as never)) as {
						messages: unknown[];
					}
				).messages;
			},
			user: (text) => {
				source.push(userMessage(text, 100 + source.length));
				ids.push(`user-${source.length}`);
			},
			restart: () => {
				clearContextHandlerSession(sessionId);
				handler = register();
			},
			editMemory: (content) => {
				const identity = projectIdentity();
				insertMemory(db, {
					projectPath: identity,
					category: "PROJECT_RULES",
					content,
					importance: 90,
				});
				bumpEpochsForWorkspaceMembers(db, identity);
			},
			bumpMemoryEpoch: () =>
				bumpEpochsForWorkspaceMembers(db, projectIdentity()),
			shiftFirstTimestamp: (by) => {
				const first = source[0] as { timestamp?: number };
				first.timestamp = (first.timestamp ?? 0) + by;
			},
		});
	} finally {
		clearContextHandlerSession(sessionId);
		closeQuietly(db);
		if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = originalXdg;
		rmSync(xdg, { recursive: true, force: true });
	}
}

const signatures = (messages: unknown[]) =>
	[
		...JSON.stringify(messages).matchAll(/"thinkingSignature":"(sig-\d+)"/g),
	].map((match) => match[1]);

/** Cases that witness a defect that is still open; see each case's comment. */
const OPEN_DEFECTS = process.env.MC_SIGNED_THINKING_OPEN_DEFECTS === "1";
const head = (messages: unknown[]) => JSON.stringify(messages.slice(0, 2));

const cachedHead = (db: ReturnType<typeof createTestDb>, sessionId: string) => {
	const row = db
		.prepare(
			`SELECT ${sessionRenderCacheSelect("cached_m0_bytes", "m0", db)}, cached_m0_materialized_at AS at, ${sessionMetaCollectionSelect("merged_reasoning_stripped_ids", "stripped", db)} FROM session_meta WHERE session_id = ?`,
		)
		.get(sessionId) as
		| { m0: Uint8Array | null; at: number | null; stripped: string | null }
		| undefined;
	return {
		m0: row?.m0 ? Buffer.from(row.m0).toString("utf8") : null,
		materializedAt: row?.at ?? null,
		stripped: row?.stripped ?? null,
	};
};

/** Runs one pass while every write of the thinking-strip record fails. */
async function passWithStripWritesFailing(s: {
	db: ReturnType<typeof createTestDb>;
	pass: () => Promise<unknown[]>;
}): Promise<void> {
	s.db.exec(
		"CREATE TEMP TRIGGER fail_thinking_strip BEFORE UPDATE OF merged_reasoning_stripped_ids ON session_meta BEGIN SELECT RAISE(ABORT, 'thinking strip write failed'); END",
	);
	// The record is a session-meta collection, which a chunked store keeps in
	// session_meta_chunks rows: every write to those rows fails as well.
	for (const event of ["INSERT", "UPDATE", "DELETE"])
		s.db.exec(
			`CREATE TEMP TRIGGER fail_thinking_strip_${event.toLowerCase()} BEFORE ${event} ON session_meta_chunks WHEN ${event === "DELETE" ? "OLD" : "NEW"}.column_name='merged_reasoning_stripped_ids' BEGIN SELECT RAISE(ABORT, 'thinking strip write failed'); END`,
		);
	try {
		await s.pass().catch(() => undefined);
	} finally {
		s.db.exec("DROP TRIGGER IF EXISTS temp.fail_thinking_strip");
		for (const event of ["insert", "update", "delete"])
			s.db.exec(`DROP TRIGGER IF EXISTS temp.fail_thinking_strip_${event}`);
	}
}

// A fold at a new turn after a memory edit, as in the case below, while the
// write that saves the strip of the earlier turn's thinking fails. Saved after
// the fold commits, the failure would leave the new head saved and the thinking
// on the wire behind it: compaction-off strips only on the pass whose fold
// re-renders the head, so no later pass would.
test("Pi compaction-off: a fold whose thinking strip cannot be saved is not saved either, and the retry folds and strips", async () => {
	const sessionId = "pi-spe-off-strip-fail";
	await withSession(sessionId, async (s) => {
		await s.pass();
		s.step(1);
		const first = await s.pass();
		s.step(2);
		await s.pass();
		const before = cachedHead(s.db, sessionId);
		s.user("next task");
		s.editMemory("keep functions small");
		await passWithStripWritesFailing(s);
		expect(cachedHead(s.db, sessionId)).toEqual(before);
		// The host sends the same request again: the fold and its strip land together.
		const out = await s.pass();
		expect(head(out) !== head(first)).toBe(true);
		expect(signatures(out)).toEqual([]);
	});
});

// A fold that re-renders the same head text while the head messages still
// differ from the served ones: here the first message's timestamp moved, which
// the head messages copy (a Pi compaction that replaces the leading messages
// does the same). The fold's transaction compares only text and image, so it
// saves no strip; the strip is decided after the commit, from the full head
// messages, as before. Without a failure it still strips; with a failing strip
// write the fold stays saved, which is the window this path keeps.
for (const failStrip of [false, true])
	test(`Pi compaction-off: a fold with the same head text but different head messages strips after the commit${failStrip ? ", strip write failing" : ""}`, async () => {
		const sessionId = `pi-spe-off-same-text-${failStrip}`;
		await withSession(sessionId, async (s) => {
			await s.pass();
			s.step(1);
			await s.pass();
			s.step(2);
			const served = await s.pass();
			const before = cachedHead(s.db, sessionId);
			s.user("next task");
			s.bumpMemoryEpoch();
			s.shiftFirstTimestamp(1_000);
			if (failStrip) {
				await passWithStripWritesFailing(s);
				const after = cachedHead(s.db, sessionId);
				expect(after.m0).toBe(before.m0);
				expect(after.materializedAt).not.toBe(before.materializedAt);
				expect(after.stripped).toBe(before.stripped);
				return;
			}
			const out = await s.pass();
			expect(cachedHead(s.db, sessionId).materializedAt).not.toBe(
				before.materializedAt,
			);
			const content = (messages: unknown[]) =>
				JSON.stringify(
					messages
						.slice(0, 2)
						.map((message) => (message as { content: unknown }).content),
				);
			expect(content(out)).toBe(content(served));
			expect(head(out)).not.toBe(head(served));
			expect(signatures(out)).toEqual([]);
		});
	});

// A fold on a pass that holds nothing (the new turn has no signed thinking
// yet) re-renders m[0] in front of the earlier turn's signed thinking, which
// stays on the wire; Anthropic invalidates every kept block behind a changed
// first user message.
test("Pi compaction-off: a dashboard memory edit folds m[0] at the next turn in front of the earlier turn's kept thinking", async () => {
	await withSession("pi-spe-off-oldturn", async (s) => {
		await s.pass();
		s.step(1);
		const first = await s.pass();
		s.step(2);
		await s.pass();
		s.user("next task");
		s.editMemory("keep functions small");
		const out = await s.pass();
		const kept = signatures(out);
		const changed = head(out) !== head(first);
		// The edit must reach the head, or the case proves nothing.
		expect(changed).toBe(true);
		expect(kept).toEqual([]);
	});
});

// A first render after a restart whose head is byte-identical to the served
// one. The kept thinking is still valid, so the case expects it kept; it is red
// when the pass strips it anyway (Pi keeps no compaction-off served array
// across a restart, so it cannot prove the head unchanged).
// Open defect: after a restart Pi strips signed thinking on a compaction-off first render even when the head is unchanged.
test.skipIf(!OPEN_DEFECTS)(
	"Pi compaction-off: a first render after a restart with an unchanged head",
	async () => {
		await withSession("pi-spe-off-restart-same-head", async (s) => {
			await s.pass();
			s.step(1);
			const before = await s.pass();
			clearCachedM0M1(s.db, "pi-spe-off-restart-same-head");
			s.restart();
			s.step(2);
			const out = await s.pass();
			expect(head(out)).toBe(head(before));
			expect(signatures(out)).toEqual(["sig-1", "sig-2"]);
		});
	},
);
