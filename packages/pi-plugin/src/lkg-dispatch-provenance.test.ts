import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import {
	boundLkgCertificate,
	certifyDispatchedLkgSlot,
	createDbLkgPersistence,
	isPreparedUndispatchedLkgSlot,
	loadPersistedLkgSlot,
	preparedLkgDispatchReceipt,
	refuseUndispatchedLkgSlot,
	saveLkgSlotToDb,
} from "@magic-context/core/hooks/magic-context/lkg-persist";
import { replayLkg } from "@magic-context/core/hooks/magic-context/lkg-replay";
import {
	checkLkgDurability,
	readServedMarker,
	recordServedCapture,
	repairLkgDurability,
} from "@magic-context/core/hooks/magic-context/lkg-served-marker";
import {
	captureSlot,
	getSlot,
	resetLkgSlotsForTest,
} from "@magic-context/core/hooks/magic-context/lkg-slot";
import { Database } from "@magic-context/core/shared/sqlite";
import { createTestTempDir } from "../../plugin/src/shared/test-temp-dir";
import { assertPiRefusedDispatch } from "./__tests__/dispatch-probe";
import {
	clearPiContextReceipt,
	registerPiGuardedContext,
} from "./pi-context-refusal";
import { __setPiHarnessKindForTesting } from "./pi-harness-kind";
import { clearPiLkgSessionState, createPiLkgCoordinator } from "./pi-lkg";
import { createTestDb, fakeContext, userMessage } from "./test-utils.test";

