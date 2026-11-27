import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { copySessionStateForClone } from "../../../plugin/src/features/magic-context/storage-clone";
import { validateStoredCompartments } from "../../../plugin/src/hooks/magic-context/compartment-runner-validation";
import { estimateTokens } from "../../../plugin/src/hooks/magic-context/read-session-formatting";
import { nonNarrativeStoredGapRanges } from "../../../plugin/src/hooks/magic-context/stored-compartment-gaps";
import type { StatusDetail } from "../../../plugin/src/shared/rpc-types";
import {
	type RpcPortFileRecord,
	rpcPortDir,
} from "../../../plugin/src/shared/rpc-utils";
import { Database } from "../../../plugin/src/shared/sqlite";
import {
	renderUserStatusSummary,
	statusSummaryFromDetail,
} from "../../../plugin/src/shared/status-summary";
import {
	buildForkIdMap,
	forkCloneFilter,
} from "../../../plugin/src/v2/fork-inheritance";
import { readV2MessageRange } from "../../../plugin/src/v2/hooks/store";
import {
	RAW_MESSAGE_TYPES,
	type V2RowStamp,
	V2StoreReader,
} from "../../../plugin/src/v2/store-reader";
import {
	inspectOpenFiles,
	isolation,
	spawnOpencode2,
	waitForPluginActive,
} from "../../src/opencode2-runner/spawn";
import { cleanupE2ETempDir, createE2ETempDir } from "../../src/temp-dir";

const WINDOW = 60_000;
const HISTORIAN = "historian-model";
const MARKERS = [
	"ALPHA",
	"BRAVO",
	"CHARLIE",
	"DELTA",
	"ECHO",
	"FOXTROT",
	"GOLF",
	"HOTEL",
	"INDIA",
	"JULIET",
];
const MISSING_RAW = ["Original-BRAVO", "Original-DELTA"];

interface Summary {
	sequence: number;
	startMessage: number;
	endMessage: number;
	startId: string;
	endId: string;
	title: string;
}

function usingDb<T>(
	path: string,
	action: (db: Database) => T,
	readonly = true,
): T {
	const db = new Database(path, { readonly, fileMustExist: true });
	try {
		// The host is running and writes this store after every turn. Without a
		// wait, a statement that meets the host's write lock fails at once.
		db.exec("PRAGMA busy_timeout = 5000");
		return action(db);
	} finally {
		db.close();
	}
}

function required<T>(value: T | undefined): T {
	assert(value !== undefined);
	return value;
}

async function until<T>(read: () => T | undefined, label: string): Promise<T> {
	const end = Date.now() + 15_000;
	for (;;) {
		const value = read();
		if (value !== undefined) return value;
		if (Date.now() >= end) throw new Error(`Timed out waiting for ${label}`);
		await Bun.sleep(50);
	}
}

function discoverStatusRpc(directory: string, storage: string | undefined) {
	return until(() => {
		const path = rpcPortDir(required(storage), directory);
		if (!existsSync(path)) return undefined;
		const file = readdirSync(path).find((name) => /^port-.*\.json$/.test(name));
		return file
			? (JSON.parse(
					readFileSync(join(path, file), "utf8"),
				) as RpcPortFileRecord)
			: undefined;
	}, "local status RPC");
}

async function callStatusRpc(
	discovery: RpcPortFileRecord,
	directory: string,
	method: "status-detail" | "sidebar-snapshot" | "recomp",
	sessionId: string,
): Promise<StatusDetail> {
	const response = await fetch(
		`http://127.0.0.1:${discovery.port}/rpc/${method}`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${discovery.token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ sessionId, directory }),
		},
	);
	expect(response.ok).toBe(true);
	return (await response.json()) as StatusDetail;
}

