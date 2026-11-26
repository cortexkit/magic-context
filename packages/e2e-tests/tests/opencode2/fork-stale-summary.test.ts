import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { validateStoredCompartments } from "../../../plugin/src/hooks/magic-context/compartment-runner-validation";
import { estimateTokens } from "../../../plugin/src/hooks/magic-context/read-session-formatting";
import { Database } from "../../../plugin/src/shared/sqlite";
import { FORK_HISTORY_NOTICE } from "../../../plugin/src/v2/hooks/storage-notice";
import { RAW_MESSAGE_TYPES } from "../../../plugin/src/v2/store-reader";
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
// Captured with the original copier. The host versions render different system and tool bytes.
const HEALTHY_FORK_BODY_SHA256: Record<string, string> = {
	"2.0.22": "8afae0c006c9edf7da4d005a8707ce759f68c39a69901ced5a2aadffa7891097",
	"2.1.0": "a00f530f4ff67fc0000e9bfbc32afe007fad20242d717f228f76b7c67f9cee41",
	"2.3.2": "9f385d9570cc66ce8318530962de09f3a4e8a45f6ed8b5a2bd785b8c1bc37d71",
	"2.4.2": "be52f0c339fe880ded99b673e9ae19cc9c08c5dcb51ee051ce2019b64dc9a907",
};

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

test("OpenCode 2 forks keep proven stale summaries, preserve unproven raw history, and repair old forks", async () => {
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
					type: string;
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
		const forkPrompt = "Answer the fork's first request.";
		const healthy = await fork();
		const healthyParent = summaries(parent);
		const healthyRequest = await turn(healthy, forkPrompt);
		expectInherited(healthy);
		expect(summaries(parent)).toEqual(healthyParent);
		const healthyInput = seen(healthyRequest);
		expect(healthyRequest.body.prompt_cache_key).toBe(parent);
		// The host's cache key is the parent id and the mock mints fresh reply
		// ids. Normalize those fixture values, not the request's content or shape.
		const portableBody = required(healthyRequest.rawBody)
			.replaceAll(fixture.root, "<fixture>")
			.replace(/Today's date: [^"\\]+/g, "Today's date: <date>")
			.replace(
				`"prompt_cache_key":"${parent}"`,
				'"prompt_cache_key":"<parent>"',
			)
			.replace(
				/"id":"msg_resp_[0-9a-f]{24}(_\d+)"/g,
				'"id":"msg_resp_<fixture>$1"',
			);
		const pin =
			HEALTHY_FORK_BODY_SHA256[
				process.env.MC_E2E_OPENCODE2_VERSION ?? "2.0.22"
			];
		if (pin)
			expect(createHash("sha256").update(portableBody).digest("hex")).toBe(pin);

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

		// Pre-seed the compartments as an older plugin left them, with a gap in
		// the middle. A seed on the next turn must not silently recopy this fork.
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
		const brokenFirst = seen(await turn(broken, "Before the repair notice."));
		for (const marker of MISSING_RAW) expect(brokenFirst).not.toContain(marker);
		const calls = captures().length;
		expect(await wrap(broken)).toEqual({
			status: "failed",
			failure_reason: "existing-validation: gap before message 5 (expected 3)",
		});
		await until(() => notices(broken)[0], "stored repair notice");
		expect(notices(broken)).toHaveLength(1);
		await client.session.wait(
			{ sessionID: broken },
			{ signal: AbortSignal.timeout(15_000) },
		);
		expect(captures()).toHaveLength(calls);
		const defer = seen(await turn(broken, "After the repair notice."));
		expect(defer).not.toContain(FORK_HISTORY_NOTICE);
		const beforeRestart = summaries(parent);
		audit();
		await required(host).stop();
		host = undefined;

		client = await start();
		audit();
		expect((await wrap(broken)).failure_reason).toContain(
			"gap before message 5 (expected 3)",
		);
		const afterRestart = await turn(broken, "After reopening the broken fork.");
		expect(seen(afterRestart)).not.toContain(FORK_HISTORY_NOTICE);
		expect(notices(broken)).toHaveLength(1);
		expect(historicalRequests()).toHaveLength(0);
		const descendant = (await client.session.fork({ sessionID: broken })).id;
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
		await host?.stop();
		cleanupE2ETempDir(fixture.root);
	}
}, 120_000);
