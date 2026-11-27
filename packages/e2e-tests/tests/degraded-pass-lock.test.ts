/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { TestHarness } from "../src/harness";
import { PLUGIN_ENTRY } from "../src/opencode-runner/spawn";
import { openTestDb } from "../src/test-db";

// A pass whose tagging step finds the writer lock held must not send the
// conversation without the session's persisted drops. This drives a real
// OpenCode 1.18.30 host: a session with a dropped ballast message is served
// once healthy, and on the next turn a second process holds context.db's
// writer lock from the tagging step's first write until the pass settles. No
// request captured after that may carry the ballast, or be larger than the
// previous managed request plus the new turn.
//
// Opt in by running with TMPDIR under $TMPDIR/magic-context/degraded-pass/;
// every root, store and log stays below it.
const enabled = /\/magic-context\/degraded-pass(?:\/|$)/.test(
	resolve(tmpdir()),
);
const residualEnabled = process.env.MC_DEGRADED_RESIDUALS_HOST === "1" &&
	/\/magic-context\/degraded-residuals-[^/]+(?:\/|$)/.test(resolve(tmpdir()));
const BALLAST_MARKER = "BALLAST-DEGRADED-PASS";
const LIVE_STORE =
	/\/Users\/[^/]+\/(\.local\/share\/(opencode|cortexkit)|\.config\/(opencode|cortexkit))\//;

function lsofPaths(pid: number): string[] {
	const result = spawnSync("lsof", ["-p", String(pid), "-Fn"], {
		encoding: "utf8",
	});
	expect(result.status).toBe(0);
	return result.stdout
		.split("\n")
		.filter((line) => line.startsWith("n"))
		.map((line) => line.slice(1));
}

function assertIsolated(pid: number, root: string, label: string): string[] {
	const databases = lsofPaths(pid).filter((path) =>
		/\.db(?:-wal|-shm)?$/.test(path),
	);
	console.info(
		`degraded-pass lsof ${label} pid=${pid} databases=${JSON.stringify(databases)}`,
	);
	expect(databases.filter((path) => LIVE_STORE.test(path))).toEqual([]);
	expect(
		databases.filter(
			(path) => !path.startsWith(root) && !path.startsWith(`/private${root}`),
		),
	).toEqual([]);
	return databases;
}

