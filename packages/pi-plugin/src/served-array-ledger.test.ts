import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
	appendFileSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as storagePermissions from "@magic-context/core/shared/storage-permissions";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import {
	__test,
	capturePiServedArray,
	clearPiServedArraySession,
	flushPiServedArrayLedger,
	getPiLastServedDigest,
	getPiServedArrayBodyPath,
	getPiServedArrayLedgerPath,
	getPiServedTagNumbers,
	getPiServedTagNumbersPath,
	PI_SERVED_ARRAY_TAIL_MESSAGES,
} from "./served-array-ledger";
import { PiServedEnvelopeUnavailable } from "./pi-served-identities";

const temporaryDirectories: string[] = [];

afterEach(() => {
	__test.reset();
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function temporaryDirectory(): string {
	const directory = createTestTempDirFromPath(
		join(tmpdir(), "pi-served-array-ledger-"),
	);
	temporaryDirectories.push(directory);
	return directory;
}

function message(index: number): Record<string, unknown> {
	return {
		role: index % 2 === 0 ? "user" : "assistant",
		content: [{ type: "text", text: `message ${index}` }],
		timestamp: index,
	};
}

describe("Pi served-array digest ledger", () => {
	test("validates a warm legacy cache and reloads a peer append", () => {
		const storageDir = temporaryDirectory();
		capturePiServedArray("cache", [], { storageDir, servedTagNumbers: [3] });
		const first = getPiServedTagNumbers("cache", storageDir);
		expect([...first]).toEqual([3]);
		expect(getPiServedTagNumbers("cache", storageDir)).toBe(first);
		appendFileSync(
			getPiServedTagNumbersPath("cache", storageDir),
			`${JSON.stringify({ version: 1, session_id: "cache", tag_numbers: [99] })}\n`,
		);
		expect([...getPiServedTagNumbers("cache", storageDir)]).toEqual([3, 99]);
	});

	test("reloads a same-size legacy rewrite when its mtime changes", () => {
		const storageDir = temporaryDirectory();
		capturePiServedArray("mtime", [], { storageDir, servedTagNumbers: [3] });
		const file = getPiServedTagNumbersPath("mtime", storageDir);
		const beforeTime = new Date("2020-01-01T00:00:00Z");
		utimesSync(file, beforeTime, beforeTime);
		expect([...getPiServedTagNumbers("mtime", storageDir)]).toEqual([3]);
		const before = statSync(file);
		writeFileSync(
			file,
			`${JSON.stringify({ version: 1, session_id: "mtime", tag_numbers: [8] })}\n`,
		);
		utimesSync(file, beforeTime, new Date(beforeTime.getTime() + 1000));
		expect(statSync(file).size).toBe(before.size);
		expect(statSync(file).ino).toBe(before.ino);
		expect([...getPiServedTagNumbers("mtime", storageDir)]).toEqual([8]);
	});

	test.skipIf(process.platform === "win32")(
		"reloads an inode replacement with unchanged size and mtime",
		() => {
			const storageDir = temporaryDirectory();
			capturePiServedArray("inode", [], { storageDir, servedTagNumbers: [3] });
			const file = getPiServedTagNumbersPath("inode", storageDir);
			const time = new Date("2020-01-01T00:00:00Z");
			utimesSync(file, time, time);
			expect([...getPiServedTagNumbers("inode", storageDir)]).toEqual([3]);
			const before = statSync(file);
			writeFileSync(
				`${file}.replacement`,
				`${JSON.stringify({ version: 1, session_id: "inode", tag_numbers: [8] })}\n`,
			);
			utimesSync(`${file}.replacement`, time, time);
			renameSync(`${file}.replacement`, file);
			expect(statSync(file).size).toBe(before.size);
			expect(statSync(file).mtimeMs).toBe(before.mtimeMs);
			expect(statSync(file).ino).not.toBe(before.ino);
			expect([...getPiServedTagNumbers("inode", storageDir)]).toEqual([8]);
		},
	);

	test("does not trust warm cached evidence after legacy file corruption", () => {
		const storageDir = temporaryDirectory();
		capturePiServedArray("warm-corrupt", [], {
			storageDir,
			servedTagNumbers: [3],
		});
		expect([...getPiServedTagNumbers("warm-corrupt", storageDir)]).toEqual([3]);
		writeFileSync(
			getPiServedTagNumbersPath("warm-corrupt", storageDir),
			"not a served record\n",
		);
		expect(() => getPiServedTagNumbers("warm-corrupt", storageDir)).toThrow();
	});

	test("a peer append racing the local mirror remains visible to the next reader", () => {
		const storageDir = temporaryDirectory();
		const file = getPiServedTagNumbersPath("race", storageDir);
		expect(getPiServedTagNumbers("race", storageDir).size).toBe(0);
		const write = storagePermissions.writeStorageFileSync;
		let reached = 0;
		const writer = spyOn(
			storagePermissions,
			"writeStorageFileSync",
		).mockImplementation((path, ...args) => {
			if (path === file) {
				reached++;
				// Execute a peer's actual append after our read, before our own append.
				appendFileSync(
					file,
					`${JSON.stringify({ version: 1, session_id: "race", tag_numbers: [99] })}\n`,
				);
			}
			write(path, ...args);
		});
		try {
			capturePiServedArray("race", [], { storageDir, servedTagNumbers: [3] });
			expect(reached).toBe(1);
			expect([...getPiServedTagNumbers("race", storageDir)]).toEqual([99, 3]);
		} finally {
			writer.mockRestore();
		}
	});

	test("unreadable identity storage refuses instead of forgetting served numbers", () => {
		const storageDir = temporaryDirectory();
		capturePiServedArray("corrupt", ["§1§ served"], {
			storageDir,
			servedTagNumbers: [1],
		});
		writeFileSync(
			getPiServedTagNumbersPath("corrupt", storageDir),
			"not a served record\n",
		);
		clearPiServedArraySession("corrupt");
		expect(() => getPiServedTagNumbers("corrupt", storageDir)).toThrow();
		expect(() =>
			capturePiServedArray("corrupt", [], {
				storageDir,
				servedTagNumbers: [9],
			}),
		).toThrow();
	});
	test("fresh process reconstructs served numbers without captured bodies", () => {
		const storageDir = temporaryDirectory();
		const modulePath = join(import.meta.dir, "served-array-ledger.ts");
		const run = (code: string) => {
			const result = Bun.spawnSync(
				[
					process.execPath,
					"--tsconfig-override",
					join(import.meta.dir, "../tsconfig.json"),
					"-e",
					code,
				],
				{ windowsHide: true },
			);
			expect(result.exitCode, result.stderr.toString()).toBe(0);
			return result.stdout.toString().trim();
		};
		run(`import { capturePiServedArray } from ${JSON.stringify(modulePath)};
capturePiServedArray("restart", ["§1§ quoted §9§"], { storageDir: ${JSON.stringify(storageDir)}, servedTagNumbers: [1] });`);
		expect(
			run(`import { getPiServedTagNumbers } from ${JSON.stringify(modulePath)};
console.log(JSON.stringify([...getPiServedTagNumbers("restart", ${JSON.stringify(storageDir)})]));`),
		).toBe("[1]");
		expect(readdirSync(storageDir)).not.toContain("pi-served-array-bodies");
	});
	test("literal markers do not create served identities", () => {
		const storageDir = temporaryDirectory();
		capturePiServedArray("literal", ["quoted §9§"], { storageDir });
		expect([...getPiServedTagNumbers("literal", storageDir)]).toEqual([]);
		capturePiServedArray("literal", ["§1§ quoted §9§"], {
			storageDir,
			servedTagNumbers: [1],
		});
		expect([...getPiServedTagNumbers("literal", storageDir)]).toEqual([1]);
	});
	test("busy recovery records bytes without reading or writing tag identity state", () => {
		const storageDir = temporaryDirectory();
		const identityPath = getPiServedTagNumbersPath("busy", storageDir);
		mkdirSync(dirname(identityPath), { recursive: true });
		writeFileSync(identityPath, "unreadable identity state");
		const db = new Proxy(
			{},
			{
				get: () => {
					throw new Error("Recovery consulted SQLite identity state");
				},
			},
		);
		const record = capturePiServedArray(
			"busy",
			["§1§ old prefix", "raw tail"],
			{
				storageDir,
				db: db as never,
				servedTagNumbers: [99],
				recoveryWithoutTagState: true,
			},
		);
		expect(record?.message_count).toBe(2);
		expect(readFileSync(identityPath, "utf8")).toBe(
			"unreadable identity state",
		);
	});
	test("records served numbers across normal and detached LKG arrays after cleanup", () => {
		const storageDir = temporaryDirectory();
		expect(getPiServedTagNumbers("numbers", storageDir).size).toBe(0);
		capturePiServedArray("numbers", ["§3§ served"], {
			storageDir,
			servedTagNumbers: [3],
		});
		capturePiServedArray("numbers", [], {
			storageDir,
			servedTagNumbers: [8],
			serializedOutput: {
				jsonMessages: ['"[dropped §8§]"'],
				json: '["[dropped §8§]"]',
			},
		});
		expect([...getPiServedTagNumbers("numbers", storageDir)]).toEqual([3, 8]);
		clearPiServedArraySession("numbers");
		expect([...getPiServedTagNumbers("numbers", storageDir)]).toEqual([3, 8]);
		expect(
			readFileSync(getPiServedTagNumbersPath("numbers", storageDir), "utf8"),
		).toContain('"tag_numbers":[3]');
	});
	test("creates every ledger artifact without group or world access", () => {
		if (process.platform === "win32") return;
		const storageDir = join(
			tmpdir(),
			"magic-context",
			`pi-owner-only-${process.pid}-${randomUUID()}`,
		);
		temporaryDirectories.push(storageDir);
		capturePiServedArray("private", [message(0)], {
			storageDir,
			servedTagNumbers: [1],
			fullBodyCapture: true,
		});
		flushPiServedArrayLedger();

		const inspect = (path: string): void => {
			const stat = statSync(path);
			const mode = stat.mode & 0o777;
			expect(mode & 0o077, `${path} mode ${mode.toString(8)}`).toBe(0);
			if (!stat.isDirectory()) return;
			for (const entry of readdirSync(path)) inspect(join(path, entry));
		};
		inspect(storageDir);
	});

	test("reuses the same-pass LKG bytes without walking messages again", () => {
		const storageDir = temporaryDirectory();
		const messages = Array.from({ length: 45 }, (_, index) => message(index));
		const jsonMessages = messages.map((message) => JSON.stringify(message));
		const json = JSON.stringify(messages);
		// The tail vectors still inspect the last 40 entries, but the full-array
		// digest must use the detached snapshot rather than serialize the head.
		Object.defineProperty(messages[0], "toJSON", {
			value: () => {
				throw new Error("head serialized twice");
			},
		});
		const record = capturePiServedArray("reuse", messages, {
			storageDir,
			fullBodyCapture: true,
			serializedOutput: { jsonMessages, json },
		});
		flushPiServedArrayLedger();
		expect(record?.sha256).toBe(
			createHash("sha256").update(json).digest("hex"),
		);
		const body = JSON.parse(
			readFileSync(getPiServedArrayBodyPath("reuse", storageDir), "utf8"),
		);
		expect(JSON.stringify(body.messages)).toBe(json);
		expect(__test.getDiagnostics().swallowedWriteCount).toBe(0);
	});

	test("session cleanup releases previous bytes but preserves queued records", () => {
		const storageDir = temporaryDirectory();
		const first = capturePiServedArray("clear", [message(0)], { storageDir });
		capturePiServedArray("other", [message(0)], { storageDir });
		clearPiServedArraySession("clear");
		const next = capturePiServedArray("clear", [message(1)], { storageDir });
		const other = capturePiServedArray("other", [message(1)], { storageDir });
		expect(next?.previous_sha256).toBeNull();
		expect(next?.sequence).toBe(1);
		expect(other?.sequence).toBe(2);
		flushPiServedArrayLedger();
		const rows = readFileSync(
			getPiServedArrayLedgerPath("clear", storageDir),
			"utf8",
		)
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(rows).toEqual([first, next]);
	});
	test("persists one full-array digest and exact first divergence per pass", () => {
		const storageDir = temporaryDirectory();
		const sessionId = "019-test-session";
		const firstMessages = [message(0), message(1), message(2)];
		const secondMessages = [
			message(0),
			{ ...message(1), timestamp: 99 },
			message(2),
		];

		const first = capturePiServedArray(sessionId, firstMessages, {
			storageDir,
			now: new Date("2026-09-04T10:00:00.000Z"),
		});
		const second = capturePiServedArray(sessionId, secondMessages, {
			storageDir,
			now: new Date("2026-09-04T10:00:01.000Z"),
		});
		flushPiServedArrayLedger();

		expect(first?.sha256).toBe(
			createHash("sha256").update(JSON.stringify(firstMessages)).digest("hex"),
		);
		expect(first?.first_divergence_message_index).toBeNull();
		expect(second?.previous_sha256).toBe(first?.sha256);
		expect(second?.first_divergence_message_index).toBe(1);
		expect(second?.block_vectors).toHaveLength(3);
		expect(second?.block_vectors[1]).toStartWith("assistant:text(");

		const rows = readFileSync(
			getPiServedArrayLedgerPath(sessionId, storageDir),
			"utf8",
		)
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(rows).toEqual([first, second]);
		expect(() =>
			readFileSync(getPiServedArrayBodyPath(sessionId, storageDir), "utf8"),
		).toThrow();
	});

	test("limits block vectors to the newest 40 messages", () => {
		const messages = Array.from(
			{ length: PI_SERVED_ARRAY_TAIL_MESSAGES + 5 },
			(_, index) => message(index),
		);
		const record = capturePiServedArray("tail-limit", messages, {
			storageDir: temporaryDirectory(),
		});

		expect(record?.block_vector_start).toBe(5);
		expect(record?.block_vectors).toHaveLength(PI_SERVED_ARRAY_TAIL_MESSAGES);
		expect(record?.block_vectors[0]).toStartWith("assistant:text(");
	});

	test("writes exact served bodies only when explicitly enabled", () => {
		const storageDir = temporaryDirectory();
		const sessionId = "body-opt-in";
		const messages = [message(0), message(1)];

		const record = capturePiServedArray(sessionId, messages, {
			storageDir,
			fullBodyCapture: true,
		});
		flushPiServedArrayLedger();

		const body = JSON.parse(
			readFileSync(
				getPiServedArrayBodyPath(sessionId, storageDir),
				"utf8",
			).trim(),
		);
		expect(body.sha256).toBe(record?.sha256);
		expect(body.messages).toEqual(messages);
	});

	test("contains unserializable input instead of affecting the provider pass", () => {
		const circular: Record<string, unknown> = { role: "user" };
		circular.content = circular;

		expect(
			capturePiServedArray("circular", [circular], {
				storageDir: temporaryDirectory(),
			}),
		).toBeUndefined();
		expect(__test.getDiagnostics().swallowedWriteCount).toBe(1);
	});
});

describe("issue #723: hole-padded NUL tails in the served ledgers", () => {
	function padNulTail(file: string, bytes: number): void {
		appendFileSync(file, Buffer.alloc(bytes));
	}

	test("identity ledger ignores a NUL-only tail, adopts the last valid record, and repairs the file", () => {
		const storageDir = temporaryDirectory();
		capturePiServedArray("nul-identity", [], {
			storageDir,
			servedTagNumbers: [3],
		});
		const file = getPiServedTagNumbersPath("nul-identity", storageDir);
		padNulTail(file, 87);

		__test.reset();
		expect([...getPiServedTagNumbers("nul-identity", storageDir)]).toEqual([3]);
		// The padded tail is repaired so the plugin never re-fails on the same bytes.
		expect(readFileSync(file).includes(0)).toBe(false);
		// The repaired file keeps validating record semantics.
		expect([...getPiServedTagNumbers("nul-identity", storageDir)]).toEqual([3]);
	});

	test("digest ledger ignores a NUL-only tail and still returns the last digest", () => {
		const storageDir = temporaryDirectory();
		capturePiServedArray("nul-digest", [], { storageDir });
		flushPiServedArrayLedger();
		const file = getPiServedArrayLedgerPath("nul-digest", storageDir);
		const digest = getPiLastServedDigest("nul-digest", storageDir);
		expect(digest).toBeDefined();
		padNulTail(file, 1584);

		__test.reset();
		expect(getPiLastServedDigest("nul-digest", storageDir)).toBe(digest);
		// The digest ledger's padded tail is repaired on read as well.
		expect(readFileSync(file).includes(0)).toBe(false);
	});

	test("genuinely corrupt content lines still fail closed with a typed error", () => {
		const storageDir = temporaryDirectory();
		capturePiServedArray("nul-content", [], {
			storageDir,
			servedTagNumbers: [3],
		});
		const file = getPiServedTagNumbersPath("nul-content", storageDir);
		// A corrupt *content* line plus NUL padding: the tail may be dropped,
		// but the unreadable record must refuse identity adoption for safety.
		writeFileSync(file, "not a served record\n\u0000\u0000\u0000");

		__test.reset();
		let error: unknown;
		try {
			getPiServedTagNumbers("nul-content", storageDir);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(PiServedEnvelopeUnavailable);
	});

	test("a raw JSON syntax failure surfaces as pi-served-envelope-unavailable", () => {
		const storageDir = temporaryDirectory();
		capturePiServedArray("nul-syntax", [], {
			storageDir,
			servedTagNumbers: [3],
		});
		const file = getPiServedTagNumbersPath("nul-syntax", storageDir);
		writeFileSync(file, "{torn json\n");

		__test.reset();
		expect(() => getPiServedTagNumbers("nul-syntax", storageDir)).toThrow(
			PiServedEnvelopeUnavailable,
		);
	});
});
