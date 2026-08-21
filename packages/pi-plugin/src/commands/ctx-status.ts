import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { getMostRecentTaskRunAt } from "@magic-context/core/features/magic-context/dreamer/storage-task-schedule";
import { getDreamTaskBacklogs } from "@magic-context/core/features/magic-context/dreamer/task-gates";
import { CANONICAL_DREAM_TASKS } from "@magic-context/core/features/magic-context/dreamer/task-registry";
import { getMemoryCount } from "@magic-context/core/features/magic-context/memory/storage-memory";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { getPendingOps } from "@magic-context/core/features/magic-context/storage";
import { getOrCreateSessionMeta } from "@magic-context/core/features/magic-context/storage-meta";
import { getOverflowState } from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { getNotes } from "@magic-context/core/features/magic-context/storage-notes";
import { getTagsBySession } from "@magic-context/core/features/magic-context/storage-tags";
import { executeStatus } from "@magic-context/core/hooks/magic-context/execute-status";
import { describeError } from "@magic-context/core/shared/error-message";
import { resolveTailHygieneStatus } from "@magic-context/core/shared/tail-hygiene-status";
import { getPiChannel1Baseline } from "../ctx-reduce-nudge-pi";
import { showStatusDialog } from "../dialogs/status-dialog";
import { resolvePiWindowGeometry } from "../pi-context-limit";
import { createCtxStatusSender, resolveSessionId } from "./pi-command-utils";

export interface RegisterCtxStatusDeps {
	db: ContextDatabase;
	projectIdentity: string;
	resolveStatusDeps?: (ctx: { cwd: string }) => CtxStatusRuntimeDeps;
	resolveProject?: (ctx: { cwd: string }) => {
		projectDir: string;
		projectIdentity: string;
	};
	protectedTags?: number;
	executeThresholdPercentage?:
		| number
		| { default: number; [modelKey: string]: number };
	historyBudgetPercentage?: number;
	injectionBudgetTokens?: number;
	commitClusterTrigger?: { enabled: boolean; min_clusters: number };
	executeThresholdTokens?: {
		default?: number;
		[modelKey: string]: number | undefined;
	};
	dreamer?: { runnable?: boolean; scheduleSummary?: string };
	/** User-owned profile selected for the project, after config resolution. */
	activeProfile?: string;
}

export type CtxStatusRuntimeDeps = Omit<
	RegisterCtxStatusDeps,
	"resolveStatusDeps"
>;

export interface CtxStatusDetails {
	sessionId: string;
	projectIdentity: string;
	activeTags: number;
	droppedTags: number;
	totalBytes: number;
	pendingOps: number;
	lastExecuteThreshold: number;
	compartmentCount: number;
	lastCompartmentRange: string | null;
	memoryCount: number;
	noteCount: number;
	activeProfile: string | null;
	dreamer: {
		enabled: boolean;
		scheduleSummary: string | null;
		lastRunAt: number | null;
		backlog?: ReturnType<typeof getDreamTaskBacklogs>;
	};
	historian: {
		lastFireCount: number;
		inProgress: boolean;
		lastFailureAt: number | null;
		lastError: string | null;
		failureCount: number;
	};
}

