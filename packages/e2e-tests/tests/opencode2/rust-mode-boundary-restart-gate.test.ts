/// <reference types="bun-types" />

/**
 * Rust mode on a real OpenCode 2 host, over a 10,000-message session: fold, restart
 * the host, fold again.
 *
 * What it pins:
 *  - the module publishes a boundary before the restart, and after the restart the
 *    adapter still trims to the RECORDED boundary (the post-fold restore and
 *    `trimToRecordedBoundary` read it back from context.db, not from process memory);
 *  - a second, later boundary is published after the restart;
 *  - no steady pass reads the whole session from the host store: the v2 reader's debug
 *    counters never show a `history` read, no single operation decodes more than
 *    one 100-row page, and the decoded-row total per pass stays bounded while the
 *    session holds 10,000 rows;
 *  - the module holds the shared context.db and its cache store.db only under
 *    this fixture's isolated root; there is no optional single-store mode.
 *
 * One hermetic daemon, module and pinned OpenCode 2 host per file, as in
 * rust-mode-fold-cadence.test.ts in this directory.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { Database } from "../../../plugin/src/shared/sqlite";
import {
	V2_STORE_READER_DEBUG_COUNTER_KEY,
	type V2StoreReaderDebugCounters,
} from "../../../plugin/src/v2/store-reader";
import { driveHistorian } from "../../src/opencode2-runner/conversion-lane";
import { isolation, spawnOpencode2 } from "../../src/opencode2-runner/spawn";
import {
	buildHermeticBinaries,
	detectRustModePrereqs,
	HermeticSubcStack,
} from "../../src/rust-runner/hermetic-subc";

const prereqs = detectRustModePrereqs();
const SEEDED_ROWS = Number(process.env.GATE_SEEDED_ROWS ?? 10_000);
/**
 * `user` (the default) seeds one-line user rows. `arcs` seeds realistic turns cloned
 * from a real one the host recorded: a user prompt, an assistant step that called the
 * read tool and got its output back, and the assistant's closing text.
 */
const SEED_SHAPE = (process.env.GATE_SEED_SHAPE ?? "user") as "user" | "arcs";
const ARC_TEMPLATE_PROMPT = "tool arc template: read the notes file";

function field(body: string, name: string): string {
	return new RegExp(`\\b${name}=([^\\s]+)`).exec(body)?.[1] ?? "";
}

function logLines(logPath: string, marker: string): string[] {
	if (!existsSync(logPath)) return [];
	return readFileSync(logPath, "utf8")
		.split("\n")
		.filter((line) => line.includes(marker))
		.map((line) => line.slice(line.indexOf(marker) + marker.length));
}

function readCoverage(
	logPath: string,
): Array<{
	ocInput: number;
	markerAt: string;
	covered: number;
	firstOrdinal: number | null;
}> {
	return logLines(logPath, "rust input coverage: ").map((body) => {
		const first = field(body, "first_ordinal");
		return {
			ocInput: Number(field(body, "oc_input") || "0"),
			markerAt: field(body, "marker_at"),
			covered: Number(field(body, "covered") || "0"),
			firstOrdinal: /^\d+$/.test(first) ? Number(first) : null,
		};
	});
}

/**
 * Every boundary written to context.db so far, by the module's fold or by the seed for a
 * the boundary message id each "v2 boundary recorded" line names.
 */
function readRecordedBoundaries(logPath: string): Set<string> {
	return new Set(
		logLines(logPath, "v2 boundary recorded at ").map(
			(line) => /boundary message ([^\s:]+)/.exec(line)?.[1] ?? "",
		),
	);
}

/** Passes that put back history from the recorded module boundary after a host checkpoint. */
function readBoundaryRestores(logPath: string): string[] {
	return logLines(logPath, "v2 restore: from the module boundary ");
}

function readTrims(logPath: string): number[] {
	return logLines(logPath, "v2 boundary trim: dropped ").map((line) =>
		Number(line.split(" ")[0]),
	);
}

