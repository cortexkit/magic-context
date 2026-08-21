import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withContentLanguageDirective } from "@magic-context/core/agents/language-directive";
import { getCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import {
	clearEmergencyRecovery,
	isWrapupInProgress,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { COMPARTMENT_STRUCTURAL_SYSTEM_PROMPT } from "@magic-context/core/hooks/magic-context/compartment-prompt";
import { executeContextRecompWithResult } from "@magic-context/core/hooks/magic-context/compartment-runner";
import {
	type PartialRecompRange,
	snapRangeToCompartments,
} from "@magic-context/core/hooks/magic-context/compartment-runner-partial-recomp";
import type { RawMessageProvider } from "@magic-context/core/hooks/magic-context/read-session-chunk";
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
import { createPiHistorianClient } from "../pi-recomp-client-shared";
import { stagePiRecompMarker } from "../pi-recomp-marker";
import { isPiRecompInFlight, spawnPiRecompRun } from "../pi-recomp-runner";
import { readPiSessionMessages } from "../read-session-pi";
import { updateStatusLine } from "../status-line";
import { createCtxStatusSender, resolveSessionId } from "./pi-command-utils";

interface RecompConfirmation {
	timestamp: number;
	argsKey: string;
}

const confirmationBySession = new Map<string, RecompConfirmation>();
const RECOMP_CONFIRMATION_WINDOW_MS = 60_000;
const RECOMP_USAGE = [
	"Usage:",
	"- `/ctx-recomp` — full rebuild from message 1 to the protected tail",
	"- `/ctx-recomp <start>-<end>` — partial rebuild of a message range (e.g. `/ctx-recomp 1-11322`)",
	"- `/ctx-recomp --upgrade` — upgrade legacy v1 compartments to v2 layout (Wave 3 runner)",
].join("\n");

export interface CtxRecompRuntimeDeps {
	db: ContextDatabase;
	runner: SubagentRunner;
	historianModel: string | undefined;
	historianChunkTokens: number;
	historianFallbacks?: readonly ModelInput[];
	historianTimeoutMs?: number;
	historianThinkingLevel?: string;
	language?: string;
	memoryEnabled: boolean;
	autoPromote: boolean;
	compactionOff?: boolean;
}

export interface RegisterCtxRecompDeps extends CtxRecompRuntimeDeps {
	resolveRuntimeDeps?: (ctx: { cwd: string }) => CtxRecompRuntimeDeps;
}

export function registerCtxRecompCommand(
	pi: ExtensionAPI,
	deps: RegisterCtxRecompDeps,
): void {
	pi.registerCommand("ctx-recomp", {
		description:
			"Rebuild Magic Context compartments from raw Pi session history",
		handler: async (args, ctx) => {
			const sendStatus = createCtxStatusSender(pi, ctx);
			const sessionId = resolveSessionId(ctx);
			if (!sessionId) {
				sendStatus({
					title: "/ctx-recomp",
					text: "## Magic Recomp\n\nNo active Pi session is available.",
					level: "error",
				});
				return;
			}
			const currentDeps = deps.resolveRuntimeDeps?.(ctx) ?? deps;
			if (currentDeps.compactionOff) {
				sendStatus({
					title: "/ctx-recomp",
					text: COMPACTION_OFF_COMMAND_UNAVAILABLE,
					level: "warning",
				});
				return;
			}

			const parsed = parseRecompArgs(args);
			if (parsed.kind === "error") {
				sendStatus({
					title: "/ctx-recomp",
					text: `## Magic Recomp — Invalid Arguments\n\n${parsed.message}`,
					level: "error",
				});
				return;
			}

			if (parsed.kind === "upgrade") {
				sendStatus({
					title: "/ctx-recomp",
					text: executeRecompUpgradeStub(currentDeps.db, sessionId),
					level: "info",
					rpcDisplay: "dialog",
				});
				return;
			}

			if (!currentDeps.historianModel) {
				sendStatus({
					title: "/ctx-recomp",
					text: "## Magic Recomp\n\n/ctx-recomp is unavailable because `historian.model` is not configured.",
					level: "error",
				});
				return;
			}

			const argsKey =
				parsed.kind === "partial"
					? `${parsed.range.start}-${parsed.range.end}`
					: "";
			const now = Date.now();
			const confirmation = confirmationBySession.get(sessionId);
			const confirmed =
				confirmation !== undefined &&
				now - confirmation.timestamp < RECOMP_CONFIRMATION_WINDOW_MS &&
				confirmation.argsKey === argsKey;

			if (!confirmed) {
				const warning = buildConfirmationWarning(
					currentDeps.db,
					sessionId,
					parsed,
				);
				if (!warning.confirmable) confirmationBySession.delete(sessionId);
				else confirmationBySession.set(sessionId, { timestamp: now, argsKey });
				sendStatus({
					title: "/ctx-recomp",
					text: warning.text,
					level: warning.confirmable ? "warning" : "error",
				});
				return;
			}

			if (isWrapupInProgress(currentDeps.db, sessionId)) {
				sendStatus({
					title: "/ctx-recomp",
					text: "## Magic Recomp\n\n/ctx-wrapup is already compacting this session. Wait for it to finish, then try `/ctx-recomp` again.",
					level: "warning",
				});
				return;
			}

			if (isPiRecompInFlight(sessionId)) {
				sendStatus({
					title: "/ctx-recomp",
					text: "## Magic Recomp\n\nA recomp or upgrade is already running for this session in the background. Wait for it to finish, then try again.",
					level: "warning",
				});
				return;
			}

			confirmationBySession.delete(sessionId);
			sendStatus({
				title: "/ctx-recomp",
				text:
					parsed.kind === "partial"
						? `## Magic Recomp\n\nPartial recomp started for range ${parsed.range.start}-${parsed.range.end}.`
						: "## Magic Recomp\n\nHistorian recomp started. Rebuilding compartments and facts from raw Pi session history now.",
				level: "info",
			});

			const provider = {
				readMessages: () => readPiSessionMessages(ctx),
			} satisfies RawMessageProvider;

			// Detached: the recomp runs in the background so the Pi REPL stays
			// responsive (parity with OpenCode's `void runManagedRecomp`). The
			// command handler returns right after this call. Provider registration,
			// the `recomp` status-line flag, shutdown-drain tracking, and cleanup
			// are owned by spawnPiRecompRun.
			spawnPiRecompRun({
				sessionId,
				provider,
				onStatusChange: () =>
					updateStatusLine(ctx, {
						db: currentDeps.db,
						projectIdentity: ctx.cwd,
					}),
				work: async () => {
					const result = await executeContextRecompWithResult(
						{
							client: createPiHistorianClient({
								runner: currentDeps.runner,
								model: currentDeps.historianModel as string,
								systemPrompt: withContentLanguageDirective(
									COMPARTMENT_STRUCTURAL_SYSTEM_PROMPT,
									currentDeps.language,
									{ preserveUserQuotes: true },
								),
								fallbackModels: currentDeps.historianFallbacks,
								timeoutMs: currentDeps.historianTimeoutMs,
								thinkingLevel: currentDeps.historianThinkingLevel,
								directory: ctx.cwd,
								accountingSessionId: sessionId,
								notify: (text) => {
									sendStatus({
										title: "/ctx-recomp",
										text,
										level: inferLevel(text),
									});
								},
							}) as never,
							db: currentDeps.db,
							sessionId,
							historianChunkTokens: currentDeps.historianChunkTokens,
							directory: ctx.cwd,
							historianTimeoutMs: currentDeps.historianTimeoutMs,
							memoryEnabled: currentDeps.memoryEnabled,
							autoPromote: currentDeps.autoPromote,
							// Embedding substrate: register before the recomp publish
							// path computes chunk embeddings, else rebuilt rows get
							// none and drop out of ctx_search semantic results.
							ensureProjectRegistered: ensureProjectRegisteredFromPiDirectory,
							// Recomp-runner model chain parity with OpenCode: configured
							// fallbacks + the session's own model as last-ditch retry.
							fallbackModels: currentDeps.historianFallbacks,
							language: currentDeps.language,
							fallbackModelId: ctx.model
								? `${ctx.model.provider}/${ctx.model.id}`
								: undefined,
						},
						parsed.kind === "partial" ? { range: parsed.range } : {},
					);
					if (result.published) {
						// A successful recomp resolves the overflow that may have armed
						// needs_emergency_recovery — clear it so the flag stops force-
						// bumping pressure to 95% every later pass (parity with
						// OpenCode runManagedRecomp). detectedContextLimit is left intact.
						try {
							clearEmergencyRecovery(currentDeps.db, sessionId);
						} catch (recoveryError) {
							sessionLog(
								sessionId,
								`/ctx-recomp: clearEmergencyRecovery failed (continuing): ${describeError(recoveryError).brief}`,
							);
						}
						// DEFERRED staging (background-safe): stage the native marker
						// as a pending blob + signal a DEFERRED history refresh so the
						// next transform pass (at a turn boundary) drains and applies
						// it. The detached run must NOT apply the marker eagerly
						// (appendCompaction mutates getBranch immediately, which from a
						// background task could land mid-turn) nor use the eager
						// history/materialization signals — those would force a
						// materialization on whatever pass is running, possibly
						// mid-turn, busting the cache. Mirrors the background
						// historian's onPublished (signalPiDeferred*).
						try {
							stagePiRecompMarker({ db: currentDeps.db, sessionId, ctx });
						} catch (markerError) {
							sessionLog(
								sessionId,
								`/ctx-recomp: marker staging failed (recomp already published; continuing): ${describeError(markerError).brief}`,
							);
						}
						signalPiDeferredHistoryRefresh(sessionId);
						signalPiDeferredMaterialization(sessionId);
					}
					sendStatus({
						title: "/ctx-recomp",
						text: result.message,
						level: inferLevel(result.message),
					});
				},
			});
		},
	});
}

function parseRecompArgs(
	raw: string,
):
	| { kind: "full" }
	| { kind: "partial"; range: PartialRecompRange }
	| { kind: "upgrade" }
	| { kind: "error"; message: string } {
	const trimmed = raw.trim();
	if (trimmed.length === 0) return { kind: "full" };
	if (trimmed === "--upgrade") return { kind: "upgrade" };
	const match = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
	if (!match) {
		return {
			kind: "error",
			message: `Invalid /ctx-recomp arguments: \`${trimmed}\`.\n\n${RECOMP_USAGE}`,
		};
	}
	const start = Number.parseInt(match[1], 10);
	const end = Number.parseInt(match[2], 10);
	if (start < 1)
		return { kind: "error", message: `Start must be >= 1 (got ${start}).` };
	if (end < start)
		return {
			kind: "error",
			message: `End must be >= start (got ${start}-${end}).`,
		};
	return { kind: "partial", range: { start, end } };
}

function executeRecompUpgradeStub(
	db: ContextDatabase,
	sessionId: string,
): string {
	const legacyCount = getCompartments(db, sessionId).filter(
		(compartment) => compartment.legacy === 1,
	).length;
	if (legacyCount === 0) {
		return "## Magic Recomp Upgrade\n\nNothing to upgrade: this session has no legacy compartments.";
	}

	return [
		"## Magic Recomp Upgrade",
		"",
		`Found ${legacyCount} legacy compartment${legacyCount === 1 ? "" : "s"} for this session.`,
		"The `--upgrade` flag is deprecated. Run `/ctx-session-upgrade` to upgrade this session.",
	].join("\n");
}

function buildConfirmationWarning(
	db: ContextDatabase,
	sessionId: string,
	parsed: { kind: "full" } | { kind: "partial"; range: PartialRecompRange },
): { text: string; confirmable: boolean } {
	const compartments = getCompartments(db, sessionId);
	if (parsed.kind === "partial") {
		const snap = snapRangeToCompartments(compartments, parsed.range);
		if ("error" in snap)
			return {
				text: `## Magic Recomp — Failed\n\n${snap.error}`,
				confirmable: false,
			};
		return {
			confirmable: true,
			text: [
				"## ⚠️ Partial Recomp Confirmation Required",
				"",
				`Requested range: \`${parsed.range.start}-${parsed.range.end}\``,
				`Snapped to compartment boundaries: **messages ${snap.snapStart}-${snap.snapEnd}**`,
				`This will rebuild ${snap.rangeCompartments.length} compartment(s).`,
				`Preserved outside range: ${snap.priorCompartments.length + snap.tailCompartments.length} compartment(s).`,
				"Facts will not be re-extracted.",
				"",
				`**To confirm, run \`/ctx-recomp ${parsed.range.start}-${parsed.range.end}\` again within 60 seconds.**`,
			].join("\n"),
		};
	}

	return {
		confirmable: true,
		text: [
			"## ⚠️ Recomp Confirmation Required",
			"",
			`You currently have **${compartments.length}** compartments.`,
			"Running /ctx-recomp will **regenerate all compartments and facts** from raw session history.",
			"",
			"This operation may take a long time and will consume historian-model tokens.",
			"",
			"**To confirm, run `/ctx-recomp` again within 60 seconds.**",
		].join("\n"),
	};
}

function inferLevel(text: string): "info" | "success" | "warning" | "error" {
	const lower = text.toLowerCase();
	if (lower.includes("failed") || lower.includes("error")) return "error";
	if (lower.includes("confirmation") || lower.includes("⚠️")) return "warning";
	if (lower.includes("complete")) return "success";
	return "info";
}
