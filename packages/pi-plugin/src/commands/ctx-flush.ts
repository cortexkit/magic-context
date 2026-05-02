import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { getPendingOps } from "@magic-context/core/features/magic-context/storage";
import { executeFlush } from "@magic-context/core/hooks/magic-context/execute-flush";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	signalPiHistoryRefresh,
	signalPiPendingMaterialization,
	signalPiSystemPromptRefresh,
} from "../context-handler";
import { resolveSessionId, sendCtxStatusMessage } from "./pi-command-utils";

export function registerCtxFlushCommand(
	pi: ExtensionAPI,
	deps: { db: ContextDatabase },
): void {
	pi.registerCommand("ctx-flush", {
		description:
			"Force pending Magic Context drops to materialize on the next provider call",
		handler: async (_args, ctx) => {
			const sessionId = resolveSessionId(ctx);
			if (!sessionId) {
				sendCtxStatusMessage(pi, {
					title: "/ctx-flush",
					text: "## /ctx-flush\n\nNo active Pi session is available.",
					level: "error",
				});
				return;
			}

			const pendingBefore = getPendingOps(deps.db, sessionId).length;
			const result = executeFlush(deps.db, sessionId);

			// Mirrors OpenCode `hook.ts:438-441` `onFlush`: explicit
			// flush is a "force everything to refresh" semantic, so we
			// signal all THREE refresh sets:
			//   1. historyRefresh — flushing mutates persistent tag
			//      state (status, drop_mode), so message[0] needs to
			//      reflect the new state. Without this the cached
			//      prepared block would replay the pre-flush version.
			//   2. pendingMaterialization — guarantees pending ops
			//      materialize on the next pass even if scheduler
			//      decides "defer". Without this, /ctx-flush wouldn't
			//      actually force materialization unless usage already
			//      crossed the execute threshold (the whole point of
			//      the command).
			//   3. systemPromptRefresh — flushing should also re-read
			//      disk-backed adjuncts (project-docs, user-profile,
			//      key-files, sticky date). Otherwise an edit to
			//      ARCHITECTURE.md followed by /ctx-flush leaves the
			//      stale block until the next natural cache-busting
			//      turn.
			signalPiHistoryRefresh(sessionId);
			signalPiPendingMaterialization(sessionId);
			signalPiSystemPromptRefresh(sessionId);

			const text =
				pendingBefore > 0
					? `## /ctx-flush\n\nFlushed ${pendingBefore} pending ops; next provider call will materialize.\n\n${result}`
					: `## /ctx-flush\n\n${result}`;
			sendCtxStatusMessage(
				pi,
				{
					title: "/ctx-flush",
					text,
					level: result.startsWith("Error:") ? "error" : "success",
				},
				{ sessionId, pendingBefore, result },
			);
		},
	});
}
