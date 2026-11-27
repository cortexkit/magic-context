import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { OpenCode } from "@opencode/client";
import {
	closeDatabase,
	LATEST_SUPPORTED_VERSION,
	openDatabase,
} from "../../../plugin/src/features/magic-context/storage-db";
import { Database } from "../../../plugin/src/shared/sqlite";
import { V2_STORAGE_REOPEN_INTERVAL_MS } from "../../../plugin/src/v2/hooks/storage-gate";
import { STORAGE_NOTICE_PREFIX } from "../../../plugin/src/v2/hooks/storage-notice";
import {
	isolation,
	spawnOpencode2,
	waitForPluginActive,
} from "../../src/opencode2-runner/spawn";
import { openTestDb } from "../../src/test-db";

const reply = "An ordinary fixture answer.";
const refusal = `${STORAGE_NOTICE_PREFIX}This turn was not sent`;
const recovery = `${STORAGE_NOTICE_PREFIX}Magic Context storage is available again`;
const resumed = "An ordinary turn after storage recovered.";

type Row = {
	id: string;
	type: string;
	data: { text?: string; outcome?: string };
};
type DraftMessage = {
	id?: string;
	role: string;
	content: Array<{ text?: string }>;
};
type Frame = {
	name: string;
	sessionID: string;
	raw: DraftMessage[];
	served: DraftMessage[];
	noticeObjectsUnchanged: boolean;
};

async function eventually<T>(
	read: () => T | undefined,
	label: string,
): Promise<T> {
	const deadline = Date.now() + 12_000;
	for (;;) {
		const value = read();
		if (value !== undefined) return value;
		if (Date.now() >= deadline)
			throw new Error(`Timed out waiting for ${label}`);
		await Bun.sleep(20);
	}
}

function storageProbe(root: string, holdRecovery: boolean) {
	const dir = join(root, "storage-notice-probe");
	mkdirSync(dir);
	writeFileSync(
		join(dir, "server.js"),
		`
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import mc from ${JSON.stringify(resolve(import.meta.dir, "../../../plugin/dist/v2/server.js"))};
const root = ${JSON.stringify(root)};
const prefix = ${JSON.stringify(STORAGE_NOTICE_PREFIX)};
export default { id: "opencode-magic-context", async setup(context) {
    const session = { ...context.session,
        hook(name, callback) {
            if (name !== "context" && name !== "generate") return context.session.hook(name, callback);
            return context.session.hook(name, async (draft) => {
                const raw = JSON.parse(JSON.stringify(draft.messages));
                const notices = draft.messages.filter((m) => /_\\d+$/.test(m.id ?? "") && m.content.some((p) => p.text?.startsWith(prefix)));
                const before = notices.map((m) => JSON.stringify(m));
                await callback(draft);
                appendFileSync(root + "/drafts.jsonl", JSON.stringify({ name, sessionID: draft.sessionID, raw,
                    served: draft.messages, noticeObjectsUnchanged: notices.every((m, i) => JSON.stringify(m) === before[i]),
                }) + "\\n");
            });
        },
        async synthetic(input) {
            if (${holdRecovery} && input.text.startsWith(${JSON.stringify(recovery)})) {
                writeFileSync(root + "/recovery-waiting", "");
                const deadline = Date.now() + 12000;
                while (!existsSync(root + "/allow-recovery")) {
                    if (Date.now() >= deadline) throw Error("test did not release the recovery admission");
                    await new Promise((done) => setTimeout(done, 5));
                }
            }
            return context.session.synthetic(input);
        },
    };
    return mc.setup({ ...context, session });
}};
`,
	);
	return dir;
}

