import { openTestDb } from "../../src/test-db";
/// <reference types="bun-types" />

/**
 * A TypeScript-mode session on OpenCode 2 over a migrated copy of a real context.db.
 *
 * Inert unless `MC_MIGRATED_CONTEXT_COPY` names a context.db copy that is already at
 * this build's schema (see real-store-copy-migration.test.ts in the plugin). The file
 * is MOVED into the throwaway host root, so pass a disposable copy. After three turns
 * the test checks that Magic Context transformed the requests, that the session's
 * rows landed in the migrated database, and that `quick_check` still passes.
 */

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { Database } from "../../../plugin/src/shared/sqlite";
import { isolation, spawnOpencode2 } from "../../src/opencode2-runner/spawn";

const copy = process.env.MC_MIGRATED_CONTEXT_COPY;

test.skipIf(!copy)(
	"a TypeScript-mode OpenCode 2 session runs on a migrated real store",
	async () => {
		const fixture = isolation();
		const storeDir = join(
			fixture.env.XDG_DATA_HOME!,
			"cortexkit",
			"magic-context",
		);
		mkdirSync(storeDir, { recursive: true });
		const dbPath = join(storeDir, "context.db");
		for (const suffix of ["", "-wal", "-shm"])
			if (existsSync(`${copy}${suffix}`))
				renameSync(`${copy}${suffix}`, `${dbPath}${suffix}`);
		const before = openTestDb(dbPath, { readonly: true }, Database);
		const sessionsBefore = (
			before.prepare("SELECT COUNT(*) AS n FROM session_meta").get() as {
				n: number;
			}
		).n;
		before.close();
		const host = await spawnOpencode2({
			existingIsolation: fixture,
			magicContextConfig: {
				memory: { enabled: false },
				dreamer: { disable: true },
				historian: { disable: true },
			},
		});
		try {
			console.log(`host pid=${host.pid ?? "?"} root=${fixture.root}`);
			const client = OpenCode.make({
				baseUrl: host.url,
				headers: {
					authorization: `Basic ${btoa(`opencode:${host.password}`)}`,
				},
			});
			const session = await client.session.create({
				location: { directory: host.cwd },
				model: { providerID: "openai", id: "mock-model" },
			});
			for (let turn = 0; turn < 3; turn += 1) {
				await client.session.prompt({
					sessionID: session.id,
					text: `migrated store turn ${turn}`,
				});
				await client.session.wait(
					{ sessionID: session.id },
					{ signal: AbortSignal.timeout(120_000) },
				);
			}
			const transformed = host.mock
				.requests()
				.filter((request) =>
					JSON.stringify(request.body).includes("migrated store turn 2"),
				)
				.some((request) => /§\d+§/.test(JSON.stringify(request.body)));
			expect(transformed).toBe(true);
			// Every database the host holds open lives under the throwaway root.
			const lsof = Bun.spawnSync([
				"lsof",
				"-Fn",
				"-p",
				String(host.pid),
			]).stdout.toString();
			const dbPaths = [
				...new Set(
					lsof
						.split("\n")
						.filter(
							(line) => line.startsWith("n") && /\.db(-wal|-shm)?$/.test(line),
						)
						.map((line) => line.slice(1)),
				),
			];
			console.log(`host ${host.pid} open .db files: ${dbPaths.join(" ")}`);
			expect(dbPaths.length).toBeGreaterThan(0);
			expect(dbPaths.filter((path) => !path.startsWith(fixture.root))).toEqual(
				[],
			);
		} finally {
			await host.stop();
		}
		const after = openTestDb(dbPath, { readonly: true }, Database);
		try {
			const sessionsAfter = (
				after.prepare("SELECT COUNT(*) AS n FROM session_meta").get() as {
					n: number;
				}
			).n;
			const version = (
				after
					.prepare("SELECT MAX(version) AS v FROM schema_migrations")
					.get() as { v: number }
			).v;
			const quickCheck = (
				after.prepare("PRAGMA quick_check").get() as { quick_check: string }
			).quick_check;
			console.log(
				`migrated store after a TS session: schema=v${version} sessions ${sessionsBefore}->${sessionsAfter} quick_check=${quickCheck}`,
			);
			expect(sessionsAfter).toBeGreaterThan(sessionsBefore);
			expect(quickCheck).toBe("ok");
		} finally {
			after.close();
		}
	},
	1_800_000,
);