export function registerCtxStatusCommand(
	pi: ExtensionAPI,
	deps: RegisterCtxStatusDeps,
): void {
	pi.registerCommand("ctx-status", {
		description: "Show Magic Context status for the current Pi session",
		handler: async (_args, ctx) => {
			const sendStatus = createCtxStatusSender(pi, ctx);
			const runtimeDeps = deps.resolveStatusDeps?.(ctx) ?? deps;
			const projectIdentity =
				runtimeDeps.resolveProject?.(ctx).projectIdentity ??
				runtimeDeps.projectIdentity;
			const currentDeps = { ...runtimeDeps, projectIdentity };
			const sessionId = resolveSessionId(ctx);
			if (!sessionId) {
				sendStatus({
					title: "/ctx-status",
					text: "## Magic Status\n\nNo active Pi session is available.",
					level: "error",
				});
				return;
			}

			try {
				if (ctx.hasUI) {
					await showStatusDialog(pi, ctx, currentDeps);
					return;
				}

				const usage = ctx.getContextUsage?.();
				const modelKey = ctx.model
					? `${ctx.model.provider}/${ctx.model.id}`
					: undefined;
				let detectedContextLimit: number | undefined;
				try {
					const detected = getOverflowState(
						currentDeps.db,
						sessionId,
					).detectedContextLimit;
					if (detected > 0) detectedContextLimit = detected;
				} catch {
					// Status remains available when overflow metadata cannot be read.
				}
				const meta = getOrCreateSessionMeta(currentDeps.db, sessionId);
				const windowGeometry = resolvePiWindowGeometry({
					rawContextWindow: usage?.contextWindow ?? ctx.model?.contextWindow,
					model: ctx.model,
					detectedContextLimit,
					persistedInputTokens: meta.lastInputTokens,
					persistedPercentage: meta.lastContextPercentage,
				});
				const usableContextLimit = windowGeometry?.usableSoft;
				const statusText = executeStatus(
					currentDeps.db,
					sessionId,
					currentDeps.protectedTags ?? 20,
					currentDeps.executeThresholdPercentage,
					modelKey,
					currentDeps.historyBudgetPercentage,
					currentDeps.commitClusterTrigger,
					currentDeps.executeThresholdTokens,
					usableContextLimit,
					{
						backlog: getDreamTaskBacklogs(
							currentDeps.db,
							currentDeps.projectIdentity,
							CANONICAL_DREAM_TASKS,
						),
					},
					windowGeometry,
					resolveTailHygieneStatus(getPiChannel1Baseline(sessionId)),
				);
				const details = buildStatusDetails(currentDeps, sessionId);
				const profileStatus = currentDeps.activeProfile ?? "none";
				sendStatus(
					{
						title: "/ctx-status",
						text: `${statusText}\n\nActive profile: ${profileStatus}`,
						level: "info",
						rpcDisplay: "dialog",
					},
					details,
				);
			} catch (error) {
				sendStatus({
					title: "/ctx-status",
					text: `## Magic Status — Failed\n\n${describeError(error).brief}`,
					level: "error",
				});
			}
		},
	});
}

function buildStatusDetails(
	deps: RegisterCtxStatusDeps,
	sessionId: string,
): CtxStatusDetails {
	const meta = getOrCreateSessionMeta(deps.db, sessionId);
	const tags = getTagsBySession(deps.db, sessionId);
	const activeTags = tags.filter((tag) => tag.status === "active");
	const droppedTags = tags.filter((tag) => tag.status === "dropped");
	const compartments = getCompartments(deps.db, sessionId);
	const lastCompartment = compartments[compartments.length - 1];
	const totalBytes = activeTags.reduce((sum, tag) => sum + tag.byteSize, 0);

	return {
		sessionId,
		projectIdentity: deps.projectIdentity,
		activeProfile: deps.activeProfile ?? null,
		activeTags: activeTags.length,
		droppedTags: droppedTags.length,
		totalBytes,
		pendingOps: getPendingOps(deps.db, sessionId).length,
		lastExecuteThreshold: meta.timesExecuteThresholdReached,
		compartmentCount: compartments.length,
		lastCompartmentRange: lastCompartment
			? `${lastCompartment.startMessage}-${lastCompartment.endMessage}`
			: null,
		memoryCount: getMemoryCount(deps.db, deps.projectIdentity),
		noteCount:
			getNotes(deps.db, { sessionId, type: "session", status: "active" })
				.length +
			getNotes(deps.db, {
				projectPath: deps.projectIdentity,
				type: "smart",
				status: ["pending", "ready"],
			}).length,
		dreamer: {
			enabled: deps.dreamer?.runnable === true,
			scheduleSummary: deps.dreamer?.scheduleSummary ?? null,
			backlog: getDreamTaskBacklogs(
				deps.db,
				deps.projectIdentity,
				CANONICAL_DREAM_TASKS,
			),
			// Dreamer V2 retired the V1 dream_state['last_dream_at'] field; the
			// live "last successful run" is MAX(last_run_at) across the project's
			// task_schedule_state rows (issue #194).
			lastRunAt: getMostRecentTaskRunAt(deps.db, deps.projectIdentity),
		},
		historian: readHistorianState(deps.db, sessionId, meta),
	};
}

function readHistorianState(
	db: ContextDatabase,
	sessionId: string,
	meta: ReturnType<typeof getOrCreateSessionMeta>,
): CtxStatusDetails["historian"] {
	const row = db
		.prepare<
			[string],
			{
				historian_failure_count: number | null;
				historian_last_error: string | null;
				historian_last_failure_at: number | null;
			}
		>(
			"SELECT historian_failure_count, historian_last_error, historian_last_failure_at FROM session_meta WHERE session_id = ?",
		)
		.get(sessionId);
	return {
		lastFireCount: meta.timesExecuteThresholdReached,
		inProgress: meta.compartmentInProgress,
		lastFailureAt:
			typeof row?.historian_last_failure_at === "number"
				? row.historian_last_failure_at
				: null,
		lastError: row?.historian_last_error ?? null,
		failureCount: row?.historian_failure_count ?? 0,
	};
}
