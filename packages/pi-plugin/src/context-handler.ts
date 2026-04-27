/**
 * Pi `context` event handler — the per-LLM-call transform pipeline.
 *
 * Pi fires `pi.on("context", ...)` immediately before each LLM
 * invocation, with the full `AgentMessage[]` that's about to be sent.
 * The handler can return `{ messages }` to replace the array.
 *
 * Step 4b.2 wires the smallest meaningful pipeline:
 *   1. Wrap the AgentMessage[] in a Transcript via `createPiTranscript`.
 *   2. Tag eligible parts with the shared `Tagger` and inject `§N§ `
 *      prefixes (unless `ctx_reduce_enabled: false`).
 *   3. Apply queued drops from `pending_ops` via the shared
 *      `applyPendingOperations` flow.
 *   4. Apply persistent dropped/truncated states from the `tags` table
 *      via `applyFlushedStatuses` so cross-session drops survive.
 *   5. Return the rebuilt messages so Pi sees the mutations.
 *
 * What's deliberately NOT in 4b.2:
 *
 * - Historian invocation. Compartment trigger logic and historian
 *   subprocess spawn live in 4b.3.
 * - Nudges (rolling, note-nudge, ctx_reduce reminders). 4b.4.
 * - Auto-search hint injection. 4b.4.
 * - Sentinel stripping for cache stability. Pi's transform model is
 *   single-pass-per-LLM-call, so OpenCode-style cache-bust avoidance
 *   doesn't apply. If a Pi provider exposes prompt cache later we'd
 *   add the relevant subset.
 * - Compaction marker injection. OpenCode-only — Pi doesn't have a
 *   compaction-event surface to inject into.
 *
 * Error handling: any thrown error is caught and logged, then the
 * original messages pass through unmodified. Pi's LLM call should
 * never fail because of a transform bug — same fail-open philosophy
 * as the OpenCode `messages-transform` wrapper.
 */

import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { getOrCreateSessionMeta } from "@magic-context/core/features/magic-context/storage-meta";
import {
	createTagger,
	type Tagger,
} from "@magic-context/core/features/magic-context/tagger";
import {
	applyFlushedStatuses,
	applyPendingOperations,
} from "@magic-context/core/hooks/magic-context/apply-operations";
import { checkCompartmentTrigger } from "@magic-context/core/hooks/magic-context/compartment-trigger";
import { setRawMessageProvider } from "@magic-context/core/hooks/magic-context/read-session-chunk";
import { log, sessionLog } from "@magic-context/core/shared/logger";
import type { SubagentRunner } from "@magic-context/core/shared/subagent-runner";
import { tagTranscript } from "@magic-context/core/shared/tag-transcript";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { runPiHistorian } from "./pi-historian-runner";
import { readPiSessionMessages } from "./read-session-pi";
import { createPiTranscript } from "./transcript-pi";

/**
 * Optional historian config. When provided, the context handler checks
 * the compartment trigger after tagging and fires `runPiHistorian`
 * asynchronously (fire-and-forget) when the trigger says shouldFire.
 * When omitted, no historian invocation happens — useful for testing
 * the transform pipeline in isolation or running Pi without a
 * configured historian model.
 */
export interface PiHistorianOptions {
	/** SubagentRunner instance (PiSubagentRunner). */
	runner: SubagentRunner;
	/** Historian provider/model id (e.g. `anthropic/claude-haiku-4-5`). */
	model: string;
	/** Optional ordered fallback chain. */
	fallbackModels?: readonly string[];
	/** Historian context window — used to derive chunk token budget. */
	historianChunkTokens: number;
	/** Optional per-call timeout (default 120s). */
	timeoutMs?: number;
	/** Cross-session memory feature gate (`memory.enabled`). */
	memoryEnabled?: boolean;
	/** Automatic-promotion gate (`memory.auto_promote`). */
	autoPromote?: boolean;
	/**
	 * Execute-threshold percentage used by the trigger logic to compute
	 * pressure-driven trigger points. Mirrors OpenCode's
	 * `execute_threshold_percentage` config; defaults to 65 when omitted.
	 */
	executeThresholdPercentage?: number;
	/**
	 * Trigger budget (tokens) used by the commit-cluster and tail-size
	 * triggers. Mirrors `compartment_token_budget` derived value in
	 * OpenCode; defaults to 8000 when omitted.
	 */
	triggerBudget?: number;
}

