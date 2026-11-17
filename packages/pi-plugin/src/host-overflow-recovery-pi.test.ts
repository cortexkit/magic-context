import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { detectOverflow } from "@magic-context/core/features/magic-context/overflow-detection";
import {
	getOverflowState,
	isProviderOverflowReconfirmed,
	resetEmergencyRecoveryRegistryForTest,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import {
	__setPiHostOverflowModuleLoaderForTests,
	loadPiHostOverflowCheck,
} from "./host-overflow-check-pi";
import { handlePiSessionBeforeCompact } from "./index";
import { handlePiProviderFailure } from "./provider-error-recovery-pi";
import { createTestDb } from "./test-utils.test";

const databases: ReturnType<typeof createTestDb>[] = [];

afterEach(() => {
	for (const db of databases.splice(0)) closeQuietly(db);
	resetEmergencyRecoveryRegistryForTest();
	__setPiHostOverflowModuleLoaderForTests(undefined);
});

function db() {
	const value = createTestDb();
	databases.push(value);
	return value;
}

function failedReply(errorMessage: string) {
	return {
		role: "assistant",
		stopReason: "error",
		errorMessage,
		provider: "google",
		model: "gemini-3.8-flash",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

// Errors Pi's own check calls an overflow and Magic Context's patterns do not
// (seen in issue 938).
const HOST_ONLY_OVERFLOWS = [
	'413 {"error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}',
	"413 status code (no body)",
	"Token limit exceeded",
];
const BOTH_OVERFLOW = "prompt is too long: 213462 tokens > 200000 maximum";

describe("provider-overflow recovery from the host's overflow check", () => {
	it("arms recovery for an overflow only the host's check recognises", async () => {
		const hostCheck = await loadPiHostOverflowCheck();
		expect(hostCheck).toBeDefined();
		for (const [index, errorMessage] of HOST_ONLY_OVERFLOWS.entries()) {
			expect(detectOverflow(errorMessage).isOverflow).toBe(false);
			const database = db();
			const sessionId = `host-only-overflow-${index}`;
			const result = handlePiProviderFailure({
				db: database,
				sessionId,
				message: failedReply(errorMessage),
				hostOverflowCheck: hostCheck,
			});
			expect(result).toMatchObject({ kind: "overflow", source: "host" });
			const state = getOverflowState(database, sessionId);
			expect(state.needsEmergencyRecovery).toBe(true);
			expect(state.emergencyRecoveryOrigin).toBe("provider_overflow");
		}
	});

	it("keeps Magic Context's own match and its reported limit when both recognise it", async () => {
		const database = db();
		const result = handlePiProviderFailure({
			db: database,
			sessionId: "both-overflow",
			message: failedReply(BOTH_OVERFLOW),
			hostOverflowCheck: await loadPiHostOverflowCheck(),
		});
		expect(result).toMatchObject({
			kind: "overflow",
			source: "magic-context",
			reportedLimit: 200000,
		});
	});

	it("arms nothing for an error neither check calls an overflow", async () => {
		const database = db();
		for (const [index, errorMessage] of [
			"429 rate limit exceeded",
			"503 Service Unavailable",
			"System operation aborted",
		].entries()) {
			const sessionId = `not-overflow-${index}`;
			expect(
				handlePiProviderFailure({
					db: database,
					sessionId,
					message: failedReply(errorMessage),
					hostOverflowCheck: await loadPiHostOverflowCheck(),
				}),
			).toEqual({ kind: "none" });
			expect(getOverflowState(database, sessionId).needsEmergencyRecovery).toBe(
				false,
			);
		}
	});

	for (const [name, loader] of [
		[
			"the host module does not load",
			async () => {
				throw new Error("Cannot find module '@earendil-works/pi-ai'");
			},
		],
		["the host module has no isContextOverflow export", async () => ({})],
	] as const) {
		it(`falls back to Magic Context's patterns when ${name}`, async () => {
			__setPiHostOverflowModuleLoaderForTests(loader);
			const hostCheck = await loadPiHostOverflowCheck();
			expect(hostCheck).toBeUndefined();
			const database = db();
			expect(
				handlePiProviderFailure({
					db: database,
					sessionId: "fallback-matches",
					message: failedReply(BOTH_OVERFLOW),
					hostOverflowCheck: hostCheck,
				}),
			).toMatchObject({ kind: "overflow", source: "magic-context" });
			expect(
				getOverflowState(database, "fallback-matches").needsEmergencyRecovery,
			).toBe(true);
			expect(
				handlePiProviderFailure({
					db: database,
					sessionId: "fallback-host-only",
					message: failedReply(HOST_ONLY_OVERFLOWS[1] as string),
					hostOverflowCheck: hostCheck,
				}),
			).toEqual({ kind: "none" });
			expect(
				getOverflowState(database, "fallback-host-only").needsEmergencyRecovery,
			).toBe(false);
		});
	}

	it("treats a host check that throws as no overflow", async () => {
		__setPiHostOverflowModuleLoaderForTests(async () => ({
			isContextOverflow: () => {
				throw new Error("unexpected message shape");
			},
		}));
		const hostCheck = await loadPiHostOverflowCheck();
		expect(hostCheck?.(failedReply("413 status code (no body)"))).toBe(false);
	});

	it("imports the host module once", async () => {
		let imports = 0;
		__setPiHostOverflowModuleLoaderForTests(async () => {
			imports += 1;
			return { isContextOverflow: () => true };
		});
		await Promise.all([loadPiHostOverflowCheck(), loadPiHostOverflowCheck()]);
		await loadPiHostOverflowCheck();
		expect(imports).toBe(1);
	});
});

describe("provider-overflow recovery from Pi's overflow compaction", () => {
	const ctx = (sessionId: string) => ({
		sessionManager: { getSessionId: () => sessionId },
		model: { provider: "google", id: "gemini-3.8-flash" },
	});

	it("cancels Pi's overflow compaction and arms recovery", async () => {
		const database = db();
		expect(
			await handlePiSessionBeforeCompact({
				db: database,
				compactionOff: false,
				ctx: ctx("compact-overflow"),
				event: { reason: "overflow" },
			}),
		).toEqual({ cancel: true });
		const state = getOverflowState(database, "compact-overflow");
		expect(state.needsEmergencyRecovery).toBe(true);
		expect(state.emergencyRecoveryOrigin).toBe("provider_overflow");
	});

	it("cancels a threshold, manual or reasonless compaction without arming", async () => {
		const database = db();
		// Oh My Pi's event carries no reason at all.
		for (const event of [
			{ reason: "threshold" },
			{ reason: "manual" },
			{},
			undefined,
		]) {
			const sessionId = `compact-${event?.reason ?? "no-reason"}-${event ? "event" : "none"}`;
			expect(
				await handlePiSessionBeforeCompact({
					db: database,
					compactionOff: false,
					ctx: ctx(sessionId),
					event,
				}),
			).toEqual({ cancel: true });
			expect(getOverflowState(database, sessionId).needsEmergencyRecovery).toBe(
				false,
			);
		}
	});

	it("leaves recovery that message_end already armed for the same failure as it is", async () => {
		const database = db();
		const sessionId = "compact-after-message-end";
		handlePiProviderFailure({
			db: database,
			sessionId,
			message: failedReply(HOST_ONLY_OVERFLOWS[0] as string),
			hostOverflowCheck: await loadPiHostOverflowCheck(),
		});
		expect(getOverflowState(database, sessionId).needsEmergencyRecovery).toBe(
			true,
		);
		await handlePiSessionBeforeCompact({
			db: database,
			compactionOff: false,
			ctx: ctx(sessionId),
			event: { reason: "overflow" },
		});
		// A second arm would read as a second provider rejection.
		expect(isProviderOverflowReconfirmed(sessionId)).toBe(false);
	});

	it("arms nothing when native compaction owns the session", async () => {
		const database = db();
		expect(
			await handlePiSessionBeforeCompact({
				db: database,
				compactionOff: true,
				ctx: ctx("compact-off-overflow"),
				event: { reason: "overflow" },
			}),
		).toBeUndefined();
		expect(
			getOverflowState(database, "compact-off-overflow").needsEmergencyRecovery,
		).toBe(false);
	});
});

describe("the host overflow check is the host's, not a bundled copy", () => {
	const packageJson = JSON.parse(
		readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"),
	) as { scripts: Record<string, string> };
	const step = packageJson.scripts.build
		?.split("&&")
		.map((part) => part.trim())
		.find((part) => part.startsWith("bun build src/index.ts"));
	const externals = [...(step ?? "").matchAll(/--external\s+(\S+)/g)].map(
		(match) => match[1] as string,
	);

	it("keeps the pi-ai import external in the extension build", async () => {
		expect(externals).toContain("@earendil-works/pi-coding-agent");
		expect(externals).toContain("@earendil-works/pi-ai");
		const built = await Bun.build({
			entrypoints: [join(import.meta.dir, "host-overflow-check-pi.ts")],
			target: "node",
			format: "esm",
			external: externals,
		});
		expect(built.success).toBe(true);
		const code = (
			await Promise.all(built.outputs.map((output) => output.text()))
		).join("\n");
		// A literal specifier: Oh My Pi rewrites only literal imports to its shim.
		expect(code).toMatch(/import\(\s*["']@earendil-works\/pi-ai["']\s*\)/);
		// pi-ai's own overflow patterns stay out of the bundle.
		expect(code).not.toContain("request_too_large");
	});
});
