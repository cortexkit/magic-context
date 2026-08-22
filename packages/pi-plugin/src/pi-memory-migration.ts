import { withMigrationLanguageDirective } from "@magic-context/core/agents/language-directive";
import {
	applyMemoryMigration,
	buildMemoryMigrationPrompt,
	isMemoryMigrationDone,
	markMemoryMigrationDone,
	parseMemoryMigrationOutput,
} from "@magic-context/core/features/magic-context/memory/memory-migration";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import { getAllActiveMemoriesForMigration } from "@magic-context/core/features/magic-context/memory/storage-memory";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { insertUserMemoryCandidates } from "@magic-context/core/features/magic-context/user-memory/storage-user-memory";
import { sessionLog } from "@magic-context/core/shared/logger";
import type {
	ModelInput,
	ResolvedModelEntry,
} from "@magic-context/core/shared/model-resolution";
import type { SubagentRunner } from "@magic-context/core/shared/subagent-runner";

/**
 * Pi memory migration (E6c parity with OpenCode E3.2).
 *
 * Re-evaluates the project's memories into the v2 5-category taxonomy using the
 * Pi historian subagent runner directly (no OpenCode-client emulation needed).
 * Reuses the shared pure pieces (prompt builder, parser, apply, once-per-project
 * guard). Idempotent + project-scoped — runs at most once per project.
 */

const MIGRATION_SYSTEM_PROMPT =
	"You re-organize a software project's long-term memory into a stricter taxonomy. " +
	"Follow the user instructions exactly. Output ONLY the requested XML blocks, nothing else.";

export interface PiMemoryMigrationDeps {
	db: ContextDatabase;
	runner: SubagentRunner;
	model: string;
	/**
	 * Optional session MAIN model to run the migration on FIRST (parity with
	 * OpenCode's `primaryModelId`). The migration is a quality-sensitive
	 * consolidation, so the user's working interactive model — typically
	 * stronger and guaranteed-present — should lead, with `model` (historian)
	 * and `fallbackModels` as the safety net behind it. When omitted the chain
	 * starts at `model` (the historian model), preserving prior behavior.
	 */
	primaryModel?: string;
	fallbackModels?: readonly ModelInput[];
	timeoutMs?: number;
	thinkingLevel?: string;
	/** Project working directory (resolves project identity). */
	directory: string;
	/** Allow a session started exactly in the canonical home directory only when user-level configuration enables it. */
	allowHomeProject?: boolean;
	/** Session id used for token accounting attribution. */
	sessionId: string;
	/** Route user_observations to the user-memory candidate pool when enabled. */
	userMemoriesEnabled?: boolean;
	language?: string;
	signal?: AbortSignal;
}

export interface PiMemoryMigrationOutcome {
	ran: boolean;
	summary: string;
}

const CANCELLED_OUTCOME: PiMemoryMigrationOutcome = {
	ran: false,
	summary: "Memory migration cancelled during session shutdown.",
};

