import { openTestDb } from "../../src/test-db";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { Database } from "../../../plugin/src/shared/sqlite";
import { rawMessages } from "../../../plugin/src/v2/hooks/store";
import { gaDatabasePath, V2StoreReader } from "../../../plugin/src/v2/store-reader";
import {
	inspectOpenFiles,
	isolation,
	spawnOpencode2,
	waitForPluginActive,
} from "../../src/opencode2-runner/spawn";

// OpenCode 2 writes an instruction update (a changed AGENTS.md, a new date) as a
// `system` row in session_message, right before the user turn that follows it.
// The row takes a raw-message ordinal, but the host renders it into the request
// as an id-less system message. A compartment that ends on it names a boundary
// no request contains: every id lookup fails, injection runs degraded and the
// covered history is served raw next to its summary.
//
// Both arms first publish an older compartment and materialize it, so the stored
// baseline sits on an earlier, served row. That is the shape a real session is in
// when a later wrapup lands on an instruction row: the priced pass still trims at
// the old baseline, the defer after it trims nothing, and the prefix grows.
//
// historian-wrapup: /ctx-wrapup snaps its cut to the user turn, which puts the
//   compartment end on the instruction row. The stored boundary must be the
//   served row before it instead.
// stored-boundary-upgrade: a compartment stored by an older build already ends on
//   the instruction row. Trim and injection must find the served row it stands
//   for without entering degraded mode.
// stored-boundary-after-host-checkpoint: the same stored boundary, in a session
//   whose host checkpoint is older than every compartment. The host's window then
//   still holds rows the compartments cover, and Magic Context restores the rows
//   between its boundary and the checkpoint itself on every pass.
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type WireItem = { role?: string; type?: string; content?: unknown };

