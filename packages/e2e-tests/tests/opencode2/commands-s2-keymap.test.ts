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

/**
 * The server command registry supplies the OpenCode 2 palette and slash entries,
 * including clients with no TUI. A second TUI keymap registration would duplicate
 * those commands, so this checks the server list and then verifies the real TUI
 * does not add another slash layer.
 *
 * The TUI log is read rather than the screen because the host owns the terminal
 * and drops plugin console output.
 */
const EXPECTED_COMMANDS = [
	"ctx-status",
	"ctx-recomp",
	"ctx-dream",
	"ctx-flush",
	"ctx-embed",
	"ctx-wrapup",
];
const REGISTRATION_PREFIX = "registered slash commands:";

test("OpenCode 2 has one server registration for each /ctx-* command", async () => {
	// Without a PTY allocator the TUI never boots, so the claim cannot be
	// checked at all; say that rather than passing on an unrun assertion.
	expect(ptyCaptureAvailable()).toBe(true);

	const fixture = isolation();
	const logPath = join(fixture.root, "magic-context-tui.log");
	fixture.env.MAGIC_CONTEXT_LOG_PATH = logPath;
	const host = await spawnOpencode2({ existingIsolation: fixture });
	try {
		const client = OpenCode.make({
			baseUrl: host.url,
			headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
		});
		const session = await client.session.create({
			title: "keymap command registration",
			location: { directory: host.cwd },
			model: { providerID: "openai", id: "mock-model" },
		});
		await waitForPluginActive(client, host.cwd);

		const listed = await client.command.list({ location: { directory: host.cwd } });
		const names = listed.data
			.filter((command) => command.name.startsWith("ctx-"))
			.map((command) => command.name)
			.sort();
		expect(names).toEqual([...EXPECTED_COMMANDS].sort());
		expect(new Set(names).size).toBe(EXPECTED_COMMANDS.length);

		// The TUI boots its own server against the same throwaway roots, so the
		// serve host has to let go of the store first.
		await host.stopHost();

		// "MAGIC CONTEXT" is the header of the sidebar the same setup() call
		// mounts, so its paint is the signal that the TUI plugin ran to completion.
		const capture = await captureTui({
			env: host.env,
			root: host.root,
			cwd: host.cwd,
			sessionID: session.id,
			keys: ["/ctx-status", "\r", "\r"],
			markers: ["MAGIC CONTEXT", "⚡ Magic Context Status"],
			timeoutMs: 120_000,
		});
		expect({ missing: capture.missing }).toEqual({ missing: [] });

		if (!existsSync(logPath)) throw new Error("the TUI wrote no plugin log");
		const registrations = readFileSync(logPath, "utf8")
			.split("\n")
			.filter((row) => row.includes(REGISTRATION_PREFIX));
		expect(registrations).toEqual([]);

		// Live-store rule: every database the TUI process group held open was
		// inside the throwaway root (captureTui throws on any database outside it).
		expect(capture.sampled).toBe(true);
		expect(
			capture.openDatabases.filter((path) => !path.startsWith(`${host.root}/`)),
		).toEqual([]);
	} finally {
		await host.stop();
	}
}, 240_000);
