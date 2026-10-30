import { openTestDb } from "../../src/test-db";
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import {
	isolation,
	spawnOpencode2,
	waitForPluginActive,
} from "../../src/opencode2-runner/spawn";
import {
	captureTui,
	ptyCaptureAvailable,
} from "../../src/opencode2-runner/tui-capture";

const EXPECTED_COMMANDS = [
	"ctx-dream",
	"ctx-embed",
	"ctx-flush",
	"ctx-recomp",
	"ctx-status",
	"ctx-wrapup",
];

const DREAM_TASKS = [
	"map-memories",
	"verify",
	"verify-broad",
	"curate",
	"compress-cues",
	"classify-memories",
	"retrospective",
	"maintain-docs",
	"evaluate-smart-notes",
	"review-user-memories",
	"promote-primers",
	"refresh-primers",
] as const;

function commandKeys(command: string, dismiss = true): string[] {
	return [command, "\r", "\r", ...(dismiss ? ["\x1b"] : [])];
}

test("OpenCode 2 TUI shows feedback for server-registered /ctx-* commands", async () => {
	expect(ptyCaptureAvailable()).toBe(true);

	const fixture = isolation();
	const logPath = join(fixture.root, "magic-context-tui-feedback.log");
	fixture.env.MAGIC_CONTEXT_LOG_PATH = logPath;
	const host = await spawnOpencode2({
		existingIsolation: fixture,
		providerID: "anthropic",
		magicContextConfig: {
			embedding: { provider: "off" },
			memory: { enabled: false },
			dreamer: {
				// Manual /ctx-dream remains enabled, but an argument-free run has
				// no scheduled jobs and cannot make provider requests in this test.
				tasks: Object.fromEntries(
					DREAM_TASKS.map((task) => [task, { schedule: "" }]),
				),
			},
		},
	});

	try {
		const client = OpenCode.make({
			baseUrl: host.url,
			headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
		});
		const session = await client.session.create({
			title: "server command TUI feedback",
			location: { directory: host.cwd },
			model: { providerID: "anthropic", id: "mock-model" },
		});
		await waitForPluginActive(client, host.cwd);

		const listed = await client.command.list({
			location: { directory: host.cwd },
		});
		const names = listed.data
			.filter((command) => command.name.startsWith("ctx-"))
			.map((command) => command.name)
			.sort();
		expect(names).toEqual(EXPECTED_COMMANDS);
		expect(new Set(names).size).toBe(EXPECTED_COMMANDS.length);

		// Seed one throwaway queue row so /ctx-flush has a visible sidebar change.
		const storageDir = host.env.MAGIC_CONTEXT_STORAGE_DIR;
		if (!storageDir)
			throw new Error("throwaway Magic Context storage path is missing");
		const db = openTestDb(join(storageDir, "context.db"));
		try {
			db.prepare(
				"INSERT INTO pending_ops (session_id, tag_id, operation, queued_at) VALUES (?, ?, 'drop', ?)",
			).run(session.id, 77, Date.now());
		} finally {
			db.close();
		}

		// Stop the HTTP server before captureTui starts the TUI's own server over
		// the same throwaway stores; two host processes must not own them at once.
		await host.stopHost();

		const keys = [
			...commandKeys("/ctx-status"),
			...commandKeys("/ctx-flush"),
			...commandKeys("/ctx-recomp"),
			...commandKeys("/ctx-dream"),
			...commandKeys("/ctx-dream maintain-docs"),
			...commandKeys("/ctx-embed"),
			...commandKeys("/ctx-embed start"),
			...commandKeys("/ctx-embed invalid"),
			...commandKeys("/ctx-wrapup"),
			...commandKeys("/ctx-wrapup 5"),
			...commandKeys("/ctx-wrapup invalid"),
		];
		const markers = [
			"1 pending",
			"Magic Context Status",
			"Flushed: 1 dropped.",
			"Recomp confirmation",
			"This session has no compartments",
			"Dream run started",
			"Ran: maintain-docs",
			"Embedding is off",
			"Embedding started",
			"Usage: /ctx-embed",
			"Wrapup started",
			"Usage: /ctx-wrapup",
		];
		const capture = await captureTui({
			env: host.env,
			root: host.root,
			cwd: host.cwd,
			sessionID: session.id,
			keys,
			markers,
			timeoutMs: 300_000,
		});
		const missing = markers.filter((marker) => !capture.raw.includes(marker));
		if (missing.length > 0) {
			throw new Error(
				`TUI did not show ${missing.join(", ")}\n${capture.text.slice(-6_000)}`,
			);
		}
		expect(capture.raw).not.toContain("Failed to run command");

		expect(capture.sampled).toBe(true);
		expect(capture.openDatabases.length).toBeGreaterThan(0);
		expect(
			capture.openDatabases.filter((path) => !path.startsWith(`${host.root}/`)),
		).toEqual([]);
		// The seeded queue row must have disappeared from the final TUI screen.
		expect(capture.raw.slice(-12_000)).not.toContain("1 pending");

		const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
		expect(log).toContain(
			`sidebar refresh requested for session ${session.id}`,
		);
		expect(log).toContain(
			`[rpc] wrapup requested for session ${session.id} (keep 20)`,
		);
		expect(log).toContain(
			`[rpc] wrapup requested for session ${session.id} (keep 5)`,
		);
	} finally {
		await host.stop();
	}
}, 360_000);