for (const arm of [
	"historian-wrapup",
	"stored-boundary-upgrade",
	"stored-boundary-after-host-checkpoint",
] as const) {
	test(`OpenCode 2 compartment boundary on an instructions-updated row (${arm}) serves a byte-stable prefix without degraded mode or double serving`, async () => {
		const fixture = isolation();
		const logPath = join(fixture.root, "magic-context.log");
		fixture.env.MAGIC_CONTEXT_LOG_PATH = logPath;
		writeFileSync(join(fixture.cwd, "AGENTS.md"), "Rule one: be brief.\n");
		const checkpoint = arm === "stored-boundary-after-host-checkpoint";
		const host = await spawnOpencode2({
			existingIsolation: fixture,
			// A small window lets one reported high-usage turn make the host compact.
			...(checkpoint ? { modelContextLimit: 16_000, modelOutputLimit: 1024 } : {}),
			magicContextConfig: {
				memory: { enabled: false },
				dreamer: { disable: true },
				historian: arm === "historian-wrapup" ? { two_pass: false } : { disable: true },
			},
		});
		const log = () => (existsSync(logPath) ? readFileSync(logPath, "utf8") : "");
		const mcPath = join(host.env.XDG_DATA_HOME!, "cortexkit", "magic-context", "context.db");
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
			const turn = async (text: string) => {
				await client.session.prompt({ sessionID: session.id, text });
				await client.session.wait(
					{ sessionID: session.id },
					{ signal: AbortSignal.timeout(30_000) },
				);
			};
			// One reported high-usage turn makes the host compact before any
			// compartment exists, so its checkpoint precedes every boundary below.
			if (checkpoint) {
				host.mock.setDefault({ text: "pressure answer", usage: { input_tokens: 15000, output_tokens: 10 } });
				await turn("PRE-CHECKPOINT");
				host.mock.setDefault({ text: "fixture reply", usage: { input_tokens: 100, output_tokens: 10 } });
				await turn("AFTER-CHECKPOINT");
			}
			for (const k of [1, 2, 3]) await turn(`COVERED-${k} ${"older history ".repeat(40)}`);
			writeFileSync(
				join(fixture.cwd, "AGENTS.md"),
				"Rule one: be brief.\nRule two: INSTRUCTION-ROW.\n",
			);
			await Bun.sleep(500);
			for (const k of [1, 2, 3, 4, 5, 6]) await turn(`TAIL-${k} ${"recent history ".repeat(40)}`);

			const reader = new V2StoreReader(
				gaDatabasePath(host.env.XDG_DATA_HOME!, "latest", host.env),
			);
			const rows = reader.history(session.id);
			const types = new Map(rows.map((row) => [row.id, row.type]));
			const raw = rawMessages(rows);
			// Raw rows written before the first COVERED turn: the two checkpoint turns.
			const base = checkpoint ? 4 : 0;
			const instruction = raw.find((message) => types.get(message.id) === "system");
			// Precondition: the host itself wrote the instruction row immediately
			// before the user turn it announces.
			expect(instruction?.ordinal).toBe(base + 7);
			expect(types.get(raw[base + 7]!.id)).toBe("user");
			const servedBefore = raw[base + 5]!;
			expect(types.get(servedBefore.id)).toBe("assistant");
			if (checkpoint) {
				const cut = reader.latestCompaction(session.id);
				expect(cut?.data.status).toBe("completed");
				expect(cut!.seq).toBeLessThan(reader.sequenceForId(session.id, raw[base]!.id)!);
			}

			const mc = openTestDb(mcPath, undefined, Database);
			mc.exec("PRAGMA busy_timeout = 5000");
			const insertCompartment = mc.prepare(
				"INSERT INTO compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, p1, created_at, harness) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'opencode2')",
			);
			const forceHard = () =>
				mc
					.prepare("UPDATE session_meta SET cached_m0_system_hash = 'stale' WHERE session_id = ?")
					.run(session.id);
			const baselineId = () =>
				(
					mc
						.prepare(
							"SELECT cached_m0_last_baseline_end_message_id AS id FROM session_meta WHERE session_id = ?",
						)
						.get(session.id) as { id: string | null }
				).id;

			// Publish and materialize an older compartment ending on a served row, so
			// the stored baseline sits before the later boundary, as in a real session.
			insertCompartment.run(session.id, 0, 1, base + 2, raw[0]!.id, raw[base + 1]!.id, "Baseline", "SUMMARY-BASELINE", "SUMMARY-BASELINE", Date.now());
			forceHard();
			await turn("BASELINE-PASS");
			expect(baselineId()).toBe(raw[base + 1]!.id);
            const baselineTurn = reader.history(session.id).find((row) =>
                row.type === "user" && JSON.stringify(row.data).includes("BASELINE-PASS"));
            expect(baselineTurn).toBeDefined();
            // session.wait settles execution before the plugin's buffered log flushes.
            const logDeadline = Date.now() + 5000;
            while (!log().includes(`turn=${baselineTurn!.id}`) && Date.now() < logDeadline) await Bun.sleep(25);
            expect(log()).toContain(`turn=${baselineTurn!.id}`);

			if (arm !== "historian-wrapup") {
				insertCompartment.run(session.id, 1, base + 3, base + 7, raw[base + 2]!.id, instruction!.id, "Upgrade", "SUMMARY-UPGRADE", "SUMMARY-UPGRADE", Date.now());
			} else {
				host.mock.addMatcher((body) => {
					const range = JSON.stringify(body).match(/Messages (\d+)-(\d+):/);
					if (!range) return null;
					return {
						text: `<compartment start="${range[1]}" end="${range[2]}" title="Wrapup"><p1>SUMMARY-WRAPUP</p1></compartment>`,
						usage: { input_tokens: 100, output_tokens: 40 },
					};
				});
				// Keep exactly the rows from the user turn after the instruction row;
				// the wrapup's user-turn snap then ends the compartment on ordinal 7.
				const total = reader.messageCount(session.id);
				await client.session.command({
					sessionID: session.id,
					name: "ctx-wrapup",
					text: String(total - 7),
				});
				const deadline = Date.now() + 30_000;
				const count = () =>
					(
						mc
							.prepare("SELECT COUNT(*) AS n FROM compartments WHERE session_id = ?")
							.get(session.id) as { n: number }
					).n;
				while (Date.now() < deadline && count() < 2) await Bun.sleep(100);
				const last = mc
					.prepare(
						"SELECT end_message, end_message_id FROM compartments WHERE session_id = ? ORDER BY sequence DESC LIMIT 1",
					)
					.get(session.id) as { end_message: number; end_message_id: string };
				// The boundary is the served row before the instruction row.
				expect(last).toEqual({ end_message: 6, end_message_id: servedBefore.id });
			}

			const logStart = log().length;
			forceHard();
			const bodies: Array<{ input: WireItem[] }> = [];
			for (const name of ["PASS-A-PRICED", "PASS-B-DEFER", "PASS-C-DEFER"]) {
				await turn(name);
				bodies.push(host.mock.requests().at(-1)!.body as { input: WireItem[] });
			}
			const passLog = log().slice(logStart);
			expect(passLog).toContain("HARD fold decision: reason=system_hash executed=true");
			expect(passLog.match(/HARD fold decision/g)).toHaveLength(1);
			expect(passLog).not.toContain("degraded");
			// A defer replays the injection's own cut first, so its second trim finding
			// nothing left to cut is normal. The priced pass must cut at the boundary.
			expect(passLog).not.toMatch(/pass=priced; no in-pass trim applied/);

			const summary = arm === "historian-wrapup" ? "SUMMARY-WRAPUP" : "SUMMARY-UPGRADE";
			for (const body of bodies) {
				const items = body.input.map((item) => JSON.stringify(item));
				const instructionAt = items.findIndex((item) => item.includes("INSTRUCTION-ROW"));
				expect(instructionAt).toBeGreaterThan(0);
				// Everything before the instruction row is the Magic Context head.
				for (const item of items.slice(0, instructionAt))
					expect(item).toContain("session-history");
				expect(items.slice(0, instructionAt).join("")).toContain(summary);
				// The first served row after the boundary follows the instruction row.
				expect(items[instructionAt + 1]).toContain("TAIL-1");
				expect(items.filter((item) => item.includes("INSTRUCTION-ROW"))).toHaveLength(1);
				// Nothing a compartment covers is served raw next to its summary.
				expect(items.some((item) => item.includes("COVERED-"))).toBe(false);
			}
			// The defers append to the priced pass: its bytes are an exact prefix.
			expect(sha(bodies[1]!.input.slice(0, bodies[0]!.input.length))).toBe(sha(bodies[0]!.input));
			expect(sha(bodies[2]!.input.slice(0, bodies[1]!.input.length))).toBe(sha(bodies[1]!.input));

			// Every database the host process holds open lives under the throwaway root.
			const openDatabases = inspectOpenFiles(host.pid!, host.root, host.env).filter((path) =>
				/\.db(-wal|-shm)?$/.test(path),
			);
			expect(openDatabases.length).toBeGreaterThan(0);
			for (const path of openDatabases) expect(path.startsWith(host.root)).toBe(true);
			console.log(`[${arm}] host open databases: ${JSON.stringify(openDatabases)}`);
			mc.close();
			reader.close();
		} catch (error) {
			console.error(host.stderr().slice(-4000), log().slice(-8000));
			throw error;
		} finally {
			await host.stop();
		}
	}, 180_000);
}
