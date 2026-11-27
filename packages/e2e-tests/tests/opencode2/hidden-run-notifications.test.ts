import { expect, test } from "bun:test";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { findV2DreamParentSession } from "../../../plugin/src/v2/hooks/dream-timer";
import { V2StoreReader } from "../../../plugin/src/v2/store-reader";
import {
	inspectOpenFiles,
	isolation,
	spawnOpencode2,
	waitForPluginActive,
} from "../../src/opencode2-runner/spawn";

const probeName = "mc-hidden-run-notifications-probe";
const model = { providerID: "openai", id: "mock-model" };
const usage = { input_tokens: 100, output_tokens: 10 };
const succeeded = "session.execution.succeeded";
type Host = Awaited<ReturnType<typeof spawnOpencode2>>;
type SessionEvent = { type: string; id: string; parent?: string };
type Run = {
	id: string;
	parentID?: string;
	ok: boolean;
	text?: string;
	error?: string;
};

async function waitFor<T>(
	what: string,
	read: () => T | undefined | false | Promise<T | undefined | false>,
): Promise<T> {
	const deadline = Date.now() + 30_000;
	do {
		const value = await read();
		if (value !== undefined && value !== false) return value;
		await Bun.sleep(20);
	} while (Date.now() < deadline);
	throw new Error(`Timed out waiting for ${what}`);
}

function hostClient(host: Host) {
	const authorization = `Basic ${btoa(`opencode:${host.password}`)}`;
	return OpenCode.make({ baseUrl: host.url, headers: { authorization } });
}

function dbInventory(host: Host) {
	const paths = inspectOpenFiles(host.pid!, host.root, host.env).filter(
		(path) => /\.db(?:-wal|-shm)?$/.test(path),
	);
	expect(paths.length).toBeGreaterThan(0);
	expect(paths.every((path) => path.startsWith(`${host.root}/`))).toBe(true);
	console.log("LSOF", host.pid, JSON.stringify(paths));
}

function control(host: Host, directory = host.cwd) {
	const file = (suffix: string) =>
		join(directory, `hidden-run-${host.pid}-${suffix}`);
	const read = <T>(suffix: string) =>
		waitFor(suffix, () => {
			const path = file(suffix);
			return existsSync(path)
				? (JSON.parse(readFileSync(path, "utf8")) as T)
				: undefined;
		});
	return {
		ready: () => read<{ version: string }>("ready"),
		atSecondCandidate: () => read<string>("at-second-candidate"),
		start(
			seq: number,
			userID: string,
			kind: "historian" | "maintenance" = "historian",
			race = false,
		) {
			writeFileSync(
				file("command.tmp"),
				JSON.stringify({ seq, userID, kind, race }),
			);
			renameSync(file("command.tmp"), file("command"));
			return {
				opened: () => read<Run>(`opened-${seq}`),
				done: () => read<Run>(`result-${seq}`),
			};
		},
		events: (): SessionEvent[] => {
			const path = file("events");
			if (!existsSync(path)) return [];
			// A concurrent append can be in flight; consume only newline-terminated events.
			return readFileSync(path, "utf8")
				.split("\n")
				.slice(0, -1)
				.map((line) => JSON.parse(line));
		},
	};
}

const runKinds = ["historian", "maintenance"] as const;
type RunKind = (typeof runKinds)[number];

function respondToHiddenRun(
	host: Host,
	seq: number,
	kind: RunKind,
	// When given, the hidden run's first model answer is held until this settles.
	until?: Promise<unknown>,
): string {
	const notice = `HIDDEN_NOTICE_${kind}_${seq}`;
	let steps = 0;
	host.mock.addMatcher((body) => {
		if (!JSON.stringify(body).includes(notice)) return null;
		if (++steps === 1 && kind === "maintenance")
			return {
				openaiOutput: [
					{
						type: "function_call",
						id: "fc_notice",
						call_id: "call_notice",
						name: "ctx_memory",
						arguments: "{}",
					},
				],
				until,
				usage,
			};
		return {
			text: notice,
			until: kind === "historian" ? until : undefined,
			usage,
		};
	});
	return notice;
}

