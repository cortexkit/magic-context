import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import {
	__test,
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import {
	createFakePi,
	createTestDb,
	fakeContext,
	type PiMessage,
	textOf,
	userMessage,
} from "./test-utils.test";

// This real-time control needs lsof and a native SQLite locker, and intentionally fails
// when a healthy pass plus writer admission exceeds OMP's 30-second context deadline.
test.skipIf(
	process.env.MC640_R2_DEADLINE !== "1" || process.platform !== "darwin",
)(
	"r2: writer wait plus in-flight historian must fit OMP's 30-second deadline",
	async () => {
		const timings: {
			hold: number;
			admissionMs: number;
			totalMs: number;
			root: string;
		}[] = [];
		for (const hold of [0, 15500]) {
			const parent = join(tmpdir(), "magic-context", "bg_a1704ae3546049d5");
			mkdirSync(parent, { recursive: true });
			const root = createTestTempDirFromPath(join(parent, "deadline-"));
			const db = createTestDb(join(root, "context.db"));
			const sessionId = `r2-deadline-${hold}`;
			const raw = Array.from({ length: 6000 }, (_, index) =>
				userMessage(
					`message ${index} ${"ordinary words ".repeat(7)}`,
					index + 1,
				),
			);
			const ids = raw.map((_, index) => `entry-${index}`);
			let holder: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
			let admission = 0;
			let resolveHistory!: () => void;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const history = new Promise<void>((done) => {
				resolveHistory = done;
			});
			const restoreHistory = __test.setInFlightHistorianForTests(
				sessionId,
				history,
			);
			try {
				if (hold) {
					holder = Bun.spawn(
						[
							"python3",
							"-c",
							'import sqlite3,sys,time; c=sqlite3.connect(sys.argv[1]); c.execute("BEGIN IMMEDIATE"); print("locked",flush=True); time.sleep(float(sys.argv[2])); c.rollback()',
							join(root, "context.db"),
							String(hold / 1000),
						],
						{
							env: process.env,
							windowsHide: true,
							stdin: "ignore",
							stdout: "pipe",
							stderr: "pipe",
						},
					);
					const reader = holder.stdout.getReader();
					expect(
						new TextDecoder().decode((await reader.read()).value),
					).toContain("locked");
					reader.releaseLock();
				}
				const descriptors = execFileSync("lsof", ["-p", String(process.pid)], {
					encoding: "utf8",
					windowsHide: true,
				});
				writeFileSync(join(root, "lsof-host.txt"), descriptors);
				const databaseRows = descriptors
					.split("\n")
					.filter((line) => /\.db(?:$|\b)/.test(line));
				expect(databaseRows.length).toBeGreaterThan(0);
				expect(databaseRows.every((line) => line.includes(parent))).toBe(true);
				const exec = db.exec.bind(db);
				db.exec = (sql: string) => {
					const value = exec(sql);
					if (sql === "BEGIN IMMEDIATE" && !admission) {
						admission = performance.now();
						// A historian can still be running when writer admission finally succeeds.
						timer = setTimeout(resolveHistory, 14000);
					}
					return value;
				};
				const fake = createFakePi();
				registerPiContextHandler(fake.pi as never, { db, protectedTags: 6100 });
				const handler = fake.handlers.get("context") as unknown as (
					event: { messages: PiMessage[] },
					ctx: ReturnType<typeof fakeContext>,
				) => Promise<{ messages: PiMessage[] }>;
				const ctx = {
					...fakeContext(sessionId, process.cwd(), ids, raw),
					abort: () => {
						refused = true;
					},
					getContextUsage: () => ({
						tokens: 960000,
						percent: 96,
						contextWindow: 1000000,
					}),
				};
				let refused = false;
				const start = performance.now();
				const result = await handler({ messages: raw }, ctx);
				if (hold) {
					// Waiting for the database writer plus the history summary exceeds
					// 21s. Refuse while there is still time to complete the 25s outcome.
					expect(refused).toBe(true);
					expect(textOf(result.messages[0])).not.toContain("§");
				} else {
					expect(refused).toBe(false);
					expect(textOf(result.messages[0])).toContain("§");
				}
				timings.push({
					hold,
					admissionMs: admission - start,
					totalMs: performance.now() - start,
					root,
				});
				writeFileSync(
					join(root, "timing.json"),
					JSON.stringify(timings.at(-1)),
				);
				// Preserve small verification receipts outside the registered fixture
				// root, which the test helper automatically removes on process exit.
				writeFileSync(
					join(parent, `deadline-${hold}-timing.json`),
					JSON.stringify(timings.at(-1)),
				);
				writeFileSync(join(parent, `deadline-${hold}-lsof.txt`), descriptors);
			} finally {
				if (timer) clearTimeout(timer);
				resolveHistory();
				restoreHistory();
				await holder?.exited;
				clearContextHandlerSession(sessionId);
				db.close();
			}
		}
		console.log("r2 deadline timings", JSON.stringify(timings));
		expect(timings[0].totalMs).toBeLessThan(30000);
		expect(timings[1].totalMs).toBeLessThan(30000);
	},
	90000,
);
