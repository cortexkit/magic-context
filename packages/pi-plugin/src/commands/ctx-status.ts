import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { MagicContextConfig } from "@magic-context/core/config/schema/magic-context";
import type { getDreamTaskBacklogs } from "@magic-context/core/features/magic-context/dreamer/task-gates";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import type { ConfigParseFailure } from "@magic-context/core/shared/config-diagnostics";
import { sessionLog } from "@magic-context/core/shared/logger";
import {
	renderUserFacingFailure,
	userFacingFailureCode,
} from "@magic-context/core/shared/user-facing-codes";

import {
	buildPiStatusDetail,
	formatPiStatusSummary,
	type StatusDialogDetail,
	showStatusDialog,
} from "../dialogs/status-dialog";
import { createCtxStatusSender, resolveSessionId } from "./pi-command-utils";

export interface RegisterCtxStatusDeps {
	db: ContextDatabase;
	projectIdentity: string;
	resolveStatusDeps?: (
		ctx: Pick<ExtensionCommandContext, "cwd" | "sessionManager">,
	) => CtxStatusRuntimeDeps;
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
	modelChainWarning?: string;
	/** User-owned profile selected for the project, after config resolution. */
	activeProfile?: string;
	configGeneration?: number;
	configAdoptedAt?: number;
	configReloadFailure?: { path: string; message: string };
	cacheTtlConfig?: MagicContextConfig["cache_ttl"];
	cacheTtlConfigured?: boolean;
	configParseFailures?: ConfigParseFailure[];
	hasDeprecatedProtectedTags?: boolean;
	compactionEnabled?: boolean;
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
		runs: number;
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
		handler: async (args, ctx) => {
			const sendStatus = createCtxStatusSender(pi, ctx);
			// One view, no modes: an argument can only be a mistake now, and
			// silently ignoring it would hide the mistake.
			if (args.trim() !== "") {
				sendStatus({
					title: "/ctx-status",
					text: "Usage: /ctx-status",
					level: "info",
				});
				return;
			}
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
					if (currentDeps.modelChainWarning)
						ctx.ui.notify(currentDeps.modelChainWarning, "error");
					await showStatusDialog(pi, ctx, currentDeps);
					return;
				}

				const statusDetail = buildPiStatusDetail(
					pi,
					ctx,
					currentDeps,
					sessionId,
				);
				const statusText = `${formatPiStatusSummary(statusDetail)}${currentDeps.modelChainWarning ? `\nWARNING: ${currentDeps.modelChainWarning}` : ""}`;
				const details = buildStatusDetails(currentDeps, statusDetail);
				sendStatus(
					{
						title: "/ctx-status",
						text: statusText,
						level: "info",
						rpcDisplay: "dialog",
					},
					details,
				);
			} catch (error) {
				sessionLog(
					sessionId,
					`ctx-status failed code=${userFacingFailureCode("status_unavailable")}`,
					error,
				);
				sendStatus({
					title: "/ctx-status",
					text: renderUserFacingFailure("status_unavailable"),
					level: "error",
				});
			}
		},
	});
}

function buildStatusDetails(
	deps: CtxStatusRuntimeDeps,
	status: StatusDialogDetail,
): CtxStatusDetails {
	return {
		sessionId: status.sessionId,
		projectIdentity: deps.projectIdentity,
		activeProfile: status.activeProfile,
		activeTags: status.activeTags,
		droppedTags: status.droppedTags,
		totalBytes: status.activeBytes,
		pendingOps: status.pendingOpsCount,
		compartmentCount: status.compartmentCount,
		lastCompartmentRange: status.lastCompartmentRange,
		memoryCount: status.memoryCount,
		noteCount: status.sessionNoteCount + status.readySmartNoteCount,
		dreamer: status.dreamer,
		historian: {
			runs: status.historianRuns,
			inProgress: status.historianRunning,
			lastFailureAt: status.historianLastFailureAt,
			lastError: status.historianLastError,
			failureCount: status.historianFailureCount,
		},
	};
}