async function openFixture() {
	const fixture = isolation();
	const probePlugin = join(fixture.root, "probe");
	const build = await Bun.build({
		entrypoints: [join(import.meta.dir, "hidden-run-notifications-probe.ts")],
		outdir: probePlugin,
		naming: "index.js",
		target: "node",
		format: "esm",
		define: { "process.env.NODE_ENV": '"production"' },
		external: ["bun:sqlite", "node:sqlite"],
	});
	if (!build.success)
		throw new AggregateError(build.logs, "Could not build hidden-run probe");
	const settings = {
		existingIsolation: fixture,
		probePlugin,
		includeMagicContext: false,
	};
	const host = await spawnOpencode2({ ...settings, serviceMode: true });
	return { settings, host };
}

test("hidden runs do not signal root completion or wake the holder or user", async () => {
	const { host } = await openFixture();
	// Releases the held model answer; also called on failure so the mock's
	// request does not stay open while the host stops.
	let releaseHiddenAnswer = () => {};
	try {
		const client = hostClient(host);
		await waitForPluginActive(client, host.cwd, probeName);
		const drive = control(host);
		const { version } = await drive.ready();
		expect(version).toMatch(/^2\.\d+\.\d+$/);
		if (process.env.MC_E2E_OPENCODE2_VERSION)
			expect(version).toBe(process.env.MC_E2E_OPENCODE2_VERSION);
		dbInventory(host);
		const user = await client.session.create({
			title: "user",
			location: { directory: host.cwd },
			model,
		});
		let holderID: string | undefined;
		for (const [seq, kind] of runKinds.entries()) {
			// The hidden run's model answer is held until the user's own turn has
			// finished, so the order of the two completions does not depend on how
			// fast the host handles a turn.
			const afterUserTurn = new Promise<void>((resolve) => {
				releaseHiddenAnswer = resolve;
			});
			const notice = respondToHiddenRun(host, seq, kind, afterUserTurn);
			const offset = drive.events().length;
			const requestsBefore = host.mock.requests().length;
			const run = drive.start(seq, user.id, kind);
			const opened = await run.opened();
			const requests = (id: string) =>
				host.mock
					.requests()
					.slice(requestsBefore)
					.filter((r) => r.headers["x-opencode-session-id"] === id);
			await waitFor(
				"hidden provider request",
				() => requests(opened.id).length > 0,
			);
			await client.session.prompt({
				sessionID: user.id,
				text: `User's own turn during ${kind}`,
			});
			await client.session.wait({ sessionID: user.id });
			const messages = async (sessionID: string) =>
				(await client.message.list({ sessionID })).data.map((row) => row.id);
			const whileRunning = await messages(user.id);
			await waitFor("the user's turn success", () =>
				drive
					.events()
					.slice(offset)
					.some((e) => e.id === user.id && e.type === succeeded),
			);
			releaseHiddenAnswer();
			const result = await run.done();
			expect(result).toMatchObject({ ok: true, text: notice });
			await waitFor("hidden execution success", () =>
				drive.events().some((e) => e.id === result.id && e.type === succeeded),
			);
			const events = drive.events().slice(offset);
			const hiddenDone = events.findIndex(
				(e) => e.id === result.id && e.type === succeeded,
			);
			const userDone = events.findIndex(
				(e) => e.id === user.id && e.type === succeeded,
			);
			expect(userDone).toBeGreaterThanOrEqual(0);
			expect(userDone).toBeLessThan(hiddenDone);
			const userEventsAfterDone = events
				.slice(userDone + 1)
				.filter((e) => e.id === user.id);
			const holder = result.parentID
				? await client.session.get({ sessionID: result.parentID })
				: undefined;
			const holderEvents = holder
				? events.filter(
						(e) => e.id === holder.id && e.type !== "session.created",
					)
				: [];
			const holderMessages = holder ? await messages(holder.id) : [];
			const userMessagesAfter = await messages(user.id);
			const userChildren = (
				await client.session.list({ directory: host.cwd, parentID: user.id })
			).data;
			const rootHiddenDone = !result.parentID;
			console.log(
				JSON.stringify({
					version,
					kind,
					rootHiddenDone,
					hiddenEvent: events[hiddenDone]?.type,
					holderID: holder?.id,
					holderEvents,
					holderMessages: holderMessages.length,
					holderRequests: holder ? requests(holder.id).length : 0,
					userDone: true,
					userChildren: userChildren.length,
					userEventsAfterDone,
					userMessagesBefore: whileRunning.length,
					userMessagesAfter: userMessagesAfter.length,
					userRequests: requests(user.id).length,
					hiddenRequests: requests(result.id).length,
				}),
			);
			expect(rootHiddenDone).toBe(version === "2.3.0");
			if (version !== "2.3.0") {
				expect(result.id).toStartWith("ses_aut_");
				expect(holder).toMatchObject({
					title: "Magic Context background runs",
					location: { directory: host.cwd },
				});
				expect(holder?.parentID ?? null).toBeNull();
				if (holderID) expect(holder?.id).toBe(holderID);
				holderID = holder?.id;
				expect(holderEvents).toEqual([]);
				expect(holderMessages).toEqual([]);
				expect(requests(holder!.id)).toEqual([]);
			}
			expect(userChildren).toEqual([]);
			expect(userEventsAfterDone).toEqual([]);
			expect(userMessagesAfter).toEqual(whileRunning);
			expect(requests(user.id)).toHaveLength(1);
			expect(requests(result.id)).toHaveLength(kind === "historian" ? 1 : 2);
			if (kind === "maintenance")
				expect(JSON.stringify(requests(result.id)[1]?.body)).toContain(
					"MAINTENANCE_TOOL_RESULT",
				);
		}
	} catch (error) {
		console.error(host.stderr().slice(-5000), host.pluginLog().slice(-5000));
		throw error;
	} finally {
		releaseHiddenAnswer();
		await host.stop();
	}
}, 120_000);

