import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { gaDatabasePath, V2StoreReader } from "../../../plugin/src/v2/store-reader";
import {
	inspectOpenFiles,
	isolation,
	spawnOpencode2,
	waitForPluginActive,
} from "../../src/opencode2-runner/spawn";

// A 1x1 PNG, attached inline the way a pasted image is.
const PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

type Row = { type?: string; outcome?: string };
type Body = { input?: unknown[] };

const imageElements = (body: Body) => {
	const item = (body.input ?? []).find((entry) => JSON.stringify(entry).includes("IMAGE-TURN")) as
		| { content?: unknown[] }
		| undefined;
	return JSON.stringify(
		(item?.content ?? []).filter((part) => JSON.stringify(part).includes(PNG_BASE64)),
	);
};

// An image row restored from before a host compaction checkpoint, in a fresh plugin
// process whose first draft starts with a system message.
//
// From OpenCode 2.3 each role has its own message class, and the system and tool
// classes have no media member. A session whose reasoning variant was switched before
// its first prompt starts its draft with the host's effort system message. When that is
// the first draft a fresh plugin process sees, a media decision taken from "the first
// message's class" concludes the host takes plain media parts, and the restored image of
// another session reaches the host as `{ type: "media", mediaType, data }`. OpenCode
// 2.3.2 then builds an asset with no bytes and every later turn of the image session
// dies before any provider call ("undefined is not an object (evaluating
// 'L.source.data.length')").
//
// The restored image must instead reach the provider byte-identical to the host's own
// rendering of the same row, on every turn after the restart. On hosts with one message
// class for every role (2.0, 2.1) the same steps must keep working.
test("a restored image survives a fresh process whose first draft starts with a system message", async () => {
	const fixture = isolation();
	const logPath = join(fixture.root, "magic-context.log");
	fixture.env.MAGIC_CONTEXT_LOG_PATH = logPath;
	const options = {
		// A small window lets one reported high-usage turn make the host compact.
		modelContextLimit: 16_000,
		modelOutputLimit: 1024,
		magicContextConfig: {
			historian: { disable: true },
			dreamer: { disable: true },
			memory: { enabled: false },
		},
		mockResponse: { text: "ok", usage: { input_tokens: 100, output_tokens: 20 } },
	};
	let host = await spawnOpencode2({ ...options, existingIsolation: fixture });
	const mock = host.mock;
	const log = () => (existsSync(logPath) ? readFileSync(logPath, "utf8") : "");
	const connect = () =>
		OpenCode.make({
			baseUrl: host.url,
			headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
		});
	try {
		let client = connect();
		const session = await client.session.create({
			location: { directory: host.cwd },
			model: { providerID: "openai", id: "mock-model" },
		});
		await waitForPluginActive(client, host.cwd);
		const turn = async (
			sessionID: string,
			text: string,
			files?: Array<{ uri: string; name: string }>,
		) => {
			const before = mock.requests().length;
			await client.session.prompt({ sessionID, text, ...(files ? { files } : {}) });
			await client.session.wait({ sessionID }, { signal: AbortSignal.timeout(60_000) });
			const listed = (await client.message.list({ sessionID })) as { data: Row[] };
			const failure = host
				.stderr()
				.split("\n")
				.find((line) => line.includes("Failed to drain Session") || line.includes("source.data"))
				?.slice(0, 300);
			expect({
				text,
				outcome: listed.data.find((row) => row.type === "idle")?.outcome,
				failure,
			}).toEqual({ text, outcome: "succeeded", failure: undefined });
			const bodies = mock
				.requests()
				.slice(before)
				.map((request) => request.body as Body)
				.filter((body) => {
					const json = JSON.stringify(body);
					return json.includes('"model":"mock-model"') && json.includes(text);
				});
			expect(bodies.length).toBeGreaterThan(0);
			return bodies;
		};

		await turn(session.id, "IMAGE-TURN what is in this image?", [
			{ uri: `data:image/png;base64,${PNG_BASE64}`, name: "pixel.png" },
		]);
		mock.setDefault({ text: "pressure answer", usage: { input_tokens: 15_000, output_tokens: 10 } });
		// The host's own rendering of the image row, before any checkpoint exists.
		const hostRendered = imageElements((await turn(session.id, "PRESSURE-TURN")).at(-1)!);
		expect(hostRendered).toContain(PNG_BASE64);
		mock.setDefault({ text: "ok", usage: { input_tokens: 100, output_tokens: 20 } });
		await turn(session.id, "AFTER-FOLD-1");

		// A fresh plugin process. Its first draft is a new session's whose reasoning
		// variant was switched before the first prompt, so the host starts that draft
		// with an effort system message.
		await host.stopHost();
		host = await spawnOpencode2({
			...options,
			modelVariants: [{ id: "high" }],
			existingIsolation: { root: host.root, env: host.env, cwd: host.cwd },
			existingMock: { mock, baseURL: host.mockBaseURL },
		});
		client = connect();
		await waitForPluginActive(client, host.cwd);
		const other = await client.session.create({
			location: { directory: host.cwd },
			model: { providerID: "openai", id: "mock-model" },
		});
		await client.session.switchModel({
			sessionID: other.id,
			model: { providerID: "openai", id: "mock-model", variant: "high" },
		} as Parameters<typeof client.session.switchModel>[0]);
		await turn(other.id, "OTHER-SESSION-TURN");
		// Precondition: the other session really holds the variant switch the host
		// renders as that effort system message.
		const otherRows = (await client.message.list({ sessionID: other.id })) as { data: Row[] };
		expect(otherRows.data.map((row) => row.type)).toContain("model-switched");

		// The image session, twice: a crash here repeats on every later prompt.
		const after = [await turn(session.id, "AFTER-RESTART-1"), await turn(session.id, "AFTER-RESTART-2")];

		// Precondition: the host checkpointed after the image row, so the image reaches
		// the request only through Magic Context's restore.
		const reader = new V2StoreReader(gaDatabasePath(host.env.XDG_DATA_HOME!, "latest", host.env));
		try {
			const cut = reader.latestCompaction(session.id);
			expect(cut?.data.status).toBe("completed");
			const imageRow = reader
				.history(session.id)
				.find((row) => row.type === "user" && JSON.stringify(row.data).includes("IMAGE-TURN"));
			expect(reader.sequenceForId(session.id, imageRow!.id)!).toBeLessThan(cut!.seq);
		} finally {
			reader.close();
		}
		for (const bodies of after)
			for (const body of bodies) expect(imageElements(body)).toBe(hostRendered);
		expect(log()).not.toContain("attachment replaced by a note");
		// Every database the host holds open is inside this test's throwaway root.
		const databases = inspectOpenFiles(host.pid!, host.root, host.env).filter((path) =>
			/\.(?:db|sqlite)(?:-(?:wal|shm))?$/.test(path),
		);
		console.log(`open databases: ${JSON.stringify(databases)}`);
		expect(databases.every((path) => path.startsWith(host.root))).toBe(true);
	} catch (error) {
		console.error(host.stderr().slice(-3000), log().slice(-6000));
		throw error;
	} finally {
		await host.stop();
	}
}, 240_000);