(enabled ? test : test.skip)(
	"OpenCode 1.18.30: a writer lock held across tagging never sends an unmanaged request",
	async () => {
		expect(
			execFileSync("opencode", ["--version"], { encoding: "utf8" }).trim(),
		).toBe("1.18.30");
		expect(PLUGIN_ENTRY.endsWith("/packages/plugin/src/index.ts")).toBe(true);
		const probeRoot = join(resolve(tmpdir()), `probe-${Date.now()}`);
		mkdirSync(probeRoot, { recursive: true });
		const arm = join(probeRoot, "arm");
		const ready = join(probeRoot, "ready");
		const locked = join(probeRoot, "locked");
		const release = join(probeRoot, "release");
		const wrapper = join(probeRoot, "plugin.ts");
		const storageModule = join(
			dirname(PLUGIN_ENTRY),
			"features/magic-context/storage-db.ts",
		);
		// The wrapper loads the plugin under test unchanged. Once armed, the
		// first writer acquisition made from the tagging step blocks the host
		// until the test's second process holds context.db's writer lock, so
		// that acquisition, and only it, meets the lock. Every earlier write in
		// the pass has already committed. The tagging step is recognized by
		// its stack, so the plugin must load from source (the harness does
		// that whenever the bundle is older than the source).
		writeFileSync(
			wrapper,
			`import mc from ${JSON.stringify(PLUGIN_ENTRY)};
import { openDatabase } from ${JSON.stringify(storageModule)};
import { existsSync, writeFileSync } from "node:fs";
let fired = false;
function holdTaggingWriter() {
    const db = openDatabase();
    if (!db) throw new Error("probe: Magic Context storage is not open");
    const exec = db.exec.bind(db);
    db.exec = (sql, ...rest) => {
        if (
            !fired &&
            /^PRAGMA busy_timeout=/.test(String(sql)) &&
            /tag-messages\\.ts|features\\/magic-context\\/tagger\\.ts/.test(new Error().stack ?? "") &&
            existsSync(${JSON.stringify(arm)})
        ) {
            fired = true;
            writeFileSync(${JSON.stringify(ready)}, "ready");
            const wait = new Int32Array(new SharedArrayBuffer(4));
            while (!existsSync(${JSON.stringify(locked)})) Atomics.wait(wait, 0, 0, 20);
        }
        return exec(sql, ...rest);
    };
}
export default {
    id: mc.id,
    server: async (input, options) => {
        const hooks = await mc.server(input, options);
        holdTaggingWriter();
        return hooks;
    },
};
`,
		);
		const previousEntry = process.env.MC_E2E_PLUGIN_ENTRY;
		process.env.MC_E2E_PLUGIN_ENTRY = wrapper;
		const h = await TestHarness.create({
			magicContextConfig: {
				historian: { disable: true },
				dreamer: { disable: true },
				memory: { enabled: false },
			},
		});
		let locker: ReturnType<typeof Bun.spawn> | undefined;
		try {
			const root = resolve(tmpdir());
			const logPath = join(h.dataDir, "cortexkit", "magic-context-e2e.log");
			const sessionId = await h.createSession();
			const mainRequests = () =>
				h.mock
					.requests()
					.filter((request) => Array.isArray(request.body.messages))
					.map((request) => JSON.stringify(request.body.messages));

			// Turn 1: unmanaged ballast.
			await h.sendPrompt(sessionId, `${BALLAST_MARKER} ${h.ballast(6000)}`);
			await h.waitForMockQuiescence();
			const unmanaged = mainRequests().at(-1) ?? "";
			expect(unmanaged).toContain(BALLAST_MARKER);

			// Persist a drop of the ballast message, as a flushed ctx_reduce leaves it.
			const writable = openTestDb(h.contextDbPath());
			try {
				const tag = writable
					.prepare(
						"SELECT tag_number FROM tags WHERE session_id = ? AND harness = 'opencode' ORDER BY tag_number LIMIT 1",
					)
					.get(sessionId) as { tag_number: number } | null;
				if (!tag) throw new Error("the first turn left no tag to drop");
				writable
					.prepare(
						"UPDATE tags SET status = 'dropped' WHERE session_id = ? AND harness = 'opencode' AND tag_number = ?",
					)
					.run(sessionId, tag.tag_number);
			} finally {
				writable.close();
			}

			// Turn 2: the healthy pass replays the drop; this is the last managed request.
			await h.sendPrompt(sessionId, "turn two");
			await h.waitForMockQuiescence();
			const managed = mainRequests().at(-1) ?? "";
			expect(managed).toContain("turn two");
			expect(managed).not.toContain(BALLAST_MARKER);
			assertIsolated(h.opencode.pid, root, "before-lock");
			const before = h.mock.requests().length;
			writeFileSync(arm, "armed");
			const logOffset = existsSync(logPath)
				? readFileSync(logPath, "utf8").length
				: 0;
			const turn = h
				.sendPrompt(sessionId, "turn three", { timeoutMs: 90_000 })
				.then(
					() => "answered",
					(error: unknown) => `refused: ${String(error).slice(0, 300)}`,
				);
			const readyDeadline = Date.now() + 30_000;
			while (!existsSync(ready) && Date.now() < readyDeadline)
				await Bun.sleep(20);
			expect(existsSync(ready)).toBe(true);

			locker = Bun.spawn(
				[
					"python3",
					"-u",
					"-c",
					"import os,sqlite3,sys,time\ndb=sqlite3.connect(sys.argv[1])\ndb.execute('BEGIN IMMEDIATE')\nprint('locked',flush=True)\nend=time.time()+60\nwhile not os.path.exists(sys.argv[2]) and time.time()<end: time.sleep(0.02)\ndb.rollback()\nprint('released',flush=True)",
					h.contextDbPath(),
					release,
				],
				{ stdout: "pipe", stderr: "pipe" },
			);
			const reader = (locker.stdout as ReadableStream<Uint8Array>).getReader();
			expect(new TextDecoder().decode((await reader.read()).value)).toContain(
				"locked",
			);
			reader.releaseLock();
			assertIsolated(h.opencode.pid, root, "host-while-locked");
			expect(
				assertIsolated(locker.pid, root, "locker").some((path) =>
					path.endsWith("/cortexkit/magic-context/context.db"),
				),
			).toBe(true);
			writeFileSync(locked, "locked");

			// Hold the lock until the pass either reaches tagging or stops at an
			// earlier stage that needs the writer (the overflow-state block
			// writes on every pass) and the wrapper settles it. Releasing
			// earlier would let a pass that continues past a failed stage find
			// the writer free again at tagging.
			const settled =
				/transform tag persistence failed|lkg_replay_served|storage-busy refusal/;
			const failDeadline = Date.now() + 30_000;
			const passLog = () =>
				existsSync(logPath)
					? readFileSync(logPath, "utf8").slice(logOffset)
					: "";
			while (!settled.test(passLog()) && Date.now() < failDeadline) {
				await Bun.sleep(20);
			}
			writeFileSync(release, "release");
			await locker.exited;
			const outcome = await turn;
			await h.waitForMockQuiescence();

			const after = h.mock
				.requests()
				.slice(before)
				.filter((request) => Array.isArray(request.body.messages))
				.map((request) => JSON.stringify(request.body.messages));
			const log = passLog();
			const lockHit = /sqlite writer site=[^\n]* outcome=busy/.test(log);
			const failedStages = [
				...log.matchAll(
					/(transform tag persistence failed[^\n]*|overflow recovery state read failed[^\n]*|transform failed [^\n]*)/g,
				),
			].map((match) => match[1].slice(0, 120));
			const served = /lkg_replay_served/.test(log)
				? "last-good replay"
				: /storage-busy refusal/.test(log)
					? "storage-busy refusal"
					: "pass served";
			console.info(
				`degraded-pass result lock_hit=${lockHit} failed_stages=${JSON.stringify(failedStages)} outcome=${outcome} served=${served} ` +
					`unmanaged_bytes=${unmanaged.length} managed_bytes=${managed.length} ` +
					`after_bytes=${JSON.stringify(after.map((body) => body.length))}`,
			);
			expect(lockHit).toBe(true);
			for (const body of after) {
				expect(body).not.toContain(BALLAST_MARKER);
				expect(body.length).toBeLessThan(unmanaged.length);
				// The previous managed request plus this turn's new messages.
				expect(body.length).toBeLessThan(managed.length + 2_000);
			}
		} catch (error) {
			console.error(
				`degraded-pass host stderr:\n${h.opencode.stderr().slice(-4000)}`,
			);
			throw error;
		} finally {
			locker?.kill();
			await h.dispose();
			if (previousEntry === undefined) delete process.env.MC_E2E_PLUGIN_ENTRY;
			else process.env.MC_E2E_PLUGIN_ENTRY = previousEntry;
		}
	},
	300_000,
);

