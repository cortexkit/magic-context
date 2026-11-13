import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import {
	gaDatabasePath,
	V2StoreReader,
} from "../../../plugin/src/v2/store-reader";
import { awaitPluginActivation } from "../../src/opencode2-runner/plugin-activation";
import { assertWriteFenceUnchanged, snapshotWriteFence } from "../../src/opencode2-runner/write-fence";
import { ROOT_KEYS, assertIsolation, assertLiveUnchanged, assertOpenPaths, handoff, isolation, snapshotLive, spawnOpencode2, waitForPluginActive, waitForPluginLog } from '../../src/opencode2-runner/spawn';

test("hermetic_v2_runner environment refuses unsafe roots before boot", () => {
	const fixture = isolation();
	expect(() => assertIsolation(fixture.root, fixture.env)).not.toThrow();
	for (const key of ROOT_KEYS) {
		expect(() =>
			assertIsolation(fixture.root, { ...fixture.env, [key]: undefined }),
		).toThrow(key);
		expect(() =>
			assertIsolation(fixture.root, { ...fixture.env, [key]: homedir() }),
		).toThrow(key);
	}
	expect(() =>
		assertIsolation(fixture.root, { ...fixture.env, OPENCODE_DB: undefined }),
	).toThrow("OPENCODE_DB");
});
test("fd guard refuses operator paths and permits isolated database", () => {
	const fixture = isolation();
	expect(() =>
		assertOpenPaths([join(fixture.root, "db")], fixture.root),
	).not.toThrow();
	expect(() =>
		assertOpenPaths(
			[join(homedir(), ".local/share/opencode/opencode.db")],
			fixture.root,
		),
	).toThrow("forbidden");
	expect(() => assertOpenPaths(["/tmp/.bcd9cd1efcadb2fc-00000007.so"], fixture.root)).not.toThrow();
	expect(() => assertOpenPaths(["/private/tmp/outside.db"], fixture.root)).toThrow("forbidden");
	expect(() => assertOpenPaths(["/private/tmp/outside.db-wal"], fixture.root)).toThrow("forbidden");
	expect(() => assertOpenPaths([join(homedir(), ".config/opencode/opencode.json")], fixture.root)).toThrow("forbidden");
	expect(() => assertOpenPaths([join(homedir(), ".config/other-app/settings.json")], fixture.root)).toThrow("forbidden");
	expect(() => assertOpenPaths([join(homedir(), ".local/state/other-app/state.json")], fixture.root)).toThrow("forbidden");
	// A source file in a directory named `config` is read by the TUI loader, not operator configuration.
	expect(() =>
		assertOpenPaths(["/work/magic-context/packages/plugin/src/config/index.ts"], fixture.root),
	).not.toThrow();
	expect(() => assertOpenPaths(["/tmp/unexpected.txt"], fixture.root, [], ["/tmp/unexpected.txt"])).toThrow("forbidden");
});
test("Foundation HTTP-cache exception permits only the exact opted-in file and SQLite handles", () => {
	const previous = process.env.MC_E2E_FOUNDATION_HTTP_CACHE_DB;
	const root = "/throwaway/fixture";
	const cache = "/private/var/folders/ab/verified-user/C/opencode/Cache.db";
	try {
		delete process.env.MC_E2E_FOUNDATION_HTTP_CACHE_DB;
		expect(() => assertOpenPaths([cache], root)).toThrow("forbidden");
		process.env.MC_E2E_FOUNDATION_HTTP_CACHE_DB = cache;
		for (const suffix of ["", "-wal", "-shm"]) {
			const path = `${cache}${suffix}`;
			if (process.platform === "darwin") {
				expect(() => assertOpenPaths([path], root, [], [path])).not.toThrow();
			} else {
				expect(() => assertOpenPaths([path], root)).toThrow("forbidden");
			}
		}
		for (const path of [
			`${cache}.other.db`, cache.replace("verified-user", "another-user"),
			cache.replace("Cache.db", "opencode.db"),
			join(homedir(), ".local/share/opencode/opencode.db"),
			join(homedir(), ".local/share/cortexkit/magic-context/context.db"),
			join(homedir(), ".config/opencode/settings.json"),
		]) expect(() => assertOpenPaths([path], root)).toThrow("forbidden");
		const unverifiedCache = join(homedir(), ".local/share/opencode/Cache.db");
		process.env.MC_E2E_FOUNDATION_HTTP_CACHE_DB = unverifiedCache;
		expect(() => assertOpenPaths([unverifiedCache], root)).toThrow("forbidden");
	} finally {
		if (previous === undefined) delete process.env.MC_E2E_FOUNDATION_HTTP_CACHE_DB;
		else process.env.MC_E2E_FOUNDATION_HTTP_CACHE_DB = previous;
	}
});
test("live snapshot detects changed database and logs that the top-level HOME fence misses", () => {
	const { root } = isolation();
	const home = join(root, "operator-home");
	const dir = join(home, ".local/share/opencode");
	mkdirSync(join(dir, "log"), { recursive: true });
	writeFileSync(join(dir, "opencode.db"), "original");
	const before = snapshotLive(home);
	const fence = snapshotWriteFence([], home);
	expect(() => assertLiveUnchanged(before, home)).not.toThrow();
	writeFileSync(join(dir, "opencode.db"), "mutated!");
	expect(() => assertLiveUnchanged(before, home)).toThrow("changed");
	expect(() => assertWriteFenceUnchanged(fence, home)).not.toThrow();
	writeFileSync(join(dir, "log", "host.log"), "new log");
	expect(() => assertLiveUnchanged(before, home)).toThrow("changed");
});
test("post-run fence rejects the old observer plugin's marker.log under a replayed repo", () => {
	const { root } = isolation();
	const repo = join(root, "operator-repo");
	const home = join(root, "operator-home");
	mkdirSync(repo);
	mkdirSync(home);
	const existing = join(repo, "existing.txt");
	writeFileSync(existing, "original");
	for (const ignored of ["node_modules", "target", ".git"]) {
		mkdirSync(join(repo, ignored));
		writeFileSync(join(repo, ignored, "large-artifact"), "fixture");
	}
	const before = snapshotWriteFence([repo], home);
	writeFileSync(join(repo, ".DS_Store"), "Finder metadata");
	writeFileSync(join(home, ".DS_Store"), "Finder metadata");
	expect(() => assertWriteFenceUnchanged(before, home)).not.toThrow();
	for (const ignored of ["node_modules", "target", ".git"]) {
		expect(before.before.has(join(repo, ignored))).toBe(true);
		expect(before.before.has(join(repo, ignored, "large-artifact"))).toBe(false);
	}
	const live = snapshotLive(home);
	expect(() => assertWriteFenceUnchanged(before, home)).not.toThrow();
	const context = { directory: repo };
	writeFileSync(join(context.directory, "marker.log"), "old observer plugin output");
	expect(() => assertWriteFenceUnchanged(before, home)).toThrow("E2E_HOST_WRITE_FENCE");
	expect(() => assertLiveUnchanged(live, home)).not.toThrow();
	const afterMarker = snapshotWriteFence([repo], home);
	writeFileSync(existing, "modified content");
	expect(() => assertWriteFenceUnchanged(afterMarker, home)).toThrow("E2E_HOST_WRITE_FENCE");
	const beforeHome = snapshotWriteFence([repo], home);
	writeFileSync(join(home, "unexpected"), "host output");
	expect(() => assertWriteFenceUnchanged(beforeHome, home)).toThrow("E2E_HOST_WRITE_FENCE");
});
test("handoff requires ordered URL and password", () => {
	expect(handoff("server listening on http://127.0.0.1:123\n")).toBeUndefined();
	expect(
		handoff(
			"server listening on http://127.0.0.1:123\nserver password secret\n",
		),
	).toEqual({ url: "http://127.0.0.1:123", password: "secret" });
});
test("OC2 runner rejects a malformed returned draft with message and part indices", async () => {
    const fixture = isolation();
    const plugin = join(fixture.root, "malformed-probe");
    mkdirSync(plugin);
    writeFileSync(join(plugin, "server.js"), `export default {
        id: "malformed-probe", async setup(ctx) {
            await ctx.session.hook("context", draft => {
                draft.messages.push({ role: "user", content: [
                    { type: "text", text: "one" }, { type: "text", text: "two" },
                    { type: "invalid-test-part", value: "malformed fixture" },
                ] });
            });
        },
    };`);
    const host = await spawnOpencode2({ existingIsolation: fixture, probePlugin: plugin, includeMagicContext: false });
    try {
        const client = OpenCode.make({
            baseUrl: host.url,
            headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
        });
        const session = await client.session.create({
            location: { directory: host.cwd },
            model: { providerID: "openai", id: "mock-model" },
        });
        await client.session.prompt({ sessionID: session.id, text: "trigger guard" });
        await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
    } finally {
        await expect(host.stop()).rejects.toThrow(/"partIndex":2.*"type":"invalid-test-part"/);
    }
    const trace = readFileSync(join(fixture.root, "llm-schema-guard.jsonl"), "utf8");
    expect(trace).toContain("FAIL ");
});

