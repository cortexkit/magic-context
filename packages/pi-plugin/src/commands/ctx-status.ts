import { getCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { getDreamState } from "@magic-context/core/features/magic-context/dreamer/storage-dream-state";
import { getMemoryCount } from "@magic-context/core/features/magic-context/memory/storage-memory";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { getPendingOps } from "@magic-context/core/features/magic-context/storage";
import { getOrCreateSessionMeta } from "@magic-context/core/features/magic-context/storage-meta";
import { getNotes } from "@magic-context/core/features/magic-context/storage-notes";
import { getTagsBySession } from "@magic-context/core/features/magic-context/storage-tags";
import { executeStatus } from "@magic-context/core/hooks/magic-context/execute-status";
import { formatBytes } from "@magic-context/core/hooks/magic-context/format-bytes";
import { describeError } from "@magic-context/core/shared/error-message";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { showStatusDialog } from "../dialogs/status-dialog";
import { resolveSessionId, sendCtxStatusMessage } from "./pi-command-utils";

export interface RegisterCtxStatusDeps {
	db: ContextDatabase;
	projectIdentity: string;
	protectedTags?: number;
	nudgeIntervalTokens?: number;
	executeThresholdPercentage?:
		| number
		| { default: number; [modelKey: string]: number };
	historyBudgetPercentage?: number;
	commitClusterTrigger?: { enabled: boolean; min_clusters: number };
	executeThresholdTokens?: {
		default?: number;
		[modelKey: string]: number | undefined;
	};
	dreamer?: { enabled?: boolean; schedule?: string };
}

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
	dreamer: {
		enabled: boolean;
		schedule: string | null;
		lastRunAt: number | null;
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
			const sessionId = resolveSessionId(ctx);
			if (!sessionId) {
				sendCtxStatusMessage(pi, {
					title: "/ctx-status",
					text: "## Magic Status\n\nNo active Pi session is available.",
					level: "error",
				});
				return;
			}

			try {
				if (ctx.hasUI) {
					await showStatusDialog(pi, ctx, deps);
					return;
				}

				const usage = ctx.getContextUsage?.();
				const modelKey = ctx.model
					? `${ctx.model.provider}/${ctx.model.id}`
					: undefined;
				const statusText = executeStatus(
					deps.db,
					sessionId,
					deps.protectedTags ?? 20,
					deps.nudgeIntervalTokens,
					deps.executeThresholdPercentage,
					modelKey,
					deps.historyBudgetPercentage,
					deps.commitClusterTrigger,
					deps.executeThresholdTokens,
					usage?.contextWindow,
				);
				const details = buildStatusDetails(deps, sessionId);
				sendCtxStatusMessage(
					pi,
					{ title: "/ctx-status", text: statusText, level: "info" },
					details,
				);
			} catch (error) {
				sendCtxStatusMessage(pi, {
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
			enabled: deps.dreamer?.enabled === true,
			schedule: deps.dreamer?.schedule ?? null,
			lastRunAt: readNumberState(
				deps.db,
				`last_dream_at:${deps.projectIdentity}`,
			),
		},
		historian: readHistorianState(deps.db, sessionId, meta),
	};
}

function readNumberState(db: ContextDatabase, key: string): number | null {
	const value = getDreamState(db, key);
	if (!value) return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
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

export function formatCtxStatusSummary(details: CtxStatusDetails): string {
	return [
		"## Magic Status",
		"",
		`**Session:** ${details.sessionId}`,
		`**Project:** ${details.projectIdentity}`,
		`**Tags:** ${details.activeTags} active (${formatBytes(details.totalBytes)}), ${details.droppedTags} dropped`,
		`**Pending ops:** ${details.pendingOps}`,
		`**Compartments:** ${details.compartmentCount}${details.lastCompartmentRange ? ` (last ${details.lastCompartmentRange})` : ""}`,
		`**Memories:** ${details.memoryCount}`,
		`**Notes:** ${details.noteCount}`,
		`**Dreamer:** ${details.dreamer.enabled ? `enabled (${details.dreamer.schedule ?? "unscheduled"})` : "disabled"}`,
		`**Historian:** ${details.historian.inProgress ? "running" : "idle"}, failures=${details.historian.failureCount}`,
	].join("\n");
}
