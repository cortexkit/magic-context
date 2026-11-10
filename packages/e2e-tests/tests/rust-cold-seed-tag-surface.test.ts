/// <reference types="bun-types" />

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { openTestDb } from "../src/test-db";
import { join } from "node:path";
import { RustTestHarness } from "../src/rust-harness";
import { rustPrereqs } from "../src/rust-scenario-support";

const TAGGED_TAIL = [
	["m2", 2, "first seeded tail"],
	["m3", 3, "second seeded tail"],
	["m4", 4, "third seeded tail"],
] as const;

function message(
	mid: string,
	ordinal: number,
	text: string,
): Record<string, unknown> {
	return {
		mid,
		ordinal,
		ck: {
			role: "user",
			content: [{ kind: { type: "text", text } }],
			meta: {
				harness_id: mid,
				ordinal,
				synthetic: false,
				summary: false,
				errored: false,
				created_at_ms: ordinal * 600_000,
			},
		},
	};
}

function transformPayload(
	sessionId: string,
	tail: ReadonlyArray<readonly [string, number, string]> = TAGGED_TAIL,
): Record<string, unknown> {
	const rows = [["m1", 1, "covered seed"], ...tail] as const;
	const messages = rows.map(([mid, ordinal, text]) =>
		message(mid, ordinal, text),
	);
	return {
		method: "transform",
		kind: "transform",
		v: 2,
		serializer_profile: "opencode-aisdk",
		serve_native: false,
		session_id: sessionId,
		render_config: "provider:anthropic|model:cold-tag-seed",
		system_prompt_hash: "cold-tag-seed-system",
		upgrade_state: "stable",
		tool_present: true,
		temporal_awareness: true,
		messages,
		tool_input_key_orders: {},
		full_array_fingerprint: createHash("sha256")
			.update(JSON.stringify(messages.map((entry) => entry.mid)))
			.digest("hex"),
		usage: {
			current_total_input_tokens: 100,
			context_limit_tokens: 100_000,
			final_wire_input_tokens: 100,
			final_wire_trusted: true,
		},
		provider_id: "anthropic",
		model_key: "cold-tag-seed",
		channel2_nudge_state: "idle",
		emergency_recovery_armed: false,
	};
}

function served(response: Record<string, unknown>): unknown[] {
	const messages = response.ck_messages ?? response.messages;
	if (!Array.isArray(messages))
		throw new Error("module response omitted served CK messages");
	return messages;
}

function servedBytes(response: Record<string, unknown>): string {
	return JSON.stringify(served(response));
}

async function seedCoveredPrefix(
	h: RustTestHarness,
	sessionId: string,
): Promise<void> {
	const compartments = [
			{
				sequence: 0,
				start_message: 1,
				end_message: 1,
				start_message_id: "m1",
				end_message_id: "m1",
                start_block_index: 0,
                end_block_index: 0,
				title: "Seeded prefix",
				content: "covered seed",
				p1: "covered seed",
				importance: 50,
				episode_type: "feature",
				created_at: 1,
			},
        ];
    const db = openTestDb(join(h.env.dataDir, "cortexkit", "magic-context", "context.db"));
    try {
        for (const row of compartments) {
            const columns = Object.keys(row);
            db.prepare(`INSERT INTO compartments (session_id, ${columns.join(", ")}) VALUES (?, ${columns.map(() => "?").join(", ")})`)
                .run(sessionId, ...Object.values(row));
        }
    } finally {
        db.close();
    }
    const response = await h.subc.moduleRequest(sessionId, h.env.workdir, {
        method: "state_sync",
        shadow_generation: 0,
        expected_shadow_seq: 0,
        seed_boundary_id: "m1#0",
    });
    expect(response.ok).toBe(true);
}

describe.skipIf(!rustPrereqs.ok)(
	"rust cold seed: complete first-pass tag surface",
	() => {
		let h: RustTestHarness;

		beforeAll(async () => {
			h = await RustTestHarness.create({ startHistorianProducer: false });
		});

		afterAll(async () => {
			await h?.dispose();
		});

		it("tags every seeded tail on the first HARD and changes only an appended tail afterward", async () => {
			const sessionId = "ses_cold_seed_tag_surface";
			await seedCoveredPrefix(h, sessionId);

			const first = await h.subc.moduleRequest(
				sessionId,
				h.env.workdir,
				transformPayload(sessionId),
			);
			expect(first.status).toBe("ok");
			expect(first.action).toBe("HARD");
			expect(first.row_version).toBe(2);
			const firstBytes = servedBytes(first);
			for (const [index, [, , text]] of TAGGED_TAIL.entries()) {
				expect(firstBytes).toMatch(new RegExp(`§${index + 2}§[^"]*${text}`));
			}

			const replay = await h.subc.moduleRequest(
				sessionId,
				h.env.workdir,
				transformPayload(sessionId),
			);
			expect(replay.action).not.toBe("HARD");
			expect(servedBytes(replay)).toBe(firstBytes);

			const appendedTail = [
				...TAGGED_TAIL,
				["m5", 5, "appended tail"] as const,
			];
			const appended = await h.subc.moduleRequest(
				sessionId,
				h.env.workdir,
				transformPayload(sessionId, appendedTail),
			);
			const stablePrefix = served(appended).slice(0, served(first).length);
			expect(JSON.stringify(stablePrefix)).toBe(firstBytes);
			expect(servedBytes(appended)).toMatch(/§5§[^"]*appended tail/);
		}, 300_000);

		it("keeps a clean active Rust session on its established byte representation", async () => {
			const sessionId = "ses_clean_tag_surface_pin";
			const response = await h.subc.moduleRequest(
				sessionId,
				h.env.workdir,
				transformPayload(sessionId, [["m2", 2, "clean tail"]]),
			);
			const digest = createHash("sha256")
				.update(servedBytes(response))
				.digest("hex");
			expect(digest).toBe(
				"4350998b065ec3ac556a82f6a485d8b9d9380bfbfe02bd6b7cbf534cc436fb8a",
			);
		}, 300_000);
	},
);
