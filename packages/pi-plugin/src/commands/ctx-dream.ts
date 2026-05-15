import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { enqueueDream } from "@magic-context/core/features/magic-context/dreamer/queue";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { sessionLog } from "@magic-context/core/shared/logger";
import { runPiDreamForProject } from "../dreamer";
import { sendCtxStatusMessage } from "./pi-command-utils";

export function registerCtxDreamCommand(
	pi: ExtensionAPI,
	deps: {
		db: ContextDatabase;
		projectDir: string;
		projectIdentity: string;
	},
): void {
	pi.registerCommand("ctx-dream", {
		description: "Run a Magic Context dreamer cycle for this project now",
		handler: async () => {
			const enqueued = enqueueDream(deps.db, deps.projectIdentity, "manual");
			if (!enqueued) {
				// Already queued or actively running. Mirrors OpenCode's
				// behavior at command-handler.ts:230 — if enqueue returns
				// null we don't kick off another cycle.
				sendCtxStatusMessage(
					pi,
					{
						title: "/ctx-dream",
						text: [
							"## /ctx-dream",
							"",
							`Dream already queued or running for ${deps.projectIdentity}.`,
						].join("\n"),
						level: "info",
					},
					{
						projectDir: deps.projectDir,
						projectIdentity: deps.projectIdentity,
						entry: null,
					},
				);
				return;
			}

			// Tell the user we're starting a real run, not just queueing.
			sendCtxStatusMessage(
				pi,
				{
					title: "/ctx-dream",
					text: [
						"## /ctx-dream",
						"",
						`Starting dream run #${enqueued.id} for ${deps.projectIdentity}…`,
						`Project directory: ${deps.projectDir}`,
					].join("\n"),
					level: "info",
				},
				{
					projectDir: deps.projectDir,
					projectIdentity: deps.projectIdentity,
					entry: enqueued,
				},
			);

			// OpenCode parity (command-handler.ts:236-246): immediately drain
			// the dream queue from the same registered client/config the
			// timer uses. Pi previously left this to the 15-min timer, so
			// /ctx-dream felt broken.
			try {
				const result = await runPiDreamForProject(deps.projectIdentity);
				let summary: string;
				if (!result) {
					summary =
						"Dream queued, but another worker is already processing the queue.";
				} else {
					const taskLines = result.tasks
						.map((task) => {
							const status = task.error ? `error: ${task.error}` : "ok";
							return `- ${task.name} (${(task.durationMs / 1000).toFixed(1)}s) — ${status}`;
						})
						.join("\n");
					const failureCount = result.tasks.filter((t) => t.error).length;
					summary = [
						`Dream run complete in ${((result.finishedAt - result.startedAt) / 1000).toFixed(1)}s.`,
						`- Tasks: ${result.tasks.length} (${failureCount} failed)`,
						`- Smart notes surfaced: ${result.smartNotesSurfaced}, pending: ${result.smartNotesPending}`,
						"",
						taskLines,
					].join("\n");
				}

				sendCtxStatusMessage(
					pi,
					{
						title: "/ctx-dream",
						text: ["## /ctx-dream", "", summary].join("\n"),
						level: result ? "success" : "info",
					},
					{
						projectDir: deps.projectDir,
						projectIdentity: deps.projectIdentity,
						entry: enqueued,
					},
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				sessionLog(
					deps.projectIdentity,
					`/ctx-dream failed to drain queue: ${message}`,
				);
				sendCtxStatusMessage(
					pi,
					{
						title: "/ctx-dream",
						text: [
							"## /ctx-dream",
							"",
							`Dream run failed: ${message}`,
							"The queued entry remains; the registered timer will retry on its next tick.",
						].join("\n"),
						level: "error",
					},
					{
						projectDir: deps.projectDir,
						projectIdentity: deps.projectIdentity,
						entry: enqueued,
					},
				);
			}
		},
	});
}
