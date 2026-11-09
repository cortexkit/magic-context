import { createHash } from "node:crypto";
import {
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	isCompactionEnabled,
	isDreamerRunnable,
} from "@magic-context/core/config/agent-disable";
import {
	openDatabase,
	resolveDatabasePath,
} from "@magic-context/core/features/magic-context/storage-db";
import {
	getOrCreateSessionMeta,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage-meta";
import { getHarness } from "@magic-context/core/shared/harness";
import { loadPiConfig } from "../config";
import type { ParitySequence } from "./standalone-prompt-parity-cases";

interface WorkerInput {
	revision: "base" | "current";
	host: "pi" | "omp";
	root: string;
	sequences: ParitySequence[];
}
type Hook = (event: unknown, ctx: unknown) => unknown;
interface PromptEvent {
	systemPrompt: string;
	systemPromptOptions?: { sections: Record<string, string> };
}
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const sourceDir = resolve(import.meta.dir, "..");
const fixtureDir = import.meta.dir;
const start = '\tpi.on("before_agent_start", async (event, ctx) => {';
const end = '\n\tinfo("registered before_agent_start system prompt injector");';
const historicalHandler = readFileSync(
	join(fixtureDir, "before-agent-start-3debe36.ts.txt"),
	"utf8",
);
const historicalHelper = readFileSync(
	join(fixtureDir, "system-prompt-9d4fb56b.ts.txt"),
	"utf8",
);

/** Only import paths and a read-only observer change; the historical hook stays verbatim. */
function materialize(revision: WorkerInput["revision"]) {
	const prefix = `.standalone-parity-${process.pid}`;
	const systemName = `${prefix}-system`;
	const composerName = `${prefix}-composer`;
	const indexPath = join(sourceDir, `${prefix}-index.ts`);
	const systemPath = join(sourceDir, `${systemName}.ts`);
	const composerPath = join(sourceDir, `${composerName}.ts`);
	let index = readFileSync(join(sourceDir, "index.ts"), "utf8");
	const from = index.indexOf(start);
	const to = index.indexOf(end, from);
	if (from < 0 || to < 0)
		throw new Error("Registered standalone hook boundary not found");
	let system: string;
	if (revision === "base") {
		index = index.slice(0, from) + historicalHandler + index.slice(to);
		index = index.replace(
			'import { composePiSystemPrompt } from "./compose-system-prompt-pi";\n',
			"",
		);
		index = index.replace(
			'import { clearPiSystemPromptSession } from "./system-prompt";',
			'import { buildMagicContextBlock, clearPiSystemPromptSession, composeMagicContextSystemPrompt, processSystemPromptForCache } from "./system-prompt";',
		);
		system = historicalHelper;
	} else {
		system = readFileSync(join(sourceDir, "system-prompt.ts"), "utf8");
		const composer = readFileSync(
			join(sourceDir, "compose-system-prompt-pi.ts"),
			"utf8",
		).replace('"./system-prompt"', `"./${systemName}"`);
		writeFileSync(composerPath, composer);
		index = index.replace(
			'"./compose-system-prompt-pi"',
			`"./${composerName}"`,
		);
	}
	const actualHandler = index.slice(
		index.indexOf(start),
		index.indexOf(end, index.indexOf(start)),
	);
	if (revision === "base" && actualHandler !== historicalHandler)
		throw new Error("Historical hook changed during materialization");
	index = index.replace('"./system-prompt"', `"./${systemName}"`);
	const dateMap =
		revision === "base" ? "stickyDateBySession" : "stickyDateBySessionDefault";
	writeFileSync(
		systemPath,
		`${system}\nexport const __parityStickyDates = () => [...${dateMap}].sort(([a], [b]) => a.localeCompare(b));\n`,
	);
	writeFileSync(indexPath, index);
	return {
		indexPath,
		systemPath,
		handlerDigest: sha(actualHandler),
		helperDigest: sha(system),
		cleanup() {
			for (const path of [
				indexPath,
				systemPath,
				...(revision === "current" ? [composerPath] : []),
			])
				unlinkSync(path);
		},
	};
}

function capturePi() {
	const handlers = new Map<string, Hook[]>();
	const bus = new Map<string, Set<(data: unknown) => void>>();
	const pi = {
		on(name: string, handler: Hook) {
			const registered = handlers.get(name) ?? [];
			registered.push(handler);
			handlers.set(name, registered);
		},
		events: {
			on(name: string, handler: (data: unknown) => void) {
				const listeners = bus.get(name) ?? new Set();
				listeners.add(handler);
				bus.set(name, listeners);
				return () => listeners.delete(handler);
			},
		},
		registerTool() {},
		registerCommand() {},
		registerFlag() {},
		registerEntryRenderer() {},
		getActiveTools: () => [],
		setActiveTools() {},
		appendEntry() {},
		sendMessage() {},
		sendUserMessage() {},
	} as unknown as ExtensionAPI;
	return {
		pi,
		async emit(name: string, event: unknown, ctx: unknown) {
			const results: unknown[] = [];
			for (const handler of handlers.get(name) ?? [])
				results.push(await handler(event, ctx));
			return results;
		},
		promptHooks: () => handlers.get("before_agent_start")?.length ?? 0,
	};
}

// JSON normally conflates an undefined hook return with null inside an array.
function encodeReturn(value: unknown): unknown {
	if (value === undefined) return { undefined: true };
	if (Array.isArray(value)) return value.map(encodeReturn);
	return value;
}

export async function runStandaloneParityWorker(input: WorkerInput) {
	process.title = input.host;
	if (!resolveDatabasePath().dbPath.startsWith(`${input.root}/`))
		throw new Error("Parity database escaped its isolated root");
	const generated = materialize(input.revision);
	let now = Date.UTC(2026, 9, 12);
	const originalNow = Date.now;
	Date.now = () => now;
	const fd = openSync(join(input.root, "trace.ndjson"), "w");
	const transcript = createHash("sha256");
	const counts = {
		sequences: 0,
		turns: 0,
		events: 0,
		confirmedSwitches: 0,
		canceledSwitches: 0,
		hookCalls: 0,
	};
	try {
		const extension = (await import(generated.indexPath)).default;
		const { __parityStickyDates } = await import(generated.systemPath);
		const signals = await import("../context-handler");
		const { buildSystemPrompt, normalizeBuildSystemPromptOptions } =
			await import(
				new URL(
					"./core/system-prompt.js",
					import.meta.resolve("pi-coding-agent-087"),
				).href
			);
		for (const [sequenceIndex, sequence] of input.sequences.entries()) {
			counts.sequences++;
			const userConfig = join(input.root, "config/cortexkit");
			mkdirSync(userConfig, { recursive: true });
			const overridePath = join(userConfig, "override.md");
			writeFileSync(
				overridePath,
				`## Magic Context\nAuthored override ${sequence.seed}/0.`,
			);
			writeFileSync(
				join(userConfig, "magic-context.json"),
				JSON.stringify({
					language: sequence.profiles[0].language,
					smart_notes: { enabled: sequence.profiles[0].smartNotes },
					compaction: { enabled: sequence.profiles[0].compaction },
					prompt_surface: sequence.profiles[0].override
						? { guidance_override_path: overridePath }
						: {},
				}),
			);
			const projectRoots = sequence.profiles.map((profile, project) => {
				const root = join(input.root, `project-${sequenceIndex}-${project}`);
				mkdirSync(join(root, ".cortexkit"), { recursive: true });
				writeFileSync(
					join(root, ".cortexkit/magic-context.json"),
					JSON.stringify({
						memory: { enabled: profile.memory },
						historian: { disable: true },
						system_prompt_injection: {
							enabled: profile.injection,
							skip_signatures: profile.skip ? ["PARITY_SKIP", ""] : [""],
						},
						temporal_awareness: profile.temporal,
						caveman_text_compression: { enabled: profile.caveman },
						dreamer: { disable: !profile.dreamer },
						prompt_surface: {
							default: profile.preset,
							models: {
								"fixture/a": "full",
								"fixture/b": "light",
								"openai/*": "light",
							},
						},
					}),
				);
				const parsed = loadPiConfig({ cwd: root }).config;
				const loaded = {
					injection: parsed.system_prompt_injection.enabled,
					skip: parsed.system_prompt_injection.skip_signatures.includes(
						"PARITY_SKIP",
					),
					memory: parsed.memory.enabled,
					temporal: parsed.temporal_awareness,
					caveman: parsed.caveman_text_compression.enabled,
					language: parsed.language,
					dreamer: isDreamerRunnable(parsed),
					smartNotes: parsed.smart_notes.enabled,
					compaction: isCompactionEnabled(parsed),
					preset: parsed.prompt_surface.default,
					override: !!parsed.prompt_surface.guidance_override_path,
				};
				if (JSON.stringify(loaded) !== JSON.stringify(profile))
					throw new Error(
						`Generated config was not honored: ${JSON.stringify({ loaded, profile })}`,
					);
				return root;
			});
			const ids = [
				`parity-${input.host}-${sequenceIndex}-a`,
				`parity-${input.host}-${sequenceIndex}-b`,
			];
			let active = 0;
			let turn = sequence.turns[0];
			let runtime = capturePi();
			const context = () => ({
				cwd: projectRoots[turn.project],
				hasUI: false,
				model: turn.model,
				sessionManager: { getSessionId: () => ids[active] },
				ui: { setStatus() {} },
			});
			const register = async () => {
				const cwd = process.cwd();
				try {
					process.chdir(projectRoots[0]);
					await extension(runtime.pi);
				} finally {
					process.chdir(cwd);
				}
				if (getHarness() !== input.host)
					throw new Error("Standalone registered the wrong host harness");
				if (runtime.promptHooks() !== 1)
					throw new Error(
						"Expected one real registered before_agent_start hook",
					);
			};
			await register();
			const db = openDatabase();
			if (!db) throw new Error("Standalone parity database failed to open");
			for (const id of ids) getOrCreateSessionMeta(db, id, input.host);
			const snapshot = (
				kind: string,
				returned: unknown[],
				event?: PromptEvent,
				rendered?: string,
			) => {
				// Read SQLite itself, not the metadata accessor used by the implementation.
				const persisted = db
					.prepare(
						"SELECT session_id, harness, system_prompt_hash, system_prompt_tokens, cache_ttl, last_response_time FROM session_meta WHERE session_id IN (?, ?) ORDER BY session_id",
					)
					.all(...ids);
				const refreshSignals = ids.map((sessionId) => ({
					sessionId,
					refresh: signals.hasSystemPromptRefresh(sessionId),
					pending: signals.hasPendingMaterialization(sessionId),
				}));
				const record = `${JSON.stringify({
					seed: sequence.seed,
					event: counts.events++,
					kind,
					active: ids[active],
					returned: encodeReturn(returned),
					sections: encodeReturn(event?.systemPromptOptions?.sections),
					rendered: encodeReturn(rendered),
					persisted,
					refreshSignals,
					stickyDates: __parityStickyDates(),
				})}\n`;
				writeSync(fd, record);
				transcript.update(record);
			};
			const lifecycle = async (name: string) => {
				const returned = await runtime.emit(name, {}, context());
				snapshot(name, returned);
			};
			let previousOptions:
				| ReturnType<typeof normalizeBuildSystemPromptOptions>
				| undefined;
			for (const [turnIndex, nextTurn] of sequence.turns.entries()) {
				turn = nextTurn;
				now =
					Date.UTC(2026, 9, 12 + Math.floor(turnIndex / 2), 12) +
					sequenceIndex * 1000;
				if (turnIndex === 3) {
					await lifecycle("session_before_switch");
					// A canceled switch emits no completion and leaves the active ID unchanged.
					counts.canceledSwitches++;
				}
				if (turnIndex === 6 || turnIndex === 9) {
					await lifecycle("session_before_switch");
					if (input.host === "pi") {
						await lifecycle("session_shutdown");
						active = 1 - active;
						runtime = capturePi();
						await register();
					} else {
						active = 1 - active;
						await lifecycle("session_switch");
					}
					previousOptions = undefined;
					counts.confirmedSwitches++;
				}
				writeFileSync(
					overridePath,
					`## Magic Context\nAuthored override ${sequence.seed}/${turn.overrideVersion}.`,
				);
				updateSessionMeta(db, ids[active], {
					cacheTtl: turn.expired ? "5m" : "never",
					lastResponseTime: turn.expired ? now - 600_000 : now - 1,
				});
				if (turn.refresh) signals.signalPiSystemPromptRefresh(ids[active]);
				const options = normalizeBuildSystemPromptOptions({
					cwd: `/standalone-parity-project/${turn.project}`,
					customPrompt: turn.base,
					// Pi can force an empty prompt; without this option its builder uses the default.
					...(turn.base === "" ? { forceSystemPrompt: "" } : {}),
					sections:
						previousOptions && turn.reuseSections
							? { ...previousOptions.sections }
							: { earlier: `Earlier extension ${sequence.seed}.` },
				});
				const event: PromptEvent =
					input.host === "pi"
						? {
								get systemPrompt() {
									return buildSystemPrompt(options);
								},
								systemPromptOptions: options,
							}
						: { systemPrompt: turn.base };
				const returned = await runtime.emit(
					"before_agent_start",
					event,
					context(),
				);
				counts.hookCalls += returned.length;
				let rendered = event.systemPrompt;
				for (const result of returned) {
					if (
						result &&
						typeof result === "object" &&
						"systemPrompt" in result &&
						typeof result.systemPrompt === "string" &&
						result.systemPrompt
					) {
						rendered = result.systemPrompt;
						if (input.host === "pi")
							options.forceSystemPrompt = result.systemPrompt;
					}
				}
				if (input.host === "pi") rendered = buildSystemPrompt(options);
				snapshot("before_agent_start", returned, event, rendered);
				previousOptions = options;
				counts.turns++;
			}
			await lifecycle("session_shutdown");
		}
		return {
			host: input.host,
			...counts,
			traceDigest: transcript.digest("hex"),
			inputDigest: sha(JSON.stringify(input.sequences)),
			handlerDigest: generated.handlerDigest,
			helperDigest: generated.helperDigest,
		};
	} finally {
		closeSync(fd);
		Date.now = originalNow;
		generated.cleanup();
	}
}

if (import.meta.main) {
	const input = JSON.parse(
		readFileSync(process.argv[2], "utf8"),
	) as WorkerInput;
	console.log(
		`STANDALONE_PARITY_WORKER ${JSON.stringify(await runStandaloneParityWorker(input))}`,
	);
}