const rootOnlyHost = process.env.MC_E2E_OPENCODE2_VERSION === "2.3.0";

test.skipIf(rootOnlyHost)(
	"runs historian and tool-using maintenance at the linked OpenCode location",
	async () => {
		const { host } = await openFixture();
		try {
			const client = hostClient(host);
			dbInventory(host);
			const target = join(host.root, "project-target");
			const link = join(host.root, "project-link");
			mkdirSync(target);
			copyFileSync(
				join(host.cwd, "opencode.json"),
				join(target, "opencode.json"),
			);
			symlinkSync(target, link, "dir");
			const user = await client.session.create({
				title: "project via link",
				location: { directory: link },
				model,
			});
			expect(user.location.directory).toBe(link);
			await waitForPluginActive(client, link, probeName);
			const drive = control(host, link);
			await drive.ready();
			for (const [seq, kind] of runKinds.entries()) {
				const notice = respondToHiddenRun(host, seq, kind);
				const result = await drive.start(seq, user.id, kind).done();
				console.log(JSON.stringify({ linkedLocation: link, kind, ...result }));
				expect(result).toMatchObject({ ok: true, text: notice });
				expect(result.id).toStartWith("ses_aut_");
				expect(result.parentID).toStartWith("ses_mc_bg_");
				expect(
					(await client.session.get({ sessionID: result.parentID! })).location
						.directory,
				).toBe(link);
				if (kind === "maintenance") {
					const requests = host.mock
						.requests()
						.filter((r) => r.headers["x-opencode-session-id"] === result.id);
					expect(requests).toHaveLength(2);
					expect(JSON.stringify(requests[1]?.body)).toContain(
						"MAINTENANCE_TOOL_RESULT",
					);
				}
			}
		} finally {
			await host.stop();
		}
	},
	120_000,
);