const BALLAST_WORDS = [
	"boundary",
	"historian",
	"compartment",
	"schedule",
	"pressure",
	"tokens",
	"window",
	"publish",
	"transform",
	"session",
	"marker",
	"budget",
	"eligible",
	"protected",
	"ordinal",
	"snapshot",
	"replay",
	"decision",
	"threshold",
];

function ballast(tokens: number): string {
	const parts: string[] = [];
	let length = 0;
	for (let index = 0; length < tokens * 4; index += 1) {
		const word = BALLAST_WORDS[index % BALLAST_WORDS.length]!;
		parts.push(index % 17 === 0 ? `${word}.` : word);
		length += word.length + 1;
	}
	return parts.join(" ");
}

function usageForBody(body: Record<string, unknown>): number {
	return Math.round(
		JSON.stringify(body.input ?? body.messages ?? []).length / 4,
	);
}

/** A probe plugin that writes the v2 reader's cumulative debug counters after each pass. */
function decodeCounterObserver(root: string) {
	const dir = join(root, "reader-observer");
	mkdirSync(dir, { recursive: true });
	const trace = join(dir, "decodes.jsonl");
	writeFileSync(trace, "");
	writeFileSync(
		join(dir, "server.js"),
		`import { appendFileSync } from "node:fs";
const key = Symbol.for(${JSON.stringify(V2_STORE_READER_DEBUG_COUNTER_KEY)});
export default { id: "boundary-gate-reader-observer", async setup(context) {
    globalThis[key] = { decodedRows: 0, operations: {}, openReaders: 0, maxOpenReaders: 0, readersOpened: 0, readersClosed: 0 };
    await context.session.hook("context", async draft => {
        await new Promise(resolve => setTimeout(resolve, 0));
        appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ sessionID: draft.sessionID, pid: process.pid, at: Date.now(), counters: globalThis[key] }) + "\\n");
    });
}};`,
	);
	return {
		dir,
		frames: () =>
			readFileSync(trace, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map(
					(line) =>
						JSON.parse(line) as {
							sessionID: string;
							at: number;
							pid: number;
							counters: V2StoreReaderDebugCounters;
						},
				),
	};
}

/** Every path a process holds open, from lsof's machine-readable output. */
function openPaths(pid: number): string[] {
	const out = Bun.spawnSync([
		"lsof",
		"-Fn",
		"-p",
		String(pid),
	]).stdout.toString();
	return out
		.split("\n")
		.filter((line) => line.startsWith("n"))
		.map((line) => line.slice(1));
}

describe.skipIf(!prereqs.ok)(
	`rust mode on OpenCode 2: boundary across a host restart on ${SEEDED_ROWS} rows${prereqs.ok ? "" : ` (skipped: ${prereqs.skipReason})`}`,
	() => {
		let host: Awaited<ReturnType<typeof spawnOpencode2>>;
		let subc: HermeticSubcStack;
		let fixture: ReturnType<typeof isolation>;
		let logPath: string;
		let observer: ReturnType<typeof decodeCounterObserver>;
		const modulePathsSeen = new Set<string>();
		let lsofTimer: ReturnType<typeof setInterval> | undefined;
		const spawnOptions = () => ({
			existingIsolation: fixture,
			modelContextLimit: 24_000,
			modelOutputLimit: 1_024,
            historianModel: { id: "mock-historian", contextLimit: 128_000 },
			probePlugin: observer.dir,
			magicContextConfig: {
				transform_mode: (process.env.GATE_TRANSFORM_MODE ?? "rust") as
					| "rust"
					| "ts",
				subc: { connection_file: subc.connectionFile },
				memory: { enabled: false },
				dreamer: { disable: true },
				historian: { opencode: { model: "openai/mock-historian" } },
				execute_threshold_percentage: 40,
				history_budget_percentage: 0.15,
			},
		});

		const modulePid = (): number | null => {
			const file = join(
				fixture.env.XDG_DATA_HOME!,
				"cortexkit",
				"rust-e2e-pids.json",
			);
			if (!existsSync(file)) return null;
			const record = JSON.parse(readFileSync(file, "utf8")) as {
				pids: Array<{ role: string; pid: number }>;
			};
			return record.pids.find((entry) => entry.role === "module")?.pid ?? null;
		};

		beforeAll(async () => {
			fixture = isolation();
			logPath = join(
				fixture.env.XDG_DATA_HOME!,
				"magic-context-boundary-gate.log",
			);
			fixture.env.MAGIC_CONTEXT_LOG_PATH = logPath;
			observer = decodeCounterObserver(fixture.root);
			const binaries = await buildHermeticBinaries(prereqs.subconsciousRoot!);
			subc = await HermeticSubcStack.start({
				dataDir: fixture.env.XDG_DATA_HOME!,
				ckMcBin: binaries.ckMcBin,
				ckSubcBin: binaries.ckSubcBin,
				startProducer: true,
			});
			host = await spawnOpencode2(spawnOptions());
			// For the realistic seed, one real tool arc is recorded first and cloned. The
			// template turn reads a file, then answers; every other request is left to the next matcher.
			let arcSteps = 0;
			host.mock.addMatcher((body) => {
				if (SEED_SHAPE !== "arcs" || body.model !== "mock-model") return null;
				if (!JSON.stringify(body.input ?? []).includes(ARC_TEMPLATE_PROMPT))
					return null;
				arcSteps += 1;
				if (arcSteps === 1)
					return {
						openaiOutput: [
							{
								type: "function_call",
								id: "fc_arc_template",
								call_id: "call_arc_template",
								name: "read",
								arguments: JSON.stringify({
									path: join(host.cwd, "arc-notes.txt"),
								}),
							},
						],
						usage: { input_tokens: 200, output_tokens: 10 },
					};
				if (arcSteps === 2)
					return {
						text: "Read the notes; nothing else to do.",
						usage: { input_tokens: 400, output_tokens: 12 },
					};
				return null;
			});
			host.mock.addMatcher((body) => ({
				text: "ok",
				usage: { input_tokens: usageForBody(body), output_tokens: 20 },
			}));
			// Sample the module's open files for the whole run.
			lsofTimer = setInterval(() => {
				const pid = modulePid();
				if (!pid) return;
				for (const path of openPaths(pid))
					if (/\.db(-wal|-shm)?$/.test(path)) modulePathsSeen.add(path);
			}, 150);
		}, 900_000);

		afterAll(async () => {
			if (lsofTimer) clearInterval(lsofTimer);
			await host?.stop();
			await subc?.stop();
		});

		it("keeps the shared-context boundary and bounded reads across a restart", async () => {
			const clientFor = () =>
				OpenCode.make({
					baseUrl: host.url,
					headers: {
						authorization: `Basic ${btoa(`opencode:${host.password}`)}`,
					},
				});
			let client = clientFor();
			const session = await client.session.create({
				location: { directory: host.cwd },
				model: { providerID: "openai", id: "mock-model" },
			});
			const dbPath = join(
				fixture.env.XDG_DATA_HOME!,
				"opencode",
				"opencode2.db",
			);
			if (SEED_SHAPE === "arcs") {
				writeFileSync(
					join(host.cwd, "arc-notes.txt"),
					`${ballast(400)}\n`,
				);
				await client.session.prompt({
					sessionID: session.id,
					text: ARC_TEMPLATE_PROMPT,
				});
				await client.session.wait(
					{ sessionID: session.id },
					{ signal: AbortSignal.timeout(120_000) },
				);
			}
			// Seed the long history into the host store while the host is down, so the
			// restarted host numbers its own next rows after it, exactly as it would for
			// a long session a user reopens.
			await host.stopHost();
			{
				const store = new Database(dbPath);
				store.exec("PRAGMA busy_timeout = 5000");
				const latest = store
					.prepare(
						"SELECT MAX(seq) AS seq FROM session_message WHERE session_id = ?",
					)
					.get(session.id) as { seq: number | null };
				const firstSeq = (latest.seq ?? -1) + 1;
				const insert = store.prepare(
					"INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
				);
				const now = Date.now() - SEEDED_ROWS * 1_000;
				// The rows each seeded turn is cloned from: the template turn's user,
				// tool-call and reply rows for `arcs`; none (a one-line user row) otherwise.
				const template = (() => {
					if (SEED_SHAPE !== "arcs") return null;
					const rows = store
						.prepare(
							"SELECT type, data FROM session_message WHERE session_id = ? AND type IN ('user','assistant') ORDER BY seq",
						)
						.all(session.id) as Array<{ type: string; data: string }>;
					const user = rows.find((row) => row.data.includes(ARC_TEMPLATE_PROMPT));
					const tool = rows.find(
						(row) => row.type === "assistant" && row.data.includes('"type":"tool"'),
					);
					const reply = rows.find(
						(row) => row.type === "assistant" && row.data.includes("nothing else to do"),
					);
					if (!user || !tool || !reply)
						throw new Error("the template tool arc was not recorded");
					return [user, tool, reply];
				})();
				store.transaction(() => {
					for (let index = 0; index < SEEDED_ROWS; index += 1) {
						const id = `msg_gate_seed_${String(index).padStart(5, "0")}`;
						const seq = firstSeq + index;
						if (!template) {
							insert.run(id, session.id, "user", seq, now + index, now + index,
								JSON.stringify({ text: `seed ${index}`, time: { created: now + index } }));
							continue;
						}
						const source = template[index % template.length]!;
						const data = JSON.parse(source.data) as Record<string, unknown>;
						// Clones carry no provider usage, so the pressure reading still
						// comes from the live turns.
						delete data.tokens;
						if (source.type === "user") data.text = `seeded turn ${index}: ${ARC_TEMPLATE_PROMPT}`;
						for (const part of (data.content as Array<Record<string, unknown>> | undefined) ?? [])
							if (part.type === "tool") part.id = `call_gate_seed_${index}`;
						insert.run(id, session.id, source.type, seq, now + index, now + index,
							JSON.stringify(data));
					}
				})();
				// The host numbers new rows from its per-session event sequence, not
				// from MAX(seq); move it past the seeded rows.
				store
					.prepare(
						"UPDATE event_sequence SET seq = MAX(seq, ?) WHERE aggregate_id = ?",
					)
					.run(firstSeq + SEEDED_ROWS + 10, session.id);
				store.close();
			}
			host = await spawnOpencode2({
				...spawnOptions(),
				existingIsolation: { root: fixture.root, env: host.env, cwd: host.cwd },
				existingMock: { mock: host.mock, baseURL: host.mockBaseURL },
			});
			client = clientFor();
			const prompt = async (text: string) => {
				await client.session.prompt({ sessionID: session.id, text });
				await client.session.wait(
					{ sessionID: session.id },
					{ signal: AbortSignal.timeout(180_000) },
				);
			};
			const pressure = {
				text: "pressure",
				usage: { input_tokens: 20_000, output_tokens: 20 },
			};
			const boundaries = () =>
				new Set(
					readCoverage(logPath)
						.map((entry) => entry.markerAt)
						.filter((marker) => marker !== "none"),
				);

			// ── 1. fold before the restart ───────────────────────────────────────
			await driveHistorian({
				prompt,
				mock: host.mock,
				pressure,
				quiet: pressure,
				label: "a module boundary before the restart",
				satisfied: () => boundaries().size >= 1,
				rounds: 24,
				settleMs: 6_000,
				text: (round) =>
					`turn ${round + 1}: durable signal ${round + 1}. ${ballast(3_000)}`,
			});
			// One more turn so the recorded boundary is read at the start of a pass.
			await prompt(`settle turn. ${ballast(500)}`);
			await Bun.sleep(2_000);
			const beforeBoundaries = boundaries();
			const beforeCoverage = readCoverage(logPath);
			const beforeTrims = readTrims(logPath);
			const beforeFrames = observer
				.frames()
				.filter((frame) => frame.sessionID === session.id);
			console.log(
				`before restart: boundaries=${[...beforeBoundaries].join(",")} passes=${beforeCoverage.length} trims=${beforeTrims.join(" ")}`,
			);
			console.log(
				`oc_input before restart: ${beforeCoverage.map((entry) => entry.ocInput).join(" ")}`,
			);

			// Diagnostics must identify context.db, not the cache-only store.db.
			const status = await subc.moduleStatus(
				session.id,
				host.cwd,
				"session.status",
			);
			const singleStore = (status.single_store ??
				(status.result as Record<string, unknown> | undefined)?.single_store) as
				| Record<string, unknown>
				| undefined;
			console.log(`session.status single_store=${JSON.stringify(singleStore)}`);

			// ── 2. restart the host; the recorded boundary must survive it ─────────
			const restartedFrom = readCoverage(logPath).length;
			const trimsBeforeRestart = readTrims(logPath).length;
			const restoresBeforeRestart = readBoundaryRestores(logPath).length;
			// A fold that lands on the last pass before the restart is recorded then, but
			// no coverage line names it until the next pass, so the record is read here.
			const recordedBeforeRestart = readRecordedBoundaries(logPath);
			await host.stopHost();
			host = await spawnOpencode2({
				...spawnOptions(),
				existingIsolation: { root: fixture.root, env: host.env, cwd: host.cwd },
				existingMock: { mock: host.mock, baseURL: host.mockBaseURL },
			});
			client = clientFor();
			await prompt(`first turn after the restart. ${ballast(500)}`);
			await Bun.sleep(2_000);
			const firstAfter = readCoverage(logPath).slice(restartedFrom);
			const conversationalRows = (() => {
				const store = new Database(dbPath, { readonly: true });
				try {
					store.exec("PRAGMA busy_timeout = 5000");
					return (
						store
							.prepare(
								"SELECT COUNT(*) AS n FROM session_message WHERE session_id = ? AND type IN ('user','assistant','synthetic')",
							)
							.get(session.id) as { n: number }
					).n;
				} finally {
					store.close();
				}
			})();
			const trimsAfterFirst = readTrims(logPath).slice(trimsBeforeRestart);
			const restoresAfterFirst =
				readBoundaryRestores(logPath).slice(restoresBeforeRestart);
			console.log(
				`first pass after restart: coverage=${JSON.stringify(firstAfter)} trims=${trimsAfterFirst.join(" ")}`,
			);

			// ── 3. a second fold after the restart ───────────────────────────────
			await driveHistorian({
				prompt,
				mock: host.mock,
				pressure,
				quiet: pressure,
				label: "a new module boundary after the restart",
				satisfied: () =>
					[...boundaries()].some((marker) => !beforeBoundaries.has(marker)),
				rounds: 24,
				settleMs: 6_000,
				text: (round) =>
					`later turn ${round + 1}: durable signal ${round + 1}. ${ballast(3_000)}`,
			});
			await prompt(`final settle turn. ${ballast(500)}`);
			await Bun.sleep(2_000);
			const afterCoverage = readCoverage(logPath).slice(restartedFrom);
			const afterFrames = observer
				.frames()
				.filter((frame) => frame.sessionID === session.id);
			console.log(
				`oc_input after restart: ${afterCoverage.map((entry) => `${entry.ocInput}@${entry.markerAt.slice(-8)}`).join(" ")}`,
			);
			console.log(`boundaries overall: ${[...boundaries()].join(",")}`);
			const allFrames = [...beforeFrames, ...afterFrames];
			const perOperation: Record<string, number> = {};
			for (const frame of allFrames)
				for (const [name, op] of Object.entries(frame.counters.operations))
					perOperation[name] = Math.max(
						perOperation[name] ?? 0,
						op.maxDecodedRows,
					);
			console.log(
				`max decoded rows per operation: ${JSON.stringify(perOperation)}`,
			);
			// Cumulative counters reset when the host restarts, so per-pass cost is the
			// difference between consecutive frames within one process.
			// Counters are per host process, so a pass's cost is the difference from the
			// previous frame of the SAME process; the first frame of each process is its
			// own cold pass.
			const perProcess = (frames: typeof allFrames) => {
				const byPid = new Map<number, number[]>();
				let previous: (typeof frames)[number] | undefined;
				for (const frame of frames) {
					const costs = byPid.get(frame.pid) ?? [];
					costs.push(
						frame.counters.decodedRows -
							(previous?.pid === frame.pid ? previous.counters.decodedRows : 0),
					);
					byPid.set(frame.pid, costs);
					previous = frame;
				}
				return [...byPid.values()];
			};
			const perPass = (frames: typeof allFrames) => perProcess(frames).flat();
			const passCosts = perPass(afterFrames);
			console.log(`decoded rows per pass: ${passCosts.join(" ")}`);
			console.log(
				`module .db files seen by lsof: ${[...modulePathsSeen].join(" ")}`,
			);

			// ── assertions ───────────────────────────────────────────────────────
			expect(beforeBoundaries.size).toBeGreaterThanOrEqual(1);
			expect(singleStore?.capable).toBe(true);
            expect(singleStore?.mode).toBeUndefined();
            expect(singleStore?.path).toBe(join(fixture.env.MAGIC_CONTEXT_STORAGE_DIR!, "context.db"));
            expect([...modulePathsSeen].some(path => path.endsWith("context.db"))).toBe(true);
            expect([...modulePathsSeen].some(path => path.endsWith("store.db"))).toBe(true);
            expect([...modulePathsSeen].filter(path => /\.db(?:-wal|-shm)?$/.test(path)).every(path => path.startsWith(`${fixture.root}/`))).toBe(true);
			// The recorded boundary survives the restart: the first pass after it starts
			// there, not at the top of the 10,000-row history. Without a host checkpoint
			// the array is trimmed to it; after one, the history put back behind the
			// checkpoint starts at it. Either way it is read back from context.db.
			expect(trimsAfterFirst.length + restoresAfterFirst.length).toBeGreaterThan(0);
			console.log(
				`first pass after restart handed ${firstAfter[0]?.ocInput} of ${conversationalRows} conversational rows to the module`,
			);
			// ...and that first pass starts at the boundary recorded before the restart, not at nothing
			// and not at one the restarted process invented. The restore line names the
			// boundary the pass started from; the coverage line names the boundary after
			// the pass, which is a newer one when a fold lands on that very pass.
			const startedFrom =
				restoresAfterFirst[0]?.split(" ")[0] ?? firstAfter[0]?.markerAt ?? "none";
			// Coverage lines name a module boundary by its fold's end message and the
			// record lines by the boundary message itself, so either spelling counts.
			expect(
				new Set([...beforeBoundaries, ...recordedBeforeRestart]).has(startedFrom),
			).toBe(true);
			expect(firstAfter[0]?.ocInput ?? Number.POSITIVE_INFINITY).toBeLessThan(
				conversationalRows,
			);
			expect(
				[...boundaries()].some((marker) => !beforeBoundaries.has(marker)),
			).toBe(true);
			// Nothing the model sees of its own history disappears unfolded: on every
			// pass, each message before the first one handed to the module lies inside
			// compartments the module has published. The module serves or folds what it
			// is handed.
			const coverage = readCoverage(logPath);
			const unfolded = coverage.filter(
				(entry) =>
					entry.firstOrdinal === null || entry.firstOrdinal - 1 > entry.covered,
			);
			expect(unfolded).toEqual([]);
			if (SEEDED_ROWS > 0)
				// Not vacuous: the long session was actually handed over from a boundary.
				expect(coverage.some((entry) => (entry.firstOrdinal ?? 0) > 1)).toBe(true);
			for (const frame of allFrames)
				expect(frame.counters.operations.history).toBeUndefined();
			for (const max of Object.values(perOperation))
				expect(max).toBeLessThanOrEqual(100);
			// Skip each process's first pass: a cold seed of a new session is allowed to
			// walk its tail. Every later pass must stay within a handful of pages.
			const steady = perProcess(afterFrames).flatMap((costs) => costs.slice(1));
			for (const cost of steady) expect(cost).toBeLessThanOrEqual(1_000);
		}, 2_400_000);
	},
);
