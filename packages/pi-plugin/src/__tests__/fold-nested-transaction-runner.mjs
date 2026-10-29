import assert from "node:assert/strict";
import {
	getOrCreateSessionMeta,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { pairedThinkingEdit } from "@magic-context/core/hooks/magic-context/paired-thinking-edit";
import { isSqliteTransactionOpen } from "@magic-context/core/shared/sqlite";
import {
	__test,
	clearContextHandlerSession,
	registerPiContextHandler,
	signalPiPendingMaterialization,
} from "../context-handler";
import { injectM0M1Pi } from "../inject-compartments-pi";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "../test-utils.test";

const reason = process.argv[2];
const sessionId = `nested-${reason}`;
const db = createTestDb();
const fake = createFakePi();
let model = "claude-opus-5-5";
const messages = [userMessage("first request", 1)];
registerPiContextHandler(fake.pi, {
	db,
	signedThinkingHold: "off",
	protectedTokens: 0,
	injection: {
		injectionBudgetTokens: 4000,
		memoryEnabled: false,
		injectDocs: false,
	},
	heuristics: { keepReasoningTokens: 1_000_000 },
});
const pass = async () => {
	const source = structuredClone(messages);
	const result = await fake.handlers.get("context")(
		{ messages: source },
		{
			...fakeContext(
				sessionId,
				process.env.MAGIC_CONTEXT_STORAGE_DIR,
				source.map((_, i) => `entry-${i}`),
				source,
			),
			model: {
				provider: "anthropic",
				id: model,
				api: "anthropic-messages",
				contextWindow: 200_000,
			},
		},
	);
	assert(result?.messages.length, "A real Pi context pass must serve messages");
	return result.messages;
};

try {
	// Establish a real cached prefix before adding a signed turn. The initial
	// request has no signed thinking, so no thinking-removal transaction is needed.
	await pass();
	messages.push(
		assistantMessage("first answer", 2, {
			provider: "anthropic",
			model,
			api: "anthropic-messages",
			content: [
				{ type: "thinking", thinking: "Plan", thinkingSignature: "signed" },
				{ type: "text", text: "first answer" },
			],
		}),
		userMessage("next request", 3),
	);
	if (reason === "project_change") {
		// A stale cached project identity simulates a project change without
		// changing the session's cwd.
		updateSessionMeta(db, sessionId, {
			cachedM0ProjectIdentity: "git:old-pin",
		});
	} else if (reason === "model_change") {
		model = "claude-sonnet-5-5";
	} else {
		assert.equal(reason, "soft_refresh");
		signalPiPendingMaterialization(sessionId);
	}

	const calls = [];
	const sql = [];
	const exec = db.exec.bind(db);
	db.exec = (statement) => {
		sql.push(statement);
		return exec(statement);
	};
	const restore = __test.setInjectM0M1PiForTests((...args) => {
		const call = {
			nested: isSqliteTransactionOpen(db),
			inTransaction: db.inTransaction,
			isTransaction: db.isTransaction,
			state: args[0],
			stack: new Error().stack,
		};
		calls.push(call);
		try {
			const sqlStart = sql.length;
			call.result = injectM0M1Pi(...args);
			call.sql = sql.slice(sqlStart);
			call.stillNested = isSqliteTransactionOpen(db);
			return call.result;
		} catch (error) {
			call.error = error;
			throw error;
		}
	});
	const served = await pass();
	// Report the original SQLite error even though the production preflight
	// logs and defers it; otherwise a served fallback could hide the regression.
	for (const call of calls) if (call.error) throw call.error;
	const preflight = calls[0];
	assert(preflight?.nested, "Preflight must run inside the paired writer");
	assert.equal(preflight.inTransaction, undefined);
	assert.equal(preflight.isTransaction, true);
	assert.match(preflight.stack, /pairedThinkingEdit/);
	assert(
		preflight.sql.some((statement) => /^SAVEPOINT pi_prefix_/.test(statement)),
	);
	assert.equal(preflight.sql.includes("COMMIT"), false);
	assert.equal(preflight.stillNested, true);
	const executions = calls.filter((call) =>
		call.sql.some((statement) => /^SAVEPOINT pi_prefix_/.test(statement)),
	);
	assert.equal(executions.length, 1);
	if (reason !== "soft_refresh")
		assert.equal(executions[0].result.m0Reason, reason);
	else
		assert.equal(
			preflight.result.m0Materialized,
			false,
			JSON.stringify(preflight.result),
		);
	const after = getOrCreateSessionMeta(db, sessionId);
	assert(after.cachedM0Bytes && after.cachedM1Bytes);
	if (reason === "project_change")
		assert.notEqual(after.cachedM0ProjectIdentity, "git:old-pin");
	if (reason === "model_change")
		assert.match(after.cachedM0ModelKey, /claude-sonnet-5-5/);
	const repeatStart = calls.length;
	const next = await pass();
	restore();
	for (const call of calls.slice(repeatStart)) {
		if (call.error) throw call.error;
		assert.equal(call.result.m0Materialized, false);
		assert.equal(
			call.sql.some((statement) => /^SAVEPOINT pi_prefix_/.test(statement)),
			false,
		);
	}
	const repeated = getOrCreateSessionMeta(db, sessionId);
	assert.deepEqual(repeated.cachedM0Bytes, after.cachedM0Bytes);
	assert.deepEqual(repeated.cachedM1Bytes, after.cachedM1Bytes);
	assert.equal(repeated.cachedM0MaterializedAt, after.cachedM0MaterializedAt);
	assert.deepEqual(next, served);

	// Failing to persist thinking removals must also roll back the cached prefix.
	assert.throws(
		() =>
			pairedThinkingEdit({
				db,
				messages: [],
				edit: () => {
					const result = injectM0M1Pi(
						{
							...preflight.state,
							preparedPrefix: undefined,
							projectIdentity: "pj-rollback",
						},
						db,
						[],
					);
					assert.equal(result.m0Materialized, true);
					assert.equal(
						getOrCreateSessionMeta(db, sessionId).cachedM0ProjectIdentity,
						"pj-rollback",
					);
					return result;
				},
				needsCompanion: () => true,
				persistCompanion: () => {
					throw new Error("companion persistence failed");
				},
			}),
		/companion persistence failed/,
	);
	const rolledBack = getOrCreateSessionMeta(db, sessionId);
	assert.deepEqual(rolledBack.cachedM0Bytes, after.cachedM0Bytes);
	assert.deepEqual(rolledBack.cachedM1Bytes, after.cachedM1Bytes);
	assert.equal(
		rolledBack.cachedM0ProjectIdentity,
		after.cachedM0ProjectIdentity,
	);
	assert.equal(rolledBack.cachedM0MaterializedAt, after.cachedM0MaterializedAt);
	assert.equal(isSqliteTransactionOpen(db), false);
	console.log(
		JSON.stringify({
			runtime: process.version,
			reason,
			passes: 3,
			executions: executions.length,
			nested: preflight.nested,
			rollbackPreservedPrefix: true,
		}),
	);
} finally {
	clearContextHandlerSession(sessionId);
	db.close();
}