export interface PiContextHandlerOptions {
	db: ContextDatabase;
	/**
	 * Whether the agent-facing `ctx_reduce` tool is exposed. When false,
	 * tag prefixes are still assigned in the DB (so drops still work
	 * via /ctx-flush or future automatic triggers) but the visible
	 * `§N§ ` markers are NOT injected — agents shouldn't see markers
	 * they can't act on. Mirrors OpenCode behavior.
	 *
	 * Step 4b.2 hardcodes this to `true` since Pi's `ctx_reduce` tool
	 * is registered. Step 5b's config loader will make it configurable.
	 */
	ctxReduceEnabled: boolean;
	/**
	 * Optional historian wiring (Step 4b.3b). When omitted, the trigger
	 * check is skipped — context events still tag + drop normally, and
	 * historian state stays untouched. When provided, the trigger fires
	 * async after each tagging pass.
	 */
	historian?: PiHistorianOptions;
}

/**
 * Resolve the active Pi session id for the given context. Pi's
 * ReadonlySessionManager exposes `getSessionId()` (the UUID written
 * into the session file's `SessionHeader`); that's stable across the
 * session's lifetime even when branches are navigated, and matches
 * what Pi itself uses internally to address the session. We prefer
 * the UUID over the file path because:
 *
 *   - It's invariant under file moves (forks create new files but
 *     keep the original session id semantics intact).
 *   - It's the same id Pi uses in its `session_switch` event, so
 *     downstream code can correlate events to magic-context state
 *     without re-deriving from paths.
 *
 * Returns undefined when no session is active — context events should
 * never fire in that state, but defending against it keeps the
 * transform fail-open if Pi's lifecycle changes in future versions.
 */
function resolveSessionId(ctx: ExtensionContext): string | undefined {
	const sm = ctx.sessionManager;
	if (sm === undefined) return undefined;
	const getSessionId = (sm as { getSessionId?: () => string | undefined })
		.getSessionId;
	if (typeof getSessionId !== "function") return undefined;
	try {
		const id = getSessionId.call(sm);
		if (typeof id !== "string" || id.length === 0) return undefined;
		return id;
	} catch {
		return undefined;
	}
}

/**
 * Register the Pi `context` event handler.
 *
 * The Tagger is created once per session boot — same lifecycle as the
 * OpenCode plugin's tagger. It maintains in-memory state (the
 * monotonic counter, assignment map) across `context` events so tag
 * numbers stay stable for the duration of the Pi session.
 */
export function registerPiContextHandler(
	pi: ExtensionAPI,
	options: PiContextHandlerOptions,
): void {
	const tagger = createTagger();
	const projectIdentity = resolveProjectIdentity(process.cwd());

	pi.on("context", async (event, ctx) => {
		try {
			const sessionId = resolveSessionId(ctx);
			if (sessionId === undefined) {
				// No active session — fall through with no mutation.
				log(
					"[magic-context][pi] context event fired with no session id (falling through unmodified)",
				);
				return;
			}

			// Lazy-initialize tagger state from DB. Idempotent: re-init
			// during the same session is a no-op because the in-memory
			// counter is already populated. Required because the tag
			// counter persists across plugin restarts via the
			// `session_meta.counter` column.
			tagger.initFromDb(sessionId, options.db);

			const result = await runPipeline({
				db: options.db,
				tagger,
				sessionId,
				projectIdentity,
				messages: event.messages,
				ctxReduceEnabled: options.ctxReduceEnabled,
			});
			// Cast the rebuilt unknown[] back to the AgentMessage[] shape
			// Pi's ContextEventResult expects. The transcript adapter
			// preserves source-identity for unchanged messages and only
			// rebuilds the mutated ones, all of which keep the same
			// (or symmetric-text) shape — so this cast is safe at
			// runtime even though TS can't see the relationship.

			// After tagging+drops have committed, check whether historian
			// should fire. Historian config is optional — tagging-only
			// behavior is the Step 4b.2 contract, and historian is
			// fire-and-forget so we never block the LLM call on it.
			if (options.historian) {
				maybeFireHistorian({
					ctx,
					sessionId,
					db: options.db,
					historian: options.historian,
				});
			}

			return result as { messages: typeof event.messages };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const stack = err instanceof Error ? err.stack : undefined;
			log(
				`[magic-context][pi] context handler failed (continuing without mutation): ${message}`,
				stack,
			);
			// Fall through with no mutation — Pi proceeds with original
			// messages, equivalent to a no-op transform pass.
			return;
		}
	});
	log("[magic-context][pi] registered context handler (tagging + drops)");
}

