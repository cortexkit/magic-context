import { expect, spyOn, test } from "bun:test";
import { getCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { getPendingOps } from "@magic-context/core/features/magic-context/storage";
import { readExecuteReclaimState } from "@magic-context/core/hooks/magic-context/execute-reclaim";
import * as boundaryModule from "@magic-context/core/hooks/magic-context/protected-tail-boundary";
import * as loggerModule from "@magic-context/core/shared/logger";
import { __test } from "./context-handler";
import { rideHarness } from "./deferred-ride-evidence.test";

test("pi floor stall marks, holds, fires next pass and drains in one publication rebuild", async () => {
	const h = rideHarness(true, "floor");
	let rebuilds = 0;
	const restore = __test.setPipelineResultObserverForTests((id, result) => {
		if (id === h.id && result.bustedThisPass) rebuilds++;
	});
	const originalEnv = process.env.NODE_ENV;
	try {
		process.env.NODE_ENV = "production";
		const warm = await h.pass(40);
		const initialBusts = rebuilds;
		h.queue();
		expect(await h.pass(76)).toEqual(warm);
		expect(readExecuteReclaimState(h.db, h.id).floorPromptId).toBe("entry-2");
		expect(h.historianRuns).toBe(0);
		expect(getPendingOps(h.db, h.id)).toHaveLength(1);
		expect(await h.pass(77)).toEqual(warm);
		expect(readExecuteReclaimState(h.db, h.id).floorOrdinal).toBeNull();
		expect(rebuilds).toBe(initialBusts);
		await h.finishHistorian();
		expect(h.historianRuns).toBeGreaterThan(0);
		const published = await h.pass(79);
		expect(published).not.toEqual(warm);
		expect(getPendingOps(h.db, h.id)).toHaveLength(0);
		expect(rebuilds - initialBusts).toBe(1);
		expect(await h.pass(40)).toEqual(published);
	} finally {
		await h.finishHistorian();
		if (originalEnv === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = originalEnv;
		restore();
		h.close();
	}
});

for (const lifted of [true, false]) {
	test(`pi stale-snapshot refresh ${lifted ? "keeps the trigger's floor lift and publishes" : "of an unlifted snapshot still clamps at the live prompt"}`, async () => {
		const h = rideHarness(true, "floor");
		const logSpy = spyOn(loggerModule, "sessionLog");
		const validate = boundaryModule.validateBoundarySnapshot;
		// The trigger's snapshot (mode "trigger") fails validation as stale, as
		// when the session's messages change between the fire and the detached
		// run's check. Every other validation runs unchanged.
		const validateSpy = spyOn(
			boundaryModule,
			"validateBoundarySnapshot",
		).mockImplementation((args) => {
			if (args.snapshot.mode !== "trigger") return validate(args);
			if (!lifted) args.snapshot.liftLivePromptFloor = undefined;
			return {
				ok: false,
				reason: "stale_snapshot",
				detail: "raw range fingerprint changed",
			};
		});
		const originalEnv = process.env.NODE_ENV;
		try {
			process.env.NODE_ENV = "production";
			await h.pass(40);
			await h.pass(76);
			expect(readExecuteReclaimState(h.db, h.id).floorPromptId).toBe("entry-2");
			await h.pass(77);
			expect(readExecuteReclaimState(h.db, h.id).floorOrdinal).toBeNull();
			await h.finishHistorian();
			expect(
				validateSpy.mock.calls.some(
					([args]) =>
						args.snapshot.mode === "trigger" &&
						(!lifted || args.snapshot.liftLivePromptFloor === true),
				),
			).toBe(true);
			const lines = logSpy.mock.calls
				.filter(([sessionId]) => sessionId === h.id)
				.map((call) => call.slice(1).join(" "));
			const refreshed = lines.some((line) =>
				line.includes(
					"historian: refreshed stale protected-tail snapshot at run time",
				),
			);
			const noop = lines.some((line) =>
				line.includes(
					"historian no-op: stale protected-tail snapshot (raw range fingerprint changed)",
				),
			);
			const compartments = getCompartments(h.db, h.id);
			if (lifted) {
				expect(refreshed).toBe(true);
				expect(noop).toBe(false);
				expect(h.historianRuns).toBeGreaterThan(0);
				expect(compartments).toHaveLength(2);
				expect(compartments[1]?.startMessage).toBe(3);
			} else {
				expect(refreshed).toBe(false);
				expect(noop).toBe(true);
				expect(h.historianRuns).toBe(0);
				expect(compartments).toHaveLength(1);
			}
		} finally {
			await h.finishHistorian();
			if (originalEnv === undefined) delete process.env.NODE_ENV;
			else process.env.NODE_ENV = originalEnv;
			validateSpy.mockRestore();
			logSpy.mockRestore();
			h.close();
		}
	});
}

test("pi worth bound holds tiny queue twice then reclaims once without a historian", async () => {
	const h = rideHarness(true, "small");
	let rebuilds = 0;
	const restore = __test.setPipelineResultObserverForTests((id, result) => {
		if (id === h.id && result.bustedThisPass) rebuilds++;
	});
	try {
		const warm = await h.pass(40);
		const initialBusts = rebuilds;
		h.queue();
		expect(await h.pass(76)).toEqual(warm);
		expect(await h.pass(77)).toEqual(warm);
		expect(readExecuteReclaimState(h.db, h.id).heldPasses).toBe(2);
		const reclaimed = await h.pass(79);
		expect(reclaimed).not.toEqual(warm);
		expect(getPendingOps(h.db, h.id)).toHaveLength(0);
		expect(rebuilds - initialBusts).toBe(1);
		expect(await h.pass(78)).toEqual(reclaimed);
		expect(rebuilds - initialBusts).toBe(1);
	} finally {
		restore();
		h.close();
	}
});
