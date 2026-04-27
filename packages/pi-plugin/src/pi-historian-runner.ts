/**
 * Pi historian runner — Step 4b.3b.
 *
 * Mirrors `compartment-runner-incremental.ts` (OpenCode) but uses
 * `PiSubagentRunner` (spawns `pi --print --mode json` subprocess) for the
 * actual historian invocation instead of `client.session.create` + prompt.
 *
 * What this runner does:
 *   1. Read existing compartments + facts for this session
 *   2. Validate stored compartments are sane
 *   3. Compute eligible chunk start (after last compartment, before protected tail)
 *   4. Read raw chunk via shared `readSessionChunk` (using Pi RawMessageProvider)
 *   5. Build prompt via shared `buildCompartmentAgentPrompt`
 *   6. Spawn historian subagent via `PiSubagentRunner.run()`
 *   7. Parse + validate output via shared `validateHistorianOutput`
 *   8. On validation failure: try repair pass (one retry)
 *   9. Append new compartments + replace facts atomically
 *  10. Queue drops for compartmentalized message range
 *  11. Promote facts to project memories (if memory.enabled + auto_promote)
 *  12. Emit success notification (if notifier provided)
 *
 * What this runner does NOT do (deferred to later slices):
 *   - OpenCode-style compaction markers (Pi has native compaction)
 *   - Compressor pass (Step 4b.4 territory)
 *   - Two-pass editor mode (config option, defer)
 *   - Note nudge triggers (Step 4b.4 territory)
 *   - Emergency 95% recovery (defer)
 *   - User memory candidate extraction (defer to dedicated slice)
 *   - In-flight cancellation via AbortSignal (PiSubagentRunner handles per-run timeout)
 *
 * Failure handling philosophy: like OpenCode, this runner is fail-closed —
 * any validation/parse/spawn failure leaves stored compartments untouched
 * and increments the historian failure counter so the next pass can
 * react. We never write partial state.
 *
 * Logs go through the shared sessionLog so OpenCode log-tailing tools
 * see Pi runs in the same `[magic-context][ses_xxx]` format.
 */

import {
	appendCompartments,
	getCompartments,
	getSessionFacts,
	replaceSessionFacts,
} from "@magic-context/core/features/magic-context/compartment-storage";
import { promoteSessionFactsToMemory } from "@magic-context/core/features/magic-context/memory";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import { getMemoriesByProject } from "@magic-context/core/features/magic-context/memory/storage-memory";
import {
	clearHistorianFailureState,
	incrementHistorianFailure,
} from "@magic-context/core/features/magic-context/storage";
import { updateSessionMeta } from "@magic-context/core/features/magic-context/storage-meta";
import {
	buildCompartmentAgentPrompt,
	COMPARTMENT_AGENT_SYSTEM_PROMPT,
} from "@magic-context/core/hooks/magic-context/compartment-prompt";
import { queueDropsForCompartmentalizedMessages } from "@magic-context/core/hooks/magic-context/compartment-runner-drop-queue";
import { buildExistingStateXml } from "@magic-context/core/hooks/magic-context/compartment-runner-state-xml";
import {
	buildHistorianRepairPrompt,
	validateChunkCoverage,
	validateHistorianOutput,
	validateStoredCompartments,
} from "@magic-context/core/hooks/magic-context/compartment-runner-validation";
import {
	clearInjectionCache,
	renderMemoryBlock,
} from "@magic-context/core/hooks/magic-context/inject-compartments";
import {
	getProtectedTailStartOrdinal,
	type RawMessageProvider,
	readSessionChunk,
	withRawMessageProvider,
} from "@magic-context/core/hooks/magic-context/read-session-chunk";
import { describeError } from "@magic-context/core/shared/error-message";
import { sessionLog } from "@magic-context/core/shared/logger";
import type { Database } from "@magic-context/core/shared/sqlite";
import type {
	SubagentRunner,
	SubagentRunResult,
} from "@magic-context/core/shared/subagent-runner";

const HISTORIAN_AGENT_NAME = "magic-context-historian";
const DEFAULT_HISTORIAN_TIMEOUT_MS = 120_000;

