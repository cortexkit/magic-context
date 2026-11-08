import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getPendingOps } from "@magic-context/core/features/magic-context/storage";
import { reclaimRidePermitted } from "@magic-context/core/hooks/magic-context/cache-busting-signals";
import { openCodeRideHarness } from "@magic-context/core/hooks/magic-context/deferred-ride-evidence.test";
import { __test } from "./context-handler";
import { rideHarness } from "./deferred-ride-evidence.test";

interface PassRecord {
	host: string;
	session: number;
	pass: number;
	action: string;
	percentage: number;
	hash: string;
	bust: number;
	pending: number;
	floor: number | null;
	fired: number | boolean;
}
const hash = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");

test("execute differential: 300 deterministic randomized passes per host", async () => {
	let seed = 0x715a73;
	const random = () => {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		return seed / 0x100000000;
	};
	const records: PassRecord[] = [];
	for (let pass = 0; pass < 900; pass++) {
		const existing = {
			hardFold: random() < 0.2,
			force: random() < 0.2,
			explicitFlush: random() < 0.2,
			publishedHistory: random() < 0.2,
			subagentExecute: random() < 0.2,
		};
		const signedThinkingHold = random() < 0.5;
		const firstRender = random() < 0.2;
		// An idle expiry never lifts the hold; drawing it keeps the later flags'
		// sequence unchanged.
		random();
		const gate = { signedThinkingHold, firstRender, emergency: random() < 0.2 };
		const baseAllowed =
			(existing.hardFold ||
				existing.force ||
				existing.explicitFlush ||
				existing.publishedHistory ||
				existing.subagentExecute) &&
			(!gate.signedThinkingHold || gate.firstRender || gate.emergency);
		expect(
			!baseAllowed ||
				reclaimRidePermitted(
					{ ...existing, executeReclaim: random() < 0.5 },
					gate,
				),
		).toBe(true);
	}
	seed = 0x715a73;
	for (const host of ["opencode", "opencode2", "pi"] as const) {
		for (let session = 0; session < 6; session++) {
			const scenario = session % 2 ? "small" : "floor";
			const oc =
				host === "pi" ? null : openCodeRideHarness(host, false, scenario);
			const pi = host === "pi" ? rideHarness(true, scenario) : null;
			const h = oc ?? pi;
			if (!h) throw new Error("Missing host harness");
			let piBusts = 0;
			const restore = __test.setPipelineResultObserverForTests((id, result) => {
				if (pi && id === h.id && result.bustedThisPass) piBusts++;
			});
			const count = () => (oc ? oc.rebuilds : piBusts);
			let publishNext = false;
			let previous: unknown;
			let sourceRevision = 0;
			let previousRevision = 0;
			let systemRevision = 0;
			const oldEnv = process.env.NODE_ENV;
			try {
				process.env.NODE_ENV = "production";
				previous = await h.pass(40);
				h.queue();
				if (pi) await pi.finishHistorian();
				for (let pass = 0; pass < 50; pass++) {
					let action = "wake-only";
					const event = random();
					if (event < 0.08) {
						h.appendTurn(true);
						sourceRevision++;
						action = "human";
					} else if (event < 0.16) {
						h.appendTurn(false);
						sourceRevision++;
						action = "wake";
					} else if (event < 0.24) {
						if (pi) pi.restart();
						else oc?.reopen();
						action = "restart";
					} else if (event < 0.31) {
						if (pi) pi.setSystemPrompt(`Fold system ${++systemRevision}`);
						else oc?.fold();
						action = "fold";
					}
					// Pin two above-threshold requests before random pressure crossings.
					const percentage =
						pass < 2
							? ([76, 79][pass] ?? 76)
							: ([40, 72, 76, 78, 82, 84][Math.floor(random() * 6)] ?? 40);
					if (publishNext && percentage >= 75 && oc) {
						oc.publish();
						publishNext = false;
						action += "+publication";
					}
					const before = count();
					const wire = await h.pass(percentage);
					const delta = count() - before;
					expect(delta).toBeLessThanOrEqual(1);
					// New host messages legitimately change a request. A defer with
					// the same input and no independent bust must replay exact bytes.
					if (
						percentage < 75 &&
						delta === 0 &&
						sourceRevision === previousRevision
					)
						expect(wire).toEqual(previous);
					if (pi) await pi.finishHistorian();
					else if (oc?.lastTrigger?.shouldFire) publishNext = true;
					const row = h.db
						.prepare(
							"SELECT trailing_blank_decisions FROM session_meta WHERE session_id=?",
						)
						.get(h.id) as { trailing_blank_decisions: string };
					const floor =
						JSON.parse(row.trailing_blank_decisions || "{}").executeReclaim
							?.floorOrdinal ?? null;
					records.push({
						host,
						session,
						pass,
						action,
						percentage,
						hash: hash(wire),
						bust: delta,
						pending: getPendingOps(h.db, h.id).length,
						floor,
						fired: pi
							? pi.historianRuns
							: (oc?.lastTrigger?.shouldFire ?? false),
					});
					previous = wire;
					previousRevision = sourceRevision;
				}
			} finally {
				if (pi) await pi.finishHistorian();
				if (oldEnv === undefined) delete process.env.NODE_ENV;
				else process.env.NODE_ENV = oldEnv;
				restore();
				h.close();
			}
		}
	}
	const output = process.env.MC_EXECUTE_DIFFERENTIAL_OUTPUT;
	if (output) {
		mkdirSync(dirname(output), { recursive: true });
		await Bun.write(output, JSON.stringify(records));
	}
	const baselinePath = process.env.MC_EXECUTE_DIFFERENTIAL_BASE;
	if (baselinePath) {
		const base: PassRecord[] = await Bun.file(baselinePath).json();
		expect(base).toHaveLength(records.length);
		const counts: Record<
			string,
			{
				base: number;
				head: number;
				newlyAllowed: number;
				replayDifferences: number;
			}
		> = {};
		let diverged = false;
		for (let i = 0; i < records.length; i++) {
			const head = records[i];
			const old = base[i];
			if (!head || !old) throw new Error("Mismatched differential records");
			expect([
				head.host,
				head.session,
				head.pass,
				head.percentage,
				head.action.replace("+publication", ""),
			]).toEqual([
				old.host,
				old.session,
				old.pass,
				old.percentage,
				old.action.replace("+publication", ""),
			]);
			const key = `${head.host}/${head.session}`;
			counts[key] ??= {
				base: 0,
				head: 0,
				newlyAllowed: 0,
				replayDifferences: 0,
			};
			const totals = counts[key];
			if (head.pass === 0) diverged = false;
			totals.base += old.bust;
			totals.head += head.bust;
			// Independent folds/flushes remain admitted even after histories diverge.
			if (old.bust && head.action === "fold") expect(head.bust).toBe(1);
			const allowed =
				head.percentage >= 75 &&
				(head.floor !== null ||
					head.fired !== old.fired ||
					(head.bust === 1 && old.bust === 0));
			if (allowed) {
				totals.newlyAllowed++;
				diverged = true;
			}
			if (head.hash !== old.hash) {
				expect(allowed || diverged).toBe(true);
				if (!allowed) totals.replayDifferences++;
			}
		}
		console.log(
			`EXECUTE_DIFFERENTIAL ${JSON.stringify({ passesPerHost: 300, seed: "0x715a73", baseStall: base.filter((p) => p.session === 0 && p.pass < 2), counts })}`,
		);
	} else
		console.log(
			`EXECUTE_DIFFERENTIAL sampled ${records.length} passes (300 per host), seed=0x715a73`,
		);
}, 600_000);
