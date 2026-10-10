import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import {
	__test,
	capturePiServedArray,
	clearPiServedArraySession,
	flushPiServedArrayLedger,
	getPiServedArrayBodyPath,
	getPiServedArrayLedgerPath,
	getPiServedTagNumbers,
	getPiServedTagNumbersPath,
	PI_SERVED_ARRAY_TAIL_MESSAGES,
} from "./served-array-ledger";

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
