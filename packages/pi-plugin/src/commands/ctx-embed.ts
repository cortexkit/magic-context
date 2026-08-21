import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	embedSessionCompartmentChunks,
	getEmbeddingCoverageStatus,
	type SessionChunkBackfillProgress,
} from "@magic-context/core/features/magic-context/project-embedding-registry";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import {
	autoEmbedAttemptedBySession,
	embedPauseBySession,
	embedRunStateBySession,
} from "@magic-context/core/hooks/magic-context/embed-session-state";
import { formatEmbedFailureSummary } from "@magic-context/core/hooks/magic-context/format-embed-failure";
import { formatEmbedStatusText } from "@magic-context/core/hooks/magic-context/format-embed-status";
import { ensureProjectRegisteredFromPiDirectory } from "../embedding-bootstrap";
import { createCtxStatusSender, resolveSessionId } from "./pi-command-utils";

const EMBED_PROGRESS_COMPARTMENT_STEP = 8;
const EMBED_PROGRESS_MIN_INTERVAL_MS = 10_000;

type EmbedDrainStatus = { text: string; level: "success" | "info" };

export function clearPiEmbedSessionState(sessionId: string): void {
	embedPauseBySession.delete(sessionId);
	const ctrl = embedRunStateBySession.get(sessionId);
	if (ctrl) {
		ctrl.abort();
		embedRunStateBySession.delete(sessionId);
	}
	autoEmbedAttemptedBySession.delete(sessionId);
}

export async function runEmbedDrain(
	db: ContextDatabase,
	projectIdentity: string,
	sessionId: string,
	options: {
		onStatus?: (status: EmbedDrainStatus) => void;
		now?: () => number;
		batchSize?: number;
	} = {},
): Promise<EmbedDrainStatus> {
	// Idempotent start: a drain already running for this session means a second
	// start would abort it then race the just-released lease to "busy" — killing
	// the active run for nothing. Just report it's running.
	const activeCtrl = embedRunStateBySession.get(sessionId);
	if (activeCtrl && !activeCtrl.signal.aborted) {
		return {
			text: "## /ctx-embed\n\nEmbedding is already running for this session.",
			level: "info",
		};
	}
	embedPauseBySession.delete(sessionId);
	const prior = embedRunStateBySession.get(sessionId);
	if (prior) prior.abort();
	const controller = new AbortController();
	embedRunStateBySession.set(sessionId, controller);
	const now = options.now ?? Date.now;
	let startEmitted = false;
	let lastProgressEmbedded = 0;
	let lastProgressAt = 0;
	const emitProgress = (progress: SessionChunkBackfillProgress): void => {
		if (progress.total <= 0) return;
		if (!startEmitted) {
			startEmitted = true;
			lastProgressAt = now();
			options.onStatus?.({
				text: `## /ctx-embed\n\nEmbedding ${progress.total} compartment${progress.total === 1 ? "" : "s"} of history…`,
				level: "info",
			});
			return;
		}
		if (progress.embedded <= 0 || progress.embedded >= progress.total) return;
		const currentTime = now();
		const enoughCompartments =
			progress.embedded - lastProgressEmbedded >=
			EMBED_PROGRESS_COMPARTMENT_STEP;
		const enoughTime =
			currentTime - lastProgressAt >= EMBED_PROGRESS_MIN_INTERVAL_MS &&
			progress.embedded > lastProgressEmbedded;
		if (!enoughCompartments && !enoughTime) return;
		lastProgressEmbedded = progress.embedded;
		lastProgressAt = currentTime;
		options.onStatus?.({
			text: `## /ctx-embed\n\nEmbedded ${progress.embedded}/${progress.total} compartments so far…`,
			level: "info",
		});
	};
	let outcome: Awaited<ReturnType<typeof embedSessionCompartmentChunks>>;
	try {
		outcome = await embedSessionCompartmentChunks(
			db,
			projectIdentity,
			sessionId,
			{
				signal: controller.signal,
				onProgress: emitProgress,
				...(options.batchSize !== undefined
					? { batchSize: options.batchSize }
					: {}),
			},
		);
	} finally {
		// Always release the controller, even on throw, so a later start works.
		if (embedRunStateBySession.get(sessionId) === controller) {
			embedRunStateBySession.delete(sessionId);
		}
	}
	switch (outcome.status) {
		case "nothing":
			return {
				text: "## /ctx-embed\n\nAll of this session's history is already embedded.",
				level: "info",
			};
		case "disabled":
			return {
				text: "## /ctx-embed\n\nNo embedding provider is configured, so there is nothing to embed.",
				level: "info",
			};
		case "busy":
			return {
				text: "## /ctx-embed\n\nEmbedding is already running for this project. Try again shortly.",
				level: "info",
			};
		case "aborted": {
			const cov = getEmbeddingCoverageStatus(db, projectIdentity, sessionId);
			return {
				text: `## /ctx-embed\n\nPaused at ${cov.session.embedded}/${cov.session.total} compartments embedded.`,
				level: "info",
			};
		}
		case "stalled":
			return {
				text: `## /ctx-embed\n\n${formatEmbedFailureSummary(
					outcome.embedded,
					outcome.remaining,
					outcome.failure,
				)}`,
				level: "info",
			};
		default:
			return {
				text: `## /ctx-embed\n\nEmbedded ${outcome.embedded} compartment${outcome.embedded === 1 ? "" : "s"} of history for semantic search.`,
				level: "success",
			};
	}
}