// Exceptions inside replay-only lanes used to be swallowed whenever the size
// guard admitted the partially replayed array. Inject at the actual message read,
// not at the wrapper: both lanes run on an ordinary, under-limit defer pass.
for (const [stage, fn, lkg, busy] of [
	["stale-reduce-strip-exception", "dropStaleReduceCalls", true, false],
	["image-strip-exception", "stripProcessedImages", false, false],
	["image-strip-exception", "stripProcessedImages", false, true],
] as const) {
	(residualEnabled ? test : test.skip)(
		`OpenCode 1.18.30: ${stage}${busy ? " (storage busy)" : ""} ${lkg ? "replays LKG" : "refuses without LKG"} and never sends raw`,
		async () => {
			expect(execFileSync("opencode", ["--version"], { encoding: "utf8" }).trim()).toBe("1.18.30");
			const root = resolve(tmpdir());
			const probeRoot = join(root, `${stage}-${Date.now()}`);
			mkdirSync(probeRoot, { recursive: true });
			const arm = join(probeRoot, "arm");
			const fired = join(probeRoot, `fired-${Date.now()}`);
			const noticesPath = join(probeRoot, "refusal-notices.json");
			const wrapper = join(probeRoot, "plugin.ts");
			const entry = resolve(import.meta.dir, "../../plugin/src/index.ts");
			writeFileSync(wrapper, `import mc from ${JSON.stringify(entry)};
import { dropSlot } from ${JSON.stringify(join(dirname(entry), "hooks/magic-context/lkg-slot.ts"))};
import { drainNotifications, registerNotificationSink } from ${JSON.stringify(join(dirname(entry), "shared/rpc-notifications.ts"))};
import { existsSync, writeFileSync } from "node:fs";
export default {
    id: mc.id,
    server: async (input, options) => {
        const hooks = await mc.server(input, options);
        const transform = hooks["experimental.chat.messages.transform"];
        let injected = false;
        hooks["experimental.chat.messages.transform"] = async (input, output) => {
            const armed = existsSync(${JSON.stringify(arm)}) && !injected;
            if (armed) {
                ${lkg ? "" : "dropSlot(output.messages.find(m => m.info.sessionID)?.info.sessionID);"}
                for (const message of output.messages) {
                  for (const [target, key] of [[message, "parts"], [message.info, "id"]]) {
                    let value = target[key];
                    Object.defineProperty(target, key, {
                        enumerable: true, configurable: true,
                        get() {
                            const stack = new Error().stack ?? "";
                            if (!injected && stack.includes(${JSON.stringify(fn)})) {
                                injected = true;
                                writeFileSync(${JSON.stringify(fired)}, stack);
                                const error = new Error(${JSON.stringify(`injected ${stage}`)});
                                if (${busy}) error.code = "SQLITE_BUSY";
                                throw error;
                            }
                            return value;
                        },
                        set(next) { value = next; },
                    });
                  }
                }
            }
            const sessionId = output.messages.find(m => m.info.sessionID)?.info.sessionID;
            const live = [];
            const unregister = ${!lkg} && armed && sessionId
                ? registerNotificationSink({ sessionId, protocol: 2, send: notice => live.push(notice) })
                : undefined;
            try {
                return await transform(input, output);
            } finally {
                unregister?.();
                if (unregister && injected) {
                    const queued = drainNotifications(0, sessionId, { sessionOnly: true });
                    writeFileSync(${JSON.stringify(noticesPath)}, JSON.stringify({ live, queued }));
                }
            }
        };
        return hooks;
    },
};`);
			const previous = process.env.MC_E2E_PLUGIN_ENTRY;
			process.env.MC_E2E_PLUGIN_ENTRY = wrapper;
			const h = await TestHarness.create({ mockProviderID: "anthropic", magicContextConfig: {
				historian: { disable: true }, dreamer: { disable: true }, memory: { enabled: false, auto_search: { enabled: false } },
			} });
			try {
				const sessionId = await h.createSession();
				const mainRequests = () => h.mock.requests().filter(request => Array.isArray(request.body.messages));
				await h.sendPrompt(sessionId, `${BALLAST_MARKER} ${h.ballast(6000)}`);
				await h.waitForMockQuiescence();
				const raw = JSON.stringify(mainRequests().at(-1)?.body.messages);
				expect(raw).toContain(BALLAST_MARKER);
				const writable = openTestDb(h.contextDbPath());
				try {
					const changed = writable.prepare("UPDATE tags SET status = 'dropped' WHERE session_id = ? AND harness = 'opencode' AND tag_number = (SELECT MIN(tag_number) FROM tags WHERE session_id = ? AND harness = 'opencode')").run(sessionId, sessionId);
					expect(changed.changes).toBeGreaterThan(0);
				} finally { writable.close(); }
				await h.sendPrompt(sessionId, "managed turn two");
				await h.waitForMockQuiescence();
				const managed = JSON.stringify(mainRequests().at(-1)?.body.messages);
				expect(managed).not.toContain(BALLAST_MARKER);
				const beforeDbs = assertIsolated(h.opencode.pid, root, `${stage}-before`);
				expect(beforeDbs.some(path => path.endsWith("/context.db"))).toBe(true);
				expect(beforeDbs.some(path => path.endsWith("/opencode.db"))).toBe(true);
				const before = h.mock.requests().length;
				const logPath = join(h.dataDir, "cortexkit", "magic-context-e2e.log");
				const offset = readFileSync(logPath, "utf8").length;
				writeFileSync(arm, "armed");
				const outcome = await h.sendPrompt(sessionId, "failed turn three", { timeoutMs: 30_000 }).then(() => "answered", error => `refused: ${String(error).slice(0, 300)}`);
				await h.waitForMockQuiescence();
				// Diagnostics flush asynchronously; wait for the failed stage's
				// record rather than treating an unflushed log as a served pass.
				const deadline = Date.now() + 10_000;
				while (!readFileSync(logPath, "utf8").slice(offset).includes(`site=${stage}`) && Date.now() < deadline) await Bun.sleep(100);
				writeFileSync(join(probeRoot, "diagnostic.log"), readFileSync(logPath, "utf8").slice(offset));
				expect(existsSync(fired)).toBe(true);
				const stack = readFileSync(fired, "utf8");
				expect(stack).toContain(fn);
				const log = readFileSync(logPath, "utf8").slice(offset);
				expect(log).toContain(`site=${stage}`);
				const after = h.mock.requests().slice(before).filter(request => Array.isArray(request.body.messages)).map(request => JSON.stringify(request.body.messages));
				const afterDbs = assertIsolated(h.opencode.pid, root, `${stage}-after`);
				if (lkg) {
					expect(log).toContain("lkg_replay_served");
					expect(after.length).toBeGreaterThan(0);
				} else {
					if (!busy) expect(outcome).toStartWith("refused:");
					const { live, queued } = JSON.parse(readFileSync(noticesPath, "utf8"));
					expect(live).toEqual([
						expect.objectContaining({
							type: "toast",
							sessionId,
							payload: {
								title: "Magic Context",
								variant: busy ? "info" : "error",
								duration: 15000,
								message: busy
									? "Magic Context's database is busy (another process held it too long); send your message again."
									: "Magic Context could not safely prepare this turn [MC-S06] (image-strip-exception). This request was not sent.",
							},
						}),
					]);
					expect(queued).toEqual(busy ? live : []);
					expect(after).toEqual([]);
				}
				for (const body of after) {
					expect(body).not.toContain(BALLAST_MARKER);
					expect(body.length).toBeLessThan(managed.length + 2000);
					expect(body.length).toBeLessThan(raw.length);
				}
				const evidence = { stage, lkg, outcome, rawBytes: raw.length, managedBytes: managed.length, afterBytes: after.map(body => body.length), beforeDbs, afterDbs };
				writeFileSync(join(probeRoot, "result.json"), JSON.stringify(evidence, null, 2));
				writeFileSync(join(probeRoot, "pass.log"), log);
				console.info(`degraded residual host ${JSON.stringify(evidence)}`);
			} finally {
				await h.dispose();
				if (previous === undefined) delete process.env.MC_E2E_PLUGIN_ENTRY;
				else process.env.MC_E2E_PLUGIN_ENTRY = previous;
			}
		}, 120_000,
	);
}
