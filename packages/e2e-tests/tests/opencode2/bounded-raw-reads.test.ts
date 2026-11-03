import { openTestDb } from "../../src/test-db";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import {
	gaDatabasePath,
	V2_STORE_READER_DEBUG_COUNTER_KEY,
	type V2StoreReaderDebugCounters,
} from "../../../plugin/src/v2/store-reader";
import {
	spawnOpencode2,
	waitForPluginActive,
} from "../../src/opencode2-runner/spawn";

function decodeCounterObserver() {
	const root = mkdtempSync(join(tmpdir(), "mc-v2-reader-counter-"));
	const trace = join(root, "decodes.jsonl");
	mkdirSync(root, { recursive: true });
	writeFileSync(trace, "");
	writeFileSync(
		join(root, "server.js"),
		`import { appendFileSync } from "node:fs";
const key = Symbol.for(${JSON.stringify(V2_STORE_READER_DEBUG_COUNTER_KEY)});
export default { id: "bounded-reader-observer", async setup(context) {
    globalThis[key] = { decodedRows: 0, operations: {} };
    await context.session.hook("context", async draft => {
        // The adapter schedules reconciliation with a zero-delay timer. Yielding to
        // the timer queue captures its first page before its setImmediate continuation.
        await new Promise(resolve => setTimeout(resolve, 0));
        appendFileSync(${JSON.stringify(trace)}, JSON.stringify({
            sessionID: draft.sessionID,
            counters: globalThis[key],
        }) + "\\n");
    });
}};`,
	);
	return {
		root,
		frames: () =>
			readFileSync(trace, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map(
					(line) =>
						JSON.parse(line) as {
							sessionID: string;
							counters: V2StoreReaderDebugCounters;
						},
				),
	};
}

test("a compartment-heavy first OpenCode 2 pass decodes at most four raw-message pages", async () => {
	const observer = decodeCounterObserver();
	const host = await spawnOpencode2({ probePlugin: observer.root });
	try {
		const client = OpenCode.make({
			baseUrl: host.url,
			headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
		});
		const session = await client.session.create({
			location: { directory: host.cwd },
			model: { providerID: "openai", id: "mock-model" },
		});
		await waitForPluginActive(client, host.cwd);

		const store = new Database(
			gaDatabasePath(host.env.XDG_DATA_HOME!, "latest", host.env),
		);
		try {
			store.exec("PRAGMA busy_timeout = 5000");
			const latest = store
				.prepare(
					"SELECT MAX(seq) AS seq FROM session_message WHERE session_id = ?",
				)
				.get(session.id) as { seq: number | null };
			const initialRaw = store
				.prepare(
					"SELECT COUNT(*) AS count FROM session_message WHERE session_id = ? AND type IN ('user', 'synthetic', 'assistant', 'skill', 'shell', 'system')",
				)
				.get(session.id) as { count: number };
			expect(initialRaw.count).toBe(0);
			// The running host owns its in-memory next-seq counter. Leave a large gap so
			// its prompt rows cannot collide with fixture rows inserted after startup.
			const firstSeq = (latest.seq ?? -1) + 1_000_000;
			const insert = store.prepare(
				"INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, 'user', ?, ?, ?, ?)",
			);
			store.transaction(() => {
				for (let index = 0; index < 5_000; index++) {
					insert.run(
						`msg_bounded_seed_${index}`,
						session.id,
						firstSeq + index,
						1_800_000_000_000 + index,
						1_800_000_000_000 + index,
						JSON.stringify({
							text: `seed ${index}`,
							time: { created: 1_800_000_000_000 + index },
						}),
					);
				}
			})();
		} finally {
			store.close();
		}

		const contextStore = openTestDb(
			join(host.env.XDG_DATA_HOME!, "cortexkit", "magic-context", "context.db"),
		);
		try {
			contextStore
				.prepare(
					"INSERT OR IGNORE INTO session_meta (session_id, harness) VALUES (?, 'opencode2')",
				)
				.run(session.id);
			contextStore
				.prepare(
					"UPDATE session_meta SET coordinate_generation = 'v2', protected_tail_policy_version = 3 WHERE session_id = ?",
				)
				.run(session.id);
			const insertCompartment = contextStore.prepare(
				`INSERT INTO compartments
					(session_id, sequence, start_message, end_message, start_message_id,
					 end_message_id, title, content, p1, p2, p3, p4, importance,
					 legacy, created_at, harness, rebase_status)
				 VALUES (?, ?, ?, ?, ?, ?, 'seed', 'seed summary', 'seed', 'seed',
					 'seed', 'seed', 50, 0, ?, 'opencode2', 'ok')`,
			);
			contextStore.transaction(() => {
				for (let index = 0; index < 50; index++) {
					const start = index * 98 + 1;
					const end = (index + 1) * 98;
					insertCompartment.run(
						session.id,
						index + 1,
						start,
						end,
						`msg_bounded_seed_${start - 1}`,
						`msg_bounded_seed_${end - 1}`,
						1_800_000_000_000 + index,
					);
				}
			})();
		} finally {
			contextStore.close();
		}

		host.mock.setDefault({
			text: "bounded read complete",
			usage: { input_tokens: 100, output_tokens: 10 },
		});
		await client.session.prompt({
			sessionID: session.id,
			text: "Read the bounded tail",
		});
		await client.session.wait(
			{ sessionID: session.id },
			{ signal: AbortSignal.timeout(30_000) },
		);

		const frame = observer.frames().find((candidate) => candidate.sessionID === session.id);
		expect(frame).toBeDefined();
		const counters = frame!.counters;
		expect(counters.operations.latestCompaction?.calls).toBeGreaterThanOrEqual(1);
		expect(counters.operations.history).toBeUndefined();
		for (const operation of Object.values(counters.operations)) {
			expect(operation.maxDecodedRows).toBeLessThanOrEqual(100);
		}
		expect(counters.operations.messageCount?.decodedRows ?? 0).toBe(0);
		// Keep decoded data within four 100-row pages: the test only needs the current
		// 101-row tail plus bounded snapshot/chunk rechecks, never the 5,000 historical
		// rows or a decoded traversal of all 50 compartment boundaries.
		expect(counters.decodedRows).toBeLessThanOrEqual(400);
	} catch (error) {
		console.error(host.stderr().slice(-8_000), JSON.stringify(observer.frames()));
		throw error;
	} finally {
		await host.stop();
		rmSync(observer.root, { recursive: true, force: true });
	}
}, 60_000);