/** Keep historian alert noise to once per minute per session. */
const HISTORIAN_ALERT_COOLDOWN_MS = 60 * 1000;
const lastHistorianAlertBySession = new Map<string, number>();

function shouldSuppressHistorianAlert(sessionId: string): boolean {
	const last = lastHistorianAlertBySession.get(sessionId);
	if (last && Date.now() - last < HISTORIAN_ALERT_COOLDOWN_MS) return true;
	lastHistorianAlertBySession.set(sessionId, Date.now());
	return false;
}

/** Cleanup module-scope state on session deletion. */
export function clearPiHistorianAlertState(sessionId: string): void {
	lastHistorianAlertBySession.delete(sessionId);
}

export interface PiHistorianDeps {
	/** SQLite handle for the shared cortexkit DB. */
	db: Database;
	/** Pi-resolved sessionId (from `pi.sessionManager.getSessionId()`). */
	sessionId: string;
	/** Project working directory (used for memory project-identity scoping). */
	directory: string;
	/** Provider that resolves `readRawSessionMessages(sessionId)` to Pi data. */
	provider: RawMessageProvider;
	/** Subagent runner (PiSubagentRunner instance) for historian spawn. */
	runner: SubagentRunner;
	/** Historian model id (provider/model) — required for PiSubagentRunner. */
	historianModel: string;
	/** Optional ordered fallback chain. */
	fallbackModels?: readonly string[];
	/** Historian context window — used to derive chunk token budget. */
	historianChunkTokens: number;
	/** Optional per-call timeout (default 120s). */
	historianTimeoutMs?: number;
	/** Cross-session memory feature gate (`memory.enabled`). */
	memoryEnabled?: boolean;
	/** Automatic-promotion gate (`memory.auto_promote`). */
	autoPromote?: boolean;
	/** Optional callback invoked on successful publication for cache-bust signaling. */
	onPublished?: () => void;
	/** Optional callback for surfacing failure notices (Pi UI / logs). */
	notifyIssue?: (message: string) => void | Promise<void>;
}

