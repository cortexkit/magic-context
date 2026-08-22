import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withContentLanguageDirective } from "@magic-context/core/agents/language-directive";
import { getCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { isMemoryMigrationDone } from "@magic-context/core/features/magic-context/memory/memory-migration";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { isWrapupInProgress } from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { COMPARTMENT_STRUCTURAL_SYSTEM_PROMPT } from "@magic-context/core/hooks/magic-context/compartment-prompt";
import { executeContextRecompWithResult } from "@magic-context/core/hooks/magic-context/compartment-runner";
import type { RawMessageProvider } from "@magic-context/core/hooks/magic-context/read-session-chunk";
import {
	contextualizeUpgradeReason,
	extractRecompReason,
	isRecompComplete,
	isRecompFailure,
} from "@magic-context/core/hooks/magic-context/recomp-orchestrator";
import { describeError } from "@magic-context/core/shared/error-message";
import { sessionLog } from "@magic-context/core/shared/logger";
import type { ModelInput } from "@magic-context/core/shared/model-resolution";
import type { SubagentRunner } from "@magic-context/core/shared/subagent-runner";
import { COMPACTION_OFF_COMMAND_UNAVAILABLE } from "../compaction-off-pi";
import {
	signalPiDeferredHistoryRefresh,
	signalPiDeferredMaterialization,
} from "../context-handler";
import { ensureProjectRegisteredFromPiDirectory } from "../embedding-bootstrap";
import { runPiMemoryMigration } from "../pi-memory-migration";
import { createPiHistorianClient } from "../pi-recomp-client-shared";
import { stagePiRecompMarker } from "../pi-recomp-marker";
import { isPiRecompInFlight, spawnPiRecompRun } from "../pi-recomp-runner";
import { readPiSessionSnapshot } from "../read-session-pi";
import { updateStatusLine } from "../status-line";
import { createCtxStatusSender, resolveSessionId } from "./pi-command-utils";

export interface CtxSessionUpgradeRuntimeDeps {
	db: ContextDatabase;
	runner: SubagentRunner;
	historianModel: string | undefined;
	historianChunkTokens: number;
	historianFallbacks?: readonly ModelInput[];
	historianTimeoutMs?: number;
	historianThinkingLevel?: string;
	language?: string;
	memoryEnabled: boolean;
	/** Allow a session started exactly in the canonical home directory only when user-level configuration enables it. */
	allowHomeProject?: boolean;
	autoPromote: boolean;
	userMemoriesEnabled?: boolean;
	compactionOff?: boolean;
}

export interface RegisterCtxSessionUpgradeDeps
	extends CtxSessionUpgradeRuntimeDeps {
	resolveRuntimeDeps?: (ctx: { cwd: string }) => CtxSessionUpgradeRuntimeDeps;
}

/**
 * /ctx-session-upgrade (E6b/E6c parity with OpenCode E3.1/E3.2).
 *
 * Upgrades THIS Pi session to the v2 history format:
 *   1. Full recomp — rebuilds every legacy v1 compartment into the v2 tiered
 *      shape (recomp emits NO facts, so curated memories are untouched here).
 *   2. Memory migration — re-evaluates the project's memories into the v2
 *      5-category taxonomy (once per project, idempotent).
 *
 * Session-scoped recomp + project-scoped (once-per-project) migration. Uses the
 * historian model/runner, so it works even when the dreamer is disabled.
 */
export function registerCtxSessionUpgradeCommand(
	pi: ExtensionAPI,
	deps: RegisterCtxSessionUpgradeDeps,
): void {
	pi.registerCommand("ctx-session-upgrade", {
		description:
			"Upgrade this session to the current Magic Context history format and re-organize project memories",
		handler: async (_args, ctx) => {
			const sendStatus = createCtxStatusSender(pi, ctx);
			const sessionId = resolveSessionId(ctx);
			if (!sessionId) {
				sendStatus({
					title: "/ctx-session-upgrade",
					text: "## Session Upgrade\n\nNo active Pi session is available.",
					level: "error",
				});
				return;
			}
			const currentDeps = deps.resolveRuntimeDeps?.(ctx) ?? deps;
			if (currentDeps.compactionOff) {
				sendStatus({
					title: "/ctx-session-upgrade",
					text: COMPACTION_OFF_COMMAND_UNAVAILABLE,
					level: "warning",
				});
				return;
			}
			if (!currentDeps.historianModel) {
				sendStatus({
					title: "/ctx-session-upgrade",
					text: "## Session Upgrade\n\nUnavailable because `historian.model` is not configured.",
					level: "error",
				});
				return;
			}

			if (isWrapupInProgress(currentDeps.db, sessionId)) {
				sendStatus({
					title: "/ctx-session-upgrade",
					text: "## Session Upgrade\n\n/ctx-wrapup is already compacting this session. Wait for it to finish, then try again.",
					level: "warning",
				});
				return;
			}

			if (isPiRecompInFlight(sessionId)) {
				sendStatus({
					title: "/ctx-session-upgrade",
					text: "## Session Upgrade\n\nAn upgrade or recomp is already running for this session in the background. Wait for it to finish, then try again.",
					level: "warning",
				});
				return;
			}

			// "Upgradable" = lacks usable v2 tiers: a pre-v2 `legacy=1` row OR a
			// malformed `legacy=0` row with no `p1` (interrupted recomp / older
			// partial-v2 build). Matching ONLY `legacy=1` would trap a session
			// whose rows are tierless-but-not-flagged-legacy (parity with
			// OpenCode runManagedUpgrade; dogfood 2026-05-30 AFT).
			const compartments = getCompartments(currentDeps.db, sessionId);
			const upgradableCount = compartments.filter(
				(c) => c.legacy === 1 || !c.p1 || c.p1.trim() === "",
			).length;

			// The session main model leads the migration chain (parity with
			// OpenCode's primaryModelId): a quality-sensitive consolidation should
			// run on the user's working model, not the (possibly misconfigured)
			// historian model. Historian model + fallbacks remain the safety net.
			const cwd = ctx.cwd;
			const sessionMainModel = ctx.model
				? `${ctx.model.provider}/${ctx.model.id}`
				: undefined;

			// Migration runs only when memory is enabled — parity with OpenCode,
			// whose orchestrator gates on `runMigration = memory.enabled !== false
			// && historian.model` (recomp-orchestrator drives migration off that
			// flag, NOT unconditionally). With memory disabled there is no memory
			// pool to re-organize, so re-categorizing would be a no-op at best and
			// could touch a pool the user opted out of at worst.
			const migrationEnabled = currentDeps.memoryEnabled;

			const runMigration = async (signal: AbortSignal): Promise<string> => {
				if (!migrationEnabled) {
					return "Memory migration skipped (memory disabled).";
				}
				// runPiMemoryMigration further self-gates via its own
				// once-per-project / empty-pool / USER_* guards.
				try {
					const outcome = await runPiMemoryMigration({
						db: currentDeps.db,
						runner: currentDeps.runner,
						primaryModel: sessionMainModel,
						model: currentDeps.historianModel as string,
						fallbackModels: currentDeps.historianFallbacks,
						timeoutMs: currentDeps.historianTimeoutMs,
						thinkingLevel: currentDeps.historianThinkingLevel,
						directory: cwd,
						allowHomeProject: currentDeps.allowHomeProject,
						sessionId,
						userMemoriesEnabled: currentDeps.userMemoriesEnabled,
						language: currentDeps.language,
						signal,
					});
					return outcome.summary;
				} catch (error) {
					if (signal.aborted) return "Memory migration cancelled.";
					return `Memory migration skipped (error): ${describeError(error).brief}`;
				}
			};

			// ── Guard: already-upgraded session (parity with OpenCode) ──────────
			// No upgradable compartments → don't run a wasteful/risky full recomp.
			//   • none + migration already done → no-op "already upgraded"
			//   • none + migration still pending → migration only (skip recomp)
			if (upgradableCount === 0) {
				const projectPath = resolveProjectIdentityForSession(
					cwd,
					currentDeps.allowHomeProject,
				);
				if (!projectPath) return;
				// migrationPending mirrors OpenCode: only pending when memory is
				// enabled AND the project hasn't been migrated yet.
				const migrationPending =
					migrationEnabled &&
					!isMemoryMigrationDone(currentDeps.db, projectPath);
				if (!migrationPending) {
					sendStatus({
						title: "/ctx-session-upgrade",
						text: [
							"## Session Upgrade — Already Up To Date",
							"",
							compartments.length === 0
								? "This session has no compartment history to upgrade yet."
								: "This session's compartments are already in the current format.",
						].join("\n"),
						level: "info",
						rpcDisplay: "dialog",
					});
					return;
				}
				// Compartments current but project memories never migrated — run
				// migration only. Detached so the single migration LLM call doesn't
				// block the Pi REPL either (parity with the full-recomp path below).
				sendStatus({
					title: "/ctx-session-upgrade",
					text: "## Session Upgrade\n\nCompartments are already current. Re-organizing project memories. This may take a while.",
					level: "info",
				});
				const snapshot = readPiSessionSnapshot(ctx);
				spawnPiRecompRun({
					sessionId,
					provider: {
						readMessages: () => snapshot.rawMessages,
					} satisfies RawMessageProvider,
					onStatusChange: () =>
						updateStatusLine(ctx, {
							db: currentDeps.db,
							projectIdentity: cwd,
						}),
					work: async (signal) => {
						const detachedSendStatus = createCtxStatusSender(pi, ctx, signal);
						const summary = await runMigration(signal);
						if (signal.aborted) return;
						detachedSendStatus({
							title: "/ctx-session-upgrade",
							text: ["## Session Upgrade — Complete", "", summary].join("\n"),
							level: "info",
							rpcDisplay: "dialog",
						});
					},
				});
				return;
			}

			sendStatus({
				title: "/ctx-session-upgrade",
				text: "## Session Upgrade\n\nRebuilding compartments into the v2 format and re-organizing project memories. This may take a while.",
				level: "info",
			});

			const snapshot = readPiSessionSnapshot(ctx);
			const provider = {
				readMessages: () => snapshot.rawMessages,
			} satisfies RawMessageProvider;

			// Detached: the upgrade (multi-pass recomp + memory migration) runs in
			// the background so the Pi REPL stays responsive (parity with OpenCode's
			// `void runManagedUpgrade`). The command handler returns right after the
			// "Rebuilding…" ack above. Provider registration, the `recomp`
			// status-line flag, shutdown-drain tracking, and cleanup are owned by
			// spawnPiRecompRun.
			spawnPiRecompRun({
				sessionId,
				provider,
				onStatusChange: () =>
					updateStatusLine(ctx, {
						db: currentDeps.db,
						projectIdentity: cwd,
					}),
				work: async (signal) => {
					const detachedSendStatus = createCtxStatusSender(pi, ctx, signal);
					// Step 1 — compartment upgrade via full recomp.
					const recompResult = await executeContextRecompWithResult(
						{
							client: createPiHistorianClient({
								runner: currentDeps.runner,
								model: currentDeps.historianModel as string,
								fallbackModels: currentDeps.historianFallbacks,
								timeoutMs: currentDeps.historianTimeoutMs,
								thinkingLevel: currentDeps.historianThinkingLevel,
								directory: cwd,
								accountingSessionId: sessionId,
								signal,
								systemPrompt: withContentLanguageDirective(
									COMPARTMENT_STRUCTURAL_SYSTEM_PROMPT,
									currentDeps.language,
									{ preserveUserQuotes: true },
								),
								notify: (text) =>
									detachedSendStatus({
										title: "/ctx-session-upgrade",
										text,
										level: "info",
									}),
							}) as never,
							db: currentDeps.db,
							sessionId,
							historianChunkTokens: currentDeps.historianChunkTokens,
							directory: cwd,
							historianTimeoutMs: currentDeps.historianTimeoutMs,
							memoryEnabled: currentDeps.memoryEnabled,
							autoPromote: currentDeps.autoPromote,
							// Embedding substrate: without this the recomp publish path
							// no-ops chunk embedding on an unregistered project, leaving
							// rebuilt compartments out of ctx_search. Parity with OpenCode.
							ensureProjectRegistered: ensureProjectRegisteredFromPiDirectory,
							// Recomp-runner model chain (parity with OpenCode
							// recomp-orchestrator): configured fallbacks + the session's
							// own model as the last-ditch retry, so an empty/invalid-but-
							// HTTP-200 historian primary escalates instead of failing.
							fallbackModels: currentDeps.historianFallbacks,
							fallbackModelId: sessionMainModel,
							language: currentDeps.language,
						},
						{},
					);
					if (signal.aborted) return;

					// Gate migration + "Complete" on `published` — the GROUND TRUTH
					// that recomp actually rebuilt compartments (parity with OpenCode
					// runManagedUpgrade). A recomp can no-op WITHOUT a "— Failed/Skipped"
					// heading (lease/activeRuns guard returns "Historian already
					// running…"), which isRecompFailure misses. Running migration +
					// declaring Complete on a skipped recomp leaves tierless rows but
					// migrated memories + a project-wide cache-bust from the epoch bump
					// (dogfood 2026-05-30, AFT false-complete under concurrent processes).
					// Require a POSITIVE full-success ("— Complete"), not merely the
					// absence of a Failed/Skipped heading: a published "— Partial"
					// rebuilt only a prefix (published===true, not a failure heading),
					// and running migration + declaring Complete on it would migrate
					// memories while leaving tierless legacy rows. Mirrors OpenCode's
					// recomp-orchestrator gate.
					if (
						!recompResult.published ||
						!isRecompComplete(recompResult.message)
					) {
						const reason = contextualizeUpgradeReason(
							isRecompFailure(recompResult.message)
								? extractRecompReason(recompResult.message)
								: `Compartments were not fully rebuilt: ${extractRecompReason(recompResult.message)}`,
						);
						detachedSendStatus({
							title: "/ctx-session-upgrade",
							text: `## Session Upgrade — Incomplete\n\n${reason}`,
							level: "error",
						});
						return;
					}

					// DEFERRED staging (background-safe): stage the native marker as a
					// pending blob + signal a DEFERRED history refresh so the next
					// transform pass (at a turn boundary) drains and applies it. The
					// detached run must NOT apply the marker eagerly (appendCompaction
					// mutates getBranch immediately, which from a background task could
					// land mid-turn) nor use the eager history/materialization signals
					// — those would force a materialization on whatever pass is
					// running, possibly mid-turn, busting the cache. Mirrors the
					// background historian's onPublished (signalPiDeferred*).
					//
					// Isolated in its own try/catch: marker staging is best-effort (the
					// next incremental historian pass re-stages a covering marker), so a
					// throw here must NOT skip the refresh signals, the memory
					// migration, or the "Complete" message below — recomp already
					// published.
					try {
						stagePiRecompMarker({
							db: currentDeps.db,
							sessionId,
							branchEntries: snapshot.branchEntries,
						});
					} catch (markerError) {
						sessionLog(
							sessionId,
							`pi /ctx-session-upgrade marker staging failed (non-fatal, recomp already published): ${describeError(markerError).brief}`,
						);
					}

					signalPiDeferredHistoryRefresh(sessionId);
					signalPiDeferredMaterialization(sessionId);

					// Step 2 — memory migration (once per project, idempotent).
					const migrationSummary = await runMigration(signal);
					if (signal.aborted) return;

					detachedSendStatus({
						title: "/ctx-session-upgrade",
						text: [
							"## Session Upgrade — Complete",
							"",
							upgradableCount > 0
								? `Rebuilt ${upgradableCount} legacy compartment${upgradableCount === 1 ? "" : "s"} into the v2 format.`
								: "Rebuilt this session's compartments into the v2 format.",
							migrationSummary ? `\n${migrationSummary}` : "",
							"",
							recompResult.message,
						].join("\n"),
						level: "info",
						rpcDisplay: "dialog",
					});
				},
			});
		},
	});
}
