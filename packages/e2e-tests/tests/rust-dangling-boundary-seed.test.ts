/// <reference types="bun-types" />

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { appendCompartments } from "../../plugin/src/features/magic-context/compartment-storage";
import {
	buildModuleStateSyncPayload,
	type ModuleStateSyncState,
} from "../../plugin/src/hooks/magic-context/module-state-sync";
import { setRawMessageProvider } from "../../plugin/src/hooks/magic-context/read-session-chunk";
import type { RawMessage } from "../../plugin/src/hooks/magic-context/read-session-raw";
import { Database } from "../../plugin/src/shared/sqlite";
import { RustTestHarness } from "../src/rust-harness";
import { rustPrereqs } from "../src/rust-scenario-support";

function rawMessages(): RawMessage[] {
	return Array.from({ length: 5 }, (_, index) => ({
		id: `m${index + 1}`,
		ordinal: index + 1,
		role: index % 2 === 0 ? "user" : "assistant",
		createdAt: index + 1,
		parts: [{ type: "text", text: `message ${index + 1}` }],
	}));
}

function syncState(): ModuleStateSyncState {
	return {
		moduleGeneration: 0,
		lastAckedSeq: 0,
		lastAckedWatermarks: null,
		idOrdinalMemoGeneration: 0,
		idOrdinalMemo: new Map(),
		seedPassPending: true,
	};
}

async function seedParams(
    h: RustTestHarness,
	sessionId: string,
	dangling: boolean,
): Promise<Record<string, unknown>> {
	const db = new Database(join(h.env.dataDir, "cortexkit", "magic-context", "context.db"));
	db.exec("PRAGMA busy_timeout = 5000");
	appendCompartments(db, sessionId, [
		{
			sequence: 0,
			startMessage: 1,
			endMessage: 2,
			startMessageId: "m1",
			endMessageId: "m2",
			title: "First",
			content: "first summary",
		},
		{
			sequence: 1,
			startMessage: 3,
			endMessage: 4,
			startMessageId: dangling ? "missing-start" : "m3",
			endMessageId: "m4",
			title: "Second",
			content: "second summary",
		},
	]);
	db.prepare(
		"UPDATE compartments SET created_at = 1234 WHERE session_id = ?",
	).run(sessionId);
	const messages = rawMessages();
	const unregister = setRawMessageProvider(sessionId, {
		readMessages: () => messages,
		readMessagePartsById: (messageId) =>
			messages.find((message) => message.id === messageId) ?? null,
		readMessageIdOrdinals: () =>
			new Map(messages.map((message) => [message.id, message.ordinal])),
		getMessageCount: () => messages.length,
	});
	try {
		const payload = await buildModuleStateSyncPayload({
			state: syncState(),
			pass: { db, sessionId, nowMs: 1 },
			force: true,
		});
		if (!payload || typeof payload !== "object") {
			throw new Error(
				`expected state-sync payload, received ${String(payload)}`,
			);
		}
		return payload.params as Record<string, unknown>;
	} finally {
		unregister();
		db.close();
	}
}

function transformPayload(sessionId: string): Record<string, unknown> {
	const messages = rawMessages().map((message) => ({
		mid: message.id,
		ordinal: message.ordinal,
		ck: {
			role: message.role,
			content: [{ kind: { type: "text", text: `message ${message.ordinal}` } }],
			meta: {
				harness_id: message.id,
				ordinal: message.ordinal,
				synthetic: false,
				summary: false,
				errored: false,
			},
		},
	}));
	const nativeMessages = rawMessages().map((message) => ({
		info: { id: message.id, role: message.role, sessionID: sessionId },
		parts: [{ type: "text", text: `message ${message.ordinal}` }],
	}));
	return {
		method: "transform",
		kind: "transform",
		v: 2,
		serializer_profile: "opencode-aisdk",
		serve_native: true,
		session_id: sessionId,
		render_config: "provider:anthropic|model:seed-fixture",
		system_prompt_hash: "seed-system",
		upgrade_state: "stable",
		protected_tags: 1,
		messages,
		native_messages: nativeMessages,
		tool_input_key_orders: {},
		full_array_fingerprint: createHash("sha256")
			.update(JSON.stringify(messages.map((message) => message.mid)))
			.digest("hex"),
		usage: {
			current_total_input_tokens: 100,
			context_limit_tokens: 100_000,
			final_wire_input_tokens: 100,
			final_wire_trusted: true,
		},
		provider_id: "anthropic",
		model_key: "seed-fixture",
		channel2_nudge_state: "idle",
		emergency_recovery_armed: false,
	};
}

function servedDigest(response: Record<string, unknown>): string {
	const served =
		response.native_messages ?? response.ck_messages ?? response.messages;
	return createHash("sha256").update(JSON.stringify(served)).digest("hex");
}

describe.skipIf(!rustPrereqs.ok)(
	"rust cold seed: dangling compartment boundary",
	() => {
		let h: RustTestHarness;

		beforeAll(async () => {
			h = await RustTestHarness.create({ startHistorianProducer: false });
		});

		afterAll(async () => {
			await h?.dispose();
		});

		it("accepts the repaired seed and preserves clean served bytes", async () => {
			const repairedSession = "ses_dangling_seed_e2e";
			const cleanSession = "ses_clean_seed_e2e";
			const repairedSeed = await seedParams(h, repairedSession, true);
			const cleanSeed = await seedParams(h, cleanSession, false);
			expect(
				(h.contextDb().query("SELECT start_message FROM compartments WHERE session_id=? AND sequence=1").get(repairedSession) as { start_message: number }).start_message,
			).toBe(3);

			for (const [sessionId, seed] of [
				[repairedSession, repairedSeed],
				[cleanSession, cleanSeed],
			] as const) {
				const response = await h.subc.moduleRequest(sessionId, h.env.workdir, {
					method: "state_sync",
					...seed,
				});
				expect(response.ok).toBe(true);
			}

			const repaired = await h.subc.moduleRequest(
				repairedSession,
				h.env.workdir,
				transformPayload(repairedSession),
			);
			const clean = await h.subc.moduleRequest(
				cleanSession,
				h.env.workdir,
				transformPayload(cleanSession),
			);
			expect(repaired.status).toBe("ok");
            expect(h.contextDb().query("SELECT start_message_id, end_message_id FROM compartments WHERE session_id=? AND sequence=1").get(repairedSession))
                .toEqual({ start_message_id: "missing-start", end_message_id: "m4" });
			expect(clean.status).toBe("ok");
			expect(servedDigest(repaired)).toMatch(/^[a-f0-9]{64}$/);
			expect(servedDigest(clean)).toBe(
				"c284ee44c4ed29d54c35a8f324266aa3175837d82d422c0b8cc9810b3b48d9b6",
			);
		}, 300_000);
	},
);
