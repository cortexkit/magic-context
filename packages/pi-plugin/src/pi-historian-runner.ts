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
	buildHistorianEditorPrompt,
	COMPARTMENT_AGENT_SYSTEM_PROMPT,
	HISTORIAN_EDITOR_SYSTEM_PROMPT,
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
	cleanupHistorianStateFile,
	maybeWriteHistorianStateFile,
} from "@magic-context/core/hooks/magic-context/historian-state-file";
import {
	clearInjectionCache,
	renderMemoryBlock,
} from "@magic-context/core/hooks/magic-context/inject-compartments";
import { onNoteTrigger } from "@magic-context/core/hooks/magic-context/note-nudger";
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
	SubagentProgressEvent,
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
	/** When true, run a second editor pass after a successful first pass to
	 *  clean low-signal U: lines and cross-compartment duplicates. Mirrors
	 *  OpenCode's `historian.two_pass` config. Editor validation falls back
	 *  to the first-pass result on failure. Default: false. */
	twoPass?: boolean;
	/** Pi only: explicit thinking level passed as --thinking <level> to
	 *  historian subagent invocations. When unset, Pi's own resolution runs
	 *  (works for most providers; may fail for e.g. github-copilot/gpt-5.4). */
	thinkingLevel?: string;
	/** Cross-session memory feature gate (`memory.enabled`). */
	memoryEnabled?: boolean;
	/** Automatic-promotion gate (`memory.auto_promote`). */
	autoPromote?: boolean;
	/** Optional callback invoked on successful publication for cache-bust signaling. */
	onPublished?: () => void;
	/** Optional Pi-native compaction append hook (`sessionManager.appendCompaction`). */
	appendCompaction?: (
		summary: string,
		firstKeptEntryId: string,
		tokensBefore: number,
		details?: unknown,
		fromHook?: boolean,
	) => string | undefined;
	/** Optional raw Pi branch entries used to map raw ordinals back to entry ids. */
	readBranchEntries?: () => unknown[];
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
		twoPass,
		thinkingLevel,
		memoryEnabled,
		autoPromote,
		onPublished,
		appendCompaction,
		readBranchEntries,
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
	let stateFilePath: string | undefined;

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

			// Offload large existing-state XML to a temp file so the inline
			// prompt body stays small. Long sessions accumulate hundreds of
			// compartments + memory + facts; passing 100K+ chars inline can
			// stall the model on certain provider/API combinations
			// (notably github-copilot/gpt-5.4 via the openai-responses API,
			// which buffers the full reasoning trace before emitting any
			// output). The historian agent has access to Pi's built-in Read
			// tool and the prompt instructs it to read the file before
			// processing the new chunk. Cleaned up in finally{}.
			stateFilePath = maybeWriteHistorianStateFile(sessionId, existingState);
			if (stateFilePath) {
				sessionLog(
					sessionId,
					`pi-historian: existing state offloaded to file (${existingState.length} chars) → ${stateFilePath}`,
				);
			}

			const prompt = buildCompartmentAgentPrompt(
				existingState,
				`Messages ${chunk.startIndex}-${chunk.endIndex}:\n\n${chunk.text}`,
				{ stateFilePath },
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

			// Verbose per-event tracing of the Pi child run. Every parsed
			// event from the subagent's NDJSON stream lands in
			// magic-context.log with phase=raw_event so we can reconstruct
			// what actually happened during a hang or a timeout. Phase
			// labels: spawned, first_event, raw_event, terminal, stderr,
			// child_exit. The trace is per-pass-prefixed so first/repair/
			// editor pass logs are unambiguous in the timeline.
			const buildProgressLogger = (passLabel: string) => {
				return (event: SubagentProgressEvent) => {
					try {
						if (event.type === "raw_event") {
							// Stringify with safe size cap so a giant
							// message body doesn't dominate the log.
							let serialized: string;
							try {
								serialized = JSON.stringify(event.event);
							} catch {
								serialized = "[unserializable]";
							}
							if (serialized.length > 4000) {
								serialized = `${serialized.slice(0, 4000)}…[truncated ${serialized.length - 4000} chars]`;
							}
							sessionLog(
								sessionId,
								`pi-historian[${passLabel}] raw_event @${event.ms}ms type=${event.eventType ?? "?"}: ${serialized}`,
							);
						} else if (event.type === "spawned") {
							sessionLog(
								sessionId,
								`pi-historian[${passLabel}] spawned pid=${event.pid ?? "?"} argv=${event.argv.length} args`,
							);
						} else if (event.type === "first_event") {
							sessionLog(
								sessionId,
								`pi-historian[${passLabel}] first_event @${event.ms}ms type=${event.eventType}`,
							);
						} else if (event.type === "terminal") {
							sessionLog(
								sessionId,
								`pi-historian[${passLabel}] terminal @${event.ms}ms stopReason=${event.stopReason ?? "?"} textLen=${event.textLength} hasToolCall=${event.hasToolCall}`,
							);
						} else if (event.type === "stderr") {
							const cleaned = event.chunk.replace(/\s+/g, " ").trim();
							if (cleaned.length > 0) {
								sessionLog(
									sessionId,
									`pi-historian[${passLabel}] stderr: ${cleaned.slice(0, 500)}`,
								);
							}
						} else if (event.type === "child_exit") {
							sessionLog(
								sessionId,
								`pi-historian[${passLabel}] child_exit @${event.ms}ms code=${event.code} signal=${event.signal}`,
							);
						}
					} catch {
						// Logging must never crash the runner.
					}
				};
			};

			// First pass.
			const firstResult = await runner.run({
				agent: HISTORIAN_AGENT_NAME,
				systemPrompt: COMPARTMENT_AGENT_SYSTEM_PROMPT,
				userMessage: prompt,
				model: historianModel,
				fallbackModels,
				timeoutMs: historianTimeoutMs,
				cwd: directory,
				thinkingLevel,
				onProgress: buildProgressLogger("first"),
			});

			let validatedPass = await validateHistorianResult(
				firstResult,
				sessionId,
				chunk,
				priorCompartments,
				sequenceOffset,
			);
			// Track which subagent run actually produced the validated
			// draft. This matters for the optional two-pass editor refinement
			// below: when first-pass validation fails but repair succeeds,
			// the editor must refine the REPAIR draft (the one that
			// validated), NOT the original first-pass text. Mirrors
			// OpenCode parity in `compartment-runner-historian.ts`,
			// which feeds `firstRun.result` or `repairRun.result` into
			// `runEditorPassOrFallback` based on which run validated.
			let validatedDraftText: string | null = firstResult.ok
				? firstResult.assistantText
				: null;

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
					thinkingLevel,
					onProgress: buildProgressLogger("repair"),
				});
				validatedPass = await validateHistorianResult(
					repairResult,
					sessionId,
					chunk,
					priorCompartments,
					sequenceOffset,
				);
				// If repair produced a valid result, that's the draft we
				// want the editor to refine. (If repair also failed,
				// validatedDraftText doesn't matter — we'll bail before
				// the editor block.)
				if (validatedPass.kind === "ok" && repairResult.ok) {
					validatedDraftText = repairResult.assistantText;
				}
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

			// Optional two-pass editor refinement. Mirrors OpenCode's
			// `runEditorPassOrFallback` in `compartment-runner-historian.ts`.
			// When `historian.two_pass` is enabled, the validated draft is
			// fed back to the historian agent with the editor system
			// prompt. The editor cleans low-signal U: lines and
			// cross-compartment redundancy. If the editor pass fails or
			// its output fails validation, we fall back to the draft.
			if (twoPass && validatedPass.kind === "ok") {
				// Feed the editor the draft that ACTUALLY validated. Without
				// this fix, when first-pass spawn-failed and repair succeeded,
				// the editor would silently get an empty string and skip the
				// editor pass entirely (silent feature regression). When
				// first-pass validation-failed (parsed but invalid) and repair
				// succeeded, the editor would refine the BAD original draft
				// instead of the repaired one. See parity audit Round 7.
				const draftAssistantText = validatedDraftText ?? "";
				if (draftAssistantText.trim().length > 0) {
					sessionLog(
						sessionId,
						"pi-historian two-pass: running editor on draft",
					);
					const editorResult = await runner.run({
						agent: HISTORIAN_AGENT_NAME,
						systemPrompt: HISTORIAN_EDITOR_SYSTEM_PROMPT,
						userMessage: buildHistorianEditorPrompt(draftAssistantText),
						model: historianModel,
						fallbackModels,
						timeoutMs: historianTimeoutMs,
						cwd: directory,
						thinkingLevel,
						onProgress: buildProgressLogger("editor"),
					});
					const editorPass = await validateHistorianResult(
						editorResult,
						sessionId,
						chunk,
						priorCompartments,
						sequenceOffset,
					);
					if (editorPass.kind === "ok") {
						sessionLog(
							sessionId,
							`pi-historian two-pass: editor accepted, replacing draft`,
						);
						validatedPass = editorPass;
					} else {
						const editorErr =
							editorPass.kind === "validation-failed"
								? editorPass.error
								: editorPass.kind === "spawn-failed"
									? `subagent run failed (${editorPass.reason}): ${editorPass.error}`
									: "editor returned no usable text";
						sessionLog(
							sessionId,
							`pi-historian two-pass: editor failed (${editorErr}), falling back to draft`,
						);
						// Keep validatedPass as the first-pass result.
					}
				}
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

			appendPiNativeCompaction({
				sessionId,
				appendCompaction,
				readBranchEntries,
				lastCompactedOrdinal: lastNewEnd,
				tokensBefore: chunk.tokenEstimate,
				summary: buildPiCompactionSummary(newCompartments),
			});

			// Cache invalidation so the next transform rebuilds <session-history>.
			clearInjectionCache(sessionId);

			// Note-nudge trigger #1 (of 3): historian publication is a natural
			// work boundary, so signal that deferred notes should surface on
			// the next user turn. Mirrors OpenCode's
			// `compartment-runner-incremental.ts:274` placement.
			onNoteTrigger(db, sessionId, "historian_complete");

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
		// Best-effort cleanup of the temp state file written when existing
		// state exceeded the inline threshold. Safe with undefined.
		cleanupHistorianStateFile(stateFilePath);
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

function buildPiCompactionSummary(
	compartments: Array<{
		title: string;
		startMessage: number;
		endMessage: number;
	}>,
): string {
	if (compartments.length === 0)
		return "Magic Context compacted prior history.";
	const titles = compartments
		.map((c) => c.title.trim())
		.filter((title) => title.length > 0);
	if (titles.length === 0) {
		const first = compartments[0];
		const last = compartments[compartments.length - 1];
		return `Magic Context compacted messages ${first?.startMessage ?? "?"}-${last?.endMessage ?? "?"}.`;
	}
	return `Magic Context compacted: ${titles.join("; ")}`;
}

function appendPiNativeCompaction(args: {
	sessionId: string;
	appendCompaction?: PiHistorianDeps["appendCompaction"];
	readBranchEntries?: () => unknown[];
	lastCompactedOrdinal: number;
	tokensBefore: number;
	summary: string;
}): void {
	const { appendCompaction, readBranchEntries } = args;
	if (!appendCompaction || !readBranchEntries) return;

	try {
		const firstKeptEntryId = findFirstKeptEntryId(
			readBranchEntries(),
			args.lastCompactedOrdinal,
		);
		if (!firstKeptEntryId) {
			sessionLog(
				args.sessionId,
				`pi-historian: native compaction skipped; no firstKeptEntryId after ordinal ${args.lastCompactedOrdinal}`,
			);
			return;
		}

		appendCompaction(
			args.summary,
			firstKeptEntryId,
			args.tokensBefore,
			{
				source: "magic-context",
				lastCompactedOrdinal: args.lastCompactedOrdinal,
			},
			true,
		);
		sessionLog(
			args.sessionId,
			`pi-historian: appended native compaction firstKept=${firstKeptEntryId} tokensBefore=${args.tokensBefore}`,
		);
	} catch (error) {
		sessionLog(
			args.sessionId,
			`pi-historian: native compaction append failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function findFirstKeptEntryId(
	entries: unknown[],
	lastCompactedOrdinal: number,
): string | null {
	let ordinal = 0;
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const e = entry as { type?: unknown; id?: unknown; message?: unknown };
		if (e.type !== "message") continue;
		const role = (e.message as { role?: unknown } | undefined)?.role;
		if (role !== "user" && role !== "assistant") continue;
		ordinal++;
		if (ordinal === lastCompactedOrdinal + 1) {
			return typeof e.id === "string" && e.id.length > 0 ? e.id : null;
		}
	}
	return null;
}
