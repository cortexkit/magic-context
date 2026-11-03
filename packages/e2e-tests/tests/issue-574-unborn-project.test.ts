import { openTestDb } from "../src/test-db";
/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk";
import {
	type RpcPortFileRecord,
	rpcPortDir,
} from "../../plugin/src/shared/rpc-utils";
import { MockProvider } from "../src/mock-provider/server";
import { createIsolatedEnv, spawnOpencode } from "../src/opencode-runner/spawn";

// This opt-in host test must never use the user's existing configuration or memory stores.
const enabled = /\/magic-context\/issue-574(?:\/|$)/.test(resolve(tmpdir()));
(enabled ? test : test.skip)(
	"OpenCode 1.18.30 unborn project loads existing dir memories without refresh stacks",
	async () => {
		expect(
			execFileSync("opencode", ["--version"], { encoding: "utf8" }).trim(),
		).toBe("1.18.30");
		const env = createIsolatedEnv();
		execFileSync("git", ["init", "-q", env.workdir]);
		const directory = realpathSync(env.workdir);
		const identity = `dir:${createHash("md5").update(directory).digest("hex").slice(0, 12)}`;
		const storage = join(env.dataDir, "cortexkit", "magic-context");
		const mock = new MockProvider();
		const { baseURL } = await mock.start();
		mock.setDefault({
			text: "memory received",
			usage: { input_tokens: 1000, output_tokens: 20 },
		});
		let host: Awaited<ReturnType<typeof spawnOpencode>> | undefined;
		try {
			host = await spawnOpencode({
				mockProviderURL: baseURL,
				existingEnv: env,
				magicContextConfig: {
					dreamer: { disable: true },
					memory: { auto_promote: false, auto_search: { enabled: false } },
				},
			});
			const client = createOpencodeClient({ baseUrl: host.url });
			const warmup = await client.session.create({ query: { directory } });
			const warmupId = warmup.data?.id;
			if (!warmupId) throw new Error("Warmup session absent");
			await client.session.prompt({
				path: { id: warmupId },
				body: {
					model: { providerID: "mock-anthropic", modelID: "mock-sonnet" },
					parts: [{ type: "text", text: "initialize plugin" }],
				},
			});
			const opened = execFileSync("lsof", ["-Fn", "-p", String(host.pid)], {
				encoding: "utf8",
			});
			const dbPaths = opened
				.split("\n")
				.filter(
					(line) => line.startsWith("n/") && /\.db(?:-wal|-shm)?$/.test(line),
				);
			console.log(
				`ISSUE574 lsof pid=${host.pid} db=${JSON.stringify(dbPaths)}`,
			);
			expect(dbPaths.length).toBeGreaterThan(0);
			expect(
				dbPaths.every((line) =>
					resolve(line.slice(1)).startsWith(realpathSync(tmpdir()) + "/"),
				),
			).toBe(true);
			const db = openTestDb(join(storage, "context.db"));
			const content =
				"UNBORN_PROJECT_EXISTING_MEMORY: always preserve the directory's established conventions";
			const now = Date.now();
			try {
				db.prepare(`INSERT INTO memories (project_path, category, content, normalized_hash, source_session_id, source_type,
                seen_count, retrieval_count, first_seen_at, created_at, updated_at, last_seen_at, status)
                VALUES (?, 'USER_DIRECTIVES', ?, ?, NULL, 'historian', 5, 0, ?, ?, ?, ?, 'active')`).run(
					identity,
					content,
					createHash("sha256").update(content).digest("hex"),
					now,
					now,
					now,
					now,
				);
				const created = await client.session.create({ query: { directory } });
				const sessionId = created.data?.id;
				if (!sessionId) throw new Error("Session absent");
				const reply = await client.session.prompt({
					path: { id: sessionId },
					body: {
						model: { providerID: "mock-anthropic", modelID: "mock-sonnet" },
						parts: [{ type: "text", text: "Recall the project conventions" }],
					},
				});
				expect(reply.error).toBeUndefined();
				const meta = db
					.prepare(
						"SELECT memory_block_count, cached_m0_project_identity FROM session_meta WHERE session_id=?",
					)
					.get(sessionId) as Record<string, unknown>;
				console.log(
					`ISSUE574 memory identity=${identity} meta=${JSON.stringify(meta)}`,
				);
				expect(meta.memory_block_count).toBe(1);
				expect(meta.cached_m0_project_identity).toBe(identity);
				expect(JSON.stringify(mock.lastRequest()?.body)).toContain(
					"UNBORN_PROJECT_EXISTING_MEMORY",
				);
				const ports = rpcPortDir(storage, directory);
				const file = readdirSync(ports).find(
					(name) => name.startsWith("port-") && name.endsWith(".json"),
				);
				if (!file) throw new Error("Sidebar discovery absent");
				const discovery = JSON.parse(
					readFileSync(join(ports, file), "utf8"),
				) as RpcPortFileRecord;
				for (let i = 0; i < 4; i++) {
					const response = await fetch(
						`http://127.0.0.1:${discovery.port}/rpc/sidebar-snapshot`,
						{
							method: "POST",
							headers: {
								"Content-Type": "application/json",
								Authorization: `Bearer ${discovery.token}`,
							},
							body: JSON.stringify({ sessionId, directory }),
						},
					);
					const snapshot = (await response.json()) as Record<string, unknown>;
					expect(snapshot.error).toBeUndefined();
					expect(snapshot.memoryCount).toBe(1);
					await Bun.sleep(2000);
				}
				const logPath = join(env.dataDir, "cortexkit", "magic-context-e2e.log");
				expect(existsSync(logPath)).toBe(true);
				const errors = readFileSync(logPath, "utf8")
					.split("\n")
					.filter(
						(line) =>
							line.includes("ProjectIdentityError") ||
							line.includes("sidebar-snapshot error:"),
					);
				console.log(
					`ISSUE574 four refreshes stack/error lines=${errors.length}`,
				);
				expect(errors).toEqual([]);
			} finally {
				db.close();
			}
		} finally {
			await host?.kill();
			await mock.stop();
		}
	},
	180_000,
);
