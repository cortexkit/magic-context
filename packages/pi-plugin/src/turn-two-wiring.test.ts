/// <reference types="bun-types" />

/**
 * Pi/OMP host wiring for memory-lifecycle turn two.
 *
 * The Pi context handler must hand the historian runner the `historian.turn_two`
 * switch, and the runner must select turn two from the reviewed allowlist alone.
 * These tests capture the deps the registered context handler builds for a real
 * historian start, then check selection against a test-supplied Pi identity.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveConfigReader } from "@magic-context/core/config/live-snapshot";
import { acquireCompartmentLease } from "@magic-context/core/features/magic-context/compartment-lease";
import { getCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import { selectTurnOneExecution } from "@magic-context/core/features/magic-context/memory/turn-one-publication";
import { loadTurnTwoAllowlist } from "@magic-context/core/features/magic-context/memory/turn-two-allowlist";
import { closeDatabase } from "@magic-context/core/features/magic-context/storage";
import type { RawMessage } from "@magic-context/core/hooks/magic-context/read-session-raw";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import type { SubagentRunner } from "@magic-context/core/shared/subagent-runner";
import { createTestTempDirFromPath } from "@magic-context/core/shared/test-temp-dir";
import { loadPiConfigDetailed } from "./config";
import {
	awaitInFlightHistorians,
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import { piTurnTwoDeps } from "./index";
import { __setPiHarnessKindForTesting } from "./pi-harness-kind";
import * as piHistorian from "./pi-historian-runner";
import { type PiHistorianDeps, runPiHistorian } from "./pi-historian-runner";
import { PI_RPC_CARRIER } from "./pi-historian-turn-two";
import {
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "./test-utils.test";

/** Enough history above a protected tail for the trigger to fire. */
const HISTORY = Array.from({ length: 24 }, (_, index) =>
	userMessage(`history ${index + 1} `.repeat(600), index + 1),
);
const ENTRY_IDS = HISTORY.map((_, index) => `entry-${index + 1}`);

const stubRunner = {
	harness: "pi",
	run: async () => ({
		ok: true,
		assistantText:
			'<compartment start="1" end="2" title="Rule change"><p1>Updated the rule.</p1></compartment>',
		durationMs: 1,
	}),
} as unknown as SubagentRunner;

function registerHandler(
	db: ReturnType<typeof createTestDb>,
	historian: Record<string, unknown>,
): ReturnType<typeof createFakePi> {
	const fake = createFakePi();
	registerPiContextHandler(fake.pi as never, {
		db,
		protectedTags: 0,
		injection: { injectionBudgetTokens: 10_000 },
		historian: {
			runner: stubRunner,
			model: "test/validation-historian",
			historianChunkTokens: 20_000,
			executeThresholdPercentage: 65,
			protectedTags: 0,
			...historian,
		},
	});
	return fake;
}

async function firePass(
	fake: ReturnType<typeof createFakePi>,
	sessionId: string,
): Promise<void> {
	const handler = fake.handlers.get("context") as (
		event: { messages: never[] },
		ctx: never,
	) => Promise<unknown>;
	const messages = structuredClone(HISTORY);
	await handler({ messages: messages as never[] }, {
		...fakeContext(sessionId, process.cwd(), ENTRY_IDS, messages),
		getContextUsage: () => ({
			tokens: 150_000,
			percent: 75,
			contextWindow: 200_000,
		}),
	} as never);
	await awaitInFlightHistorians(sessionId);
}

beforeEach(() => {
	__setPiHarnessKindForTesting("pi");
});

afterEach(() => {
	__setPiHarnessKindForTesting(undefined);
	closeDatabase();
});

describe("the Pi context handler hands the runner the switch", () => {
	for (const turnTwo of ["allowlist", "off"] as const) {
		it(`a historian configured with turn_two ${turnTwo} passes it through`, async () => {
			const db = createTestDb();
			const sessionId = `ses-pi-wiring-${turnTwo}`;
			const started: PiHistorianDeps[] = [];
			const spy = spyOn(piHistorian, "runPiHistorian").mockImplementation(
				async (deps: PiHistorianDeps) => {
					started.push(deps);
				},
			);
			try {
				const fake = registerHandler(db, { turnTwo });
				await firePass(fake, sessionId);
				expect(started).toHaveLength(1);
				expect(started[0]?.turnTwo).toBe(turnTwo);
				// The allowlist is loaded from the shipped file, and the test-only
				// row source stays unset on this host.
				expect(started[0]?.allowlist?.entries).toEqual([]);
				expect(started[0]?.validatedProfiles).toBeUndefined();
			} finally {
				spy.mockRestore();
				clearContextHandlerSession(sessionId);
				closeQuietly(db);
			}
		});
	}
});

