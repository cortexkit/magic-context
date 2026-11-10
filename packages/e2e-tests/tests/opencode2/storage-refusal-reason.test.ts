import { openTestDb } from "../../src/test-db";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import {
	closeDatabase,
	getPersistedSchemaVersion,
	LATEST_SUPPORTED_VERSION,
	openDatabase,
} from "../../../plugin/src/features/magic-context/storage-db";
import { inspectLivePiProcesses } from "../../../plugin/src/shared/rpc-utils";
import { Database as ContextDatabase } from "../../../plugin/src/shared/sqlite";
import { V2_STORAGE_REOPEN_INTERVAL_MS } from "../../../plugin/src/v2/hooks/storage-gate";
import { STORAGE_NOTICE_PREFIX } from "../../../plugin/src/v2/hooks/storage-notice";
import {
	isolation,
	spawnOpencode2,
	waitForPluginActive,
} from "../../src/opencode2-runner/spawn";

// A shared context.db one schema version behind this build, with a live process
// advertising itself as an OpenCode server of an older build (a discovery file,
// the way an OpenCode 1 server with an older plugin appears). The OpenCode 2 host
// must refuse the migration and the turn, and say why: in the Magic Context log
// with the blocking PID, and in the conversation. Once the blocker is gone, the
// next turn must migrate and get a reply from the same host process.
test("OpenCode 2 names a migration refused by an older live host, then recovers without a restart", async () => {
	// The guard also treats every live Pi harness on this machine as a possible
	// holder of the default shared database, and the host sees this store as that
	// database. A live Pi here would keep blocking after the fake blocker exits.
	const pi = inspectLivePiProcesses();
	if (pi.processIds.length > 0)
		throw new Error(
			`a live Pi harness (PID ${pi.processIds.join(", ")}) would block the migration this test expects to succeed; stop it and rerun`,
		);

	const fixture = isolation();
	const logPath = join(fixture.root, "magic-context.log");
	fixture.env.MAGIC_CONTEXT_LOG_PATH = logPath;
	const storageDir = fixture.env.MAGIC_CONTEXT_STORAGE_DIR!;
	const dbPath = join(storageDir, "context.db");
	mkdirSync(storageDir, { recursive: true });
	// Current schema, then the newest upstream migration removed, so the host has
	// one migration to run on open.
	openDatabase(dbPath);
	closeDatabase();
	const seeded = new ContextDatabase(dbPath);
	seeded
		.prepare("DELETE FROM schema_migrations WHERE version = ?")
		.run(LATEST_SUPPORTED_VERSION);
	seeded.exec("DROP TABLE single_store_state");
	seeded.close();
	const persistedVersion = () => {
		const db = new ContextDatabase(dbPath);
		try {
			return getPersistedSchemaVersion(db);
		} finally {
			db.close();
		}
	};
	expect(persistedVersion()).toBe(LATEST_SUPPORTED_VERSION - 1);

	const blocker = Bun.spawn(["sleep", "600"], {
		stdout: "ignore",
		stderr: "ignore",
	});
	const blockerDir = join(storageDir, "rpc", "older-opencode-host");
	mkdirSync(blockerDir, { recursive: true });
	writeFileSync(
		join(blockerDir, `port-${blocker.pid}.json`),
		JSON.stringify({
			port: 1,
			pid: blocker.pid,
			started_at: Date.now() + 1_000,
			kind: "OpenCode server",
			instance_id: "older-opencode-host",
		}),
	);

	const host = await spawnOpencode2({
		existingIsolation: fixture,
		prepareContextDatabase: false,
		magicContextConfig: {
			execute_threshold_tokens: { default: 20_000 },
			historian: { two_pass: false },
			dreamer: { disable: true },
			memory: { enabled: false },
		},
	});
	const log = () => (existsSync(logPath) ? readFileSync(logPath, "utf8") : "");
	// The plugin logger flushes in batches, so a line can trail the turn that wrote it.
	const logOnceContains = async (text: string) => {
		const deadline = Date.now() + 10_000;
		while (!log().includes(text) && Date.now() < deadline) await Bun.sleep(100);
		return log();
	};
	const requestsWith = (text: string) =>
		host.mock
			.requests()
			.filter((request) => JSON.stringify(request).includes(text)).length;
	try {
		const client = OpenCode.make({
			baseUrl: host.url,
			headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
		});
		const session = await client.session.create({
			title: "storage refusal reason",
			location: { directory: host.cwd },
			model: { providerID: "openai", id: "mock-model" },
		});
		await waitForPluginActive(client, host.cwd);
		const settle = () =>
			client.session
				.wait(
					{ sessionID: session.id },
					{ signal: AbortSignal.timeout(30_000) },
				)
				.catch(() => undefined);
		const turn = async (text: string) => {
			await client.session.prompt({ sessionID: session.id, text });
			await settle();
			// A notice stored after the turn starts a short turn of its own; let it end
			// before the next prompt.
			await Bun.sleep(300);
			await settle();
		};
		let historianCalls = 0;
		const rows = () => {
			const db = openTestDb(
				join(fixture.env.XDG_DATA_HOME!, "opencode", fixture.env.OPENCODE_DB!),
				{
					readonly: true,
				},
			);
			try {
				return (
					db
						.prepare(
							"SELECT type, data FROM session_message WHERE session_id = ? ORDER BY seq",
						)
						.all(session.id) as Array<{ type: string; data: string }>
				).map((row) => ({
					type: row.type,
					data: JSON.parse(row.data) as Record<string, unknown>,
				}));
			} finally {
				db.close();
			}
		};

		await turn("TURN-WHILE-BLOCKED");

		expect(requestsWith("TURN-WHILE-BLOCKED")).toBe(0);
		expect(persistedVersion()).toBe(LATEST_SUPPORTED_VERSION - 1);
		const refusedLog = await logOnceContains("arm=storage-unavailable");
		expect(refusedLog).toContain(`OpenCode server (PID ${blocker.pid})`);
		expect(refusedLog).toContain(
			`The database is at upstream migration v${LATEST_SUPPORTED_VERSION - 1}; this build needs v${LATEST_SUPPORTED_VERSION}.`,
		);
		expect(refusedLog).toContain("arm=storage-unavailable");
		// The notice is stored once the refused turn has ended, not during it.
		const deadline = Date.now() + 10_000;
		while (
			!rows().some((row) => row.type === "synthetic") &&
			Date.now() < deadline
		)
			await Bun.sleep(100);
		const refusedRows = rows();
		expect(refusedRows).toContainEqual({
			type: "synthetic",
			data: expect.objectContaining({
				text: expect.stringContaining(`OpenCode server (PID ${blocker.pid})`),
			}),
		});
		expect(refusedRows).toContainEqual({
			type: "idle",
			data: expect.objectContaining({ outcome: "interrupted" }),
		});
		// Storing the notice starts a turn of its own on this host; that turn ends
		// before the provider instead of asking the model to answer the notice.
		await logOnceContains("arm=storage-notice-turn");
		expect(log()).toContain("arm=storage-notice-turn");

		blocker.kill();
		await blocker.exited;
		// A refused open is retried at most once per interval.
		await Bun.sleep(V2_STORAGE_REOPEN_INTERVAL_MS + 500);
		expect(requestsWith("TURN-WHILE-BLOCKED")).toBe(0);
		host.mock.setDefault({
			text: "REPLY-AFTER-RECOVERY",
			usage: { input_tokens: 100, output_tokens: 10 },
		});

		await turn("TURN-AFTER-BLOCKER-STOPPED");

		expect(requestsWith("TURN-AFTER-BLOCKER-STOPPED")).toBeGreaterThan(0);
		expect(persistedVersion()).toBe(LATEST_SUPPORTED_VERSION);
		const recoveredLog = await logOnceContains("v2 storage recovered");
		expect(recoveredLog).toContain(
			"The historian and dreamer are running again.",
		);
		expect(recoveredLog).toContain(
			"Restart OpenCode to enable Magic Context's tools.",
		);
		expect(JSON.stringify(rows())).toContain("REPLY-AFTER-RECOVERY");
		const noticeRows = () =>
			rows().filter(
				(row) =>
					row.type === "synthetic" &&
					String(row.data.text).startsWith(STORAGE_NOTICE_PREFIX),
			);
		const recoveryDeadline = Date.now() + 10_000;
		while (noticeRows().length < 2 && Date.now() < recoveryDeadline)
			await Bun.sleep(100);
		// One refusal notice and one recovery notice, both kept in the conversation.
		expect(noticeRows()).toHaveLength(2);

		// A priced pass (over the execute threshold) and the defer pass after it,
		// with both notices in the transcript. The notices are never served, and the
		// defer pass sends the priced pass's bytes unchanged as its prefix.
		host.mock.addMatcher((body) => {
			const range = JSON.stringify(body).match(/Messages (\d+)-(\d+):/);
			if (!range) return null;
			historianCalls++;
			return {
				text: `<compartment start="${range[1]}" end="${range[2]}" title="Recovered history"><p1>The turns after recovery record durable history.</p1></compartment>`,
				usage: { input_tokens: 100, output_tokens: 40 },
			};
		});
		host.mock.setDefault({
			text: "pressure reply",
			usage: { input_tokens: 30_000, output_tokens: 10 },
		});
		await turn(`PRESSURE-TURN ${"recovered history ".repeat(60)}`);
		host.mock.setDefault({
			text: "priced reply",
			usage: { input_tokens: 1_000, output_tokens: 10 },
		});
		await turn(`PRICED-TURN ${"recovered history ".repeat(60)}`);
		host.mock.setDefault({
			text: "defer reply",
			usage: { input_tokens: 1_000, output_tokens: 10 },
		});
		await turn(`DEFER-TURN ${"recovered history ".repeat(60)}`);

		const decisions = await logOnceContains("inputTokens=1000 ");
		const schedulerLine = (inputTokens: number) =>
			decisions
				.split("\n")
				.find(
					(line) =>
						line.includes(`[${session.id}]`) &&
						line.includes("transform scheduler:") &&
						line.includes(`inputTokens=${inputTokens} `),
				);
		expect(schedulerLine(30_000)).toContain("decision=execute");
		expect(schedulerLine(1_000)).toContain("decision=defer");
		const served = (marker: string) => {
			const matching = host.mock.requests().filter((request) => {
				const text = JSON.stringify(request.body);
				const input = (request.body as { input?: unknown[] }).input ?? [];
				return (
					!/Messages \d+-\d+:/.test(text) &&
					JSON.stringify(input.at(-1) ?? null).includes(marker)
				);
			});
			const request = matching.at(-1);
			if (!request) throw new Error(`no served request for ${marker}`);
			return request.body as { input: unknown[]; instructions?: unknown };
		};
		const priced = served("PRICED-TURN");
		const deferred = served("DEFER-TURN");
		expect(deferred.instructions).toEqual(priced.instructions);
		expect(deferred.input.slice(0, priced.input.length)).toEqual(priced.input);
		for (const request of host.mock.requests())
			expect(JSON.stringify(request.body)).not.toContain(STORAGE_NOTICE_PREFIX);
		// Still exactly two notices: the recovery notice is delivered once.
		expect(noticeRows()).toHaveLength(2);

		// The historian runs after recovery without a restart.
		const compartments = () => {
			const db = new ContextDatabase(dbPath);
			try {
				return (
					db
						.prepare(
							"SELECT COUNT(*) AS count FROM compartments WHERE session_id = ?",
						)
						.get(session.id) as { count: number }
				).count;
			} finally {
				db.close();
			}
		};
		await client.session.command({
			sessionID: session.id,
			name: "ctx-wrapup",
			text: "2",
		});
		const historianDeadline = Date.now() + 60_000;
		while (compartments() === 0 && Date.now() < historianDeadline)
			await Bun.sleep(200);
		expect(historianCalls).toBeGreaterThan(0);
		expect(compartments()).toBeGreaterThan(0);
	} finally {
		blocker.kill();
		await host.stop();
	}
}, 180_000);