test.skipIf(rootOnlyHost)(
	"the dream timer still borrows the user session after quiet runs",
	async () => {
		const { host } = await openFixture();
		try {
			const client = hostClient(host);
			await waitForPluginActive(client, host.cwd, probeName);
			dbInventory(host);
			const user = await client.session.create({
				title: "user",
				location: { directory: host.cwd },
				model,
			});
			await client.session.prompt({
				sessionID: user.id,
				text: "A user turn before the nightly run",
			});
			await client.session.wait({ sessionID: user.id });
			const openReader = () =>
				new V2StoreReader(
					join(host.env.XDG_DATA_HOME!, "opencode", "opencode2.db"),
				);
			expect(findV2DreamParentSession(openReader, host.cwd)).toBe(user.id);
			await Bun.sleep(1100);
			const drive = control(host);
			for (const [seq, kind] of runKinds.entries()) {
				const notice = respondToHiddenRun(host, seq, kind);
				const result = await drive.start(seq, user.id, kind).done();
				expect(result).toMatchObject({ ok: true, text: notice });
				expect(result.parentID).toStartWith("ses_mc_bg_");
			}
			expect(findV2DreamParentSession(openReader, host.cwd)).toBe(user.id);
		} finally {
			await host.stop();
		}
	},
	120_000,
);

test.skipIf(rootOnlyHost)(
	"choosing the background holder for chat is refused before a provider request",
	async () => {
		const { host } = await openFixture();
		try {
			const client = hostClient(host);
			await waitForPluginActive(client, host.cwd, probeName);
			dbInventory(host);
			const user = await client.session.create({
				title: "user",
				location: { directory: host.cwd },
				model,
			});
			const drive = control(host);
			const result = await drive.start(0, user.id).done();
			expect(result).toMatchObject({ ok: true });
			expect(result.parentID).toStartWith("ses_mc_bg_");
			const holderID = result.parentID!;
			await client.session.prompt({
				sessionID: holderID,
				text: "Can we chat here?",
			});
			await client.session.wait({ sessionID: holderID });
			const outcome = await waitFor("holder execution outcome", () =>
				drive
					.events()
					.find(
						(event) =>
							event.id === holderID &&
							(event.type === succeeded ||
								event.type === "session.execution.failed"),
					),
			);
			expect(outcome.type).toBe("session.execution.failed");
			expect(
				host.mock
					.requests()
					.filter((r) => r.headers["x-opencode-session-id"] === holderID),
			).toEqual([]);
			const log = await waitFor("holder refusal explanation", () =>
				host
					.pluginLog()
					.split("\n")
					.find(
						(line) =>
							line.includes("hidden child refused:") && line.includes(holderID),
					),
			);
			expect(log).toContain(
				"This session holds Magic Context's background runs and can't be used for chat.",
			);
		} finally {
			await host.stop();
		}
	},
	120_000,
);

// The current host exercises cascade removal and the two-process creation race. The matrix
// above also checks that 2.3.0 still runs without a parent, so it cannot wake a holder.
const currentHost = process.env.MC_E2E_OPENCODE2_VERSION === "2.4.2";