const cleanups: Array<() => void> = [];
const databases: Database[] = [];
afterEach(() => {
	__setPiHarnessKindForTesting(undefined);
	clearPiContextReceipt("dispatch-provenance");
	clearPiLkgSessionState("dispatch-provenance");
	resetLkgSlotsForTest();
	for (const db of databases.splice(0)) db.close();
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture() {
	clearPiLkgSessionState("dispatch-provenance");
	resetLkgSlotsForTest();
	const { dir: root, cleanup } = createTestTempDir("lkg-dispatch-provenance-");
	cleanups.push(cleanup);
	const path = join(root, "context.db");
	const db = createTestDb(path);
	const sessionId = "dispatch-provenance";
	const coordinator = createPiLkgCoordinator(db);
	const raw = [userMessage("original input")];
	const begin = (via = coordinator, grown = false) =>
		via.beginPass({
			sessionId,
			messages: grown ? [...raw, userMessage("new turn", 2)] : raw,
			entryIds: grown ? ["entry-1", "entry-2"] : ["entry-1"],
			modelKey: null,
			providerKey: null,
		});
	const publish = (text = "saved request") => {
		const snapshot = begin();
		coordinator.captureAppliedPass({
			snapshot,
			outputMessages: [userMessage(text)],
			outputEntryIds: ["entry-1"],
			cacheBusting: false,
			publishServedNumbers: () => {},
		});
		return snapshot;
	};
	const restart = () => {
		db.close();
		clearPiLkgSessionState(sessionId);
		resetLkgSlotsForTest();
		const reader = new Database(path);
		databases.push(reader);
		return { reader, restarted: createPiLkgCoordinator(reader) };
	};
	return { db, sessionId, coordinator, begin, publish, restart };
}

const states = {
	missing: (db: Database) => db.exec("DELETE FROM lkg_served_markers"),
	replaced: (db: Database) =>
		recordServedCapture(db, "dispatch-provenance", true),
	unreadable: (db: Database) => db.exec("DROP TABLE lkg_served_markers"),
	"no id": (db: Database) =>
		db.exec("UPDATE lkg_slots SET served_capture_id = NULL"),
	"legacy NULL digest": (db: Database) =>
		db.exec("UPDATE lkg_served_markers SET served_digest = NULL"),
};

for (const [state, mutate] of Object.entries(states)) {
	test(`cold ${state} dispatch evidence restricts replay; bound twin admits it`, () => {
		for (const bound of [false, true]) {
			const f = fixture();
			const snapshot = f.publish();
			if (bound) f.coordinator.certifyDispatched(snapshot);
			else mutate(f.db);
			const { reader, restarted } = f.restart();
			const loaded = getSlot(f.sessionId);
			expect(loaded?.jsonPrefix).toContain("saved request");
			expect(loaded?.dispatchUnconfirmed === true).toBe(!bound);
			const grown = restarted.replay(f.begin(restarted, true));
			if (bound) expect(grown.ok).toBe(true);
			else
				expect(grown).toEqual({
					ok: false,
					reason: "lkg_dispatch_unconfirmed",
				});
			// OpenCode's shared replay entry point must enforce the same restriction.
			{
				const replay = replayLkg({
					sessionId: f.sessionId,
					messages: [],
					modelKey: null,
					providerKey: null,
					skipSeamValidation: true,
					entry: {
						entryInputIds: ["entry-1", "entry-2"],
						entryContentDigests: loaded?.inputContentDigests ?? [],
						anchorIndex: 0,
						pristineTail: [userMessage("new turn", 2)],
					},
				});
				if (bound) expect(replay.ok).toBe(true);
				else
					expect(replay).toEqual({
						ok: false,
						reason: "lkg_dispatch_unconfirmed",
					});
			}
			expect(restarted.replay(f.begin(restarted)).ok).toBe(true);
			if (state !== "unreadable") {
				// Copying a hydrated slot is not proof that this process dispatched its request.
				expect(loaded).toBeDefined();
				if (!loaded) throw new Error("cold capture did not hydrate");
				expect(
					captureSlot(f.sessionId, {
						...loaded,
						dispatchUnconfirmed: undefined,
						fullCoverage: true,
					}),
				).toBe(true);
				const changes = reader.prepare("SELECT total_changes() AS n").get();
				repairLkgDurability(reader, f.sessionId);
				expect(reader.prepare("SELECT total_changes() AS n").get()).toEqual(
					changes,
				);
			}
		}
	});
}

test("sent capture keeps its own bound evidence beside a newer pending marker", () => {
	const f = fixture();
	const sent = f.publish();
	f.coordinator.certifyDispatched(sent);
	recordServedCapture(f.db, f.sessionId, true);
	expect(readServedMarker(f.db, f.sessionId)?.servedCaptureId).toBe(2);
	expect(
		createDbLkgPersistence(f.db).load(f.sessionId)?.dispatchUnconfirmed,
	).toBeUndefined();
	expect(f.coordinator.replay(f.begin(f.coordinator, true)).ok).toBe(true);
	// A restarted coordinator has neither the original dispatch ticket nor
	// the overwritten marker certificate.
	const { restarted } = f.restart();
	expect(restarted.replay(f.begin(restarted, true))).toEqual({
		ok: false,
		reason: "lkg_dispatch_unconfirmed",
	});
});

test("dispatch ticket proves a sent capture even after another allocation", () => {
	const f = fixture();
	const sent = f.publish();
	recordServedCapture(f.db, f.sessionId, true);
	f.coordinator.certifyDispatched(sent);
	expect(boundLkgCertificate(f.db, f.sessionId)?.servedCaptureId).toBe(1);
	expect(
		createDbLkgPersistence(f.db).load(f.sessionId)?.dispatchUnconfirmed,
	).toBeUndefined();
	f.restart();
});

test("refusal after another allocation leaves its own bytes unconfirmed, never unrestricted", () => {
	const f = fixture();
	const refused = f.publish("never sent");
	recordServedCapture(f.db, f.sessionId, true);
	const marker = readServedMarker(f.db, f.sessionId);
	f.coordinator.refuseDispatch(refused);
	expect(readServedMarker(f.db, f.sessionId)).toEqual(marker);
	expect(loadPersistedLkgSlot(f.db, f.sessionId)?.jsonPrefix).toContain(
		"never sent",
	);
	const { restarted } = f.restart();
	expect(getSlot(f.sessionId)?.dispatchUnconfirmed).toBe(true);
	expect(restarted.replay(f.begin(restarted, true))).toEqual({
		ok: false,
		reason: "lkg_dispatch_unconfirmed",
	});
	expect(restarted.replay(f.begin(restarted)).ok).toBe(true);
});

test("allocation after refusal degrades to exact-input-only, never unrestricted", () => {
	const f = fixture();
	const refused = f.publish("never sent");
	f.coordinator.refuseDispatch(refused);
	expect(createDbLkgPersistence(f.db).load(f.sessionId)).toBeUndefined();
	recordServedCapture(f.db, f.sessionId, true);
	const { restarted } = f.restart();
	expect(getSlot(f.sessionId)?.dispatchUnconfirmed).toBe(true);
	expect(restarted.replay(f.begin(restarted, true))).toEqual({
		ok: false,
		reason: "lkg_dispatch_unconfirmed",
	});
	expect(restarted.replay(f.begin(restarted)).ok).toBe(true);
});

test("a newer publication cannot orphan an earlier dispatch or refusal ticket", () => {
	const f = fixture();
	const earlier = f.publish("earlier");
	const newer = f.publish("newer");
	f.coordinator.certifyDispatched(earlier);
	expect(boundLkgCertificate(f.db, f.sessionId)?.servedCaptureId).toBe(1);
	f.coordinator.refuseDispatch(earlier);
	expect(loadPersistedLkgSlot(f.db, f.sessionId)?.jsonPrefix).toContain(
		"newer",
	);
	f.coordinator.refuseDispatch(newer);
	expect(createDbLkgPersistence(f.db).load(f.sessionId)).toBeUndefined();
	f.restart();
});

// The provider-dispatch gate is live: losing a durable refusal is not permission
// to skip admission when the exact original input is retried after a restart.
test("OMP rechecks and refuses an exact replay after its refusal marker is replaced", async () => {
	__setPiHarnessKindForTesting("omp");
	const f = fixture();
	let aborts = 0;
	let refusedChecks = 0;
	const notices: string[] = [];
	const ctx = {
		...fakeContext(f.sessionId),
		isIdle: () => false,
		abort: () => aborts++,
	};
	const guarded = (
		coordinator: ReturnType<typeof createPiLkgCoordinator>,
		retry: boolean,
	) => {
		const handlers = new Map<
			string,
			(event: unknown, ctx: unknown) => unknown
		>();
		registerPiGuardedContext(
			{
				on: (
					name: string,
					handler: (event: unknown, ctx: unknown) => unknown,
				) => handlers.set(name, handler),
				appendEntry: (_type: string, data: { message: string }) =>
					notices.push(data.message),
			} as never,
			async (_event, _ctx, budget) => {
				const snapshot = retry ? f.begin(coordinator) : f.publish();
				const result = retry
					? coordinator.replay(snapshot)
					: {
							ok: true as const,
							messages: JSON.parse(getSlot(f.sessionId)?.jsonPrefix ?? "null"),
						};
				expect(result.ok).toBe(true);
				if (!result.ok) throw new Error(result.reason);
				budget.dispatchCertificate = {
					confirm: () => coordinator.certifyDispatched(snapshot),
					refuse: () => {
						refusedChecks++;
						coordinator.refuseDispatch(snapshot);
					},
				};
				return { messages: result.messages as never };
			},
		);
		return (name: string, event: unknown = {}) => {
			const handler = handlers.get(name);
			if (!handler) throw new Error(`missing ${name}`);
			return handler(event, ctx);
		};
	};
	const first = guarded(f.coordinator, false);
	first("agent_start");
	await first("context", { messages: [userMessage("original input")] });
	assertPiRefusedDispatch(
		first("before_provider_request", {
			payload: { messages: [userMessage("missing managed signature")] },
		}),
		"missing current receipt signature",
	);
	expect(notices).toHaveLength(1);
	expect(notices[0]).toContain("missing current receipt signature");
	expect(refusedChecks).toBe(1);
	expect(createDbLkgPersistence(f.db).load(f.sessionId)).toBeUndefined();
	recordServedCapture(f.db, f.sessionId, true);
	const { restarted } = f.restart();
	expect(getSlot(f.sessionId)?.dispatchUnconfirmed).toBe(true);
	expect(restarted.replay(f.begin(restarted, true))).toEqual({
		ok: false,
		reason: "lkg_dispatch_unconfirmed",
	});
	const retry = guarded(restarted, true);
	retry("agent_start");
	await retry("context", { messages: [userMessage("original input")] });
	assertPiRefusedDispatch(
		retry("before_provider_request", {
			payload: { messages: [userMessage("missing managed signature")] },
		}),
		"missing current receipt signature",
	);
	expect(refusedChecks).toBe(2);
	expect(aborts).toBe(0);
	expect(notices).toHaveLength(2);
	expect(notices[1]).toContain("missing current receipt signature");
});

test("a newer publication cannot orphan an earlier refusal ticket or roll back newer bytes", () => {
	const f = fixture();
	const earlier = f.publish("earlier");
	const newer = f.publish("newer");
	expect(isPreparedUndispatchedLkgSlot(f.db, f.sessionId, 1)).toBe(true);
	f.coordinator.refuseDispatch(earlier);
	expect(isPreparedUndispatchedLkgSlot(f.db, f.sessionId, 1)).toBe(false);
	expect(getSlot(f.sessionId)?.jsonPrefix).toContain("newer");
	expect(loadPersistedLkgSlot(f.db, f.sessionId)?.jsonPrefix).toContain(
		"newer",
	);
	f.coordinator.refuseDispatch(newer);
	expect(createDbLkgPersistence(f.db).load(f.sessionId)).toBeUndefined();
	f.restart();
});

test("an old ticket cannot settle or refuse a newer save that reused its numeric capture id", () => {
	for (const outcome of ["confirm", "refuse"] as const) {
		const f = fixture();
		const old = f.publish("older request");
		f.db.exec("DELETE FROM lkg_served_markers");
		const newer = f.publish("new request after marker cleanup");
		expect(readServedMarker(f.db, f.sessionId)?.servedCaptureId).toBe(1);
		if (outcome === "confirm") f.coordinator.certifyDispatched(old);
		else f.coordinator.refuseDispatch(old);
		expect(readServedMarker(f.db, f.sessionId)?.servedDigest).toBeNull();
		expect(isPreparedUndispatchedLkgSlot(f.db, f.sessionId, 1)).toBe(true);
		expect(loadPersistedLkgSlot(f.db, f.sessionId)?.jsonPrefix).toContain(
			"new request",
		);
		f.coordinator.certifyDispatched(newer);
		expect(
			createDbLkgPersistence(f.db).load(f.sessionId)?.dispatchUnconfirmed,
		).toBeUndefined();
		f.restart();
	}
});

test("a session's long deferred-save run certifies only retained dispatch receipts", () => {
	const f = fixture();
	const evicted: Array<{ id: number; receipt: object }> = [];
	let newest = f.publish("deferred request 0");
	for (let index = 0; index < 19; index++) {
		if (index > 0) newest = f.publish(`deferred request ${index}`);
		const id = getSlot(f.sessionId)?.servedCaptureId;
		const receipt = preparedLkgDispatchReceipt(f.db, f.sessionId, id);
		expect(id).toBe(index + 1);
		expect(receipt).toBeDefined();
		if (id === undefined || !receipt)
			throw new Error("deferred save has no receipt");
		if (index < 3) evicted.push({ id, receipt });
	}
	const newestId = getSlot(f.sessionId)?.servedCaptureId;
	const uncertified = {
		durable: true,
		servedCaptureId: null,
		certified: false,
	};
	expect(repairLkgDurability(f.db, f.sessionId)).toEqual(uncertified);
	for (const { id, receipt } of evicted) {
		expect(preparedLkgDispatchReceipt(f.db, f.sessionId, id)).toBeUndefined();
		expect(certifyDispatchedLkgSlot(f.db, f.sessionId, id, receipt)).toBe(
			false,
		);
		expect(refuseUndispatchedLkgSlot(f.db, f.sessionId, id, receipt)).toBe(
			false,
		);
		expect(boundLkgCertificate(f.db, f.sessionId)).toBeUndefined();
		expect(checkLkgDurability(f.db, f.sessionId)).toEqual(uncertified);
	}
	f.coordinator.certifyDispatched(newest);
	const certified = { durable: true, servedCaptureId: newestId };
	expect(checkLkgDurability(f.db, f.sessionId)).toEqual(certified);
	for (const { id, receipt } of evicted) {
		expect(certifyDispatchedLkgSlot(f.db, f.sessionId, id, receipt)).toBe(
			false,
		);
		expect(refuseUndispatchedLkgSlot(f.db, f.sessionId, id, receipt)).toBe(
			false,
		);
		expect(boundLkgCertificate(f.db, f.sessionId)?.servedCaptureId).toBe(
			newestId,
		);
		expect(repairLkgDurability(f.db, f.sessionId)).toEqual(certified);
	}
	const { restarted } = f.restart();
	expect(getSlot(f.sessionId)?.jsonPrefix).toContain("deferred request 18");
	expect(getSlot(f.sessionId)?.dispatchUnconfirmed).toBeUndefined();
	expect(restarted.replay(f.begin(restarted, true)).ok).toBe(true);
});

test("the prepared session limit refuses a new save without evicting outstanding receipts", () => {
	const f = fixture();
	const first = f.publish();
	const pending = getSlot(f.sessionId);
	if (!pending) throw new Error("pending capture was not installed");
	for (let index = 0; index < 999; index++) {
		const sessionId = `prepared-capacity-${index}`;
		const servedCaptureId = recordServedCapture(f.db, sessionId, true);
		expect(servedCaptureId).toBeDefined();
		expect(
			saveLkgSlotToDb(
				f.db,
				sessionId,
				{ ...pending, servedCaptureId },
				{
					deferCertificate: true,
				},
			),
		).toBe(true);
	}
	const overflow = "prepared-capacity-overflow";
	const servedCaptureId = recordServedCapture(f.db, overflow, true);
	expect(servedCaptureId).toBeDefined();
	const saveOverflow = () =>
		saveLkgSlotToDb(
			f.db,
			overflow,
			{ ...pending, servedCaptureId },
			{
				deferCertificate: true,
			},
		);
	expect(saveOverflow()).toBe(false);
	expect(loadPersistedLkgSlot(f.db, overflow)).toBeUndefined();
	expect(
		f.db
			.prepare("SELECT count(*) AS n FROM lkg_slot_chunks WHERE session_id = ?")
			.get(overflow),
	).toEqual({ n: 0 });
	expect(
		isPreparedUndispatchedLkgSlot(f.db, f.sessionId, pending.servedCaptureId),
	).toBe(true);
	expect(repairLkgDurability(f.db, f.sessionId)).toEqual({
		durable: true,
		servedCaptureId: null,
		certified: false,
	});
	f.coordinator.certifyDispatched(first);
	expect(checkLkgDurability(f.db, f.sessionId)).toEqual({
		durable: true,
		servedCaptureId: pending.servedCaptureId,
	});
	expect(saveOverflow()).toBe(true);
	f.restart();
});
