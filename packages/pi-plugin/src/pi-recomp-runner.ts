import {
	type RawMessageProvider,
	setRawMessageProvider,
} from "@magic-context/core/hooks/magic-context/read-session-chunk";
import { sessionLog } from "@magic-context/core/shared/logger";
import { setMagicContextRecompActive } from "./status-line";

/**
 * In-flight detached recomp / upgrade runs, keyed by session, so the
 * `session_shutdown` handler can await only that session's work — mirrors
 * `inFlightHistorian` in context-handler.ts.
 *
 * Why detached: Pi's command handler IS the REPL turn (single process). Awaiting
 * a multi-pass recomp inline froze ALL input — new prompts and even /ctx-status —
 * until it finished (dogfood 2026-06-01: a 1105-message upgrade locked the REPL
 * across several ~4-min historian passes). OpenCode runs recomp/upgrade as
 * `void runManagedRecomp(...)` in its separate server process; Pi must do the
 * equivalent fire-and-forget so the REPL stays responsive while the historian
 * passes run in the background — the same pattern as `spawnPiHistorianRun`.
 */
const inFlightRecomp = new Map<string, Promise<unknown>>();

/** True when a detached recomp/upgrade is already running for this session. */
export function isPiRecompInFlight(sessionId: string): boolean {
	return inFlightRecomp.has(sessionId);
}

/**
 * Await one session's in-flight recomp/upgrade run. Called from
 * `session_shutdown` (bounded by a timeout there) so a background recomp can
 * finish publishing before Pi tears that session down. Omitting the session id
 * waits for all runs and remains available for process-exit callers and tests.
 */
export async function awaitInFlightRecomps(sessionId?: string): Promise<void> {
	const runs = sessionId
		? [inFlightRecomp.get(sessionId)].filter(
				(run): run is Promise<unknown> => run !== undefined,
			)
		: [...inFlightRecomp.values()];
	if (runs.length === 0) return;
	await Promise.allSettled(runs);
}

/**
 * Run a recomp/upgrade body detached from the command handler.
 *
 * Registers the raw-message provider + the `recomp` status-line flag for the
 * run's lifetime, tracks the promise for shutdown drain, and cleans everything
 * up on settle. The command handler returns immediately after calling this, so
 * the Pi REPL stays responsive. `work()` owns all command-specific logic
 * (the recomp call, the published gate, marker staging, migration, and the
 * status messages it sends) and must not throw uncaught — failures are logged.
 *
 * The provider unregister is closure-guarded (setRawMessageProvider only deletes
 * if the slot still holds THIS provider), so a concurrent user turn that
 * re-registers its own provider for the same session is not clobbered on
 * cleanup.
 */
export function spawnPiRecompRun(args: {
	sessionId: string;
	provider: RawMessageProvider;
	onStatusChange: () => void;
	work: () => Promise<void>;
}): void {
	const { sessionId, provider, onStatusChange, work } = args;
	const unregister = setRawMessageProvider(sessionId, provider);
	setMagicContextRecompActive(sessionId, true);
	onStatusChange();
	const runPromise = (async () => {
		try {
			await work();
		} catch (err) {
			sessionLog(
				sessionId,
				`pi recomp run failed (detached): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	})().finally(() => {
		inFlightRecomp.delete(sessionId);
		setMagicContextRecompActive(sessionId, false);
		unregister();
		onStatusChange();
	});
	inFlightRecomp.set(sessionId, runPromise);
}
