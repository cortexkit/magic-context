import { expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCompartments } from "../../plugin/src/features/magic-context/compartment-storage";
import {
	setPendingPiCompactionMarkerState,
	updateSessionMeta,
} from "../../plugin/src/features/magic-context/storage";
import { PiTestHarness } from "../src/pi-harness";
import { resolvePiHostInvocation } from "../src/pi-runner/spawn";
import { createE2ETempDir } from "../src/temp-dir";
import { openTestDb } from "../src/test-db";

interface Entry {
	type: string;
	id: string;
	firstKeptEntryId?: unknown;
	details?: { source?: string };
	fromExtension?: boolean;
	message?: { role: string; content: unknown };
}

it("OMP: a verified marker supersedes shifted markers and removes pre-boundary history from the next request", async () => {
	const base = join(realpathSync(tmpdir()), "magic-context/issue-748");
	mkdirSync(base, { recursive: true });
	const previousTmp = process.env.TMPDIR;
	process.env.TMPDIR = base;
	const fixture = createE2ETempDir("omp-marker-");
	const snapshotPath = join(fixture, "branch.json");
	const extension = join(fixture, "marker-probe.mjs");
	writeFileSync(
		extension,
		`
import { writeFileSync } from "node:fs";
export default function(pi) {
    pi.registerCommand("e2e-marker-snapshot", { description: "Capture the persisted branch", handler(_args, ctx) {
        writeFileSync(${JSON.stringify(snapshotPath)}, JSON.stringify({ file: ctx.sessionManager.getSessionFile(), arity: ctx.sessionManager.appendCompaction.length, branch: ctx.sessionManager.getBranch() }));
    }});
    pi.registerCommand("e2e-marker-corrupt", { description: "Seed shifted historical markers", handler(boundary, ctx) {
        for (let i = 0; i < 108; i++) {
            ctx.sessionManager.appendCompaction("LEGACY_SHIFTED_SUMMARY_748_" + i, boundary.trim(), 400, { source: "magic-context", lastCompactedOrdinal: 2 }, true);
        }
    }});
}
`,
	);
	let h: PiTestHarness | undefined;
	try {
		h = await PiTestHarness.create({
			host: "omp",
			extensionsBeforeMagicContext: [extension],
			magicContextConfig: {
				execute_threshold_percentage: 95,
				dreamer: { disable: true },
				compressor: { enabled: false },
			},
		});
		const harness = h;
		const assertIsolation = (label: string) => {
			for (const path of [
				harness.env.baseDir,
				harness.env.configDir,
				harness.env.dataDir,
				harness.env.cacheDir,
				harness.env.agentDir,
			]) {
				expect(path.startsWith(`${base}/`)).toBe(true);
			}
			const opened = execFileSync(
				"lsof",
				["-Fn", "-p", String(harness.hostPid)],
				{ encoding: "utf8" },
			);
			writeFileSync(join(fixture, `lsof-${label}.txt`), opened);
			const stores = opened
				.split("\n")
				.filter(
					(line) =>
						line.startsWith("n/") &&
						(/\.db(?:-wal|-shm)?$/.test(line) ||
							/\/\.(?:config|pi|omp)\//.test(line)),
				)
				.map((line) => line.slice(1));
			expect(stores.length).toBeGreaterThan(0);
			expect(stores.every((path) => path.startsWith(`${base}/`))).toBe(true);
			return stores;
		};
		const session = await h.createSession();
		assertIsolation("start");
		await h.sendPrompt(session, "RAW_BEFORE_BOUNDARY_748");
		await h.sendPrompt(session, "KEPT_TAIL_748");
		const latestWire = () => harness.mock.requests().at(-1)!.body;
		expect(JSON.stringify(latestWire().messages)).toContain(
			"RAW_BEFORE_BOUNDARY_748",
		);
		const snapshot = async () => {
			await harness.invokeExtensionCommand("e2e-marker-snapshot");
			return JSON.parse(readFileSync(snapshotPath, "utf8")) as {
				file: string;
				arity: number;
				branch: Entry[];
			};
		};
		const before = await snapshot();
		expect([4, 7]).toContain(before.arity);
		const messages = before.branch.filter((entry) => entry.type === "message");
		const first = messages[0]!;
		const end = messages[1]!;
		const kept = messages[2]!;
		expect(JSON.stringify(kept.message)).toContain("KEPT_TAIL_748");

		await h.invokeExtensionCommand(`e2e-marker-corrupt ${kept.id}`);
		const broken = await snapshot();
		expect(
			broken.branch.filter((entry) => entry.type === "compaction"),
		).toHaveLength(108);
		expect(broken.branch.at(-1)?.firstKeptEntryId).toBe(400);
		const db = openTestDb(h.contextDbPath());
		try {
			appendCompartments(db as never, session, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 2,
					startMessageId: first.id,
					endMessageId: end.id,
					title: "CANONICAL_HISTORY_748",
					content: "The earlier work is summarized here.",
				},
			]);
			updateSessionMeta(db as never, session, { piStableIdScheme: 1 });
			setPendingPiCompactionMarkerState(db as never, session, {
				firstKeptEntryId: kept.id,
				endMessageId: end.id,
				ordinal: 2,
				tokensBefore: 400,
				summary: "HOST_MARKER_ONLY_748",
				publishedAt: Date.now(),
			});
		} finally {
			db.close();
		}
		await h.restart();
		await h.invokeExtensionCommand("ctx-flush");
		await h.sendPrompt(session, "MATERIALIZE_HISTORY_748");
		const applied = await snapshot();
		const markers = applied.branch.filter(
			(entry) => entry.type === "compaction",
		);
		expect(markers).toHaveLength(109);
		const marker = markers.at(-1)!;
		expect(marker.firstKeptEntryId).toBe(kept.id);
		expect(
			applied.branch.some(
				(entry) =>
					entry.id === marker.firstKeptEntryId && entry.type === "message",
			),
		).toBe(true);
		expect(marker.details?.source).toBe("magic-context");
		expect(marker.fromExtension).toBe(true);
		const persisted = readFileSync(applied.file, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Entry);
		expect(
			persisted.find((entry) => entry.id === marker.id)?.firstKeptEntryId,
		).toBe(kept.id);

		// Restart forces OMP to rebuild from the journal, including the older
		// malformed entries that still lie between the kept tail and new marker.
		await h.restart();
		await h.sendPrompt(session, "AFTER_CORRECT_MARKER_748");
		const wire = latestWire();
		const bytes = JSON.stringify(wire.messages);
		expect(bytes).toContain("CANONICAL_HISTORY_748");
		expect(bytes).toContain("KEPT_TAIL_748");
		expect(bytes).not.toContain("RAW_BEFORE_BOUNDARY_748");
		expect(bytes).not.toContain("LEGACY_SHIFTED_SUMMARY_748");
		expect(bytes).not.toContain("HOST_MARKER_ONLY_748");
		expect(
			(await snapshot()).branch.filter((entry) => entry.type === "compaction"),
		).toHaveLength(109);
		const stores = assertIsolation("after-restart");
		const version = JSON.parse(
			readFileSync(resolvePiHostInvocation("omp").packageJson, "utf8"),
		).version;
		writeFileSync(
			join(fixture, "proof.json"),
			JSON.stringify(
				{ version, pid: h.hostPid, marker, stores, wire },
				null,
				2,
			),
		);
		console.log(
			`OMP748_PROOF ${JSON.stringify({ version, arity: before.arity, pid: h.hostPid, markerId: marker.id, firstKeptEntryId: marker.firstKeptEntryId, keptEntryId: kept.id, markerCount: 109, stores, wireSha256: createHash("sha256").update(bytes).digest("hex"), rawHistoryAbsent: true, oldSummariesAbsent: true, hostSummaryAbsent: true })}`,
		);
		console.log(
			`OMP ${version}, appendCompaction.length=${before.arity}; 108 shifted markers superseded; isolation/wire evidence ${fixture}`,
		);
	} finally {
		await h?.dispose();
		if (previousTmp === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previousTmp;
	}
}, 120_000);