export function registerCtxEmbedCommand(
	pi: ExtensionAPI,
	deps: {
		db: ContextDatabase;
		projectDir: string;
		projectIdentity: string;
		memoryEnabled?: boolean;
		resolveMemoryEnabled?: (ctx: { cwd: string }) => boolean | undefined;
		resolveProject?: (ctx: { cwd: string }) => {
			projectDir: string;
			projectIdentity: string;
		};
	},
): void {
	pi.registerCommand("ctx-embed", {
		description:
			"Embedding status, or start/pause history compartment embedding (start | pause)",
		handler: async (args, ctx) => {
			const sendStatus = createCtxStatusSender(pi, ctx);
			const sessionId = resolveSessionId(ctx);
			if (!sessionId) {
				sendStatus({
					title: "/ctx-embed",
					text: "## /ctx-embed\n\nNo active Pi session is available.",
					level: "error",
				});
				return;
			}
			const project = deps.resolveProject?.(ctx) ?? {
				projectDir: deps.projectDir,
				projectIdentity: deps.projectIdentity,
			};
			const memoryEnabled =
				deps.resolveMemoryEnabled?.(ctx) ?? deps.memoryEnabled;
			const sub = args.trim().toLowerCase();

			if (sub === "pause") {
				embedPauseBySession.add(sessionId);
				const ctrl = embedRunStateBySession.get(sessionId);
				if (ctrl) ctrl.abort();
				const cov = getEmbeddingCoverageStatus(
					deps.db,
					project.projectIdentity,
					sessionId,
				);
				sendStatus({
					title: "/ctx-embed",
					text: `## /ctx-embed\n\nPaused at ${cov.session.embedded}/${cov.session.total} compartments embedded.`,
					level: "info",
				});
				return;
			}

			if (memoryEnabled === false) {
				sendStatus({
					title: "/ctx-embed",
					text: "## /ctx-embed\n\nMemory is disabled for this project, so there is no semantic embedding to backfill.",
					level: "info",
				});
				return;
			}

			await ensureProjectRegisteredFromPiDirectory(project.projectDir, deps.db);

			if (sub === "start") {
				const { text, level } = await runEmbedDrain(
					deps.db,
					project.projectIdentity,
					sessionId,
					{
						onStatus: (status) =>
							sendStatus({
								title: "/ctx-embed",
								...status,
							}),
					},
				);
				sendStatus({ title: "/ctx-embed", text, level });
				return;
			}

			if (sub !== "") {
				sendStatus({
					title: "/ctx-embed",
					text: "## /ctx-embed\n\nUsage: `/ctx-embed` (status), `/ctx-embed start`, or `/ctx-embed pause`.",
					level: "info",
				});
				return;
			}

			const coverage = getEmbeddingCoverageStatus(
				deps.db,
				project.projectIdentity,
				sessionId,
			);
			const statusText = formatEmbedStatusText(coverage, { status: "idle" });
			sendStatus({
				title: "/ctx-embed",
				text: `## Embedding Status\n\n${statusText}`,
				level: "info",
				rpcDisplay: "dialog",
			});
		},
	});
}

/** Fire-and-forget auto-drain for the active Pi session (once per process). */
export function maybeAutoEmbedPiSession(
	deps: {
		db: ContextDatabase;
		projectDir: string;
		projectIdentity: string;
		memoryEnabled?: boolean;
	},
	sessionId: string,
	projectDir: string,
	projectIdentity: string,
	notify: (text: string) => void,
): void {
	if (autoEmbedAttemptedBySession.has(sessionId)) return;
	if (embedPauseBySession.has(sessionId)) return;
	if (deps.memoryEnabled === false) return;
	autoEmbedAttemptedBySession.add(sessionId);
	void (async () => {
		let completedDrainWithWork = false;
		try {
			// Defer off the context-handler thread before any DB/config work:
			// ensureProjectRegisteredFromPiDirectory does its config load + stale
			// wipe synchronously, so awaiting it first would run on the hot path.
			await new Promise((resolve) => setTimeout(resolve, 0));
			await ensureProjectRegisteredFromPiDirectory(projectDir, deps.db);
			const coverage = getEmbeddingCoverageStatus(
				deps.db,
				projectIdentity,
				sessionId,
			);
			if (!coverage.enabled) return;
			const remaining = coverage.session.total - coverage.session.embedded;
			if (remaining <= 0) return;
			notify(
				`Embedding ${remaining} compartment${remaining === 1 ? "" : "s"} of history in the background…`,
			);
			const { text, level } = await runEmbedDrain(
				deps.db,
				projectIdentity,
				sessionId,
			);
			completedDrainWithWork = level === "success";
			notify(text.replace(/^## \/ctx-embed\n\n/, ""));
		} catch {
			// best-effort background drain
		} finally {
			if (!completedDrainWithWork)
				autoEmbedAttemptedBySession.delete(sessionId);
		}
	})();
}