export async function runPiHistorian(deps: PiHistorianDeps): Promise<void> {
	const {
		db,
		sessionId,
		directory,
		provider,
		runner,
		historianModel,
		fallbackModels,
		historianChunkTokens,
		historianTimeoutMs = DEFAULT_HISTORIAN_TIMEOUT_MS,
		memoryEnabled,
		autoPromote,
		onPublished,
		notifyIssue,
	} = deps;

	const notify = async (message: string): Promise<void> => {
		if (shouldSuppressHistorianAlert(sessionId)) {
			sessionLog(sessionId, "historian alert suppressed (cooldown)");
			return;
		}
		try {
			await notifyIssue?.(message);
		} catch (error) {
			sessionLog(sessionId, "historian notify failed", {
				error: describeError(error).brief,
			});
		}
	};

	updateSessionMeta(db, sessionId, { compartmentInProgress: true });
	let completedSuccessfully = false;

	try {
		// All session-data reads in the historian path go through the shared
		// helpers, which consult our RawMessageProvider for this sessionId.
		// The withRawMessageProvider scope ensures we unregister even on throw.
		await withRawMessageProvider(sessionId, provider, async () => {
			const priorCompartments = getCompartments(db, sessionId);
			const priorFacts = getSessionFacts(db, sessionId);

			// Sanity-check existing stored state before touching anything.
			const existingValidationError =
				validateStoredCompartments(priorCompartments);
			if (existingValidationError) {
				sessionLog(
					sessionId,
					`pi-historian failure: source=existing-validation reason="${existingValidationError}"`,
				);
				await notify(
					`Historian skipped: existing stored compartments are invalid: ${existingValidationError}`,
				);
				return;
			}

			// Where does the new chunk start?
			const offset =
				priorCompartments.length > 0
					? priorCompartments[priorCompartments.length - 1].endMessage + 1
					: 1;

			const protectedTailStart = getProtectedTailStartOrdinal(sessionId);
			if (protectedTailStart <= offset) {
				sessionLog(
					sessionId,
					`pi-historian skip: protected tail covers all eligible history (offset=${offset}, protectedStart=${protectedTailStart})`,
				);
				return;
			}

			const chunk = readSessionChunk(
				sessionId,
				historianChunkTokens,
				offset,
				protectedTailStart,
			);
			if (!chunk.text || chunk.messageCount === 0) {
				sessionLog(
					sessionId,
					`pi-historian skip: empty chunk (offset=${offset}, protectedStart=${protectedTailStart})`,
				);
				return;
			}

			const chunkCoverageError = validateChunkCoverage(chunk);
			if (chunkCoverageError) {
				sessionLog(
					sessionId,
					`pi-historian failure: source=chunk-coverage reason="${chunkCoverageError}" chunkRange=${chunk.startIndex}-${chunk.endIndex}`,
				);
				await notify(
					`Historian skipped: raw chunk could not be safely chunked: ${chunkCoverageError}`,
				);
				return;
			}

			// Build prompt: include prior compartments, facts, AND read-only
			// memory block so historian can dedup new facts against existing
			// project memories. Cross-harness coherence comes free here —
			// memories written by OpenCode show up in this Pi historian run.
			const projectPath = resolveProjectIdentity(directory);
			const memories = getMemoriesByProject(db, projectPath, [
				"active",
				"permanent",
			]);
			const memoryBlock = renderMemoryBlock(memories) ?? undefined;

			const existingState =
				priorCompartments.length > 0 || priorFacts.length > 0
					? buildExistingStateXml(priorCompartments, priorFacts, memoryBlock)
					: memoryBlock
						? `${memoryBlock}\n\nThis is your first run. No existing compartments or facts.`
						: "This is your first run. No existing state.";

			const prompt = buildCompartmentAgentPrompt(
				existingState,
				`Messages ${chunk.startIndex}-${chunk.endIndex}:\n\n${chunk.text}`,
			);

			// Defensive: use MAX(sequence) + 1 over .length to survive any old
			// recomp gaps. Same logic as OpenCode runner.
			const maxExistingSequence = priorCompartments.reduce(
				(max, c) => (c.sequence > max ? c.sequence : max),
				-1,
			);
			const sequenceOffset =
				priorCompartments.length === 0 ? 0 : maxExistingSequence + 1;

			sessionLog(
				sessionId,
				`pi-historian: invoking subagent (model=${historianModel}, chunk=${chunk.startIndex}-${chunk.endIndex}, ${chunk.messageCount} msgs, ~${chunk.tokenEstimate} tokens)`,
			);

			// First pass.
			const firstResult = await runner.run({
				agent: HISTORIAN_AGENT_NAME,
				systemPrompt: COMPARTMENT_AGENT_SYSTEM_PROMPT,
				userMessage: prompt,
				model: historianModel,
				fallbackModels,
				timeoutMs: historianTimeoutMs,
				cwd: directory,
			});

			let validatedPass = await validateHistorianResult(
				firstResult,
				sessionId,
				chunk,
				priorCompartments,
				sequenceOffset,
			);

			// Repair retry on validation failure (mirrors OpenCode behavior).
			if (validatedPass.kind === "validation-failed") {
				sessionLog(
					sessionId,
					`pi-historian: first pass validation failed, retrying with repair prompt: ${validatedPass.error}`,
				);
				const repairPrompt = buildHistorianRepairPrompt(
					prompt,
					validatedPass.rawText,
					validatedPass.error,
				);
				const repairResult = await runner.run({
					agent: HISTORIAN_AGENT_NAME,
					systemPrompt: COMPARTMENT_AGENT_SYSTEM_PROMPT,
					userMessage: repairPrompt,
					model: historianModel,
					fallbackModels,
					timeoutMs: historianTimeoutMs,
					cwd: directory,
				});
				validatedPass = await validateHistorianResult(
					repairResult,
					sessionId,
					chunk,
					priorCompartments,
					sequenceOffset,
				);
			}

			if (validatedPass.kind !== "ok") {
				const errorMsg =
					validatedPass.kind === "validation-failed"
						? validatedPass.error
						: validatedPass.kind === "spawn-failed"
							? `subagent run failed (${validatedPass.reason}): ${validatedPass.error}`
							: "historian returned no usable text";
				sessionLog(sessionId, `pi-historian failure: ${errorMsg}`);
				incrementHistorianFailure(db, sessionId, errorMsg);
				await notify(`Historian failed: ${errorMsg}`);
				return;
			}

			const newCompartments = validatedPass.compartments;
			const lastNewEnd =
				newCompartments[newCompartments.length - 1]?.endMessage ?? 0;
			if (lastNewEnd + 1 <= offset) {
				const errorMsg = `historian returned compartments that did not advance past raw message ${offset - 1}`;
				sessionLog(
					sessionId,
					`pi-historian failure: source=no-progress newCompartmentCount=${newCompartments.length} lastNewEnd=${lastNewEnd} priorEnd=${offset - 1}`,
				);
				incrementHistorianFailure(db, sessionId, errorMsg);
				await notify(`Historian failed: ${errorMsg}`);
				return;
			}

			// Atomic publication: append + replace facts + clear failure state.
			db.transaction(() => {
				appendCompartments(db, sessionId, newCompartments);
				replaceSessionFacts(db, sessionId, validatedPass.facts ?? []);
				clearHistorianFailureState(db, sessionId);
			})();

			// Cache invalidation so the next transform rebuilds <session-history>.
			clearInjectionCache(sessionId);
			onPublished?.();

			// Cross-harness memory promotion — facts written by Pi historian
			// show up alongside facts written by OpenCode historian.
			if (memoryEnabled !== false && autoPromote !== false) {
				promoteSessionFactsToMemory(
					db,
					sessionId,
					projectPath,
					validatedPass.facts ?? [],
				);
			}

			queueDropsForCompartmentalizedMessages(db, sessionId, lastNewEnd);

			sessionLog(
				sessionId,
				`pi-historian: published ${newCompartments.length} compartment(s), ${validatedPass.facts?.length ?? 0} fact(s) covering messages ${chunk.startIndex}-${lastNewEnd}`,
			);
			completedSuccessfully = true;
		});
	} catch (error) {
		const desc = describeError(error);
		sessionLog(
			sessionId,
			`pi-historian failure: source=exception ${desc.brief}${desc.stackHead ? ` stackHead="${desc.stackHead}"` : ""}`,
		);
		incrementHistorianFailure(db, sessionId, desc.brief);
		await notify(`Historian failed unexpectedly: ${desc.brief}`);
	} finally {
		if (!completedSuccessfully) {
			updateSessionMeta(db, sessionId, { compartmentInProgress: false });
		} else {
			updateSessionMeta(db, sessionId, { compartmentInProgress: false });
		}
	}
}