async function fixture(holdRecovery: boolean) {
	const isolated = isolation();
	const storage = isolated.env.MAGIC_CONTEXT_STORAGE_DIR!;
	mkdirSync(storage, { recursive: true });
	const dbPath = join(storage, "context.db");
	openDatabase(dbPath);
	closeDatabase();
	const old = new Database(dbPath);
	old
		.prepare("DELETE FROM schema_migrations WHERE version = ?")
		.run(LATEST_SUPPORTED_VERSION);
	old.exec("DROP TABLE single_store_state");
	old.close();
	const holder = Bun.spawn(["sleep", "120"], {
		stdout: "ignore",
		stderr: "ignore",
	});
	const locks = join(storage, "rpc", "old-opencode-server");
	mkdirSync(locks, { recursive: true });
	writeFileSync(
		join(locks, `port-${holder.pid}.json`),
		JSON.stringify({
			port: 1,
			pid: holder.pid,
			started_at: Date.now() + 1_000,
			kind: "OpenCode server",
			instance_id: "old-opencode-server",
		}),
	);
	let active: Awaited<ReturnType<typeof spawnOpencode2>> | undefined;
	const dispose = async () => {
		holder.kill();
		await holder.exited;
		await active?.stop();
	};
	try {
		const host = await spawnOpencode2({
			existingIsolation: isolated,
			magicContextPlugin: storageProbe(isolated.root, holdRecovery),
			prepareContextDatabase: false,
			providerID: "anthropic",
			compactionAuto: false,
			magicContextConfig: {
				dreamer: { disable: true },
				memory: { enabled: false },
				historian: { disable: true },
			},
		});
		active = host;
		const client = OpenCode.make({
			baseUrl: host.url,
			headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
		});
		await waitForPluginActive(client, host.cwd);
		host.mock.setDefault({
			text: reply,
			usage: { input_tokens: 120, output_tokens: 8 },
		});
		const create = async () =>
			(
				await client.session.create({
					title: "Released OpenCode 2 storage notice",
					location: { directory: host.cwd },
					model: { providerID: "anthropic", id: "mock-model" },
				})
			).id;
		const sessionID = await create();
		const wait = (id = sessionID) =>
			client.session.wait(
				{ sessionID: id },
				{ signal: AbortSignal.timeout(20_000) },
			);
		const prompt = async (text: string, id = sessionID) => {
			const result = await client.session.prompt({ sessionID: id, text });
			await wait(id);
			return result;
		};
		const rows = (id = sessionID): Row[] => {
			const db = openTestDb(
				join(host.env.XDG_DATA_HOME!, "opencode", host.env.OPENCODE_DB!),
				{ readonly: true },
			);
			try {
				const raw = db
					.query(
						"SELECT id,type,data FROM session_message WHERE session_id=? ORDER BY seq",
					)
					.all(id) as Array<{ id: string; type: string; data: string }>;
				return raw.map(({ data, ...row }) => ({
					...row,
					data: JSON.parse(data),
				}));
			} finally {
				db.close();
			}
		};
		const notice = (prefix: string) =>
			eventually(
				() =>
					rows().find(
						(r) => r.type === "synthetic" && r.data.text?.startsWith(prefix),
					),
				"released storage notice",
			);
		await prompt("Original user turn while storage is blocked.");
		await notice(refusal);
		await wait();
		expect(host.mock.requests()).toEqual([]);
		expect(rows().at(-1)?.data.outcome).toBe("interrupted");
		return {
			host,
			client,
			sessionID,
			wait,
			create,
			prompt,
			rows,
			notice,
			dispose,
			frames: () =>
				readFileSync(join(host.root, "drafts.jsonl"), "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line) as Frame),
			async reopen() {
				holder.kill();
				await holder.exited;
				await Bun.sleep(V2_STORAGE_REOPEN_INTERVAL_MS + 500);
				await prompt(resumed);
			},
		};
	} catch (error) {
		await dispose();
		throw error;
	}
}

async function run(
	testBody: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
	holdRecovery = false,
) {
	const f = await fixture(holdRecovery);
	try {
		await testBody(f);
	} catch (error) {
		console.error(f.host.stderr(), f.host.pluginLog());
		throw error;
	} finally {
		await f.dispose();
	}
}

function wireSince(
	f: Awaited<ReturnType<typeof fixture>>,
	at: number,
	text: string,
) {
	const requests = f.host.mock.requests().slice(at);
	expect(requests).toHaveLength(1);
	const raw = requests[0]?.rawBody;
	expect(raw).toContain(text);
	return raw;
}

test(
	"OpenCode 2 side questions strip released storage notices without dropping saved replay",
	() =>
		run(async (f) => {
			const side = (prompt: string) =>
				f.client.session.generate(
					{ sessionID: f.sessionID, prompt },
					{ signal: AbortSignal.timeout(15_000) },
				);
			let before = f.host.mock.requests().length;
			await side("A side question while storage is unavailable.");
			expect(
				wireSince(f, before, "A side question while storage is unavailable."),
			).not.toContain(STORAGE_NOTICE_PREFIX);

			await f.reopen();
			const banner = await f.notice(recovery);
			await f.wait();
			const primary = f
				.frames()
				.findLast(
					(frame) =>
						frame.name === "context" &&
						frame.raw.at(-1)?.content.some((p) => p.text === resumed),
				);
			expect(
				primary?.raw.some((m) =>
					m.content.some((p) => p.text?.startsWith(refusal)),
				),
			).toBe(true);
			expect(
				primary?.served.some((m) =>
					m.content.some((p) => p.text?.startsWith(refusal)),
				),
			).toBe(false);
			before = f.host.mock.requests().length;
			await side("A side question just after the recovery notice.");
			expect(
				wireSince(f, before, "A side question just after the recovery notice."),
			).not.toContain(STORAGE_NOTICE_PREFIX);
			const generated = f
				.frames()
				.findLast((frame) => frame.name === "generate");
			expect(generated?.raw.some((m) => m.id === banner.id)).toBe(true);
			expect(generated?.served.some((m) => m.id === banner.id)).toBe(false);
			expect(generated?.served.slice(0, primary?.served.length)).toEqual(
				primary?.served,
			);
			expect(f.host.pluginLog()).not.toContain(
				"generate replay apply skipped: history-mismatch",
			);
		}),
	60_000,
);

test(
	"OpenCode 2 strips whole fork copies of released storage notices but keeps typed and unrelated input",
	() =>
		run(async (f) => {
			await f.reopen();
			await f.notice(recovery);
			await f.wait();
			const { id: fork } = await f.client.session.fork({
				sessionID: f.sessionID,
			});
			const copied = f
				.rows(fork)
				.filter(
					(r) =>
						r.type === "synthetic" &&
						r.data.text?.startsWith(STORAGE_NOTICE_PREFIX),
				);
			expect(copied).toHaveLength(2);
			expect(copied.every(({ id }) => !f.rows().some((r) => r.id === id))).toBe(
				true,
			);
			const otherText = "Unrelated native synthetic control.";
			const typedText = `${STORAGE_NOTICE_PREFIX}The user literally typed this sentence.`;
			const other = await f.client.session.synthetic({
				sessionID: fork,
				text: otherText,
				resume: false,
			});
			const at = f.host.mock.requests().length;
			const typed = await f.prompt(typedText, fork);
			const raw = wireSince(f, at, typedText);
			expect(raw).toContain(otherText);
			expect(raw).not.toContain(refusal);
			expect(raw).not.toContain(recovery);
			expect(f.rows(fork).find(({ id }) => id === typed.id)?.type).toBe("user");
			expect(f.rows(fork).find(({ id }) => id === other.id)?.type).toBe(
				"synthetic",
			);
			const frame = f
				.frames()
				.findLast((f) => f.name === "context" && f.sessionID === fork);
			for (const row of copied) {
				expect(frame?.raw.some((m) => m.id === row.id)).toBe(true);
				expect(frame?.served.some((m) => m.id === row.id)).toBe(false);
			}
			expect(frame?.noticeObjectsUnchanged).toBe(true);
		}),
	60_000,
);

test.each([false, true])(
	"OpenCode 2 preserves the tool continuation when a storage recovery notice arrives late (thinking=%s)",
	(thinking) =>
		run(async (f) => {
			await f.reopen();
			await eventually(
				() =>
					existsSync(join(f.host.root, "recovery-waiting")) ? true : undefined,
				"held recovery admission",
			);
			const file = join(f.host.cwd, "fact.txt");
			const fact = "A fact read from the real tool result.";
			const text = "Read fact.txt for the storage notice regression.";
			writeFileSync(file, fact);
			f.host.mock.addMatcher((body) => {
				if (
					!Array.isArray(body.messages) ||
					!JSON.stringify(body.messages.at(-1))?.includes(text)
				)
					return null;
				return {
					content: [
						...(thinking
							? [
									{
										type: "thinking",
										thinking: "Read the file first.",
										signature: "storage-notice-signature",
									},
								]
							: []),
						{
							type: "tool_use",
							id: "toolu_storage_notice_read",
							name: "read",
							input: { path: file },
						},
					],
					stop_reason: "tool_use",
					usage: { input_tokens: 150, output_tokens: 9 },
					streamHoldMs: 1_500,
				};
			});
			const control = await f.create();
			const old = f.host.mock.requests().length;
			await f.prompt(text, control);
			const expected = f.host.mock.requests().slice(old);
			expect(expected).toHaveLength(2);
			expect(expected[1]?.rawBody).toContain(fact);
			const at = f.host.mock.requests().length;
			await f.client.session.prompt({ sessionID: f.sessionID, text });
			await eventually(
				() =>
					f.host.mock
						.requests()
						.slice(at)
						.find((r) => r.rawBody?.includes(text)),
				"first tool call in flight",
			);
			writeFileSync(join(f.host.root, "allow-recovery"), "");
			await f.notice(recovery);
			await f.wait();
			const actual = f.host.mock.requests().slice(at);
			expect(actual).toHaveLength(expected.length);
			expect(actual[1]?.rawBody).toContain(fact);
			if (thinking)
				expect(actual[1]?.rawBody).toContain("storage-notice-signature");
			for (const request of actual) {
				expect(request.rawBody).not.toContain(STORAGE_NOTICE_PREFIX);
				expect(request.body.messages?.at(-1)?.role).toBe("user");
			}
			expect(f.rows().at(-1)?.data.outcome).toBe("succeeded");
		}, true),
	60_000,
);

test(
	"OpenCode 2 refuses the idle recovery notice wake without sending the previous answer",
	() =>
		run(async (f) => {
			await f.reopen();
			const notice = await f.notice(recovery);
			await f.wait();
			const requests = f.host.mock.requests();
			expect(
				requests
					.map((request) => request.rawBody)
					.filter((body) => body?.includes(resumed)),
			).toHaveLength(1);
			expect(requests).toHaveLength(1);
			const rows = f.rows();
			expect(rows.filter((row) => row.type === "assistant")).toHaveLength(1);
			expect(rows.at(-2)?.id).toBe(notice.id);
			expect(rows.at(-1)?.data.outcome).toBe("interrupted");
		}),
	60_000,
);
