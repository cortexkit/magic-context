import { expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as filesystem from "node:fs";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { listOpenFiles } from "../../plugin/src/shared/test-open-files";

const root = process.env.FENCE_REVIEW_OUTPUT;
const source = resolve(
	process.env.FENCE_REVIEW_SOURCE ?? join(import.meta.dir, "../../.."),
);
const host = process.env.FENCE_REVIEW_HOST;
const seed = Number(process.env.FENCE_REVIEW_SEED ?? 81273);
const load = (path: string) => import(join(source, "packages", path));
function proveIsolation() {
	const result = listOpenFiles();
	// Missing evidence must not be interpreted as an isolated independent host.
	if (!result.available) throw new Error(result.reason);
	const paths = result.paths;
	expect(
		paths.some((line) =>
			/\/(?:\.local\/share\/opencode|\.local\/share\/cortexkit\/magic-context|\.config\/(?:opencode|cortexkit))\//.test(
				line,
			),
		),
	).toBe(false);
	console.log(
		`INDEPENDENT_LSOF pid=${process.pid} paths=${paths.length} forbidden=0`,
	);
}
const median = (times: number[]) =>
	[...times].sort((a, b) => a - b)[Math.floor(times.length / 2)];

function filesystemProbe() {
	const fs = filesystem as unknown as Record<string, unknown>;
	const operations: string[] = [];
	const descriptors = new Set<number>();
	const restorers: Array<() => void> = [];
	for (const name of [
		"openSync",
		"closeSync",
		"readFileSync",
		"writeFileSync",
		"writeSync",
		"fsyncSync",
		"renameSync",
		"readdirSync",
		"lstatSync",
		"statSync",
		"rmSync",
		"mkdirSync",
	]) {
		const original = fs[name] as (...args: unknown[]) => unknown;
		const spy = (
			spyOn as unknown as (
				object: unknown,
				method: string,
			) => {
				mockImplementation(fn: (...args: unknown[]) => unknown): void;
				mockRestore(): void;
			}
		)(fs, name);
		spy.mockImplementation((...args) => {
			const relevant =
				args.some(
					(arg) =>
						typeof arg === "string" && arg.includes("lkg-recovery-fences"),
				) ||
				(typeof args[0] === "number" && descriptors.has(args[0]));
			if (relevant) operations.push(name);
			const result = original(...args);
			if (name === "openSync" && relevant && typeof result === "number")
				descriptors.add(result);
			if (name === "closeSync" && typeof args[0] === "number")
				descriptors.delete(args[0]);
			return result;
		});
		restorers.push(() => spy.mockRestore());
	}
	return {
		operations,
		restore: () => {
			for (const restore of restorers.reverse()) restore();
		},
	};
}

function stream() {
	let state = seed >>> 0;
	const next = () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return state >>> 0;
	};
	const atoms = [
		"§literal§",
		"\n",
		"\t",
		"🙂",
		"é",
		"日本",
		"<tool>",
		'"quote"',
		"\\",
		"plain ",
	];
	return Array.from({ length: 120 }, (_, turn) => {
		const kind = next() % 3;
		let text = `turn ${turn}: `;
		for (let i = 0, n = 10 + (next() % 30); i < n; i++)
			text += atoms[next() % atoms.length];
		return {
			turn,
			kind,
			text,
			execute: next() % 7 === 0,
			signed: next() % 4 === 0,
		};
	});
}

