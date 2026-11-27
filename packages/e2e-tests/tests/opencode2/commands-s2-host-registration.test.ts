import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import {
	isolation,
	spawnOpencode2,
	waitForPluginActive,
} from "../../src/opencode2-runner/spawn";

/**
 * A terminal-UI keymap entry lives inside one UI process, so it cannot be
 * reached from `opencode run`, the HTTP API or Desktop. OpenCode 2's command
 * domain can: added definitions go into a registry that `GET /api/command`
 * lists and `POST /api/session/:sessionID/command` executes by calling the
 * plugin back.
 *
 * This proves both halves on the pinned real host with no terminal UI running
 * at all: the commands are listed, and invoking one produces its server-side
 * effect. `/ctx-flush` is the command under test because its effect is
 * observable: the next request must allow queued drops and cleanup as an
 * explicit user flush, which the plugin records in its own log.
 */
const HEURISTICS_DECISION = "heuristics WILL";
const EXPLICIT_FLUSH = "heuristics WILL RUN — reason=pending_materialization origin=user_flush";

async function eventually<T>(
	read: () => T | undefined | Promise<T | undefined>,
	what: string,
	timeoutMs = 20_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await read();
		if (value !== undefined) return value;
		if (Date.now() >= deadline)
			throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(50);
	}
}

function decisions(logPath: string, sessionID: string): string[] {
	if (!existsSync(logPath)) return [];
	return readFileSync(logPath, "utf8")
		.split("\n")
		.filter(
			(line) =>
				line.includes(`[${sessionID}]`) && line.includes(HEURISTICS_DECISION),
		);
}

test("OpenCode 2 lists and runs the /ctx-* commands without a terminal UI", async () => {
	const fixture = isolation();
	const logPath = join(fixture.root, "magic-context-commands.log");
	fixture.env.MAGIC_CONTEXT_LOG_PATH = logPath;
	const host = await spawnOpencode2({
		existingIsolation: fixture,
		providerID: "anthropic",
	});
	try {
		const client = OpenCode.make({
			baseUrl: host.url,
			headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
		});
		const session = await client.session.create({
			title: "host command registration",
			location: { directory: host.cwd },
			model: { providerID: "anthropic", id: "mock-model" },
		});
		await waitForPluginActive(client, host.cwd);
		host.mock.setDefault({
			text: "command fixture reply",
			usage: { input_tokens: 140, output_tokens: 12 },
		});

		// The server-side registry, read the way any non-TUI client reads it.
		const listed = await eventually(async () => {
			const commands = await client.command.list({
				location: { directory: host.cwd },
			});
			const ours = commands.data.filter((command) =>
				command.name.startsWith("ctx-"),
			);
			return ours.length >= 6 ? ours : undefined;
		}, "the /ctx-* commands to appear in the host command registry");
		expect(listed.map((command) => command.name).sort()).toEqual([
			"ctx-dream",
			"ctx-embed",
			"ctx-flush",
			"ctx-recomp",
			"ctx-status",
			"ctx-wrapup",
		]);
		// A listed command with no description is unexplained in every client's
		// command list, so the description has to survive registration too.
		for (const command of listed) {
			expect(command.description ?? "").not.toBe("");
		}

		// Invoke status through the session API without a TUI; reading the status
		// must complete even though there is no dialog surface to receive its result.
		await client.session.command({
			sessionID: session.id,
			name: "ctx-status",
			text: "",
		});

		const prompt = async (text: string): Promise<void> => {
			await client.session.prompt({ sessionID: session.id, text });
			await client.session.wait(
				{ sessionID: session.id },
				{ signal: AbortSignal.timeout(30_000) },
			);
		};

		await prompt("first turn before the command");
		await prompt("second turn before the command");
		// Control: ordinary turns must already have recorded a pass decision and
		// none of them may claim an explicit flush, or the assertion below would
		// pass on a log that never changed.
		const control = await eventually(() => {
			const seen = decisions(logPath, session.id);
			return seen.length >= 2 ? seen : undefined;
		}, "the two control turns to record a pass decision");
		expect(control.filter((line) => line.includes(EXPLICIT_FLUSH))).toEqual([]);

		// The non-TUI entry point: the host executes the registered command by
		// calling this plugin's own callback.
		await client.session.command({
			sessionID: session.id,
			name: "ctx-flush",
			text: "",
		});

		await prompt("turn after the command");
		await prompt("ordinary turn after the flush was consumed");
		const afterCommand = await eventually(() => {
			const seen = decisions(logPath, session.id);
			return seen.length >= 4 ? seen : undefined;
		}, "both turns after the command to record a pass decision");
		expect(afterCommand.map((line) => line.includes(EXPLICIT_FLUSH))).toEqual([false, false, true, false]);
	} catch (error) {
		console.error(
			host.stderr(),
			existsSync(logPath) ? readFileSync(logPath, "utf8") : "(no plugin log)",
		);
		throw error;
	} finally {
		await host.stop();
	}
}, 180_000);