/** Internal validation result classification — mirrors OpenCode pass result shape. */
type ValidationOutcome =
	| {
			kind: "ok";
			compartments: ReturnType<typeof validateHistorianOutput> extends infer T
				? T extends { ok: true; compartments: infer C }
					? C
					: never
				: never;
			facts: ReturnType<typeof validateHistorianOutput> extends infer T
				? T extends { ok: true; facts: infer F }
					? F
					: never
				: never;
			userObservations?: string[];
	  }
	| { kind: "validation-failed"; error: string; rawText: string }
	| { kind: "spawn-failed"; reason: string; error: string }
	| { kind: "no-output" };

async function validateHistorianResult(
	result: SubagentRunResult,
	sessionId: string,
	chunk: Parameters<typeof validateHistorianOutput>[2],
	priorCompartments: Parameters<typeof validateHistorianOutput>[3],
	sequenceOffset: number,
): Promise<ValidationOutcome> {
	if (!result.ok) {
		return {
			kind: "spawn-failed",
			reason: result.reason,
			error: result.error,
		};
	}
	if (result.assistantText.trim().length === 0) {
		return { kind: "no-output" };
	}

	const validation = validateHistorianOutput(
		result.assistantText,
		sessionId,
		chunk,
		priorCompartments,
		sequenceOffset,
	);
	if (validation.ok) {
		return {
			kind: "ok",
			compartments: validation.compartments,
			facts: validation.facts,
			userObservations: validation.userObservations,
		};
	}
	return {
		kind: "validation-failed",
		error: validation.error,
		rawText: result.assistantText,
	};
}