describe("a Pi firing selects turn two from the allowlist alone", () => {
	it("the shipped empty allowlist keeps the run dormant", async () => {
		const db = createTestDb();
		const sessionId = "ses-pi-wiring-dormant";
		try {
			expect(acquireCompartmentLease(db, sessionId, "holder")).not.toBeNull();
			await runPiHistorian({
				db,
				sessionId,
				directory: process.cwd(),
				provider: { readMessages: () => [] as RawMessage[] },
				runner: stubRunner,
				historianModel: "test/validation-historian",
				historianChunkTokens: 20_000,
				historianContextLimit: 200_000,
				compartmentLeaseHolderId: "holder",
				ensureProjectRegistered: () => {},
				hasUI: true,
				allowlist: loadTurnTwoAllowlist(),
			});
			expect(getCompartments(db, sessionId)).toEqual([]);
		} finally {
			closeQuietly(db);
		}
	});

	it("only an entry naming the Pi lane and carrier selects it", () => {
		const db = createTestDb();
		try {
			const identity = {
				lane: "pi" as const,
				carrier: PI_RPC_CARRIER,
				provider: "test",
				modelId: "validation-historian",
				variant: null,
				temperature: null,
				thinkingLevel: null,
				historianSystemHash: "a".repeat(64),
				combinedSchemaHash: "b".repeat(64),
				historianToolHash: "c".repeat(64),
				checkSystemHashes: {
					disproof: "d".repeat(64),
					support: "e".repeat(64),
					"kept-clause": "f".repeat(64),
					compatibility: "0".repeat(64),
				},
				checkSchemaHash: "1".repeat(64),
				checkToolHash: "2".repeat(64),
			};
			const select = (
				entries: Array<typeof identity>,
				turnTwo: "allowlist" | "off" = "allowlist",
			) =>
				selectTurnOneExecution(db, {
					projectPath: resolveProjectIdentity(process.cwd()) ?? "git:pi-wiring",
					request: {
						requestedIdentity: identity,
					} as unknown as Parameters<
						typeof selectTurnOneExecution
					>[1]["request"],
					turnTwo,
					twoPass: false,
					canContinue: true,
					hasUI: true,
					allowlist: loadTurnTwoAllowlist({ version: 1, entries }),
				}).lane;
			expect(select([identity])).toBe("enabled");
			// `omp` never authorizes `pi`, and neither does another carrier literal.
			expect(select([{ ...identity, lane: "omp" }])).toBe("dormant");
			expect(
				select([{ ...identity, carrier: "hidden-completion" } as never]),
			).toBe("dormant");
			expect(select([])).toBe("dormant");
			expect(select([identity], "off")).toBe("dormant");
		} finally {
			closeQuietly(db);
		}
	});
});

describe("the Pi host re-reads the switch from its live reader while a reply is pending", () => {
	it("the builder its resolver uses follows a real reload", () => {
		const root = createTestTempDirFromPath(
			join(tmpdir(), "mc-pi-live-switch-"),
		);
		const previousConfigHome = process.env.XDG_CONFIG_HOME;
		try {
			process.env.XDG_CONFIG_HOME = root;
			const projectDir = join(root, "project");
			mkdirSync(projectDir, { recursive: true });
			const userDirectory = join(root, "cortexkit");
			mkdirSync(userDirectory, { recursive: true });
			const userFile = join(userDirectory, "magic-context.jsonc");
			const write = (turnTwo: "allowlist" | "off") =>
				writeFileSync(
					userFile,
					JSON.stringify({ historian: { turn_two: turnTwo } }),
				);
			write("allowlist");

			const boot = loadPiConfigDetailed({ cwd: projectDir }, false).config;
			const reader = new LiveConfigReader(
				projectDir,
				boot,
				() => loadPiConfigDetailed({ cwd: projectDir }, false).config,
				() => {},
			);
			reader.poll();
			// `piTurnTwoDeps` builds the exact option the per-pass resolver hands the
			// runner. Assert the dep itself, not just its effect.
			const deps = piTurnTwoDeps(boot, () => reader.poll().effective);
			expect(typeof deps.turnTwoIsEnabled).toBe("function");
			expect(deps.turnTwoIsEnabled?.()).toBe(true);
			write("off");
			expect(deps.turnTwoIsEnabled?.()).toBe(false);
		} finally {
			if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
			else process.env.XDG_CONFIG_HOME = previousConfigHome;
			rmSync(root, { recursive: true, force: true });
		}
	});
});