test.each([
	"healthy and stale fork bytes",
	"straddling summary keeps copied raw messages",
	"rejected live coverage restores raw messages beyond stored ordinals",
	"damaged parent fork keeps an uncut tail",
	"fork repair is shown until rebuild without changing the wire",
	"converted gap remains valid in the fork and its descendant",
	"an accepted gap still stops the prefix when its copied row differs",
	"one-sided and neighbouring coverage protects the wire",
] as const)("OpenCode 2: %s", async (scenario) => {
	const fixture = isolation(createE2ETempDir("mc-issue-968-"));
	const source = join(
		required(fixture.env.XDG_DATA_HOME),
		"opencode",
		required(fixture.env.OPENCODE_DB),
	);
	const context = join(
		required(fixture.env.MAGIC_CONTEXT_STORAGE_DIR),
		"context.db",
	);
	const summaries = (sessionID: string) =>
		usingDb(
			context,
			(db) =>
				db
					.prepare(`
        SELECT sequence, start_message AS startMessage, end_message AS endMessage,
               start_message_id AS startId, end_message_id AS endId, title
        FROM compartments WHERE session_id = ? ORDER BY sequence`)
					.all(sessionID) as Summary[],
		);
	const rawRows = (sessionID: string) =>
		usingDb(
			source,
			(db) =>
				db
					.prepare(`
        SELECT id, type, seq, time_created, data FROM session_message
        WHERE session_id = ? AND type IN (${RAW_MESSAGE_TYPES.map(() => "?").join(",")})
        ORDER BY seq`)
					.all(sessionID, ...RAW_MESSAGE_TYPES) as {
					id: string;
					type: V2RowStamp["type"];
					seq: number;
					time_created: number;
					data: string;
				}[],
		);
	const historianRuns = (sessionID: string) =>
		usingDb(
			context,
			(db) =>
				db
					.prepare(`
        SELECT status, failure_reason FROM historian_runs WHERE session_id = ? ORDER BY id`)
					.all(sessionID) as {
					status: string;
					failure_reason: string | null;
				}[],
		);
	let host: Awaited<ReturnType<typeof spawnOpencode2>> | undefined;
	let repairing = false;
	let socket: WebSocket | undefined;

	async function start() {
		const server = await spawnOpencode2({
			existingIsolation: fixture,
			modelContextLimit: WINDOW,
			modelOutputLimit: 1024,
			compactionAuto: false,
			magicContextConfig: {
				memory: { enabled: false },
				dreamer: { disable: true },
				historian: { two_pass: false },
			},
			historianModel: { id: HISTORIAN, contextLimit: 200_000 },
		});
		host = server;
		server.mock.setDefault({
			text: "ordinary reply",
			usage: { input_tokens: 100, output_tokens: 10 },
		});
		server.mock.addMatcher((body) => {
			if (body.model !== HISTORIAN) return null;
			const range = JSON.stringify(body).match(/Messages (\d+)-(\d+):/);
			if (!range) return null;
			const title = repairing ? "RebuiltEntireHistory" : "AppendedHistory";
			return {
				text: `<compartment start="${range[1]}" end="${range[2]}" title="${title}"><p1>Continued history.</p1></compartment>`,
				usage: { input_tokens: 100, output_tokens: 20 },
			};
		});
		const client = OpenCode.make({
			baseUrl: server.url,
			headers: {
				authorization: `Basic ${btoa(`opencode:${server.password}`)}`,
			},
		});
		await waitForPluginActive(client, server.cwd);
		return client;
	}

	function audit() {
		const pid = required(host?.pid);
		const paths = inspectOpenFiles(pid, fixture.root, fixture.env).filter(
			(path) => /\.(?:db|sqlite)(?:-(?:wal|shm|journal))?$/.test(path),
		);
		expect(paths).toContain(source);
		expect(paths).toContain(context);
		expect(paths.every((path) => path.startsWith(`${fixture.root}/`))).toBe(
			true,
		);
		console.log(
			"fork history host open databases",
			pid,
			[...new Set(paths)].sort(),
		);
	}

	try {
		const client = await start();
		const captures = () => required(host).mock.requests();
		const historicalRequests = () =>
			captures().filter(({ body }) => body.model === HISTORIAN);
		const unseededForks = new Set<string>();
		async function turn(sessionID: string, text: string) {
			const before = captures().length;
			await client.session.prompt({ sessionID, text });
			await client.session.wait(
				{ sessionID },
				{ signal: AbortSignal.timeout(20_000) },
			);
			const requests = captures()
				.slice(before)
				.filter(
					({ body }) =>
						body.model === "mock-model" && JSON.stringify(body).includes(text),
				);
			expect(requests).toHaveLength(1);
			if (unseededForks.delete(sessionID)) {
				const reader = new V2StoreReader(source);
				try {
					const rows = summaries(sessionID);
					const gaps = usingDb(context, (db) =>
						nonNarrativeStoredGapRanges(db, sessionID, rows, (from, to) =>
							readV2MessageRange(reader, sessionID, from, to),
						),
					);
					expect(validateStoredCompartments(rows, gaps)).toBeNull();
				} finally {
					reader.close();
				}
			}
			return required(requests[0]);
		}
		async function wrap(sessionID: string) {
			const before = historianRuns(sessionID).length;
			await client.session.command({
				sessionID,
				name: "ctx-wrapup",
				text: "2",
			});
			return until(() => historianRuns(sessionID)[before], "wrapup result");
		}
		const parent = (
			await client.session.create({
				title: "Summary range parent",
				location: { directory: fixture.cwd },
				model: { providerID: "openai", id: "mock-model" },
			})
		).id;
		for (const marker of MARKERS)
			await turn(parent, `Original-${marker}: a normal narrative message.`);
		audit();
		const parentRows = rawRows(parent);
		expect(parentRows).toHaveLength(20);
		usingDb(
			context,
			(db) => {
				const insert = db.prepare(`INSERT INTO compartments
                (session_id, sequence, start_message, end_message, start_message_id, end_message_id,
                 title, content, p1, created_at, harness) VALUES (?,?,?,?,?,?,?,?,?,?,'opencode2')`);
				for (const [sequence, start] of [1, 3, 5, 7, 9].entries()) {
					const content = `Summary ${sequence}.`;
					insert.run(
						parent,
						sequence,
						start,
						start + 1,
						required(parentRows[start - 1]).id,
						required(parentRows[start]).id,
						`FixtureSummary${sequence}`,
						content,
						content,
						1,
					);
				}
			},
			false,
		);
		const setAnchor = (
			sequence: number,
			side: "start" | "end",
			value: string,
		) =>
			usingDb(
				context,
				(db) =>
					db
						.prepare(
							`UPDATE compartments SET ${side}_message_id = ? WHERE session_id = ? AND sequence = ?`,
						)
						.run(value, parent, sequence),
				false,
			);
		const fork = async (sessionID = parent) => {
			const child = (await client.session.fork({ sessionID })).id;
			unseededForks.add(child);
			return child;
		};
		const expectInherited = (sessionID: string) => {
			const copies = rawRows(sessionID);
			expect(
				summaries(sessionID).map(
					({
						sequence,
						startMessage: start,
						endMessage: end,
						startId,
						endId,
					}) => [sequence, start, end, startId, endId],
				),
			).toEqual(
				[1, 3, 5, 7, 9].map((start, sequence) => [
					sequence,
					start,
					start + 1,
					required(copies[start - 1]).id,
					required(copies[start]).id,
				]),
			);
		};
		const seen = ({ body }: ReturnType<typeof captures>[number]) =>
			JSON.stringify(body.input ?? body.messages);
		function markDropped(sessionID: string, ordinal: number) {
			const id = `${required(rawRows(sessionID)[ordinal - 1]).id}:p0`;
			usingDb(
				context,
				(db) => {
					// Match the identity and state of a normal historian or manual drop.
					const updated = db
						.prepare(
							"UPDATE tags SET status = 'dropped' WHERE session_id = ? AND message_id = ?",
						)
						.run(sessionID, id);
					if (Number(updated.changes) > 0) return;
					db.prepare(`INSERT INTO tags (session_id, message_id, type, status, byte_size, tag_number, harness)
				    VALUES (?, ?, 'message', 'dropped', 100, ?, 'opencode2')`).run(
						sessionID,
						id,
						100 + ordinal,
					);
				},
				false,
			);
		}
		if (scenario === "one-sided and neighbouring coverage protects the wire") {
			usingDb(
				context,
				(db) =>
					db
						.prepare(
							"DELETE FROM compartments WHERE session_id = ? AND sequence > 1",
						)
						.run(parent),
				false,
			);
			setAnchor(1, "end", required(parentRows[5]).id);
			setAnchor(1, "start", "missing-start");
			for (const ordinal of [3, 5, 7]) markDropped(parent, ordinal);
			for (const neighbour of [false, true]) {
				setAnchor(
					0,
					"end",
					neighbour ? required(parentRows[1]).id : "missing-end",
				);
				usingDb(
					context,
					(db) =>
						db
							.prepare(
								"UPDATE compartments SET start_message = ? WHERE session_id = ? AND sequence = 1",
							)
							.run(neighbour ? 4 : 3, parent),
					false,
				);
				const sessionID = await fork();
				const input = seen(
					await turn(
						sessionID,
						"Keep raw content even when a saved endpoint is missing.",
					),
				);
				expect(summaries(sessionID).map(({ sequence }) => sequence)).toEqual(
					neighbour ? [0] : [],
				);
				expect(input).toContain("Original-CHARLIE");
				expect(input).toContain("Original-BRAVO");
				expect(input).not.toContain("Original-DELTA");
			}
			return;
		}
		if (
			scenario ===
				"converted gap remains valid in the fork and its descendant" ||
			scenario ===
				"an accepted gap still stops the prefix when its copied row differs"
		) {
			const changed = scenario.startsWith("an accepted gap");
			usingDb(
				context,
				(db) => {
					db.prepare("DELETE FROM compartments WHERE session_id = ?").run(
						parent,
					);
					const insert =
						db.prepare(`INSERT INTO compartments (session_id, sequence, start_message, end_message,
					start_message_id, end_message_id, title, content, p1, created_at, harness)
					VALUES (?,?,?,?,?,?,?,?,?,1,'opencode2')`);
					for (const [sequence, [from, to]] of [
						[1, 4],
						[6, 10],
						[11, 14],
					].entries()) {
						const text = `Summary through ${to}.`;
						insert.run(
							parent,
							sequence,
							from,
							to,
							required(parentRows[required(from) - 1]).id,
							required(parentRows[required(to) - 1]).id,
							`FixtureSummary${sequence}`,
							text,
							text,
						);
					}
					db.prepare(
						"UPDATE session_meta SET coordinate_rebase_notice = ? WHERE session_id = ?",
					).run(JSON.stringify({ generation: "v2", healedGaps: 1 }), parent);
				},
				false,
			);
			const sessionID = await fork();
			const parentGap = required(parentRows[4]).id;
			const forkGap = required(rawRows(sessionID)[4]).id;
			// The parent accepts this counted synthetic message only because
			// of its v2 coordinate_rebase_notice record.
			usingDb(
				source,
				(db) => {
					db.prepare(
						"UPDATE session_message SET type = 'synthetic' WHERE id IN (?, ?)",
					).run(parentGap, forkGap);
					if (changed)
						db.prepare(
							"UPDATE session_message SET data = json_set(data, '$.text', 'Changed copied gap') WHERE id = ?",
						).run(forkGap);
				},
				false,
			);
			const input = seen(
				await turn(sessionID, "Read from the converted fork."),
			);
			expect(summaries(sessionID).map(({ sequence }) => sequence)).toEqual(
				changed ? [0] : [0, 1, 2],
			);
			const sidebar = async (id: string) =>
				callStatusRpc(
					await discoverStatusRpc(
						fixture.cwd,
						fixture.env.MAGIC_CONTEXT_STORAGE_DIR,
					),
					fixture.cwd,
					"sidebar-snapshot",
					id,
				);
			expect((await sidebar(sessionID)).forkHistoryGap).not.toBe(true);
			if (!changed) {
				for (const seq of [0, 1, 2])
					expect(input).toContain(`FixtureSummary${seq}`);
				const child = await fork(sessionID);
				await turn(child, "Read from a descendant of the converted fork.");
				expect(summaries(child).map(({ sequence }) => sequence)).toEqual([
					0, 1, 2,
				]);
				expect((await sidebar(child)).forkHistoryGap).not.toBe(true);
			}
			expect((await wrap(sessionID)).status).toBe("success");
			return;
		}
		if (scenario === "straddling summary keeps copied raw messages") {
			const straddling = await fork();
			await turn(parent, "The fork did not copy this final parent turn.");
			const end = required(rawRows(parent).at(-1));
			usingDb(
				context,
				(db) => {
					db.prepare(
						"DELETE FROM compartments WHERE session_id = ? AND sequence > 1",
					).run(parent);
					db.prepare(`UPDATE compartments SET end_message = 22, end_message_id = ?, title = 'StraddlingSummary'
				    WHERE session_id = ? AND sequence = 1`).run(end.id, parent);
				},
				false,
			);
			markDropped(parent, 3);
			const input = seen(
				await turn(straddling, "The copied half is still raw."),
			);
			expect(summaries(straddling).map(({ sequence }) => sequence)).toEqual([
				0,
			]);
			expect(input).not.toContain("StraddlingSummary");
			expect(input).toContain("Original-BRAVO");
			expect(input).not.toContain(
				"The fork did not copy this final parent turn.",
			);
			return;
		}
		if (scenario === "healthy and stale fork bytes") {
			const forkPrompt = "Answer the fork's first request.";
			// GOLF is outside the last summary, so this independent drop must replay.
			markDropped(parent, 13);
			const healthy = await fork();
			const control = await fork();
			// The reference uses the original two-ID rule in the shared copier. The
			// real sibling forks share parent messages, reply IDs and the cache key.
			const through = required(parentRows.at(-1)).seq;
			const controlMap = buildForkIdMap(parentRows, rawRows(control), through);
			usingDb(
				context,
				(db) =>
					copySessionStateForClone(
						db,
						parent,
						control,
						forkCloneFilter(controlMap, new Set()),
					),
				false,
			);
			const healthyParent = summaries(parent);
			const healthyRequest = await turn(healthy, forkPrompt);
			const controlRequest = await turn(control, forkPrompt);
			expect(required(healthyRequest.rawBody)).toBe(
				required(controlRequest.rawBody),
			);
			expectInherited(healthy);
			expect(summaries(parent)).toEqual(healthyParent);
			const healthyInput = seen(healthyRequest);
			expect(healthyInput).not.toContain("Original-GOLF");
			expect(healthyRequest.body.prompt_cache_key).toBe(parent);

			setAnchor(1, "start", "missing-start");
			setAnchor(3, "end", "missing-end");
			const staleParent = summaries(parent);
			const repaired = await fork();
			const copies = rawRows(repaired);
			expect(copies.map(({ id: _id, ...row }) => row)).toEqual(
				parentRows.map(({ id: _id, ...row }) => row),
			);
			const repairedRequest = await turn(repaired, forkPrompt);
			const repairedInput = seen(repairedRequest);
			expectInherited(repaired);
			expect(repairedInput).toBe(healthyInput);
			expect(repairedRequest.rawBody).toBe(healthyRequest.rawBody);
			for (const marker of MISSING_RAW)
				expect(repairedInput).not.toContain(marker);
			expect(repairedInput).toContain("Original-FOXTROT");
			expect(summaries(parent)).toEqual(staleParent);

			// This anchor is live, but contradicts the saved end position. The next
			// summary must not advance the cut across the resulting raw tail.
			setAnchor(1, "end", required(parentRows[4]).id);
			const conflictingParent = summaries(parent);
			const unproven = await fork();
			const unprovenRequest = await turn(unproven, "Read the intact raw tail.");
			expect(summaries(unproven).map(({ sequence }) => sequence)).toEqual([0]);
			for (const marker of MISSING_RAW)
				expect(seen(unprovenRequest)).toContain(marker);
			expect(seen(unprovenRequest)).not.toContain("FixtureSummary2");
			const tokens = estimateTokens(JSON.stringify(unprovenRequest.body));
			expect(tokens).toBeLessThan(WINDOW);
			console.log(
				"unproven fork estimated request tokens / window",
				tokens,
				WINDOW,
			);
			// Finish all fixture writes before starting either background historian.
			expect((await wrap(repaired)).status).toBe("success");
			expect(summaries(repaired).at(-1)?.startMessage).toBe(11);
			expect((await wrap(unproven)).status).toBe("success");
			expect(summaries(unproven).at(-1)?.startMessage).toBe(3);
			expect(summaries(parent)).toEqual(conflictingParent);
			return;
		}
		if (
			scenario ===
			"rejected live coverage restores raw messages beyond stored ordinals"
		) {
			usingDb(
				context,
				(db) =>
					db
						.prepare(
							"DELETE FROM compartments WHERE session_id = ? AND sequence > 1",
						)
						.run(parent),
				false,
			);
			setAnchor(1, "end", required(parentRows[4]).id);
			markDropped(parent, 5);
			markDropped(parent, 7);
			const sessionID = await fork();
			const input = seen(
				await turn(sessionID, "The rejected live range stays raw."),
			);
			expect(summaries(sessionID).map(({ sequence }) => sequence)).toEqual([0]);
			expect(input).toContain("Original-CHARLIE");
			expect(input).not.toContain("Original-DELTA");
			return;
		}

		// Pre-seed the compartments as an older plugin left them, with a gap in
		// the middle. A seed on the next turn must not silently recopy this fork.
		async function seedBroken() {
			const broken = await fork();
			unseededForks.delete(broken); // Pre-existing broken history, not a clone seed.
			const brokenRows = rawRows(broken);
			usingDb(
				context,
				(db) => {
					for (const sequence of [0, 2, 4]) {
						const start = sequence * 2;
						db.prepare(`INSERT INTO compartments (session_id, sequence, start_message, end_message,
                    start_message_id, end_message_id, title, content, p1, created_at, harness)
                    SELECT ?, sequence, start_message, end_message, ?, ?, title, content, p1, created_at, harness
                    FROM compartments WHERE session_id = ? AND sequence = ?`).run(
							broken,
							required(brokenRows[start]).id,
							required(brokenRows[start + 1]).id,
							parent,
							sequence,
						);
					}
				},
				false,
			);
			return broken;
		}
		const broken = await seedBroken();
		if (scenario === "damaged parent fork keeps an uncut tail") {
			// Ordinal 5 is in a validly anchored summary after the gap; ordinal 3
			// is in no parent summary. Only the former removal depends on coverage.
			markDropped(broken, 3);
			markDropped(broken, 5);
			const child = await fork(broken);
			const input = seen(await turn(child, "Read the surviving fork history."));
			expect(summaries(child).map(({ sequence }) => sequence)).toEqual([0]);
			expect(input).toContain("Original-CHARLIE");
			expect(input).toContain("Original-DELTA");
			expect(input).not.toContain("Original-BRAVO");
			return;
		}
		const control = await seedBroken();
		const server = required(host);
		const discovery = await discoverStatusRpc(
			fixture.cwd,
			fixture.env.MAGIC_CONTEXT_STORAGE_DIR,
		);
		const rpc = async (
			method: "status-detail" | "sidebar-snapshot" | "recomp",
			sessionID = broken,
		) => callStatusRpc(discovery, fixture.cwd, method, sessionID);
		const allRows = () =>
			usingDb(source, (db) =>
				db
					.prepare(
						"SELECT * FROM session_message WHERE session_id = ? ORDER BY seq",
					)
					.all(broken),
			);
		const before = allRows();
		const calls = captures().length;
		expect((await rpc("sidebar-snapshot")).forkHistoryGap).toBe(true);
		const warning = "This fork's saved history has a gap.";
		const frames: {
			type: string;
			notification?: {
				id: number;
				payload?: { message?: string; action?: string };
			};
		}[] = [];
		// Bun accepts upgrade headers; the DOM constructor in this package's
		// TypeScript environment only declares the subprotocol argument.
		const BunWebSocket = WebSocket as unknown as new (
			url: string,
			options: { headers: Record<string, string> },
		) => WebSocket;
		socket = new BunWebSocket(`ws://127.0.0.1:${discovery.port}/ws`, {
			headers: { Authorization: `Bearer ${discovery.token}` },
		});
		const hello = () =>
			required(socket).send(
				JSON.stringify({
					type: "hello",
					token: discovery.token,
					protocol: 2,
					sessionId: broken,
				}),
			);
		socket.addEventListener("message", ({ data }) =>
			frames.push(JSON.parse(String(data))),
		);
		socket.addEventListener("open", hello, { once: true });
		await until(
			() => frames.find((frame) => frame.type === "hello-ack"),
			"attached terminal notification sink",
		);
		await client.session.command({
			sessionID: broken,
			name: "ctx-status",
			text: "",
		});
		await until(
			() =>
				frames.find(
					({ notification }) =>
						notification?.payload?.action === "show-status-dialog",
				),
			"terminal status command",
		);
		const detail = await rpc("status-detail");
		expect(detail.forkHistoryGap).toBe(true);
		expect(
			renderUserStatusSummary(statusSummaryFromDetail(detail), "plain"),
		).toContain(warning);
		const forkToasts = () =>
			frames.filter(({ notification }) =>
				notification?.payload?.message?.includes(warning),
			);
		await until(() => (forkToasts().length ? true : undefined), "repair toast");
		await rpc("sidebar-snapshot");
		await rpc("status-detail");
		hello();
		await until(
			() =>
				frames.filter(({ type }) => type === "hello-ack").length >= 2
					? true
					: undefined,
			"notification ordering fence",
		);
		expect(forkToasts()).toHaveLength(1);
		expect(
			server
				.pluginLog()
				.split("\n")
				.filter(
					(line) =>
						line.includes(broken) &&
						line.includes("/ctx-recomp repairs this fork"),
				),
		).toHaveLength(1);
		expect(allRows()).toEqual(before);
		expect(captures()).toHaveLength(calls);
		// This used to arm a synthetic notice even if the user never opened status.
		expect((await wrap(broken)).failure_reason).toContain(
			"gap before message 5",
		);
		expect((await wrap(control)).failure_reason).toContain(
			"gap before message 5",
		);
		expect(allRows()).toEqual(before);
		expect(captures()).toHaveLength(calls);

		const question = "A displayed history gap must not change this request.";
		const controlRequest = await turn(control, question);
		const displayedRequest = await turn(broken, question);
		expect(required(displayedRequest.rawBody)).toBe(
			required(controlRequest.rawBody),
		);
		expect(
			rawRows(broken)
				.slice(-2)
				.map(({ type }) => type),
		).toEqual(["user", "assistant"]);
		expect(seen(displayedRequest)).not.toContain(warning);

		const parentBefore = summaries(parent);
		repairing = true;
		// The dialog invokes the same rebuild RPC after terminal confirmation.
		await rpc("recomp");
		const rebuilt = await until(() => {
			const rows = summaries(broken);
			return rows.some(({ title }) => title === "RebuiltEntireHistory")
				? rows
				: undefined;
		}, "full history rebuild");
		expect(validateStoredCompartments(rebuilt)).toBeNull();
		const repairRequest = JSON.stringify(historicalRequests()[0]?.body);
		for (const marker of MISSING_RAW) expect(repairRequest).toContain(marker);
		expect(repairRequest).not.toContain(warning);
		expect((await rpc("sidebar-snapshot")).forkHistoryGap).not.toBe(true);
		const repairedDetail = await rpc("status-detail");
		expect(repairedDetail.forkHistoryGap).not.toBe(true);
		expect(
			renderUserStatusSummary(statusSummaryFromDetail(repairedDetail), "plain"),
		).not.toContain(warning);
		const after = seen(await turn(broken, "After rebuilding the fork."));
		expect(after).toContain("RebuiltEntireHistory");
		expect(after).not.toContain("FixtureSummary");
		expect(summaries(parent)).toEqual(parentBefore);
	} catch (error) {
		console.error(
			host?.stderr().slice(-3_000),
			host
				?.pluginLog()
				.split("\n")
				.filter((line) => /fork|historian|wrapup|recomp/.test(line))
				.slice(-35)
				.join("\n"),
		);
		throw error;
	} finally {
		socket?.close();
		await host?.stop();
		cleanupE2ETempDir(fixture.root);
	}
}, 120_000);
