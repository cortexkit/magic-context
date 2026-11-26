import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { copySessionStateForClone } from "../../../plugin/src/features/magic-context/storage-clone";
import { validateStoredCompartments } from "../../../plugin/src/hooks/magic-context/compartment-runner-validation";
import { estimateTokens } from "../../../plugin/src/hooks/magic-context/read-session-formatting";
import { Database } from "../../../plugin/src/shared/sqlite";
import {
	buildForkIdMap,
	forkCloneFilter,
} from "../../../plugin/src/v2/fork-inheritance";
import { FORK_HISTORY_NOTICE } from "../../../plugin/src/v2/hooks/storage-notice";
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
const NOTICE_QUESTION = "The first user pass after a pending repair notice.";
const QUEUED_QUESTION =
	"The next user message is queued behind the notice step.";

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

test.each([
	"healthy and stale fork bytes",
	"straddling summary keeps copied raw messages",
	"damaged parent fork keeps an uncut tail",
	"fork notice is sent from a user pass and survives either crash boundary",
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
	const notices = (sessionID: string) =>
		rawRows(sessionID).filter(
			({ type, data }) =>
				type === "synthetic" && JSON.parse(data).text === FORK_HISTORY_NOTICE,
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
	let noticeSession = "";
	let followOnHeld = false;
	const releaseFollowOn = Promise.withResolvers<void>();
	const observer = scenario.includes("notice is sent")
		? Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				async fetch(request) {
					if (
						new URL(request.url).searchParams.get("session") ===
							noticeSession &&
						!followOnHeld
					) {
						followOnHeld = true;
						await releaseFollowOn.promise;
					}
					return new Response("ok");
				},
			})
		: undefined;
	const probe = observer && join(fixture.root, "queue-behind-fork-notice");
	if (probe) {
		mkdirSync(probe);
		writeFileSync(
			join(probe, "server.js"),
			`export default { id: 'queue-behind-fork-notice', async setup(context) {
			await context.session.hook('context', async draft => {
				const question = draft.messages.findIndex(m => m.content.some(p => typeof p.text === 'string' && p.text.includes(${JSON.stringify(NOTICE_QUESTION)})));
				if (question < 0 || !draft.messages.slice(question + 1).some(m => m.role === 'assistant')) return;
				await (await fetch(${JSON.stringify(`http://127.0.0.1:${observer?.port}/?session=`)} + draft.sessionID)).text();
			});
		}};`,
		);
	}

	async function start() {
		const server = await spawnOpencode2({
			existingIsolation: fixture,
			...(probe ? { probePlugin: probe } : {}),
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
		if (probe)
			await waitForPluginActive(client, server.cwd, "queue-behind-fork-notice");
		return client;
	}

	async function stop() {
		await required(host).stop();
		host = undefined;
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
		let client = await start();
		const captures = () => required(host).mock.requests();
		const historicalRequests = () =>
			captures().filter(({ body }) => body.model === HISTORIAN);
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
		const fork = async () =>
			(await client.session.fork({ sessionID: parent })).id;
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
			expect((await wrap(repaired)).status).toBe("success");
			expect(summaries(repaired).at(-1)?.startMessage).toBe(11);
			expect(summaries(parent)).toEqual(staleParent);

			// This anchor is live, but contradicts the saved end position. The next
			// summary must not advance the cut across the resulting raw tail.
			setAnchor(1, "end", required(parentRows[4]).id);
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
			expect((await wrap(unproven)).status).toBe("success");
			expect(summaries(unproven).at(-1)?.startMessage).toBe(3);
			return;
		}

		// Pre-seed the compartments as an older plugin left them, with a gap in
		// the middle. A seed on the next turn must not silently recopy this fork.
		async function seedBroken() {
			const broken = await fork();
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
			const child = (await client.session.fork({ sessionID: broken })).id;
			const input = seen(await turn(child, "Read the surviving fork history."));
			expect(summaries(child).map(({ sequence }) => sequence)).toEqual([0]);
			expect(input).toContain("Original-CHARLIE");
			expect(input).toContain("Original-DELTA");
			expect(input).not.toContain("Original-BRAVO");
			return;
		}
		const noNotice = await seedBroken();
		const noticeKey = `%:fork-history-notice/${broken}`;
		const pendingValue = () =>
			usingDb(
				source,
				(db) =>
					db.prepare("SELECT value FROM kv WHERE key LIKE ?").get(noticeKey) as
						| { value: string }
						| undefined,
			)?.value;
		const calls = captures().length;
		expect(await wrap(broken)).toEqual({
			status: "failed",
			failure_reason: "existing-validation: gap before message 5 (expected 3)",
		});
		const pending = required(pendingValue());
		expect(JSON.parse(pending)).toMatchObject({ id: expect.any(String) });
		expect(notices(broken)).toHaveLength(0);
		expect(captures()).toHaveLength(calls);
		const beforeRestart = summaries(parent);
		audit();
		await stop();

		client = await start();
		audit();
		const controlRequest = await turn(noNotice, NOTICE_QUESTION);
		noticeSession = broken;
		const beforeSend = captures().length;
		await client.session.prompt({ sessionID: broken, text: NOTICE_QUESTION });
		await until(
			() => (followOnHeld ? true : undefined),
			"the host's notice follow-on step",
		);
		const first = required(captures()[beforeSend]);
		expect(required(first.rawBody)).toBe(required(controlRequest.rawBody));
		expect(seen(first)).not.toContain(FORK_HISTORY_NOTICE);
		const queued = await client.session.prompt({
			sessionID: broken,
			text: QUEUED_QUESTION,
			delivery: "queue",
		});
		expect(queued.delivery).toBe("queue");
		releaseFollowOn.resolve();
		await client.session.wait(
			{ sessionID: broken },
			{ signal: AbortSignal.timeout(20_000) },
		);
		const afterSend = captures().slice(beforeSend);
		expect(afterSend).toHaveLength(3);
		expect(seen(required(afterSend[2]))).toContain(QUEUED_QUESTION);
		expect(
			afterSend.every(
				(request) => !required(request.rawBody).includes(FORK_HISTORY_NOTICE),
			),
		).toBe(true);
		const notice = await until(
			() => notices(broken)[0],
			"notice sent from the live user pass",
		);
		expect(notice.id).toBe(JSON.parse(pending).id);
		const user = rawRows(broken).find(
			({ type, data }) =>
				type === "user" && JSON.parse(data).text === NOTICE_QUESTION,
		);
		expect(notice.seq).toBeGreaterThan(required(user).seq);
		const replies = rawRows(broken).filter(
			({ type, seq }) => type === "assistant" && seq > required(user).seq,
		);
		expect(replies).toHaveLength(3);
		const reader = new V2StoreReader(source);
		try {
			expect(
				replies.map(({ id }) =>
					reader.messageById(broken, id)?.data.content?.map(({ text }) => text),
				),
			).toEqual([["ordinary reply"], ["ordinary reply"], ["ordinary reply"]]);
		} finally {
			reader.close();
		}
		expect(
			replies.every(({ data }) => JSON.parse(data).finish === "stop"),
		).toBe(true);
		const extra = required(afterSend[1]);
		console.log("fork notice follow-on stored a second reply", {
			requestBytes: required(extra.rawBody).length,
			estimatedInput: estimateTokens(required(extra.rawBody)),
			reportedUsage: JSON.parse(required(replies[1]).data).tokens,
		});
		audit();
		await stop();
		// Restore the durable snapshot of a process that died after projection
		// and before clearing the pending record: keep the real projected row.
		usingDb(
			source,
			(db) =>
				db
					.prepare("UPDATE kv SET value = ? WHERE key LIKE ?")
					.run(pending, noticeKey),
			false,
		);
		client = await start();
		audit();
		expect((await wrap(broken)).failure_reason).toContain(
			"gap before message 5 (expected 3)",
		);
		const afterRestart = await turn(broken, "After reopening the broken fork.");
		expect(seen(afterRestart)).not.toContain(FORK_HISTORY_NOTICE);
		expect(notices(broken).map(({ id }) => id)).toEqual([notice.id]);
		expect(JSON.parse(required(pendingValue()))).toBe("delivered");
		expect(historicalRequests()).toHaveLength(0);
		const descendant = (await client.session.fork({ sessionID: broken })).id;
		expect(notices(descendant)).toHaveLength(1);
		expect(notices(descendant)[0]?.id).not.toBe(notice.id);
		expect(
			seen(await turn(descendant, "A fork of the session with a notice.")),
		).not.toContain(FORK_HISTORY_NOTICE);

		repairing = true;
		await client.session.command({
			sessionID: broken,
			name: "ctx-recomp",
			text: "",
		});
		const rebuilt = await until(() => {
			const rows = summaries(broken);
			return rows.some(({ title }) => title === "RebuiltEntireHistory")
				? rows
				: undefined;
		}, "full history rebuild");
		expect(validateStoredCompartments(rebuilt)).toBeNull();
		const repairRequest = JSON.stringify(historicalRequests()[0]?.body);
		for (const marker of MISSING_RAW) expect(repairRequest).toContain(marker);
		expect(repairRequest).not.toContain(FORK_HISTORY_NOTICE);
		const after = seen(await turn(broken, "After rebuilding the fork."));
		expect(after).toContain("RebuiltEntireHistory");
		expect(after).not.toContain("FixtureSummary");
		expect(notices(broken)).toHaveLength(1);
		expect(
			captures().some(({ rawBody }) => rawBody?.includes(FORK_HISTORY_NOTICE)),
		).toBe(false);
		expect(summaries(parent)).toEqual(beforeRestart);
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
		releaseFollowOn.resolve();
		await host?.stop();
		observer?.stop(true);
		cleanupE2ETempDir(fixture.root);
	}
}, 120_000);