/**
 * Track in-flight historian runs per session so we don't fire a second
 * pass while the first is still running. The flag also exists in
 * session_meta.compartment_in_progress (see `runPiHistorian` setting
 * it), but that DB-side flag is durable across restarts and the
 * trigger logic already inspects it; this in-memory map is a
 * fast-path so we don't hit the DB just to dedupe per turn.
 *
 * We store the actual Promise (not just the session id) so the
 * `session_shutdown` handler can `await` outstanding runs before Pi
 * exits — critical for `pi --print` mode where the parent process
 * exits as soon as `agent_end` fires, otherwise killing the historian
 * subprocess mid-run.
 */
const inFlightHistorian = new Map<string, Promise<unknown>>();

/**
 * Wait for all in-flight historian runs to complete. Called from the
 * Pi `session_shutdown` event handler so historian can finish writing
 * compartments before the process exits. Returns immediately if no
 * runs are in-flight.
 */
export async function awaitInFlightHistorians(): Promise<void> {
	if (inFlightHistorian.size === 0) return;
	const promises = Array.from(inFlightHistorian.values());
	await Promise.allSettled(promises);
}

/**
 * Trigger evaluation + fire-and-forget historian invocation. Runs
 * after the synchronous tagging pass so trigger logic sees the
 * just-assigned tags.
 *
 * The actual historian subagent spawn (`runPiHistorian`) is async
 * and intentionally NOT awaited — the LLM call should never wait on
 * historian. Errors are logged but never propagated; the user's
 * agent turn continues regardless of historian outcome.
 */
