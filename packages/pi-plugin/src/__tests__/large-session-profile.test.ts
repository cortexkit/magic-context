import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { arch, availableParallelism, cpus, platform } from "node:os";
import { join, resolve } from "node:path";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import type { TagTranscriptOptions } from "@magic-context/core/shared/tag-transcript";
import { tagTranscript } from "@magic-context/core/shared/tag-transcript";
import {
	cleanupTestTempDir,
	createTestTempDirFromPath,
} from "@magic-context/core/shared/test-temp-dir";
import { __test, clearContextHandlerSession } from "../context-handler";
import {
	createPiTagSnapshotCandidate,
	type PiTagSnapshotCandidate,
} from "../tag-snapshot-pi";
import { startPiTagSnapshotWorker } from "../tag-snapshot-worker-client-pi";
import { createTestDb } from "../test-utils.test";
import { createPiTranscript } from "../transcript-pi";
import {
	compactedRanges,
	LARGE_SESSION_ID,
	largeSessionMessages,
	seedLargeSession,
} from "./large-session-profile.fixture";

const profile = process.env.PI_LARGE_SESSION_PROFILE === "1";
const passProjection = process.env.PI_LARGE_SESSION_PASS === "1";
const sha = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
function memory() {
	Bun.gc(true);
	return process.memoryUsage();
}

