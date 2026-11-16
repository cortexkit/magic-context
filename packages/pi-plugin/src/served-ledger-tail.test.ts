import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resetLkgSlotsForTest } from "@magic-context/core/hooks/magic-context/lkg-slot";
import * as logger from "@magic-context/core/shared/logger";
import { createTestTempDir } from "../../plugin/src/shared/test-temp-dir";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import {
	PiServedEnvelopeUnavailable,
	publishPiServedNumbers,
} from "./pi-served-identities";
import * as ledger from "./served-array-ledger";
import {
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "./test-utils.test";

let sequence = 0;
async function fixture(
	run: (f: {
		db: ReturnType<typeof createTestDb>;
		sessionId: string;
		turn: (
			raw: ReturnType<typeof userMessage>[],
		) => Promise<{ messages: unknown[] }>;
		notices: string[];
		refusals: { aborts: number };
		failWith: (error: Error) => void;
	}) => void | Promise<void>,
) {
	const { dir: root, cleanup } = createTestTempDir("pi-ledger-tail-");
	const previous = {
		data: process.env.XDG_DATA_HOME,
		config: process.env.XDG_CONFIG_HOME,
		storage: process.env.MAGIC_CONTEXT_STORAGE_DIR,
	};
	process.env.XDG_DATA_HOME = root;
	process.env.XDG_CONFIG_HOME = root;
	process.env.MAGIC_CONTEXT_STORAGE_DIR = join(root, "storage");
	const db = createTestDb(join(root, "context.db"));
	const sessionId = `pi-ledger-tail-${sequence++}`;
	const notices: string[] = [];
	const refusals = { aborts: 0 };
	const fake = createFakePi();
	// Only Magic Context's ctx_reduce: the session can call it.
	Object.assign(fake.pi, {
		getAllTools: () => [
			{ name: "ctx_reduce", description: "", parameters: { type: "object" } },
		],
		getActiveTools: () => ["ctx_reduce"],
	});
	let failure: Error | undefined;
	registerPiContextHandler(fake.pi as never, {
		db,
		resolveForProject: () => {
			if (failure) throw failure;
			return { db };
		},
	});
	const handler = fake.handlers.get("context") as unknown as (
		event: { messages: ReturnType<typeof userMessage>[] },
		ctx: ReturnType<typeof fakeContext>,
	) => Promise<{ messages: unknown[] }>;
	const turn = (input: ReturnType<typeof userMessage>[]) => {
		const raw = structuredClone(input);
		const ctx = Object.assign(
			fakeContext(
				sessionId,
				root,
				raw.map((_, i) => `entry-${i}`),
				raw,
			),
			{
				getSystemPrompt: () => "You are a coding assistant.",
				abort: () => {
					refusals.aborts++;
				},
				ui: { notify: (text: string) => notices.push(text) },
				model: {
					provider: "anthropic",
					id: "claude-sonnet-4-20250514",
					api: "anthropic-messages",
					contextWindow: 100000,
					maxTokens: 8192,
				},
			},
		);
		return handler({ messages: raw }, ctx);
	};
	try {
		await run({
			db,
			sessionId,
			turn,
			notices,
			refusals,
			failWith: (error) => {
				failure = error;
			},
		});
	} finally {
		ledger.flushPiServedArrayLedger();
		clearContextHandlerSession(sessionId);
		ledger.__test.reset();
		resetLkgSlotsForTest();
		db.close();
		for (const [key, value] of [
			["XDG_DATA_HOME", previous.data],
			["XDG_CONFIG_HOME", previous.config],
			["MAGIC_CONTEXT_STORAGE_DIR", previous.storage],
		] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		cleanup();
	}
}

test("zero-only ledger tails preserve provider request bytes and repair on append", async () => {
	await fixture(async ({ sessionId, turn, notices }) => {
		const raw = [userMessage("already served §99§ quotation é", 1)];
		await turn(raw);
		const clean = JSON.stringify((await turn(raw)).messages);
		ledger.flushPiServedArrayLedger();
		ledger.clearPiServedArraySession(sessionId);
		const digestPath = ledger.getPiServedArrayLedgerPath(sessionId);
		const identityPath = ledger.getPiServedTagNumbersPath(sessionId);
		const digest = ledger.getPiLastServedDigest(sessionId);
		const numbers = [...ledger.getPiServedTagNumbers(sessionId)];
		const identityBytes = readFileSync(identityPath);
		const digestBytes = readFileSync(digestPath);
		appendFileSync(identityPath, Buffer.alloc(87));
		appendFileSync(digestPath, Buffer.alloc(1584));
		const warnings: string[] = [];
		const originalLog = logger.log;
		const logging = spyOn(logger, "log").mockImplementation((...args) => {
			warnings.push(args.map(String).join(" "));
			originalLog(...args);
		});
		try {
			expect([...ledger.getPiServedTagNumbers(sessionId)]).toEqual(numbers);
			expect(ledger.getPiLastServedDigest(sessionId)).toBe(digest);
			expect(ledger.getPiLastServedDigest(sessionId)).toBe(digest);
			expect(readFileSync(identityPath)).toEqual(
				Buffer.concat([identityBytes, Buffer.alloc(87)]),
			);
			expect(readFileSync(digestPath)).toEqual(
				Buffer.concat([digestBytes, Buffer.alloc(1584)]),
			);
			expect(JSON.stringify((await turn(raw)).messages)).toBe(clean);
			expect(notices).toEqual([]);
			const zeroWarnings = warnings.filter((line) =>
				line.includes("WARNING unwritten served-ledger tail"),
			);
			expect(zeroWarnings).toHaveLength(2);
			expect(
				zeroWarnings.every(
					(line) =>
						line.includes(sessionId) &&
						line.includes("retained_bytes=") &&
						line.includes("total_bytes="),
				),
			).toBe(true);
			expect(zeroWarnings.join("\n")).toContain("ignored_zero_bytes=87");
			expect(zeroWarnings.join("\n")).toContain("ignored_zero_bytes=1584");
		} finally {
			logging.mockRestore();
		}
		await turn([...raw, userMessage("newly served", 2)]);
		ledger.flushPiServedArrayLedger();
		const repairedIdentity = readFileSync(identityPath);
		const repairedDigest = readFileSync(digestPath);
		expect(repairedIdentity.subarray(0, identityBytes.length)).toEqual(
			identityBytes,
		);
		expect(repairedDigest.subarray(0, digestBytes.length)).toEqual(digestBytes);
		expect(repairedIdentity.includes(0)).toBe(false);
		expect(repairedDigest.includes(0)).toBe(false);
		expect(ledger.__test.getDiagnostics().swallowedWriteCount).toBe(0);
	});
});

test("torn identity mirror requires committed numbers and repairs without reusing them", async () => {
	await fixture(({ db, sessionId }) => {
		ledger.capturePiServedArray(sessionId, [], { servedTagNumbers: [3] });
		const file = ledger.getPiServedTagNumbersPath(sessionId);
		const before = readFileSync(file);
		appendFileSync(file, '{"version":1,"session_id":"');
		expect(() => ledger.getPiServedTagNumbers(sessionId)).toThrow(
			"Torn Pi served-number tail",
		);
		expect(() =>
			ledger.getPiServedTagNumbers(sessionId, undefined, db),
		).toThrow("No committed Pi served-number envelope");
		publishPiServedNumbers(db, sessionId, [3, 9]);
		expect([...ledger.getPiServedTagNumbers(sessionId, undefined, db)]).toEqual(
			[3, 9],
		);
		ledger.capturePiServedArray(sessionId, [], { db, servedTagNumbers: [9] });
		expect(readFileSync(file).subarray(0, before.length)).toEqual(before);
		expect([...ledger.getPiServedTagNumbers(sessionId)]).toEqual([3, 9]);
		expect(readFileSync(file, "utf8").split("\n").filter(Boolean)).toHaveLength(
			2,
		);
	});
});

test("torn delayed digest cannot authorize replay of an older request", async () => {
	await fixture(({ sessionId }) => {
		ledger.capturePiServedArray(sessionId, [userMessage("complete request")]);
		ledger.flushPiServedArrayLedger();
		ledger.clearPiServedArraySession(sessionId);
		appendFileSync(
			ledger.getPiServedArrayLedgerPath(sessionId),
			'{"version":1,"sha256":"partial',
		);
		expect(() => ledger.getPiLastServedDigest(sessionId)).toThrow(
			"Torn Pi served digest tail; exact-byte replay evidence unavailable",
		);
	});
});

for (const kind of ["identity", "digest"] as const) {
	test(`middle ${kind} corruption is a named recoverable refusal even with a committed envelope`, async () => {
		await fixture(({ db, sessionId }) => {
			ledger.capturePiServedArray(sessionId, [], { servedTagNumbers: [3] });
			ledger.flushPiServedArrayLedger();
			ledger.clearPiServedArraySession(sessionId);
			publishPiServedNumbers(db, sessionId, [3, 9]);
			const file =
				kind === "identity"
					? ledger.getPiServedTagNumbersPath(sessionId)
					: ledger.getPiServedArrayLedgerPath(sessionId);
			const row = readFileSync(file);
			writeFileSync(
				file,
				Buffer.concat([row, Buffer.from("\0invalid\n"), row]),
			);
			const read = () =>
				kind === "identity"
					? ledger.getPiServedTagNumbers(sessionId, undefined, db)
					: ledger.getPiLastServedDigest(sessionId);
			expect(read).toThrow(PiServedEnvelopeUnavailable);
			expect(read).toThrow("Corrupt Pi served ledger JSON record");
			try {
				read();
			} catch (error) {
				expect((error as Error).cause).toBeInstanceOf(SyntaxError);
			}
		});
	});
}

test("persistent fallback failure names its cause without busy or resend advice", async () => {
	await fixture(async ({ turn, notices, failWith, refusals }) => {
		failWith(
			new PiServedEnvelopeUnavailable(
				"Corrupt Pi served ledger JSON record: identity.jsonl",
			),
		);
		await turn([userMessage("hello")]);
		expect(refusals.aborts).toBe(1);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain(
			"Corrupt Pi served ledger JSON record: identity.jsonl",
		);
		expect(notices[0]).not.toContain("storage is busy");
		expect(notices[0]).not.toContain("send your message again");
	});
});

test("real SQLite lock fallback retains transient busy retry advice", async () => {
	await fixture(async ({ turn, notices, failWith, refusals }) => {
		failWith(
			Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }),
		);
		await turn([userMessage("hello")]);
		expect(refusals.aborts).toBe(1);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("storage is busy; send your message again");
	});
});