export async function runPiMemoryMigration(
	deps: PiMemoryMigrationDeps,
): Promise<PiMemoryMigrationOutcome> {
	if (deps.signal?.aborted) return CANCELLED_OUTCOME;
	const projectPath = resolveProjectIdentityForSession(
		deps.directory,
		deps.allowHomeProject,
	);
	if (!projectPath) {
		return {
			ran: false,
			summary: "No project identity is bound for the home directory.",
		};
	}

	if (isMemoryMigrationDone(deps.db, projectPath)) {
		return {
			ran: false,
			summary: "Memories were already migrated for this project.",
		};
	}

	// Only `active` memories are migrated; `permanent` (user-curated) rows are
	// left untouched (see applyMemoryMigration). Load the EXACT set we mutate —
	// all active rows including expired (getAllActiveMemoriesForMigration), so the
	// prompt and the destructive apply operate on the same set (parity with
	// OpenCode; fixes the expired-survivor partial-wipe bug).
	const memories = getAllActiveMemoriesForMigration(deps.db, projectPath);
	if (memories.length === 0) {
		markMemoryMigrationDone(deps.db, projectPath);
		return { ran: false, summary: "No project memories to migrate." };
	}

	const prompt = buildMemoryMigrationPrompt(memories);

	// Escalate through the configured fallback chain on EMPTY/UNPARSEABLE output,
	// not just on a HARD subagent failure. `runner.run({ fallbackModels })` only
	// iterates its chain on spawn/non-zero/truncated failures; a model that
	// returns ok-but-empty (e.g. a misconfigured primary that emits nothing) or
	// replies without a <migrated> block passes that gate and would bail here
	// without the chain ever being tried. Try each model in order, validating
	// output, until one parses.
	//
	// Chain head = primaryModel when provided (the upgrade path passes the
	// session MAIN model), ELSE the historian model — NOT both. This exactly
	// mirrors OpenCode's `[primaryModelId ?? historian-default, ...fallbackModels]`
	// (memory-migration.ts:321): the historian model is the head ONLY when no
	// session-model primary is given, never an always-present 2nd element.
	// Inserting `model` (historian) between primary and fallbacks would make Pi
	// run a different 2nd model than OpenCode on the rare primary-failure path —
	// and for a misconfigured historian (e.g. an empty-returning provider) it
	// would waste an attempt on a model OpenCode never tries. Then the configured
	// fallbacks. Each de-duplicated.
	const modelChain: ResolvedModelEntry[] = [];
	const seenModels = new Set<string>();
	for (const candidate of [
		{
			model: deps.primaryModel ?? deps.model,
			...(deps.primaryModel
				? {}
				: deps.thinkingLevel
					? { qualifier: deps.thinkingLevel }
					: {}),
		},
		...(deps.fallbackModels ?? []).map((fallback) =>
			typeof fallback === "string" ? { model: fallback } : fallback,
		),
	]) {
		const key = `${candidate.model}\u0000${candidate.qualifier ?? ""}`;
		if (candidate.model && !seenModels.has(key)) {
			seenModels.add(key);
			modelChain.push(candidate);
		}
	}

	let parsed: ReturnType<typeof parseMemoryMigrationOutput> | null = null;
	let lastFailReason = "no output";
	for (let i = 0; i < modelChain.length; i += 1) {
		if (deps.signal?.aborted) return CANCELLED_OUTCOME;
		const model = modelChain[i];
		if (i > 0) {
			sessionLog(
				deps.sessionId,
				`memory-migration: escalating to configured fallback model ${model.model} (${i}/${modelChain.length - 1})`,
			);
		}
		const result = await deps.runner.run({
			agent: "magic-context-historian",
			systemPrompt: withMigrationLanguageDirective(
				MIGRATION_SYSTEM_PROMPT,
				deps.language,
			),
			userMessage: prompt,
			model: model.model,
			// We drive the chain here (validating each), so don't let the runner
			// re-iterate its own hard-failure-only chain.
			fallbackModels: undefined,
			timeoutMs: deps.timeoutMs ?? 5 * 60 * 1000,
			cwd: deps.directory,
			thinkingLevel: model.qualifier,
			accountingSessionId: deps.sessionId,
			// Reuse the "recomp" accounting bucket — memory migration is part of the
			// session-upgrade flow and there is no dedicated subagent tag for it.
			accountingSubagent: "recomp",
			signal: deps.signal,
		});
		if (deps.signal?.aborted) return CANCELLED_OUTCOME;

		if (!result.ok) {
			lastFailReason = `historian ${result.reason}`;
			continue; // hard failure → escalate
		}
		const candidate = parseMemoryMigrationOutput(result.assistantText);
		if (!candidate.parsed) {
			lastFailReason = "no usable output";
			continue; // empty / no <migrated> block → escalate
		}
		parsed = candidate; // first usable result wins
		break;
	}

	// An UNPARSEABLE result (across all models) aborts.
	if (!parsed) {
		return {
			ran: false,
			summary: `Memory migration produced no usable output (${lastFailReason}); memories unchanged.`,
		};
	}

	// SAFETY (parity with OpenCode runMemoryMigration): a parsed <migrated> block
	// with ZERO recognized v2-category memories is NOT a successful migration —
	// applying it would hard-delete the whole active pool and insert nothing (root
	// cause, dogfood 2026-05-31). Refuse the destructive apply AND do NOT set the
	// once-per-project guard, so a later retry with a capable model can migrate.
	if (parsed.memories.length === 0) {
		return {
			ran: false,
			summary:
				"Memory migration skipped: the model returned no usable re-categorized memories (an empty or malformed result). Your memories are unchanged. Point `historian.model` at a capable model and re-run /ctx-session-upgrade.",
		};
	}

	// USER_* safety: never delete the pool when user traits were
	// extracted but cannot be durably stored.
	if (parsed.userObservations.length > 0 && !deps.userMemoriesEnabled) {
		return {
			ran: false,
			summary:
				"Memory migration skipped: the model extracted user traits but user memories are disabled. Enable `dreamer.user_memories` so they can be preserved, then re-run /ctx-session-upgrade.",
		};
	}

	if (deps.signal?.aborted) return CANCELLED_OUTCOME;
	// Persist observations BEFORE the destructive apply.
	let routed = 0;
	if (deps.userMemoriesEnabled && parsed.userObservations.length > 0) {
		insertUserMemoryCandidates(
			deps.db,
			parsed.userObservations.map((content) => ({
				content,
				sessionId: deps.sessionId,
			})),
		);
		routed = parsed.userObservations.length;
	}

	// Apply the destructive rewrite AND set the done-guard atomically (parity with
	// OpenCode). Separate, a crash between them leaves the project migrated-to-v2
	// but UNGUARDED, so a retry re-migrates v2 rows. A nested db.transaction() runs
	// as a savepoint, so applyMemoryMigration's inner transaction still works.
	const { removed, inserted } = deps.db.transaction(() => {
		const counts = applyMemoryMigration(deps.db, projectPath, parsed);
		markMemoryMigrationDone(deps.db, projectPath);
		return counts;
	})();
	return {
		ran: true,
		summary: `Re-evaluated ${removed} memor${removed === 1 ? "y" : "ies"} into ${inserted} v2-taxonomy memor${inserted === 1 ? "y" : "ies"}${routed > 0 ? `, routed ${routed} user trait${routed === 1 ? "" : "s"} to your profile` : ""}.`,
	};
}