test(
	"isolated large-session fixture preserves existing tag numbers during replay",
	async () => {
		const scratch = resolve(import.meta.dir, "../../../../target/scratch");
		mkdirSync(scratch, { recursive: true });
		const directory = createTestTempDirFromPath(
			join(scratch, "pi-large-profile-"),
		);
		const countList = [
			profile ? Number(process.env.PI_LARGE_SESSION_COUNT ?? 250_000) : 1000,
		];
		const records: unknown[] = [];
		let jobId = 0;
		try {
			for (const count of countList) {
				const path = join(directory, `fixture-${count}.sqlite`);
				const db = createTestDb(path);
				try {
					const seedStart = performance.now();
					seedLargeSession(db, count);
					const seedMs = performance.now() - seedStart;
					const statusCounts = db
						.prepare("SELECT status, count(*) AS n FROM tags GROUP BY status")
						.all();
					const load = async (cached: PiTagSnapshotCandidate["tags"] = []) => {
						// Use the real Pi worker with byteLimit=Infinity to measure a full candidate even when normal admission rejects it.
						const job = startPiTagSnapshotWorker(
							{
								path,
								sessionId: LARGE_SESSION_ID,
								connectionEpoch: 1,
								sessionEpoch: 1,
								jobId: ++jobId,
								projection: passProjection ? "pass" : undefined,
							},
							{
								cached,
								byteLimit: passProjection
									? undefined
									: Number.POSITIVE_INFINITY,
								deadlineMs: 600_000,
							},
						);
						const result = await job.result;
						await job.released;
						return result;
					};
					const before = memory();
					let cold: Awaited<ReturnType<typeof load>> | undefined = await load();
					const after = memory();
					const estimate = cold.candidate.estimatedBytes;
					let warm: Awaited<ReturnType<typeof load>> | undefined = await load(
						cold.candidate.tags,
					);
					const afterReuse = memory();
					expect(
						warm.candidate.tags.every(
							(row, i) => row === cold?.candidate.tags[i],
						),
					).toBe(true);
					const admission = (() => {
						const assembly = createPiTagSnapshotCandidate();
						let admitted = 0;
						let normalAdmissionError = "";
						try {
							for (const row of cold.candidate.tags) {
								assembly.appendTag(row);
								admitted++;
							}
						} catch (error) {
							normalAdmissionError = String(error);
						}
						const activeEstimate = createPiTagSnapshotCandidate();
						for (const row of cold.candidate.active)
							activeEstimate.appendTag(row);
						return {
							admitted,
							normalAdmissionError,
							activeEstimatedBytes: activeEstimate.estimatedBytes,
						};
					})();
					if (passProjection) {
						expect(admission.admitted).toBe(count);
						expect(admission.normalAdmissionError).toBe("");
						expect(estimate).toBeLessThan(128 * 1024 * 1024);
					}
					const hydration = {
						seedMs,
						statusCounts,
						ranges: compactedRanges(count).length,
						before,
						after,
						afterReuse,
						estimatedBytes: estimate,
						fallbackRows: cold.candidate.fallback.length,
						...admission,
						reuseEstimatedBytes: warm.candidate.estimatedBytes,
						allocatedBytes: cold.candidate.allocatedBytes,
						reuseAllocatedBytes: warm.candidate.allocatedBytes,
						reusedBytes: warm.candidate.reusedBytes,
						cold: cold.telemetry,
						reuse: warm.telemetry,
					};
					cold = undefined;
					warm = undefined;
					memory();

					const tagger = createTagger();
					const initStart = performance.now();
					tagger.initFromDb(LARGE_SESSION_ID, db);
					const initMs = performance.now() - initStart;
					const hitStart = performance.now();
					tagger.initFromDb(LARGE_SESSION_ID, db);
					const initHitMs = performance.now() - hitStart;
					const tagging: unknown[] = [];
					let sqlCounts = new Map<string, number>();
					const prepare = db.prepare.bind(db);
					const instrumentedPrepare = ((sql: string) => {
						const statement = prepare(sql);
						const methods: Record<
							"run" | "get" | "all",
							(...args: unknown[]) => unknown
						> = statement;
						for (const method of ["run", "get", "all"] as const) {
							const original = methods[method].bind(statement);
							methods[method] = (...args: unknown[]) => {
								const key = `${method}: ${sql.replace(/\s+/g, " ").trim()}`;
								sqlCounts.set(key, (sqlCounts.get(key) ?? 0) + 1);
								return original(...args);
							};
						}
						return statement;
					}) as typeof db.prepare;
					const statements = spyOn(db, "prepare").mockImplementation(
						instrumentedPrepare,
					);
					// Compare full-history and 1k-tail inputs without reusable IDs, then with all IDs reusable and the first pass's token caches.
					for (const first of new Set([1, Math.max(1, count - 999)])) {
						const input = largeSessionMessages(first, count);
						const reusable = new Set(input.ids);
						const textTokenCache: NonNullable<
							TagTranscriptOptions["textTokenCache"]
						> = new Map();
						const toolTokenCache: NonNullable<
							TagTranscriptOptions["toolTokenCache"]
						> = new Map();
						let previousWire: string | undefined;
						for (const mode of ["cold", "restart", "reuse"] as const) {
							sqlCounts = new Map();
							const messages = structuredClone(input.messages);
							const buildStart = performance.now();
							const transcript = createPiTranscript(
								messages,
								LARGE_SESSION_ID,
								input.ids,
							);
							const buildMs = performance.now() - buildStart;
							const activeTagger = mode === "restart" ? createTagger() : tagger;
							const validationStart = performance.now();
							if (mode === "restart") {
								clearContextHandlerSession(LARGE_SESSION_ID);
								activeTagger.initFromDb(LARGE_SESSION_ID, db);
								textTokenCache.clear();
								toolTokenCache.clear();
							}
							const identity =
								mode === "restart"
									? __test.buildPiTextIdentityPlan(
											db,
											LARGE_SESSION_ID,
											activeTagger,
											transcript,
										)
									: undefined;
							const validationMs = performance.now() - validationStart;
							const phases: Record<string, number> = {};
							const start = performance.now();
							const view = transcript.messages.map((message) => ({
								...message,
								parts: message.parts,
							}));
							const { targets } = tagTranscript(
								LARGE_SESSION_ID,
								{ ...transcript, messages: view },
								activeTagger,
								db,
								{
									preserveTagOnlyAssistantText: true,
									reuseMessageIds: mode === "reuse" ? reusable : undefined,
									reuseTextMessageIds: identity?.reusableTextMessageIds,
									textIdentityDriftMessageIds: identity?.driftedMessageIds,
									textIdentitySourceCache: identity?.sourceCache,
									textTokenCache,
									toolTokenCache,
									onTiming: (phase, elapsed) => {
										phases[phase] = elapsed;
									},
								},
							);
							const tagMessagesMs = performance.now() - start;
							transcript.commit();
							const wire = sha(transcript.getOutputMessages());
							if (previousWire !== undefined) expect(wire).toBe(previousWire);
							previousWire = wire;
							expect(targets.size).toBe(count - first + 1);
							expect(activeTagger.getCounter(LARGE_SESSION_ID)).toBe(count);
							tagging.push({
								first,
								mode,
								tags: count - first + 1,
								rawMessages: messages.length,
								buildMs,
								validationMs,
								tagMessagesMs,
								phases,
								targets: targets.size,
								wire,
								sqlCounts: Object.fromEntries(sqlCounts),
							});
							if (mode === "restart") activeTagger.cleanup(LARGE_SESSION_ID);
						}
						memory();
					}
					statements.mockRestore();
					tagger.cleanup(LARGE_SESSION_ID);
					records.push({ count, hydration, initMs, initHitMs, tagging });
					console.log(JSON.stringify(records.at(-1)));
				} finally {
					db.close();
				}
			}
			if (profile) {
				const output = process.env.PI_LARGE_SESSION_OUTPUT;
				if (!output)
					throw new Error(
						"PI_LARGE_SESSION_OUTPUT is required for measurements",
					);
				mkdirSync(resolve(output, ".."), { recursive: true });
				writeFileSync(
					output,
					`${JSON.stringify(
						{
							runtime: {
								bun: Bun.version,
								platform: platform(),
								arch: arch(),
								cpu: cpus()[0]?.model,
								availableParallelism: availableParallelism(),
							},
							records,
						},
						null,
						2,
					)}\n`,
				);
			}
		} finally {
			cleanupTestTempDir(directory);
		}
	},
	profile ? 1_200_000 : 30_000,
);