for (const records of [1, 2]) {
	test(`${records} complete records followed by 87/1584-byte NUL tails stay read-only until append`, async () => {
		await fixture(({ sessionId }) => {
			ledger.capturePiServedArray(sessionId, [], { servedTagNumbers: [3] });
			if (records === 2)
				ledger.capturePiServedArray(
					sessionId,
					[userMessage("second request")],
					{ servedTagNumbers: [8] },
				);
			ledger.flushPiServedArrayLedger();
			const identity = ledger.getPiServedTagNumbersPath(sessionId);
			const digest = ledger.getPiServedArrayLedgerPath(sessionId);
			const identityPrefix = readFileSync(identity);
			const digestPrefix = readFileSync(digest);
			const lastDigest = ledger.getPiLastServedDigest(sessionId);
			expect(lastDigest).toBeDefined();
			appendFileSync(identity, Buffer.alloc(87));
			appendFileSync(digest, Buffer.alloc(1584));
			ledger.clearPiServedArraySession(sessionId);
			expect([...ledger.getPiServedTagNumbers(sessionId)]).toEqual(
				records === 1 ? [3] : [3, 8],
			);
			expect(ledger.getPiLastServedDigest(sessionId)).toBe(lastDigest);
			expect([...ledger.getPiServedTagNumbers(sessionId)]).toEqual(
				records === 1 ? [3] : [3, 8],
			);
			expect(readFileSync(identity)).toEqual(
				Buffer.concat([identityPrefix, Buffer.alloc(87)]),
			);
			expect(readFileSync(digest)).toEqual(
				Buffer.concat([digestPrefix, Buffer.alloc(1584)]),
			);
			ledger.capturePiServedArray(sessionId, [], { servedTagNumbers: [9] });
			ledger.flushPiServedArrayLedger();
			expect(readFileSync(identity).subarray(0, identityPrefix.length)).toEqual(
				identityPrefix,
			);
			expect(readFileSync(digest).subarray(0, digestPrefix.length)).toEqual(
				digestPrefix,
			);
			expect(readFileSync(identity).includes(0)).toBe(false);
			expect(readFileSync(digest).includes(0)).toBe(false);
		});
	});
}

