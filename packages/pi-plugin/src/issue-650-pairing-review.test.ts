import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	readReplayEnvelope,
	serializeReplayDocument,
	updateReplayDocument,
} from "@magic-context/core/features/magic-context/storage-replay-document";
import * as persistence from "@magic-context/core/hooks/magic-context/lkg-persist";
import { resetLkgSlotsForTest } from "@magic-context/core/hooks/magic-context/lkg-slot";
import * as storagePermissions from "@magic-context/core/shared/storage-permissions";
import { createTestTempDir } from "../../plugin/src/shared/test-temp-dir";
import { assertPiRefusedDispatch } from "./__tests__/dispatch-probe";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import { __setPiHarnessKindForTesting } from "./pi-harness-kind";
import {
	publishPiServedNumbers,
	readPiCommittedServedNumbers,
} from "./pi-served-identities";
import { observePiPublicationForTest } from "./publication-observer-fixture.test";
import {
	flushPiServedArrayLedger,
	getPiServedTagNumbers,
	getPiServedTagNumbersPath,
} from "./served-array-ledger";
import {
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "./test-utils.test";

const enabled = process.env.MC_PAIRING_REVIEW === "1";
let sequence = 0;

async function fixture(run: (f: ReturnType<typeof setup>) => Promise<void>) {
	const { dir: root, cleanup } = createTestTempDir("pi-pairing-review-");
	const previous = [process.env.XDG_DATA_HOME, process.env.XDG_CONFIG_HOME];
	process.env.XDG_DATA_HOME = root;
	process.env.XDG_CONFIG_HOME = root;
	__setPiHarnessKindForTesting("omp");
	const f = setup(root);
	try {
		await run(f);
	} finally {
		flushPiServedArrayLedger();
		clearContextHandlerSession(f.sessionId);
		resetLkgSlotsForTest();
		f.db.close();
		__setPiHarnessKindForTesting(undefined);
		for (const [index, key] of ["XDG_DATA_HOME", "XDG_CONFIG_HOME"].entries()) {
			if (previous[index] === undefined) delete process.env[key];
			else process.env[key] = previous[index];
		}
		cleanup();
	}
}

function setup(root: string) {
	const dbPath = join(root, "context.db");
	const db = createTestDb(dbPath);
	const sessionId = `pairing-review-${sequence++}`;
	const fake = createFakePi();
	Object.assign(fake.pi, {
		appendEntry: () => undefined,
		getAllTools: () => [],
	});
	registerPiContextHandler(fake.pi as never, { db });
	let aborts = 0;
	let blocked = 0;
	let dispatches = 0;
	const raw = [userMessage("review served bytes", 1)];
	const ctx = Object.assign(fakeContext(sessionId, root, ["entry-1"], raw), {
		getSystemPrompt: () => "current system",
		model: {
			provider: "openai-codex",
			id: "gpt-5.6-sol",
			contextWindow: 272000,
			maxTokens: 68000,
		},
		abort: () => {
			aborts++;
		},
	});
	const event = (name: string, payload: unknown = {}) => {
		const handler = fake.handlers.get(name);
		if (!handler) throw new Error(`missing ${name} handler`);
		return handler(payload as never, ctx as never);
	};
	const serve = () =>
		event("context", { messages: structuredClone(raw) }) as Promise<{
			messages: unknown[];
		}>;
	const dispatch = () => {
		const result = event("before_provider_request");
		if (result === undefined) dispatches++;
		else {
			assertPiRefusedDispatch(result, "Magic Context could not safely prepare");
			blocked++;
		}
	};
	return {
		root,
		db,
		dbPath,
		sessionId,
		ctx,
		raw,
		event,
		serve,
		dispatch,
		stops: () => aborts + blocked,
		dispatches: () => dispatches,
	};
}

function jsonlNumbers(sessionId: string): number[] {
	const path = getPiServedTagNumbersPath(sessionId);
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.flatMap((line) => JSON.parse(line).tag_numbers);
}

// The verification report's admission/reservation contract permits saved tag numbers
// and last-good requests to survive a later Oh My Pi dispatch refusal. These opt-in
// assertions require retained reservations but zero sends for late/stale/ended turns.
describe.skipIf(!enabled)("issue 650 publication review", () => {
	for (const boundary of ["sqlite", "mirror"] as const) {
		test(`review: ${boundary} overrun retains admitted reservations and LKG with zero OMP sends`, async () => {
			await fixture(async (f) => {
				let now = 0;
				const clock = spyOn(performance, "now").mockImplementation(() => now);
				const save = persistence.saveLkgSlotToDb;
				const write = storagePermissions.writeStorageFileSync;
				let reached = 0;
				const saver = spyOn(persistence, "saveLkgSlotToDb").mockImplementation(
					(...args) => {
						const result = save(...args);
						if (boundary === "sqlite") {
							reached++;
							now = 26_000;
						}
						return result;
					},
				);
				const writer = spyOn(
					storagePermissions,
					"writeStorageFileSync",
				).mockImplementation((path, ...args) => {
					write(path, ...args);
					if (
						boundary === "mirror" &&
						path === getPiServedTagNumbersPath(f.sessionId)
					) {
						reached++;
						now = 26_000;
					}
				});
				try {
					await f.serve();
					f.dispatch();
					expect(reached).toBe(1);
					expect(f.stops()).toBeGreaterThan(0);
					expect(f.dispatches()).toBe(0);
					expect(
						persistence.loadPersistedLkgSlot(f.db, f.sessionId)?.jsonPrefix,
					).toContain("§1§");
					expect(readPiCommittedServedNumbers(f.db, f.sessionId)).toEqual([1]);
				} finally {
					saver.mockRestore();
					writer.mockRestore();
					clock.mockRestore();
				}
			});
		});
	}

	test("review: stale pass after commit retains admitted reservations and LKG with zero OMP sends", async () => {
		await fixture(async (f) => {
			const save = persistence.saveLkgSlotToDb;
			let reached = 0;
			const saver = spyOn(persistence, "saveLkgSlotToDb").mockImplementation(
				(...args) => {
					const result = save(...args);
					reached++;
					// A replacement turn invalidates the old receipt while native IO returns.
					f.event("agent_start");
					return result;
				},
			);
			try {
				await expect(f.serve()).rejects.toThrow("superseded");
				f.dispatch();
				expect(reached).toBe(1);
				expect(f.dispatches()).toBe(0);
				expect(readPiCommittedServedNumbers(f.db, f.sessionId)).toEqual([1]);
				expect(
					persistence.loadPersistedLkgSlot(f.db, f.sessionId)?.jsonPrefix,
				).toContain("§1§");
			} finally {
				saver.mockRestore();
			}
		});
	});

	test("review: ended OMP turn retains admitted reservations and LKG with zero sends", async () => {
		await fixture(async (f) => {
			await f.serve();
			f.event("agent_end");
			f.dispatch();
			expect(f.stops()).toBe(1);
			expect(f.dispatches()).toBe(0);
			expect(readPiCommittedServedNumbers(f.db, f.sessionId)).toEqual([1]);
			expect(
				persistence.loadPersistedLkgSlot(f.db, f.sessionId)?.jsonPrefix,
			).toContain("§1§");
		});
	});

	test("review control: completed OMP pass dispatches the same bytes as its durable pair", async () => {
		await fixture(async (f) => {
			const served = await f.serve();
			f.dispatch();
			expect(f.dispatches()).toBe(1);
			expect(f.stops()).toBe(0);
			expect(
				persistence.loadPersistedLkgSlot(f.db, f.sessionId)?.jsonPrefix,
			).toBe(JSON.stringify(served.messages));
			expect(readPiCommittedServedNumbers(f.db, f.sessionId)).toEqual([1]);
			expect(jsonlNumbers(f.sessionId)).toEqual([1]);
		});
	});

	test("review control: publication storage failure serves and logs but rolls back the pair", async () => {
		await fixture(async (f) => {
			f.db.exec(
				"CREATE TRIGGER busy_lkg BEFORE INSERT ON lkg_slots BEGIN SELECT RAISE(ABORT, 'database is locked'); END",
			);
			const observer = observePiPublicationForTest(f.sessionId);
			try {
				const served = await f.serve();
				f.dispatch();
				expect(f.dispatches()).toBe(1);
				expect(JSON.stringify(served.messages)).toContain(
					"§1§ review served bytes",
				);
				expect(readPiCommittedServedNumbers(f.db, f.sessionId)).toEqual([]);
				expect(
					persistence.loadPersistedLkgSlot(f.db, f.sessionId),
				).toBeUndefined();
				observer.expect("commit_failed", "pair_commit_failed", 1, 1);
			} finally {
				observer.restore();
			}
		});
	});

	for (const limitation of ["branch", "twins"] as const) {
		test(`review control: recurring ${limitation} limitation dispatches with number-only evidence`, async () => {
			await fixture(async (f) => {
				if (limitation === "branch") {
					f.ctx.sessionManager.getBranch = () => {
						throw new Error("branch unavailable");
					};
				} else {
					const known = userMessage("known", 2);
					f.raw.splice(
						0,
						1,
						userMessage("unsaved twin", 1),
						userMessage("unsaved twin", 1),
						known,
					);
					f.ctx.sessionManager.getBranch = () => [
						{ type: "message", id: "known", message: known },
					];
				}
				const observer = observePiPublicationForTest(f.sessionId);
				try {
					const first = await f.serve();
					f.dispatch();
					const second = await f.serve();
					f.dispatch();
					expect(second.messages).toEqual(first.messages);
					expect(f.dispatches()).toBe(2);
					expect(readPiCommittedServedNumbers(f.db, f.sessionId)).toEqual(
						limitation === "branch" ? [1] : [1, 2, 3],
					);
					expect(
						persistence.loadPersistedLkgSlot(f.db, f.sessionId),
					).toBeUndefined();
					observer.expect(
						"numbers_only",
						limitation === "branch"
							? "lkg_entry_ids_unavailable"
							: "lkg_duplicate_entry_id",
						2,
					);
				} finally {
					observer.restore();
				}
			});
		});
	}

	for (const envelope of [
		"{",
		'{"version":3,"trailingBlank":{},"future":"retain"}',
	]) {
		test(`review control: OMP dispatches while preserving unreadable envelope ${envelope}`, async () => {
			await fixture(async (f) => {
				expect(updateReplayDocument(f.db, f.sessionId, () => false)).toBe(true);
				f.db
					.prepare(
						"UPDATE session_meta SET trailing_blank_decisions=? WHERE session_id=?",
					)
					.run(envelope, f.sessionId);
				const served = await f.serve();
				f.dispatch();
				expect(f.dispatches()).toBe(1);
				expect(JSON.stringify(served.messages)).toContain(
					"§1§ review served bytes",
				);
				expect(
					f.db
						.prepare(
							"SELECT trailing_blank_decisions FROM session_meta WHERE session_id=?",
						)
						.get(f.sessionId),
				).toEqual({ trailing_blank_decisions: envelope });
				expect(
					f.db
						.prepare("SELECT session_id FROM lkg_slots WHERE session_id=?")
						.get(f.sessionId) ?? undefined,
				).toBeUndefined();
				expect(jsonlNumbers(f.sessionId)).toEqual([]);
			});
		});
	}

	test("review: legacy peer append after cache warmup is imported on the next real pass", async () => {
		await fixture(async (f) => {
			expect([...getPiServedTagNumbers(f.sessionId, undefined, f.db)]).toEqual(
				[],
			);
			// The peer has its own cache and appends v1 JSONL records of served tag numbers.
			const code = releasePackage
				? `
				import { registerPiContextHandler } from './src/context-handler.ts';
				import { createTestDb, createFakePi, fakeContext, userMessage } from './src/test-utils.test.ts';
				import { flushPiServedArrayLedger } from './src/served-array-ledger.ts';
				const db = createTestDb(${JSON.stringify(f.dbPath)});
				const fake = createFakePi(); registerPiContextHandler(fake.pi,{db});
				const raw=[userMessage('peer',2)];
				const ctx=fakeContext(${JSON.stringify(f.sessionId)},${JSON.stringify(f.root)},['peer'],raw);
				const served=await fake.handlers.get('context')({messages:raw},ctx);
				if (!JSON.stringify(served.messages).includes('§1§')) throw new Error('old handler did not serve identity');
				await new Promise(resolve=>setImmediate(resolve)); flushPiServedArrayLedger(); db.close();
			`
				: `
				import { capturePiServedArray, flushPiServedArrayLedger } from './src/served-array-ledger.ts';
				capturePiServedArray(${JSON.stringify(f.sessionId)}, [{role:'user',content:'§99§ peer',timestamp:2}], {servedTagNumbers:[99]});
				flushPiServedArrayLedger();
			`;
			await output(peer(f, code, releasePackage));
			expect(jsonlNumbers(f.sessionId)).toContain(releasePackage ? 1 : 99);
			await f.serve();
			f.dispatch();
			expect(f.dispatches()).toBe(1);
			console.log(
				`PAIRING_LEGACY ${JSON.stringify({ file: jsonlNumbers(f.sessionId), committed: readPiCommittedServedNumbers(f.db, f.sessionId), adoption: [...getPiServedTagNumbers(f.sessionId, undefined, f.db)] })}`,
			);
			expect(readPiCommittedServedNumbers(f.db, f.sessionId)).toContain(
				releasePackage ? 1 : 99,
			);
			expect([
				...getPiServedTagNumbers(f.sessionId, undefined, f.db),
			]).toContain(releasePackage ? 1 : 99);
		});
	});
});

const releasePackage = process.env.MC_REVIEW_RELEASE
	? resolve(process.env.MC_REVIEW_RELEASE, "packages/pi-plugin")
	: undefined;

function peer(f: ReturnType<typeof setup>, code: string, cwd = process.cwd()) {
	return Bun.spawn([process.execPath, "-e", code], {
		windowsHide: true,
		cwd,
		env: {
			...process.env,
			XDG_DATA_HOME: f.root,
			XDG_CONFIG_HOME: f.root,
			MAGIC_CONTEXT_TEST_DATA_DIR: f.root,
			MAGIC_CONTEXT_STORAGE_DIR: undefined,
		},
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
}

async function output(child: ReturnType<typeof peer>) {
	const [text, error, status] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(status, error).toBe(0);
	return text;
}

const writerImports = `
	import { Database } from '@magic-context/core/shared/sqlite';
	import { publishPiServedNumbers } from './src/pi-served-identities.ts';
	import { addRemovedReasoningIds } from '@magic-context/core/features/magic-context/storage-reasoning-removal';
`;

describe.skipIf(!enabled)("issue 650 concurrent and growth controls", () => {
	test("review control: two Pi processes and an OpenCode namespace writer keep all dispatched numbers", async () => {
		await fixture(async (f) => {
			expect(
				updateReplayDocument(f.db, f.sessionId, (doc) => {
					doc.version = 2;
					doc.piNative = { sentinel: "retain" };
					return true;
				}),
			).toBe(true);
			const piCode = (index: number) => `
				import { registerPiContextHandler } from './src/context-handler.ts';
				import { createTestDb, createFakePi, fakeContext, userMessage } from './src/test-utils.test.ts';
				import { flushPiServedArrayLedger } from './src/served-array-ledger.ts';
				const db = createTestDb(${JSON.stringify(f.dbPath)});
				const fake = createFakePi(); registerPiContextHandler(fake.pi, {db});
				const raw = [userMessage('peer ${index}', ${index})];
				const ctx = fakeContext(${JSON.stringify(f.sessionId)}, ${JSON.stringify(f.root)}, ['peer-${index}'], raw);
				const served = await fake.handlers.get('context')({messages:raw}, ctx);
				console.log(JSON.stringify(served.messages));
				flushPiServedArrayLedger(); db.close();
			`;
			const native = peer(
				f,
				`${writerImports}
				const db = new Database(${JSON.stringify(f.dbPath)}); db.exec('PRAGMA busy_timeout=10000');
				for (let i=0;i<25;i++) if (!addRemovedReasoningIds(db, ${JSON.stringify(f.sessionId)}, ['oc-'+i])) throw new Error('OpenCode namespace CAS failed');
				db.close();
			`,
			);
			const a = peer(f, piCode(1));
			const b = peer(f, piCode(2));
			const [wireA, wireB] = await Promise.all([
				output(a),
				output(b),
				output(native),
			]);
			const servedNumbers = [...`${wireA}${wireB}`.matchAll(/§(\d+)§/g)].map(
				(match) => Number(match[1]),
			);
			expect(new Set(servedNumbers).size).toBe(2);
			const envelope = readReplayEnvelope(f.db, f.sessionId);
			expect(envelope.piNative).toEqual({ sentinel: "retain" });
			expect(
				(envelope.reasoningRemoval as { messageIds: string[] }).messageIds,
			).toHaveLength(25);
			for (const number of servedNumbers)
				expect(readPiCommittedServedNumbers(f.db, f.sessionId)).toContain(
					number,
				);
		});
	}, 30_000);

	test("review control: CAS retries a real competing connection without dropping Pi or OpenCode namespaces", async () => {
		await fixture(async (f) => {
			const other = createTestDb(f.dbPath);
			try {
				publishPiServedNumbers(f.db, f.sessionId, [1]);
				let attempts = 0;
				expect(
					updateReplayDocument(f.db, f.sessionId, (doc) => {
						attempts++;
						if (attempts === 1) publishPiServedNumbers(other, f.sessionId, [2]);
						doc.reasoningRemoval = { messageIds: ["oc"] };
						doc.reasoningRemovalBackup = { messageIds: ["oc"] };
						return true;
					}),
				).toBe(true);
				expect(attempts).toBe(2);
				expect(readPiCommittedServedNumbers(f.db, f.sessionId)).toEqual([1, 2]);
				expect(readReplayEnvelope(f.db, f.sessionId)).toMatchObject({
					reasoningRemoval: { messageIds: ["oc"] },
					reasoningRemovalBackup: { messageIds: ["oc"] },
				});
			} finally {
				other.close();
			}
		});
	});

	test("review control: real writer-busy admission replays only previously dispatched identities", async () => {
		await fixture(async (f) => {
			const first = await f.serve();
			f.dispatch();
			const child = peer(
				f,
				`${writerImports}
				const db = new Database(${JSON.stringify(f.dbPath)}); db.exec('BEGIN IMMEDIATE');
				console.log('LOCKED');
				for await (const chunk of Bun.stdin.stream()) break;
				db.exec('ROLLBACK'); db.close();
			`,
			);
			const reader = child.stdout.getReader();
			try {
				const ready = await reader.read();
				expect(new TextDecoder().decode(ready.value)).toContain("LOCKED");
				const replayed = await f.serve();
				f.dispatch();
				expect(replayed.messages).toEqual(first.messages);
				expect(f.dispatches()).toBe(2);
				expect(readPiCommittedServedNumbers(f.db, f.sessionId)).toEqual([1]);
			} finally {
				child.stdin.write("release\n");
				child.stdin.end();
				while (!(await reader.read()).done) {
					/* Drain the already-acquired pipe. */
				}
				reader.releaseLock();
				const error = await new Response(child.stderr).text();
				expect(await child.exited, error).toBe(0);
			}
		});
	}, 30_000);

	for (const size of [50_000, 200_000]) {
		test(`review measurement: ${size} cumulative numbers serialize and CAS`, async () => {
			await fixture(async (f) => {
				const numbers = Array.from({ length: size }, (_, i) => i + 1);
				publishPiServedNumbers(f.db, f.sessionId, numbers);
				const envelope = readReplayEnvelope(f.db, f.sessionId);
				const serializeMs: number[] = [];
				const casMs: number[] = [];
				let bytes = 0;
				for (let trial = 0; trial < 15; trial++) {
					let start = performance.now();
					bytes = Buffer.byteLength(serializeReplayDocument(envelope));
					serializeMs.push(performance.now() - start);
					start = performance.now();
					f.db
						.transaction(() =>
							publishPiServedNumbers(f.db, f.sessionId, [size + trial + 1]),
						)
						.immediate();
					casMs.push(performance.now() - start);
				}
				expect(readPiCommittedServedNumbers(f.db, f.sessionId)).toHaveLength(
					size + 15,
				);
				console.log(
					`PAIRING_GROWTH ${JSON.stringify({ size, bytes, serializeMs, casMs })}`,
				);
			});
		});
	}
});

describe.skipIf(!enabled || !releasePackage)(
	"issue 650 release interoperability",
	() => {
		test("review known limit: 0.47.0 misses a committed identity until its failed mirror is repaired", async () => {
			await fixture(async (f) => {
				const write = storagePermissions.writeStorageFileSync;
				let attempts = 0;
				const writer = spyOn(
					storagePermissions,
					"writeStorageFileSync",
				).mockImplementation((path, ...args) => {
					if (path === getPiServedTagNumbersPath(f.sessionId)) {
						attempts++;
						throw new Error("mirror unavailable");
					}
					return write(path, ...args);
				});
				try {
					const served = await f.serve();
					f.dispatch();
					expect(attempts).toBe(1);
					expect(f.dispatches()).toBe(1);
					expect(JSON.stringify(served.messages)).toContain("§1§");
					expect(readPiCommittedServedNumbers(f.db, f.sessionId)).toEqual([1]);
					const child = peer(
						f,
						`
					import { getPiServedTagNumbers } from './src/served-array-ledger.ts';
					console.log(JSON.stringify([...getPiServedTagNumbers(${JSON.stringify(f.sessionId)})]));
				`,
						releasePackage,
					);
					// A fresh 0.47.0 reader only knows the JSONL file, not SQLite's number 1.
					// The next new-version pass repairs that file before another downgrade read.
					expect(JSON.parse((await output(child)).trim())).toEqual([]);
					writer.mockRestore();
					const repaired = await f.serve();
					f.dispatch();
					expect(repaired.messages).toEqual(served.messages);
					expect(f.dispatches()).toBe(2);
					const afterRepair = peer(
						f,
						`
						import { getPiServedTagNumbers } from './src/served-array-ledger.ts';
						console.log(JSON.stringify([...getPiServedTagNumbers(${JSON.stringify(f.sessionId)})]));
					`,
						releasePackage,
					);
					expect(JSON.parse((await output(afterRepair)).trim())).toEqual([1]);
				} finally {
					writer.mockRestore();
				}
			});
		});

		test("review control: JSONL-only 0.47.0 evidence imports through the real new handler", async () => {
			await fixture(async (f) => {
				await output(
					peer(
						f,
						`
				import { capturePiServedArray, flushPiServedArrayLedger } from './src/served-array-ledger.ts';
				capturePiServedArray(${JSON.stringify(f.sessionId)}, [{role:'user',content:'§99§ old',timestamp:2}], {servedTagNumbers:[99]});
				flushPiServedArrayLedger();
			`,
						releasePackage,
					),
				);
				expect(readPiCommittedServedNumbers(f.db, f.sessionId)).toEqual([]);
				await f.serve();
				f.dispatch();
				expect(readPiCommittedServedNumbers(f.db, f.sessionId)).toEqual([
					99, 1,
				]);
			});
		});
	},
);