test.skipIf(!root || !host)(
	"independent randomized complete-request corpus and warm I/O",
	async () => {
		if (!root) throw new Error("Missing FENCE_REVIEW_OUTPUT");
		mkdirSync(root, { recursive: true });
		const harness = await load("plugin/src/shared/harness.ts");
		harness.setHarness(host === "pi" ? "pi" : "opencode");
		const operations: string[] = [];
		let restore = () => {};
		if (
			existsSync(
				join(
					source,
					"packages/plugin/src/hooks/magic-context/lkg-recovery-fence.ts",
				),
			)
		) {
			const fence = await load(
				"plugin/src/hooks/magic-context/lkg-recovery-fence.ts",
			);
			restore = fence.__test.setIoObserver((op: string) => operations.push(op));
		}
		const probe = filesystemProbe();
		const wires: string[] = [];
		const times: number[] = [];
		const executions: boolean[] = [];
		const session = `independent-${host}-${seed}`;
		const project = process.env.FENCE_REVIEW_CWD ?? process.cwd();
		const signed = process.env.FENCE_REVIEW_SIGNED !== "0";
		const pressure = process.env.FENCE_REVIEW_PRESSURE === "1";
		const plan = stream();
		let dispose = async () => {};
		try {
			if (host === "pi") {
				const u = await load("pi-plugin/src/test-utils.test.ts");
				const { registerPiContextHandler, clearContextHandlerSession } =
					await load("pi-plugin/src/context-handler.ts");
				const db = u.createTestDb(join(root, "context.db"));
				const fake = u.createFakePi();
				registerPiContextHandler(fake.pi, {
					db,
					scheduler: { executeThresholdPercentage: 80 },
					heuristics: { keepReasoningTokens: 1000 },
					injection: {
						memoryEnabled: false,
						injectDocs: false,
						temporalAwareness: false,
					},
				});
				dispose = async () => {
					clearContextHandlerSession(session);
					db.close();
				};
				const raw = [u.userMessage("Independent fixed head", 1)];
				for (const item of plan) {
					raw.push(u.userMessage(item.text, item.turn * 10 + 2));
					if (item.kind === 1) {
						raw.push(
							u.assistantToolCall(
								`call-${item.turn}`,
								"read",
								{ path: `file-${item.turn}.ts`, line: item.turn },
								item.turn * 10 + 3,
							),
						);
						raw.push(
							u.toolResultMessage(
								`call-${item.turn}`,
								`${item.text} result`,
								item.turn * 10 + 4,
							),
						);
					} else {
						const assistant = u.assistantMessage(
							`${item.text} answer`,
							item.turn * 10 + 3,
							signed
								? {
										api: "anthropic-messages",
										provider: "anthropic",
										model: "claude-opus-5-5",
									}
								: {},
						);
						if (signed && item.signed)
							assistant.content.unshift({
								type: "thinking",
								thinking: `reason ${item.turn}`,
								thinkingSignature: `proof-${item.turn}`,
							});
						raw.push(assistant);
					}
					const messages = structuredClone(raw);
					const ctx = {
						...u.fakeContext(
							session,
							project,
							raw.map((_: unknown, i: number) => `entry-${i}`),
							raw,
						),
						getSystemPrompt: () => "Independent system.",
						getContextUsage: () => ({
							tokens: pressure && item.execute ? 180000 : 10000,
							percent: pressure && item.execute ? 90 : 5,
							contextWindow: 200000,
						}),
						model: {
							provider: signed ? "anthropic" : "openai",
							id: signed ? "claude-opus-5-5" : "gpt-4.1",
							contextWindow: 200000,
							maxTokens: 10000,
						},
					};
					operations.length = 0;
					probe.operations.length = 0;
					const start = performance.now();
					const result = await fake.handlers.get("context")({ messages }, ctx);
					times.push(performance.now() - start);
					if (item.turn === 0) proveIsolation();
					wires.push(JSON.stringify(result));
					await new Promise((done) => setImmediate(done));
					if (item.turn > 1 && !pressure) {
						expect(probe.operations).toEqual([]);
						expect(operations).toEqual([]);
					}
					executions.push(pressure && item.execute);
				}
			} else {
				const storage = await load(
					"plugin/src/features/magic-context/storage-db.ts",
				);
				const { createTransform } = await load(
					"plugin/src/hooks/magic-context/transform.ts",
				);
				const { createTagger } = await load(
					"plugin/src/features/magic-context/tagger.ts",
				);
				const availability = await load(
					"plugin/src/hooks/magic-context/ctx-reduce-availability.ts",
				);
				availability.setCtxReduceRegisteredGlobally(true);
				const db = storage.openDatabase(join(root, "context.db"));
				if (!db) throw new Error("No isolated context.db");
				let execute = false;
				const refresh = new Set<string>();
				const transform = createTransform({
					db,
					tagger: createTagger(),
					scheduler: { shouldExecute: () => (execute ? "execute" : "defer") },
					contextUsageMap: new Map(),
					historyRefreshSessions: refresh,
					pendingMaterializationSessions: new Set(),
					lastHeuristicsTurnId: new Map(),
					historianRunnable: false,
					protectedTokens: 0,
					clearReasoningAge: 1000,
					directory: project,
					memoryConfig: { enabled: false },
					injectDocs: false,
					liveModelBySession: new Map([
						[
							session,
							{
								providerID: signed ? "anthropic" : "openai",
								modelID: signed ? "claude-opus-5-5" : "gpt-4.1",
							},
						],
					]),
				});
				dispose = async () => {
					transform.disposeRust();
					storage.closeDatabase();
					availability.resetCtxReduceRegisteredGloballyForTest();
				};
				const model = {
					providerID: signed ? "anthropic" : "openai",
					modelID: signed ? "claude-opus-5-5" : "gpt-4.1",
				};
				const raw: Array<{
					info: Record<string, unknown>;
					parts: Array<Record<string, unknown>>;
				}> = [];
				const add = (
					role: string,
					parts: Array<Record<string, unknown>>,
					turn: number,
				) =>
					raw.push({
						info: {
							id: `m-${raw.length}`,
							role,
							sessionID: session,
							model,
							tools: { ctx_reduce: true, read: true },
							time: { created: turn + 1 },
							...(role === "assistant" ? { finish: "stop" } : {}),
						},
						parts,
					});
				add("user", [{ type: "text", text: "Independent fixed head" }], 0);
				const { createMessagesTransformHandler } = await load(
					"plugin/src/plugin/messages-transform.ts",
				);
				const wrapper = createMessagesTransformHandler({
					magicContext: { "experimental.chat.messages.transform": transform },
				});
				// The v2 bridge is used directly so execute/defer is controlled, rather than
				// inferred from a timing-sensitive historian scheduled by a fake host.
				const adapter =
					host === "oc2"
						? await load("plugin/src/v2/hooks/payload.ts")
						: undefined;
				for (const item of plan) {
					add("user", [{ type: "text", text: item.text }], item.turn * 10 + 2);
					if (item.kind === 1)
						add(
							"assistant",
							[
								{
									type: "tool",
									callID: `call-${item.turn}`,
									tool: "read",
									state: {
										status: "completed",
										input: { path: `file-${item.turn}.ts` },
										output: `${item.text} result`,
										time: {
											start: item.turn * 10 + 3,
											end: item.turn * 10 + 4,
										},
									},
								},
							],
							item.turn * 10 + 3,
						);
					else
						add(
							"assistant",
							[
								...(signed && item.signed
									? [
											{
												type: "reasoning",
												text: `reason ${item.turn}`,
												metadata: {
													anthropic: { signature: `proof-${item.turn}` },
												},
											},
										]
									: []),
								{ type: "text", text: `${item.text} answer` },
							],
							item.turn * 10 + 3,
						);
					execute = item.execute;
					operations.length = 0;
					probe.operations.length = 0;
					const output = { messages: structuredClone(raw) };
					const start = performance.now();
					if (adapter) {
						const draft = {
							sessionID: session,
							model: {
								providerID: model.providerID,
								id: model.modelID,
								limit: { context: 200000 },
							},
							agent: "build",
							system: [],
							options: {},
							tools: {
								ctx_reduce: {
									description: "reduce",
									input: { type: "object" },
								},
								read: { description: "read", input: { type: "object" } },
							},
							messages: raw.map((m) => ({
								id: m.info.id,
								role: m.info.role,
								content: m.parts,
							})),
						};
						const adapted = adapter.adaptPayload(draft);
						await wrapper({}, adapted);
						adapted.commit();
						wires.push(JSON.stringify(draft));
					} else {
						await wrapper({}, output);
						wires.push(JSON.stringify(output));
					}
					times.push(performance.now() - start);
					if (item.turn === 0) proveIsolation();
					await new Promise((done) => setImmediate(done));
					if (item.turn > 1) {
						expect(probe.operations).toEqual([]);
						expect(operations).toEqual([]);
					}
					executions.push(execute);
				}
			}
			expect(wires).toHaveLength(120);
			expect(new Set(wires).size).toBe(120);
			expect(wires[0]).toContain("§1§");
			writeFileSync(join(root, `${host}-${seed}.json`), JSON.stringify(wires));
			console.log(
				"INDEPENDENT " +
					JSON.stringify({
						host,
						seed,
						signed,
						pressure,
						samples: wires.length,
						execute: executions.filter(Boolean).length,
						warmMedianMs: median(times.slice(10)),
						warmMinMs: Math.min(...times.slice(10)),
						warmMaxMs: Math.max(...times.slice(10)),
						warmFenceIo: operations.length,
						filesystemFenceIo: probe.operations.length,
					}),
			);
		} finally {
			restore();
			probe.restore();
			await dispose();
		}
	},
	120000,
);
