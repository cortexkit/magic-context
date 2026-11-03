import { openTestDb } from "../../src/test-db";
/**
 * A session whose last provider reading is past its usable window must still get a
 * Magic Context pass on the next turn, and the turn must reach the provider when that
 * pass leaves a request the provider can take.
 *
 * The shape is the one reported on issue 493: a session converted from OpenCode 1,
 * a 1,000,000-token model whose usable window is 750,000 once room for the reply is
 * set aside, and a provider-accepted reply of 962,842 input tokens (128% of the
 * usable window, 96% of the model's own window). Before this was fixed, the OpenCode 2
 * context hook turned every following turn away before any Magic Context work ran,
 * so nothing could shrink the session and the stored reading never changed.
 */
import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { Database } from "../../../plugin/src/shared/sqlite";
import { buildMockHistorianPayload, findHistorianOrdinalRange } from "../../src/mock-historian";
import { MockProvider } from "../../src/mock-provider/server";
import {
	conversionFixture,
	SHARED_MOCK_MODEL_ID,
	SHARED_MOCK_PROVIDER_ID,
	spawnOpencode1,
} from "../../src/opencode2-runner/conversion-lane";
import { spawnOpencode2, waitForPluginActive } from "../../src/opencode2-runner/spawn";

const MODEL_WINDOW = 1_000_000;
// Large enough that the output reserve reaches its cap of a quarter of the window,
// which is how a 1,000,000-token model ends up with a 750,000-token usable window.
const MODEL_OUTPUT = 384_000;
const REPORTED_INPUT = 962_842;
const TOOL_COUNT = 24;
const RESULT_TEXT = "payload ".repeat(2_300);

/**
 * Copy the converted tool call into a tail of large completed tool results, so the
 * emergency reclaim on the next pass has something real to drop. The newest copy
 * carries the over-limit usage the provider reported, making it the stored reading
 * the next turn starts from.
 */
function seedLargeToolTail(path: string, sessionID: string): void {
	const db = new Database(path);
	try {
		const rows = db
			.prepare("SELECT id, type, data FROM session_message WHERE session_id = ? ORDER BY seq")
			.all(sessionID) as Array<{ id: string; type: string; data: string }>;
		const user = rows.find((row) => row.type === "user");
		const tool = rows.find((row) => row.type === "assistant" && row.data.includes('"type":"tool"'));
		const overLimit = [...rows]
			.reverse()
			.find((row) => row.type === "assistant" && row.data.includes('"text":"big"'));
		if (!user || !tool || !overLimit) throw new Error("conversion did not produce the tool and over-limit rows");
		const overLimitTokens = (JSON.parse(overLimit.data) as { tokens: unknown }).tokens;
		const add = db.prepare(`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
			SELECT ?, session_id, type, ?, time_created, time_updated, ? FROM session_message WHERE id = ?`);
		const max = db.prepare("SELECT MAX(seq) AS seq FROM session_message WHERE session_id = ?").get(sessionID) as {
			seq: number;
		};
		let seq = max.seq;
		db.transaction(() => {
			for (let index = 0; index < TOOL_COUNT; index++) {
				const prompt = JSON.parse(user.data) as { text: string };
				prompt.text = `fixture converted turn ${index}`;
				add.run(`msg_fixture_user_${String(index).padStart(4, "0")}`, ++seq, JSON.stringify(prompt), user.id);
				const assistant = JSON.parse(tool.data) as {
					tokens?: unknown;
					content: Array<{ type: string; id: string; state: { input: Record<string, unknown>; content: unknown[] } }>;
				};
				delete assistant.tokens;
				if (index === TOOL_COUNT - 1) assistant.tokens = overLimitTokens;
				const part = assistant.content.find((entry) => entry.type === "tool");
				if (!part) throw new Error("converted tool disappeared");
				part.id = `toolu_fixture_${String(index).padStart(4, "0")}`;
				part.state.input = { filePath: `fixture-${index}.txt` };
				part.state.content = [{ type: "text", text: RESULT_TEXT }];
				add.run(`msg_fixture_tool_${String(index).padStart(4, "0")}`, ++seq, JSON.stringify(assistant), tool.id);
			}
			db.prepare("UPDATE event_sequence SET seq = ? WHERE aggregate_id = ?").run(seq, sessionID);
		})();
	} finally {
		db.close();
	}
}

function requestsContaining(mock: MockProvider, text: string): number {
	return mock.requests().filter((request) => JSON.stringify(request.body).includes(text)).length;
}

