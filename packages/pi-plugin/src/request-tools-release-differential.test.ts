import { afterEach, expect, it, spyOn } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getOrCreateSessionMeta,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { openDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import {
	_resetHarnessForTesting,
	setHarness,
} from "@magic-context/core/shared/harness";
import * as logger from "@magic-context/core/shared/logger";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
	signalPiSystemHashChange,
} from "./context-handler";
import {
	clearPiSystemPromptSession,
	processSystemPromptForCache,
} from "./system-prompt";
import {
	assistantMessage,
	createFakePi,
	fakeContext,
	type PiMessage,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

// Differential for the request-tools release on a prefix-bound model in Pi and
// OMP: when the active tools never change, reading them must not change a
// single served byte on any pass of a long session, and must never release.
// The same scripted session runs twice on separate databases: once where the
// host exposes no active-tool list (so no fingerprint exists, the behaviour
// before the release), and once where it does. The script mixes completed
// turns with signed thinking, held tool loops after heavy reasoning, and usage
// that climbs through the execute threshold into the force band.

const MODEL = "claude-fable-5-2";
const PASSES = 60;

const roots: string[] = [];
afterEach(() => {
	_resetHarnessForTesting();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

async function run(
	harness: "pi" | "omp",
	withActiveTools: boolean,
	schemaChangeAt?: number,
) {
	const name = `${harness}-${withActiveTools ? "with" : "without"}${schemaChangeAt === undefined ? "" : "-changed"}`;
	const parent = join(
		tmpdir(),
		"magic-context",
		"request-tools-release-differential",
	);
	mkdirSync(parent, { recursive: true });
	const root = createTestTempDirFromPath(join(parent, `${name}-`));
	roots.push(root);
	const sessionId = `pi-tools-diff-${name}`;
	_resetHarnessForTesting();
	setHarness(harness);
	const db = openDatabase(join(root, "context.db"));
	if (!db) throw new Error("throwaway database unavailable");
	getOrCreateSessionMeta(db, sessionId);
	updateSessionMeta(db, sessionId, {
		piStableIdScheme: 1,
		lastResponseTime: Date.now(),
		cacheTtl: "never",
	});
	const tools = [
		{
			name: "read",
			description: "Read a file",
			parameters: {
				type: "object",
				properties: { path: { type: "string" } },
			},
		},
		{
			name: "bash",
			description: "Run a command",
			parameters: {
				type: "object",
				properties: { command: { type: "string" } },
			},
		},
	];
	const fake = createFakePi();
	Object.assign(fake.pi, {
		getAllTools: () => tools,
		...(withActiveTools ? { getActiveTools: () => ["read", "bash"] } : {}),
	});
	registerPiContextHandler(fake.pi as never, {
		db,
		tagger: createTagger(),
		protectedTokens: 4000,
		injection: {
			injectionBudgetTokens: 1000,
			memoryEnabled: false,
			injectDocs: false,
		},
		heuristics: { keepReasoningTokens: 2000 },
		scheduler: { executeThresholdPercentage: 65 },
	});
	const source: PiMessage[] = [];
	const ids: string[] = [];
	const logs = spyOn(logger, "sessionLog").mockImplementation(() => {});
	const served: string[] = [];
	try {
		let clock = 0;
		let turn = 0;
		for (let index = 0; index < PASSES; index++) {
			if (index === schemaChangeAt)
				tools[0] = {
					name: "read",
					description: "Read a file",
					parameters: {
						type: "object",
						properties: { path: { type: "string" } },
						required: ["path"],
					} as never,
				};
			clock += 10;
			if (index % 5 === 0) {
				turn += 1;
				source.push(
					userMessage(`task ${turn}: ${"detail ".repeat(40)}`, clock),
				);
				ids.push(`p${turn}`);
			} else {
				// Every third turn's steps reason heavily, so its tool loop is held.
				const heavy = turn % 3 === 0;
				const id = `a${turn}-${index % 5}`;
				source.push(
					assistantMessage("", clock, {
						provider: "anthropic",
						model: MODEL,
						api: "anthropic-messages",
						content: [
							{
								type: "thinking",
								thinking: `thinking ${id}`,
								thinkingSignature: `sig-${id}`,
							},
							{
								type: "toolCall",
								id: `call-${id}`,
								name: "read",
								arguments: { path: `src/${id}.ts` },
							},
						],
						usage: {
							input: 0,
							output: 80,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 80,
							reasoning: heavy ? 1_600 : 200,
							cost: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								total: 0,
							},
						},
					}),
					toolResultMessage(
						`call-${id}`,
						`contents of ${id}\n${"line\n".repeat(60)}`,
						clock + 1,
					),
				);
				ids.push(id, `r-${id}`);
			}
			const prompt = processSystemPromptForCache({
				db,
				sessionId,
				systemPrompt: "base instruction",
				isCacheBusting: false,
			});
			if (prompt.hashChanged)
				signalPiSystemHashChange(sessionId, prompt.currentHash);
			// Usage climbs from 10% through the execute threshold into the force band.
			const percent = Math.min(90, 10 + index * 1.4);
			const messages = structuredClone(source);
			const ctx = {
				...fakeContext(sessionId, process.cwd(), [...ids], messages),
				getSystemPrompt: () => prompt.systemPrompt,
				model: {
					provider: "anthropic",
					id: MODEL,
					api: "anthropic-messages",
					contextWindow: 200000,
				},
				getContextUsage: () => ({
					tokens: percent * 2000,
					percent,
					contextWindow: 200000,
				}),
			};
			const handler = fake.handlers.get("context");
			if (!handler) throw new Error("context handler was not registered");
			const result = (await handler({ messages } as never, ctx as never)) as
				| { messages: unknown[] }
				| undefined;
			served.push(
				JSON.stringify(result?.messages ?? messages).replaceAll(
					sessionId,
					"SESSION",
				),
			);
		}
		const lines = logs.mock.calls.map((call) => String(call[1]));
		return {
			served,
			releases: lines.filter((line) => line.startsWith("request tools changed"))
				.length,
			adoptions: lines.filter((line) =>
				line.startsWith("request tools fingerprint adopted"),
			).length,
			holds: lines.filter((line) =>
				line.startsWith("signed thinking hold: held=true"),
			).length,
		};
	} finally {
		logs.mockRestore();
		clearContextHandlerSession(sessionId);
		clearPiSystemPromptSession(sessionId);
		db.close();
	}
}

for (const harness of ["pi", "omp"] as const) {
	it(`${harness}, claude-fable-5-2: unchanged tools serve every pass byte for byte and never release`, async () => {
		const without = await run(harness, false);
		const withTools = await run(harness, true);
		expect(withTools.served).toHaveLength(PASSES);
		for (let index = 0; index < PASSES; index++) {
			expect({ pass: index, bytes: withTools.served[index] }).toEqual({
				pass: index,
				bytes: without.served[index],
			});
		}
		expect(withTools.releases).toBe(0);
		expect(withTools.adoptions).toBe(1);
		expect(without.adoptions).toBe(0);
		// The script reaches held passes, not only unheld ones.
		expect(withTools.holds).toBeGreaterThan(0);
	}, 300_000);
}

// Control: the same comparison does see a release. A schema-only change makes
// the run that reads the active tools differ from the pass it lands on, and
// only from there.
it("pi, claude-fable-5-2: a schema-only change is the first pass that differs, and releases once", async () => {
	const changeAt = 32;
	const without = await run("pi", false, changeAt);
	const withTools = await run("pi", true, changeAt);
	for (let index = 0; index < changeAt; index++)
		expect(withTools.served[index]).toBe(without.served[index]);
	expect(withTools.served[changeAt]).not.toBe(without.served[changeAt]);
	expect(withTools.releases).toBe(1);
}, 300_000);
