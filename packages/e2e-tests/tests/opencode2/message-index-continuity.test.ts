import { openTestDb } from "../../src/test-db";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { getLastIndexedOrdinal } from "../../../plugin/src/features/magic-context/message-index";
import { searchMessageHistory } from "../../../plugin/src/features/magic-context/search";
import { Database } from "../../../plugin/src/shared/sqlite";
import { renderSearchArchive } from "../../../plugin/src/tools/ctx-expand/search-archive";
import {
	gaDatabasePath,
	RAW_MESSAGE_TYPES,
	V2StoreReader,
} from "../../../plugin/src/v2/store-reader";
import {
	inspectOpenFiles,
	spawnOpencode2,
	waitForPluginActive,
} from "../../src/opencode2-runner/spawn";

test("OpenCode 2 real host advances the raw index after a new post-rebase message", async () => {
	const host = await spawnOpencode2();
	const storage = host.env.MAGIC_CONTEXT_STORAGE_DIR;
	const dataHome = host.env.XDG_DATA_HOME;
	const pid = host.pid;
	if (!storage || !dataHome || !pid) {
		await host.stop();
		throw new Error("Host did not supply its isolated storage and PID");
	}
	const db = openTestDb(join(storage, "context.db"), undefined, Database);
	const client = OpenCode.make({
		baseUrl: host.url,
		headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
	});
	try {
		const session = await client.session.create({
			location: { directory: host.cwd },
			model: { providerID: "openai", id: "mock-model" },
		});
		await waitForPluginActive(client, host.cwd);
		const prompt = async (text: string) => {
			await client.session.prompt({ sessionID: session.id, text });
			await client.session.wait(
				{ sessionID: session.id },
				{ signal: AbortSignal.timeout(20000) },
			);
		};
		await prompt("Before the one-time generation stamp");
		const generation = db
			.prepare(
				"SELECT coordinate_generation FROM session_meta WHERE session_id = ?",
			)
			.get(session.id) as { coordinate_generation: string };
		expect(generation.coordinate_generation).toBe("v2");
		// Production defers indexing through the fixed two-minute boot quiet period.
		const bootDeadline = Date.now() + 150000;
		while (
			getLastIndexedOrdinal(db, session.id) === 0 &&
			Date.now() < bootDeadline
		)
			await Bun.sleep(100);
		const before = getLastIndexedOrdinal(db, session.id);
		expect(before).toBeGreaterThan(0);
		const needle = "postrebaseneedle772";
		await prompt(`${needle} newly written raw message`);
		let hits: ReturnType<typeof searchMessageHistory>;
		const deadline = Date.now() + 15000;
		do {
			hits = searchMessageHistory(db, {
				sessionId: session.id,
				query: needle,
				probes: [needle],
				limit: 5,
				collectDiagnostics: false,
				dateRange: null,
			});
			if (hits.results.length) break;
			await Bun.sleep(25);
		} while (Date.now() < deadline);
		expect(hits.results).toHaveLength(1);
		const hit = hits.results[0];
		if (!hit || hit.messageOrdinal === undefined)
			throw new Error("Search did not return the new message's ordinal");
		const after = getLastIndexedOrdinal(db, session.id);
		expect(after).toBeGreaterThan(before);
		expect(hit.messageOrdinal).toBeGreaterThan(before);
		const archive = renderSearchArchive(
			db,
			session.id,
			hit.messageOrdinal,
			hit.messageOrdinal,
			1000,
			true,
		);
		expect(archive).toContain(`${needle} newly written raw message`);
		const paths = inspectOpenFiles(pid, host.root, host.env);
		const rawDb = new Database(gaDatabasePath(dataHome, "latest", host.env), {
			readonly: true,
		});
		let queryPlans: unknown[];
		try {
			queryPlans = [
				...rawDb
					.prepare(
						"EXPLAIN QUERY PLAN SELECT MAX(seq) FROM session_message WHERE session_id = ?",
					)
					.all(session.id),
				...rawDb
					.prepare(
						`EXPLAIN QUERY PLAN SELECT COUNT(*) FROM session_message WHERE session_id = ? AND seq > ? AND seq <= ? AND type IN (${RAW_MESSAGE_TYPES.map(() => "?").join(",")})`,
					)
					.all(session.id, 0, 100, ...RAW_MESSAGE_TYPES),
			];
			expect(JSON.stringify(queryPlans)).not.toContain("SCAN session_message");
			expect(JSON.stringify(queryPlans)).toContain("INDEX");
		} finally {
			rawDb.close();
		}
		console.log(
			JSON.stringify({
				version: process.env.MC_E2E_OPENCODE2_VERSION,
				before,
				after,
				search: hits.results,
				ctx_expand: archive,
				lsofPid: host.pid,
				isolatedRoot: host.root,
				queryPlans,
				databases: paths.filter((path) => /\.db(?:-wal|-shm)?$/.test(path)),
			}),
		);
		const rawCount = () => {
			const reader = new V2StoreReader(
				gaDatabasePath(dataHome, "latest", host.env),
			);
			try {
				return reader.messageCount(session.id);
			} finally {
				reader.close();
			}
		};
		const searchFor = (query: string) =>
			searchMessageHistory(db, {
				sessionId: session.id,
				query,
				probes: [query],
				limit: 5,
				collectDiagnostics: false,
				dateRange: null,
			}).results;
		const waitForMessage = async (query: string) => {
			const deadline = Date.now() + 15000;
			while (Date.now() < deadline) {
				const hit = searchFor(query)[0];
				if (hit) return hit;
				await Bun.sleep(25);
			}
			throw new Error(`Message index did not find ${query}`);
		};
		await prompt("revertedneedle772 remove this turn from search");
		const reverted = await waitForMessage("revertedneedle772");
		if (!reverted.messageId || reverted.messageOrdinal === undefined)
			throw new Error("Revert target did not have an indexed message identity");
		const beforeRevert = rawCount();
		await client.session.revert.stage({
			sessionID: session.id,
			messageID: reverted.messageId,
		});
		expect(rawCount()).toBe(beforeRevert);
		await client.session.revert.commit({ sessionID: session.id });
		const afterRevert = rawCount();
		expect(afterRevert).toBeLessThan(beforeRevert);
		expect(afterRevert).toBe(reverted.messageOrdinal - 1);
		const revertDeadline = Date.now() + 15000;
		while (
			getLastIndexedOrdinal(db, session.id) !== afterRevert &&
			Date.now() < revertDeadline
		)
			await Bun.sleep(25);
		expect(getLastIndexedOrdinal(db, session.id)).toBe(afterRevert);
		expect(searchFor("revertedneedle772")).toEqual([]);
		await prompt("replacementneedle772 append after committed revert");
		const replacement = await waitForMessage("replacementneedle772");
		expect(replacement.messageOrdinal).toBe(afterRevert + 1);
		expect(getLastIndexedOrdinal(db, session.id)).toBeLessThanOrEqual(
			rawCount(),
		);
		expect(searchFor("revertedneedle772")).toEqual([]);
		expect(host.pluginLog()).not.toContain("reconciliation stalled");
		inspectOpenFiles(pid, host.root, host.env);
		console.log(
			JSON.stringify({
				version: process.env.MC_E2E_OPENCODE2_VERSION,
				revert: {
					before: beforeRevert,
					after: afterRevert,
					watermark: getLastIndexedOrdinal(db, session.id),
				},
				revertedSearch: searchFor("revertedneedle772"),
				replacementSearch: searchFor("replacementneedle772"),
			}),
		);
	} finally {
		db.close();
		await host.stop();
	}
});