for (const content of ["not a served record\n\0\0\0", "{torn json\n"]) {
	test(`malformed record refuses with its syntax cause: ${JSON.stringify(content)}`, async () => {
		await fixture(({ sessionId }) => {
			ledger.capturePiServedArray(sessionId, [], { servedTagNumbers: [3] });
			const file = ledger.getPiServedTagNumbersPath(sessionId);
			writeFileSync(file, content);
			ledger.clearPiServedArraySession(sessionId);
			let caught: unknown;
			try {
				ledger.getPiServedTagNumbers(sessionId);
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(PiServedEnvelopeUnavailable);
			expect((caught as Error).cause).toBeInstanceOf(SyntaxError);
			expect(readFileSync(file, "utf8")).toBe(content);
		});
	});
}

test("append repair refuses a detected peer size change without removing the peer's bytes", async () => {
	await fixture(({ sessionId }) => {
		ledger.capturePiServedArray(sessionId, [], { servedTagNumbers: [3] });
		const file = ledger.getPiServedTagNumbersPath(sessionId);
		appendFileSync(file, Buffer.alloc(87));
		const padded = readFileSync(file);
		const peer = `${JSON.stringify({ version: 1, session_id: sessionId, tag_numbers: [99] })}\n`;
		const stat = fs.fstatSync;
		let reached = 0;
		const racing = spyOn(fs, "fstatSync").mockImplementation((...args) => {
			const result = stat(...args);
			if (++reached === 1) appendFileSync(file, peer);
			return result;
		});
		try {
			expect(() =>
				ledger.capturePiServedArray(sessionId, [], { servedTagNumbers: [9] }),
			).toThrow("Pi served-number identity could not be persisted or restored");
			expect(reached).toBe(2);
			expect(readFileSync(file)).toEqual(
				Buffer.concat([padded, Buffer.from(peer)]),
			);
		} finally {
			racing.mockRestore();
		}
	});
});