test("a converted session over its usable window gets a reducing pass and reaches the provider on every turn", async () => {
	const fixture = conversionFixture("over-limit-recovery-e2e");
	const mock = new MockProvider();
	const provider = await mock.start();
	mock.setDefault({ text: "ok", usage: { input_tokens: 1_200, output_tokens: 20 } });
	const magicContextConfig = {
		memory: { enabled: false },
		dreamer: { disable: true },
	};
	const hostLimits = { modelContextLimit: MODEL_WINDOW, modelOutputLimit: MODEL_OUTPUT };
	const v2Options = {
		existingIsolation: fixture,
		existingMock: { mock, baseURL: provider.baseURL },
		magicContextConfig,
		...hostLimits,
		compactionAuto: false,
	};
	let v1: Awaited<ReturnType<typeof spawnOpencode1>> | undefined;
	let v2: Awaited<ReturnType<typeof spawnOpencode2>> | undefined;
	try {
		v1 = await spawnOpencode1({
			fixture,
			mock,
			mockBaseURL: provider.baseURL,
			magicContextConfig,
			...hostLimits,
			logLabel: "v1-over-limit",
		});
		const sdk = await import("@opencode-ai/sdk");
		const client1 = sdk.createOpencodeClient({ baseUrl: v1.url });
		const session = await client1.session.create({ query: { directory: fixture.cwd } });
		const sessionID = session.data?.id;
		if (!sessionID) throw new Error("v1 session create failed");
		const file = join(fixture.cwd, "seed.txt");
		writeFileSync(file, "converted fixture output\n".repeat(200));
		let issueTool = true;
		mock.addMatcher((body) => {
			const request = JSON.stringify(body);
			if (!issueTool || !request.includes("seed one converted tool") || !request.includes('"name":"read"')) return null;
			issueTool = false;
			return {
				content: [{ type: "tool_use", id: "toolu_fixture_original", name: "read", input: { filePath: file } }],
				stop_reason: "tool_use" as const,
				usage: { input_tokens: 1_200, output_tokens: 20 },
			};
		});
		for (const text of ["seed one converted tool", "settle converted tool"]) {
			const result = await client1.session.prompt({
				path: { id: sessionID },
				body: {
					model: { providerID: SHARED_MOCK_PROVIDER_ID, modelID: SHARED_MOCK_MODEL_ID },
					parts: [{ type: "text", text }],
				},
			});
			expect(result.data?.info?.error).toBeFalsy();
		}
		expect(issueTool).toBe(false);
		await v1.stop();
		v1 = undefined;

		const logPath = fixture.logPath("v2-over-limit");
		fixture.env.MAGIC_CONTEXT_LOG_PATH = logPath;
		const bootV2 = async () => {
			v2 = await spawnOpencode2(v2Options);
			const client = OpenCode.make({
				baseUrl: v2.url,
				headers: { authorization: `Basic ${btoa(`opencode:${v2.password}`)}` },
			});
			await waitForPluginActive(client, fixture.cwd);
			return async (text: string) => {
				await client.session.prompt({ sessionID, text });
				await client.session.wait({ sessionID }, { signal: AbortSignal.timeout(60_000) });
			};
		};

		// The historian answers with a valid compartment over whatever chunk it is
		// given, so the pass that joins it can fold history into a compartment.
		mock.addMatcher((body) => {
			if (!JSON.stringify(body).includes("<new_messages>")) return null;
			// OpenCode 2 sends this provider the Responses shape, where the prompt
			// sits under `input` rather than `messages`.
			const range = findHistorianOrdinalRange({ messages: body.input ?? body.messages });
			if (!range) return null;
			return {
				text: buildMockHistorianPayload({
					start: range.start,
					end: range.end,
					title: "Converted fixture work",
					body: "The converted session read fixture files repeatedly.",
				}),
				usage: { input_tokens: 500, output_tokens: 200 },
			};
		});

		// The provider accepts a request past the usable window.
		let turn = await bootV2();
		mock.setDefault({ text: "big", usage: { input_tokens: REPORTED_INPUT, output_tokens: 20 } });
		await turn("record the over-limit reading");
		await v2!.stopHost();
		v2 = undefined;
		seedLargeToolTail(fixture.openCodeDbPath, sessionID);

		// A fresh host process starts from the stored reading alone, as the reporter's did.
		turn = await bootV2();
		await turn("first turn after the over-limit reading");
		expect(requestsContaining(mock, "first turn after the over-limit reading")).toBeGreaterThan(0);
		// The provider reports the same size again: a repeated reading must not refuse.
		await turn("second turn after the over-limit reading");
		expect(requestsContaining(mock, "second turn after the over-limit reading")).toBeGreaterThan(0);

		// The provider now reports a reduced request, and the session is back to normal.
		mock.setDefault({ text: "ok", usage: { input_tokens: 1_200, output_tokens: 20 } });
		await turn("turn that brings the reading down");
		await turn("turn after recovery");
		expect(requestsContaining(mock, "turn after recovery")).toBeGreaterThan(0);

		await v2!.stopHost();
		v2 = undefined;
		const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
		const usageLines = log.split("\n").filter((line) => line.includes("v2 usage:"));
		// The limit is the model's window minus the capped reply reserve; the
		// provider's accepted figure counts as pressure against it rather than
		// widening it.
		expect(
			usageLines.some((line) => /v2 usage: inputTokens=962842 contextLimit=750000 percentage=128\.3/.test(line)),
		).toBe(true);
		expect(usageLines.at(-1)).toMatch(/inputTokens=1200 contextLimit=750000 /);
		expect(log).not.toContain("v2 refusal:");
		// The pass after the over-limit reading joined the historian, which folded
		// the converted history into a compartment, and the emergency reclaim then
		// dropped seeded tool results that were still on the wire.
		expect(log).toContain("transform: blocking at 128.4% until compartment agent completes");
		expect(log).toMatch(/historian publish stage: stage=publish-txn status=completed .*compartments=1/);
		expect(log).toMatch(/emergency tiered drop: tiered drop: [1-9]\d* tags/);
		const contextDb = openTestDb(fixture.contextDbPath, undefined, Database);
		try {
			const row = contextDb
				.prepare("SELECT COUNT(*) AS count FROM compartments WHERE session_id = ?")
				.get(sessionID) as { count: number };
			expect(row.count).toBeGreaterThan(0);
		} finally {
			contextDb.close();
		}
	} finally {
		if (v2) await v2.stopHost();
		if (v1) await v1.stop();
		await mock.stop();
	}
}, 600_000);