test.skipIf(!currentHost)(
	"deleting a holder interrupts a hidden run and the next run repairs the holder",
	async () => {
		const { host } = await openFixture();
		try {
			const client = hostClient(host);
			await waitForPluginActive(client, host.cwd, probeName);
			dbInventory(host);
			const drive = control(host);
			const user = await client.session.create({
				title: "user",
				location: { directory: host.cwd },
				model,
			});
			host.mock.addMatcher((body) =>
				JSON.stringify(body).includes("HIDDEN_NOTICE_historian_0")
					? { text: "the deleted run must not finish", delayMs: 10_000, usage }
					: null,
			);
			const run = drive.start(0, user.id);
			const first = await run.opened();
			expect(first.parentID).toStartWith("ses_mc_bg_");
			await waitFor("running child at the provider", () =>
				host.mock
					.requests()
					.some((r) => r.headers["x-opencode-session-id"] === first.id),
			);
			await client.session.remove({ sessionID: first.parentID! });
			await waitFor("the child interruption", () =>
				drive
					.events()
					.some(
						(e) =>
							e.id === first.id && e.type === "session.execution.interrupted",
					),
			);
			expect(await run.done()).toMatchObject({ ok: false, id: first.id });
			await expect(
				client.session.get({ sessionID: first.id }),
			).rejects.toThrow();
			const next = await drive.start(1, user.id).done();
			expect(next).toMatchObject({ ok: true, parentID: first.parentID });
			expect(next.id).not.toBe(first.id);
			expect(
				(await client.session.get({ sessionID: first.parentID! })).title,
			).toBe("Magic Context background runs");
			console.log(
				JSON.stringify({
					holderDeletedAndRepaired: first.parentID,
					interruptedChild: first.id,
					nextChild: next.id,
				}),
			);
		} finally {
			await host.stop();
		}
	},
	100_000,
);

test.skipIf(!currentHost)(
	"moving the holder leaves it untouched and two processes converge on one replacement",
	async () => {
		const { host, settings } = await openFixture();
		let peer: Host | undefined;
		try {
			const client = hostClient(host);
			await waitForPluginActive(client, host.cwd, probeName);
			dbInventory(host);
			const drive = control(host);
			const user = await client.session.create({
				title: "user",
				location: { directory: host.cwd },
				model,
			});
			const first = await drive.start(0, user.id).done();
			expect(first).toMatchObject({ ok: true });
			expect(first.parentID).toStartWith("ses_mc_bg_");
			const destination = join(host.root, "displaced");
			mkdirSync(destination);
			copyFileSync(
				join(host.cwd, "opencode.json"),
				join(destination, "opencode.json"),
			);
			await client.session.move({
				sessionID: first.parentID!,
				directory: destination,
			});
			await waitFor(
				"holder moved",
				async () =>
					(await client.session.get({ sessionID: first.parentID! })).location
						.directory === destination,
			);
			peer = await spawnOpencode2({
				...settings,
				prepareContextDatabase: false,
				existingMock: { mock: host.mock, baseURL: host.mockBaseURL },
			});
			await waitForPluginActive(hostClient(peer), peer.cwd, probeName);
			dbInventory(peer);
			const other = control(peer);
			const runA = drive.start(1, user.id, "historian", true);
			const runB = other.start(2, user.id, "historian", true);
			const candidates = await Promise.all([
				drive.atSecondCandidate(),
				other.atSecondCandidate(),
			]);
			expect(candidates).toEqual([
				`${first.parentID}_2`,
				`${first.parentID}_2`,
			]);
			writeFileSync(join(host.cwd, "release-holder-race"), "ready");
			const results = await Promise.all([runA.done(), runB.done()]);
			for (const result of results)
				expect(result).toMatchObject({ ok: true, parentID: candidates[0] });
			expect(results[0]?.id).not.toBe(results[1]?.id);
			const displaced = await client.session.get({
				sessionID: first.parentID!,
			});
			expect(displaced.location.directory).toBe(destination);
			expect(displaced.title).toBe("Magic Context background runs");
			const roots = (
				await client.session.list({ directory: host.cwd, parentID: null })
			).data;
			expect(
				roots
					.filter((row) => row.metadata?.magic_context === "background-holder")
					.map((row) => row.id),
			).toEqual([candidates[0]]);
			console.log(
				JSON.stringify({
					displacedHolder: displaced.id,
					racingPids: [host.pid, peer.pid],
					replacement: candidates[0],
				}),
			);
		} finally {
			if (peer) await peer.stopHost();
			await host.stop();
		}
	},
	120_000,
);