function maybeFireHistorian(args: {
	ctx: ExtensionContext;
	sessionId: string;
	db: ContextDatabase;
	historian: PiHistorianOptions;
}): void {
	const { ctx, sessionId, db, historian } = args;

	if (inFlightHistorian.has(sessionId)) {
		sessionLog(sessionId, "pi-historian trigger eval: in-flight, skipping");
		return;
	}

	// Pi exposes ctx.getContextUsage() returning { tokens, contextWindow,
	// percent }. We map to OpenCode's ContextUsage shape ({ percentage,
	// inputTokens }) used by the shared trigger.
	let usage: { percentage: number; inputTokens: number };
	try {
		const piUsage = ctx.getContextUsage?.();
		if (
			!piUsage ||
			piUsage.tokens === null ||
			piUsage.percent === null ||
			piUsage.contextWindow === 0
		) {
			sessionLog(
				sessionId,
				`pi-historian trigger eval: no usage info yet (tokens=${piUsage?.tokens ?? "<no piUsage>"}, percent=${piUsage?.percent ?? "<no piUsage>"}, contextWindow=${piUsage?.contextWindow ?? "<no piUsage>"})`,
			);
			return;
		}
		usage = {
			percentage: piUsage.percent,
			inputTokens: piUsage.tokens,
		};
		sessionLog(
			sessionId,
			`pi-historian trigger eval: usage=${usage.percentage.toFixed(1)}% (${usage.inputTokens} tokens), checking trigger...`,
		);
	} catch (err) {
		sessionLog(
			sessionId,
			`pi-historian trigger eval: getContextUsage threw: ${err instanceof Error ? err.message : String(err)}`,
		);
		return;
	}

	// Register the Pi RawMessageProvider for this sessionId so the
	// shared trigger logic + historian can read Pi session messages
	// via the standard `readRawSessionMessages` etc. helpers. The
	// provider stays registered while the historian runs and
	// unregisters in finally.
	const provider = {
		readMessages: () => readPiSessionMessages(ctx),
	};
	const unregister = setRawMessageProvider(sessionId, provider);

	let triggered = false;
	try {
		const sessionMeta = getOrCreateSessionMeta(db, sessionId);
		const trigger = checkCompartmentTrigger(
			db,
			sessionId,
			sessionMeta,
			usage,
			0, // _previousPercentage — unused by current trigger logic
			historian.executeThresholdPercentage ?? 65,
			historian.triggerBudget ?? 8000,
		);

		if (!trigger.shouldFire) {
			sessionLog(
				sessionId,
				`pi-historian trigger eval: shouldFire=false (no trigger condition met)`,
			);
			return;
		}

		triggered = true;
		sessionLog(
			sessionId,
			`pi-historian trigger fired (reason=${trigger.reason ?? "unknown"}) usage=${usage.percentage.toFixed(1)}% — spawning subagent`,
		);

		// Fire-and-forget for the user's LLM call: the parent agent
		// turn never awaits this. But we DO track the Promise in
		// inFlightHistorian so `awaitInFlightHistorians()` can wait
		// at session_shutdown — without that, `pi --print` mode would
		// kill the historian subprocess mid-run when the parent exits.
		const runPromise = runPiHistorian({
			db,
			sessionId,
			directory: ctx.cwd,
			provider,
			runner: historian.runner,
			historianModel: historian.model,
			fallbackModels: historian.fallbackModels,
			historianChunkTokens: historian.historianChunkTokens,
			historianTimeoutMs: historian.timeoutMs,
			memoryEnabled: historian.memoryEnabled,
			autoPromote: historian.autoPromote,
		}).finally(() => {
			inFlightHistorian.delete(sessionId);
			unregister();
		});
		inFlightHistorian.set(sessionId, runPromise);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		sessionLog(sessionId, `pi-historian trigger eval failed: ${message}`);
		if (!triggered) unregister();
	}
}
interface RunPipelineArgs {
	db: ContextDatabase;
	tagger: Tagger;
	sessionId: string;
	projectIdentity: string;
	messages: Parameters<typeof createPiTranscript>[0];
	ctxReduceEnabled: boolean;
}

async function runPipeline(args: RunPipelineArgs) {
	const transcript = createPiTranscript(args.messages, args.sessionId);

	// Tagging: assigns tag numbers + injects §N§ prefixes (unless
	// ctx_reduce_enabled is false, in which case prefixes are skipped
	// but DB-side tag IDs still get created so drops continue to work).
	const { targets } = tagTranscript(
		args.sessionId,
		transcript,
		args.tagger,
		args.db,
		{
			skipPrefixInjection: !args.ctxReduceEnabled,
		},
	);

	// Apply queued drops from pending_ops. This is what /ctx-reduce or
	// future automatic compaction triggers use to remove specific tag
	// numbers; the actual mutation goes through the TagTarget surface
	// we built above and lands in the underlying AgentMessage content.
	//
	// `protectedTags` is hardcoded to 0 for Pi here because we don't
	// have a magic-context.jsonc config loader yet; once 5b lands the
	// configured value flows in. 0 is the existing OpenCode default
	// for unprotected behavior — at this stage Pi sessions don't have
	// the recent-turn protection that primary OpenCode sessions get.
	applyPendingOperations(args.sessionId, args.db, targets, 0);

	// Apply persistent dropped/truncated tag statuses so cross-pass
	// drops survive even if pending_ops was already drained on a
	// previous pass. Unlike OpenCode (where this is replayed every
	// transform pass for cache-stability), Pi calls this once per
	// LLM call and the mutations get written back via the adapter's
	// commit() step.
	applyFlushedStatuses(args.sessionId, args.db, targets);

	transcript.commit();

	const outputMessages = transcript.getOutputMessages();
	// Pi's ContextEventResult: returning { messages } replaces the
	// array; returning nothing leaves it untouched. We always return
	// the rebuilt array even when there were no mutations because
	// `getOutputMessages()` returns source identity in that case
	// (see createPiTranscript), so Pi can short-circuit downstream
	// work via reference equality.
	return { messages: outputMessages };
}
