import { expect } from "bun:test";
import { Database } from "../../../plugin/src/shared/sqlite";
import { MockProvider } from "../mock-provider/server";
import { conversionFixture, spawnOpencode1 } from "./conversion-lane";
import { inspectOpenFiles, spawnOpencode2 } from "./spawn";

export type CommandStoreKind = "pure-v2" | "converted-v1";

/** Real hosts create both store shapes: a fresh OpenCode 2 database has no
 * legacy schema; the converted store retains history written by OpenCode 1. */
export async function commandStoreFixture(kind: CommandStoreKind) {
	const fixture = conversionFixture(`issue-629-${kind}`);
	const mock = new MockProvider();
	mock.setDefault({
		text: "ordinary turn",
		usage: { input_tokens: 100, output_tokens: 10 },
	});
	const provider = await mock.start();
	let sessionId: string | undefined;
	if (kind === "converted-v1") {
		const host = await spawnOpencode1({
			fixture,
			mock,
			mockBaseURL: provider.baseURL,
			magicContextConfig: {
				memory: { enabled: false },
				historian: { disable: true },
				dreamer: { disable: true },
			},
		});
		try {
			const { createOpencodeClient } = await import("@opencode-ai/sdk");
			const client = createOpencodeClient({ baseUrl: host.url });
			sessionId = (
				await client.session.create({ query: { directory: fixture.cwd } })
			).data!.id;
			const reply = await client.session.prompt({
				path: { id: sessionId },
				body: {
					model: { providerID: "openai", modelID: "mock-model" },
					parts: [{ type: "text", text: "History created on OpenCode 1" }],
				},
			});
			expect(reply.data?.info.error).toBeUndefined();
			expect(reply.data).toBeDefined();
		} finally {
			await host.stop();
		}
	}
	const host = await spawnOpencode2({
		existingIsolation: fixture,
		existingMock: { mock, baseURL: provider.baseURL },
		includeMagicContext: false,
	});
	await host.stopHost();
	const db = new Database(fixture.openCodeDbPath, {
		readonly: true,
		fileMustExist: true,
	});
	try {
		expect(
			db
				.prepare(
					"SELECT name FROM sqlite_master WHERE name = 'session_message'",
				)
				.get(),
		).toBeDefined();
		if (kind === "pure-v2") {
			expect(
				db
					.prepare(
						"SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('message', 'part')",
					)
					.all(),
			).toEqual([]);
		} else {
			expect(
				(
					db.prepare("SELECT COUNT(*) AS count FROM message").get() as {
						count: number;
					}
				).count,
			).toBeGreaterThan(0);
			expect(
				db.prepare("SELECT value FROM kv WHERE key = 'migration.v1-v2'").get(),
			).toBeDefined();
		}
	} finally {
		db.close();
	}
	return { fixture, mock, provider, sessionId };
}

/** Compare actual legacy rows and the conversion sentinel, not a marker proxy.
 * OpenCode 2 must neither publish v1 markers nor request destructive reconversion. */
export function legacyStoreSnapshot(
	path: string,
	kind: CommandStoreKind,
): string {
	const db = new Database(path, { readonly: true, fileMustExist: true });
	try {
		const tables = db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('message', 'part') ORDER BY name",
			)
			.all();
		if (kind === "pure-v2") expect(tables).toEqual([]);
		else expect(tables).toHaveLength(2);
		return JSON.stringify({
			tables,
			messages:
				kind === "converted-v1"
					? db.prepare("SELECT * FROM message ORDER BY id").all()
					: [],
			parts:
				kind === "converted-v1"
					? db.prepare("SELECT * FROM part ORDER BY id").all()
					: [],
			conversion: db
				.prepare("SELECT value FROM kv WHERE key = 'migration.v1-v2'")
				.get(),
		});
	} finally {
		db.close();
	}
}

export function recordCommandStoreContainment(
	host: Awaited<ReturnType<typeof spawnOpencode2>>,
): void {
	if (!host.pid) throw new Error("host pid missing");
	const paths = inspectOpenFiles(host.pid, host.root, host.env).filter((path) =>
		/\.db(?:-wal|-shm)?$/.test(path),
	);
	console.error(
		`[issue 629] lsof -p ${host.pid}: ${JSON.stringify([...new Set(paths)])}`,
	);
	expect(paths.length).toBeGreaterThan(0);
}