test("OC2 runner rejects a plain-object media part while accepting host-created attachments", async () => {
    const fixture = isolation();
    const plugin = join(fixture.root, "plain-media-probe");
    mkdirSync(plugin);
    writeFileSync(join(plugin, "server.js"), `export default {
        id: "plain-media-probe", async setup(ctx) {
            await ctx.session.hook("context", draft => {
                draft.messages.push({ role: "user", content: [
                    { type: "text", text: "image" },
                    { type: "media", media: { source: { type: "base64", data: "AA==", mediaType: "image/png" } } },
                ] });
            });
        },
    };`);
    const host = await spawnOpencode2({ existingIsolation: fixture, probePlugin: plugin, includeMagicContext: false });
    try {
        const client = OpenCode.make({ baseUrl: host.url,
            headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` } });
        const session = await client.session.create({ location: { directory: host.cwd },
            model: { providerID: "openai", id: "mock-model" } });
        await client.session.prompt({ sessionID: session.id, text: "trigger invalid media" });
        await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
    } finally {
        await expect(host.stop()).rejects.toThrow(/"partIndex":1.*"type":"media".*Media.Asset instance/);
    }
});

test("plugin activation rejects a failed plugin with the host error before its deadline", async () => {
	const pluginRoot = mkdtempSync(join(tmpdir(), "mc-oc2-broken-plugin-"));
	writeFileSync(
		join(pluginRoot, "index.js"),
		'export default { id: "broken-activation", setup() { throw new Error("deliberate broken plugin fixture"); } };\n',
	);
	const host = await spawnOpencode2({
		probePlugin: pluginRoot,
		includeMagicContext: false,
	});
	try {
		const client = OpenCode.make({
			baseUrl: host.url,
			headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
		});
		await client.session.create({
			location: { directory: host.cwd },
			model: { providerID: "openai", id: "mock-model" },
		});
		const started = Date.now();
		await expect(
			awaitPluginActivation(client, host.cwd, "broken-activation", 60_000),
		).rejects.toThrow("deliberate broken plugin fixture");
		expect(Date.now() - started).toBeLessThan(60_000);
	} finally {
		await host.stop();
		rmSync(pluginRoot, { recursive: true, force: true });
	}
}, 90_000);

test("v2_loads_via_exports_map and session_message_reader real host writes", async () => {
	const host = await spawnOpencode2();
	try {
		const client = OpenCode.make({
			baseUrl: host.url,
			headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
		});
		const session = await client.session.create({
			title: "v2 runner fixture",
			location: { directory: host.cwd },
			model: { providerID: "openai", id: "mock-model" },
		});
		await waitForPluginActive(client, host.cwd);
		const plugins = await client.plugin.list({
			location: { directory: host.cwd },
		});
		// Both loaders now share the v1 plugin id through the additive union entry.
		expect(
			plugins.data.find((plugin) => plugin.id === "opencode-magic-context")
				?.state.status,
		).toBe("active");
		expect(
			await waitForPluginLog(host.env, "@cortexkit/opencode-magic-context v2 setup"),
		).toContain("@cortexkit/opencode-magic-context v2 setup");
		expect(host.stdout() + host.stderr()).not.toContain("[magic-context]");
		host.mock.setDefault({
			text: "fixture reply",
			usage: { input_tokens: 100, output_tokens: 10 },
		});
		await client.session.prompt({
			sessionID: session.id,
			text: "fixture prompt",
		});
		await client.session.wait(
			{ sessionID: session.id },
			{ signal: AbortSignal.timeout(20000) },
		);
		expect(host.mock.requests().length).toBeGreaterThan(0);
		const reader = new V2StoreReader(
			gaDatabasePath(host.env.XDG_DATA_HOME!, "latest", host.env),
		);
		try {
			const rows = reader.window(session.id);
			if (process.env.OC2_RECORD_FIXTURE === "1")
				writeFileSync(
					new URL("../../src/opencode2-runner/host-rows.json", import.meta.url),
					JSON.stringify(rows, null, 2) + "\n",
				);
			expect(rows.some((row) => row.type === "user")).toBe(true);
			expect(rows.some((row) => row.type === "assistant")).toBe(true);
			expect(reader.idleRows(session.id).at(-1)?.data.outcome).toBe(
				"succeeded",
			);
			expect(rows.map((row) => row.seq)).toEqual(
				rows.map((row) => row.seq).sort((a, b) => a - b),
			);
		} finally {
			reader.close();
		}
	} catch (error) {
		console.error(
			host.stdout(),
			host.stderr(),
			JSON.stringify(host.mock.requests()),
		);
		throw error;
	} finally {
		await host.stop();
	}
}, 60000);

test("GA serve rejects standalone flag; direct serve uses private roots", async () => {
	await expect(spawnOpencode2({ probeStandalone: true })).rejects.toThrow(
		"Unrecognized flag: --standalone",
	);
}, 30000);
