import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTagsBySession } from "@magic-context/core/features/magic-context/storage";
import {
	getNativeReplayState,
	saveNativeToolInputs,
} from "@magic-context/core/features/magic-context/storage-native-replay";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { tagTranscript } from "@magic-context/core/shared/tag-transcript";
import { applyPiHeuristicCleanup } from "../heuristic-cleanup-pi";
import {
	authorizePiToolRemoval,
	preparePiToolRemovalMeasurements,
} from "../native-replay-state-pi";
import { getPiTagSnapshot } from "../tag-snapshot-pi";
import {
	assistantToolCall,
	createTestDb,
	toolResultMessage,
	userMessage,
} from "../test-utils.test";
import { createPiTranscript } from "../transcript-pi";

export function runHeuristicCostFixture() {
	const parent = join(tmpdir(), "magic-context", "heuristic-cost");
	mkdirSync(parent, { recursive: true });
	const root = mkdtempSync(join(parent, "fixture-"));
	const db = createTestDb(join(root, "context.db"));
	const sessionId = "heuristic-cost-fixture";
	try {
		const insert = db.prepare(`INSERT INTO tags
			(session_id, message_id, type, status, byte_size, tag_number, harness)
			VALUES (?, ?, 'message', ?, 100, ?, 'pi')`);
		db.transaction(() => {
			for (let i = 1; i <= 50_000; i++)
				insert.run(
					sessionId,
					`history-${i}`,
					i <= 1500 ? "active" : "dropped",
					i,
				);
		}).immediate();
		// A large replay envelope makes repeated whole-document CAS writes visible.
		saveNativeToolInputs(
			db,
			sessionId,
			new Map(
				Array.from({ length: 10_000 }, (_, i) => [
					`historic-call-${i}`,
					JSON.stringify({
						path: `history/${i}`,
						content: "prior input ".repeat(10),
					}),
				]),
			),
		);
		const messages: unknown[] = [];
		for (let i = 0; i < 130; i++) {
			messages.push(
				assistantToolCall(
					`call-${i}`,
					"ctx_note",
					{ action: `note-${i}` },
					i * 2,
				),
				toolResultMessage(
					`call-${i}`,
					"completed tool output ".repeat(100),
					i * 2 + 1,
				),
			);
		}
		for (let i = 0; i < 740; i++)
			messages.push(
				userMessage(
					i < 10
						? "<system-reminder>continuation</system-reminder>"
						: `user text ${i}`,
					260 + i,
				),
			);
		const steps: Record<string, { ms: number; calls: number; rows?: number }> =
			{};
		const time = <T>(name: string, fn: () => T): T => {
			const start = performance.now();
			try {
				return fn();
			} finally {
				steps[name] ??= { ms: 0, calls: 0 };
				const step = steps[name];
				step.ms += performance.now() - start;
				step.calls++;
			}
		};
		const saved = getNativeReplayState(db, sessionId).toolInputs;
		const transcript = createPiTranscript(messages, sessionId, undefined, {
			authorizeToolRemoval: (callId) =>
				time("nativeAuthorization", () =>
					authorizePiToolRemoval({
						db,
						sessionId,
						callId,
						saved,
						canApply: true,
					}),
				),
			authorizeToolRemovals: (callIds) =>
				time("prepareNativeRemovals", () =>
					preparePiToolRemovalMeasurements({
						db,
						sessionId,
						callIds,
						saved,
						canApply: true,
					}),
				),
		});
		const tagger = createTagger();
		tagger.initFromDb(sessionId, db);
		const { targets } = tagTranscript(sessionId, transcript, tagger, db);
		const prepare = db.prepare.bind(db);
		const exec = db.exec.bind(db);
		let transactions = 0;
		let autocommitDocumentWrites = 0;
		db.exec = (sql) => {
			if (/^BEGIN/i.test(sql)) transactions++;
			return exec(sql);
		};
		db.prepare = ((sql: string) => {
			const statement = prepare(sql);
			return new Proxy(statement, {
				get(target, key) {
					const method = Reflect.get(target, key);
					if (typeof method !== "function") return method;
					return (...args: unknown[]) => {
						const connection = db as unknown as {
							inTransaction?: boolean;
							isTransaction?: boolean;
						};
						if (
							/UPDATE session_meta SET trailing_blank_decisions/.test(sql) &&
							key === "run" &&
							!connection.inTransaction &&
							!connection.isTransaction
						)
							autocommitDocumentWrites++;
						const name = /FROM tags/.test(sql)
							? "tagQueries"
							: /UPDATE session_meta SET trailing_blank_decisions/.test(sql)
								? "nativeDocumentWrites"
								: /UPDATE tags/.test(sql)
									? "tagWrites"
									: "otherSql";
						return time(name, () => {
							const value = method.apply(target, args);
							if (Array.isArray(value)) {
								steps[name] ??= { ms: 0, calls: 0 };
								steps[name].rows = (steps[name].rows ?? 0) + value.length;
							}
							return value;
						});
					};
				},
			});
		}) as typeof db.prepare;
		for (const target of targets.values()) {
			const measure = target.measureReclaim?.bind(target);
			if (measure)
				target.measureReclaim = (skeleton) =>
					time("measureReclaim", () => measure(skeleton));
			const drop = target.drop?.bind(target);
			if (drop) target.drop = () => time("dropTargets", drop);
		}
		const tags = time("tagSnapshot", () => getPiTagSnapshot(db, sessionId));
		const result = time("cleanup", () =>
			applyPiHeuristicCleanup(
				sessionId,
				db,
				targets,
				messages,
				{
					protectedTags: 0,
					prepareToolRemovalMeasurements:
						transcript.prepareToolRemovalMeasurements,
					protectedCutoff: 50_871,
					protectedToolTags: new Set(
						Array.from({ length: 82 }, (_, i) => 50_049 + i),
					),
					staleReduceStripEnabled: true,
					emergency: {
						currentTotalInputTokens: 320_874,
						ceilingTokens: 281_250,
						usagePercentage: 85.6,
						passAlreadyPriced: true,
					},
				},
				tags.filter((tag) => tag.status === "active"),
			),
		);
		time("commit", () => {
			transcript.commit();
			transcript.finalizeToolRemovals();
		});
		db.prepare = prepare;
		db.exec = exec;
		const wire = JSON.stringify(messages);
		const tagState = JSON.stringify(getTagsBySession(db, sessionId));
		const replayDocument = (
			db
				.prepare(
					"SELECT trailing_blank_decisions AS doc FROM session_meta WHERE session_id = ?",
				)
				.get(sessionId) as { doc: string }
		).doc;
		const hash = (text: string) =>
			createHash("sha256").update(text).digest("hex");
		return {
			root,
			steps,
			transactions,
			autocommitDocumentWrites,
			result,
			hashes: {
				wire: hash(wire),
				tags: hash(tagState),
				replay: hash(replayDocument),
			},
			wire,
			tagState,
			replayDocument,
		};
	} finally {
		db.close();
	}
}
