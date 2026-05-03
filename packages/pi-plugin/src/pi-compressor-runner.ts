/**
 * Pi compressor runner — parity with OpenCode's
 * `compartment-runner-compressor.ts`.
 *
 * OpenCode runs a second-stage historian when the rendered
 * `<session-history>` block grows beyond budget. It selects the oldest
 * contiguous run inside the lowest available compression-depth tier,
 * merges it through the historian model, then increments depth counters
 * for the covered raw ordinals.
 *
 * Pi uses the same shared compartment/fact/depth tables and prompt
 * builders, but invokes the model through `SubagentRunner` (normally
 * `PiSubagentRunner`) rather than OpenCode's child-session SDK. The
 * publication side only rewrites compartment rows and depth counters;
 * it deliberately does NOT touch Pi compaction-marker state. The caller
 * signals `historyRefreshSessions` so compressed output becomes visible
 * on a later natural cache-busting transform pass.
 */

import {
	COMPRESSOR_MERGE_RATIO_BY_DEPTH,
	DEFAULT_COMPRESSOR_GRACE_COMPARTMENTS,
	DEFAULT_COMPRESSOR_MAX_COMPARTMENTS_PER_PASS,
	DEFAULT_COMPRESSOR_MAX_MERGE_DEPTH,
	DEFAULT_COMPRESSOR_MIN_COMPARTMENT_RATIO,
	DEFAULT_HISTORIAN_TIMEOUT_MS,
} from "@magic-context/core/config/schema/magic-context";
import type { Compartment } from "@magic-context/core/features/magic-context/compartment-storage";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import {
	getAverageCompressionDepth,
	getCompartments,
	getSessionFacts,
	incrementCompressionDepth,
	replaceAllCompartmentState,
} from "@magic-context/core/features/magic-context/storage";
import type { CavemanLevel } from "@magic-context/core/hooks/magic-context/caveman";
import { cavemanCompress } from "@magic-context/core/hooks/magic-context/caveman";
import { parseCompartmentOutput } from "@magic-context/core/hooks/magic-context/compartment-parser";
import {
	buildCompressorPrompt,
	COMPARTMENT_AGENT_SYSTEM_PROMPT,
} from "@magic-context/core/hooks/magic-context/compartment-prompt";
import { estimateTokens } from "@magic-context/core/hooks/magic-context/read-session-formatting";
import { describeError } from "@magic-context/core/shared/error-message";
import { sessionLog } from "@magic-context/core/shared/logger";
import type { SubagentRunner } from "@magic-context/core/shared/subagent-runner";

const COMPRESSOR_AGENT_NAME = "magic-context-compressor";

export interface PiCompressorDeps {
	db: ContextDatabase;
	sessionId: string;
	directory: string;
	runner: SubagentRunner;
	historianModel: string;
	fallbackModels?: readonly string[];
	historyBudgetTokens: number;
	historianTimeoutMs?: number;
	/** Pi only: explicit thinking level for compressor subagent invocations. */
	thinkingLevel?: string;
	minCompartmentRatio?: number;
	maxMergeDepth?: number;
	maxCompartmentsPerPass?: number;
	graceCompartments?: number;
	onPublished?: () => void;
}

interface ScoredCompartment {
	compartment: Compartment;
	index: number;
	tokenEstimate: number;
	averageDepth: number;
}

interface SelectionConstraints {
	maxPickable: number;
	maxMergeDepth: number;
	graceCompartments: number;
	floorHeadroom: number;
}

function cavemanLevelForDepth(outputDepth: number): CavemanLevel | null {
	if (outputDepth <= 1) return null;
	if (outputDepth === 2) return "lite";
	if (outputDepth === 3) return "full";
	if (outputDepth === 4) return "ultra";
	return null;
}

function compartmentTokenEstimate(
	compartment: Pick<
		Compartment,
		"startMessage" | "endMessage" | "title" | "content"
	>,
): number {
	return estimateTokens(
		`<compartment start="${compartment.startMessage}" end="${compartment.endMessage}" title="${compartment.title}">\n${compartment.content}\n</compartment>\n`,
	);
}

function scoreCompartments(
	db: ContextDatabase,
	sessionId: string,
	compartments: Compartment[],
): ScoredCompartment[] {
	return compartments.map((compartment, index) => ({
		compartment,
		index,
		tokenEstimate: compartmentTokenEstimate(compartment),
		averageDepth: getAverageCompressionDepth(
			db,
			sessionId,
			compartment.startMessage,
			compartment.endMessage,
		),
	}));
}

/**
 * Exported for tests. Same selection contract as OpenCode: try depth
 * tiers ascending, oldest contiguous same-depth run within a tier,
 * excluding a freshness grace tail and respecting floor/max caps.
 */
export function selectPiCompressionBand(
	scored: ScoredCompartment[],
	constraints: SelectionConstraints,
): ScoredCompartment[] {
	const { maxPickable, maxMergeDepth, graceCompartments, floorHeadroom } =
		constraints;
	const hardMaxPick = Math.max(0, Math.min(maxPickable, floorHeadroom));
	if (hardMaxPick < 2) return [];

	const scanEnd = Math.max(0, scored.length - graceCompartments);
	if (scanEnd < 2) return [];

	const tiers = new Set<number>();
	for (let i = 0; i < scanEnd; i++) {
		const entry = scored[i];
		if (!entry) continue;
		if (entry.averageDepth >= maxMergeDepth) continue;
		tiers.add(Math.round(entry.averageDepth));
	}

	for (const targetDepth of [...tiers].sort((a, b) => a - b)) {
		let i = 0;
		while (i < scanEnd) {
			const anchor = scored[i];
			if (
				!anchor ||
				anchor.averageDepth >= maxMergeDepth ||
				Math.round(anchor.averageDepth) !== targetDepth
			) {
				i++;
				continue;
			}

			let j = i;
			while (j < scanEnd) {
				const entry = scored[j];
				if (!entry) break;
				if (entry.averageDepth >= maxMergeDepth) break;
				if (Math.round(entry.averageDepth) !== targetDepth) break;
				if (j - i >= hardMaxPick) break;
				j++;
			}

			if (j - i >= 2) return scored.slice(i, j);
			i = Math.max(j, i + 1);
		}
	}

	return [];
}

export async function runPiCompressionPassIfNeeded(
	deps: PiCompressorDeps,
): Promise<boolean> {
	const {
		db,
		sessionId,
		historyBudgetTokens,
		minCompartmentRatio = DEFAULT_COMPRESSOR_MIN_COMPARTMENT_RATIO,
		maxMergeDepth = DEFAULT_COMPRESSOR_MAX_MERGE_DEPTH,
		maxCompartmentsPerPass = DEFAULT_COMPRESSOR_MAX_COMPARTMENTS_PER_PASS,
		graceCompartments = DEFAULT_COMPRESSOR_GRACE_COMPARTMENTS,
		onPublished,
	} = deps;

	const compartments = getCompartments(db, sessionId);
	if (compartments.length <= 1) return false;

	const facts = getSessionFacts(db, sessionId);
	let totalTokens = 0;
	for (const c of compartments) totalTokens += compartmentTokenEstimate(c);
	for (const f of facts) totalTokens += estimateTokens(`* ${f.content}\n`);

	if (totalTokens <= historyBudgetTokens) {
		sessionLog(
			sessionId,
			`pi-compressor: history block ~${totalTokens} tokens within budget ${historyBudgetTokens}, skipping`,
		);
		return false;
	}

	const lastEndMessage = compartments[compartments.length - 1]?.endMessage ?? 0;
	const floor = Math.max(1, Math.ceil(lastEndMessage / minCompartmentRatio));
	const floorHeadroom = compartments.length - floor;
	if (floorHeadroom < 1) {
		sessionLog(
			sessionId,
			`pi-compressor: no floor headroom (${compartments.length} compartments, floor=${floor}), skipping`,
		);
		return false;
	}

	const scored = scoreCompartments(db, sessionId, compartments);
	const band = selectPiCompressionBand(scored, {
		maxPickable: maxCompartmentsPerPass,
		maxMergeDepth,
		graceCompartments,
		floorHeadroom,
	});
	if (band.length < 2) {
		sessionLog(
			sessionId,
			`pi-compressor: no eligible same-depth band found (floor=${floor}, maxDepth=${maxMergeDepth}, grace=${graceCompartments}, maxPerPass=${maxCompartmentsPerPass}), skipping`,
		);
		return false;
	}

	const firstIndex = band[0]?.index ?? 0;
	const lastIndex = band[band.length - 1]?.index ?? firstIndex;
	const selectedCompartments = band.map((s) => s.compartment);
	const selectedTokens = band.reduce((sum, s) => sum + s.tokenEstimate, 0);
	const avgDepth =
		band.reduce((sum, s) => sum + s.averageDepth, 0) / band.length;
	const outputDepth = Math.min(5, Math.max(1, Math.round(avgDepth) + 1));
	const mergeRatio = COMPRESSOR_MERGE_RATIO_BY_DEPTH[outputDepth] ?? 2.0;
	const outputCount =
		mergeRatio > 0 ? Math.max(1, Math.ceil(band.length / mergeRatio)) : 1;

	sessionLog(
		sessionId,
		`pi-compressor: picked ${band.length} compartments (${selectedCompartments[0]?.startMessage}-${selectedCompartments[selectedCompartments.length - 1]?.endMessage}, ~${selectedTokens} tokens), avg_depth=${avgDepth.toFixed(1)} → output_depth=${outputDepth}`,
	);

	if (outputDepth === 5) {
		const compressed = selectedCompartments.map((c) => ({
			startMessage: c.startMessage,
			endMessage: c.endMessage,
			startMessageId: c.startMessageId,
			endMessageId: c.endMessageId,
			title: c.title,
			content: "",
		}));
		const ok = finalizeCompression({
			db,
			sessionId,
			compartments,
			leadingCount: firstIndex,
			trailingIndex: lastIndex + 1,
			compressed,
			originalStart: selectedCompartments[0]?.startMessage ?? 0,
			originalEnd:
				selectedCompartments[selectedCompartments.length - 1]?.endMessage ?? 0,
			facts,
			logLabel: `depth-5 title-only collapse (${selectedCompartments.length} → ${compressed.length})`,
		});
		if (ok) onPublished?.();
		return ok;
	}

	const llmCompressed = await runCompressorPass({
		...deps,
		compartments: selectedCompartments,
		currentTokens: selectedTokens,
		targetTokens: Math.max(200, Math.floor(selectedTokens / mergeRatio)),
		outputCount,
		outputDepth,
	});
	if (!llmCompressed) return false;

	const level = cavemanLevelForDepth(outputDepth);
	const finalCompressed = level
		? llmCompressed.map((c) => ({
				...c,
				content: cavemanCompress(c.content, level),
			}))
		: llmCompressed;
	const ok = finalizeCompression({
		db,
		sessionId,
		compartments,
		leadingCount: firstIndex,
		trailingIndex: lastIndex + 1,
		compressed: finalCompressed,
		originalStart: selectedCompartments[0]?.startMessage ?? 0,
		originalEnd:
			selectedCompartments[selectedCompartments.length - 1]?.endMessage ?? 0,
		facts,
		logLabel: `depth-${outputDepth} (${selectedCompartments.length} → ${finalCompressed.length})`,
	});
	if (ok) onPublished?.();
	return ok;
}

async function runCompressorPass(
	args: PiCompressorDeps & {
		compartments: Compartment[];
		currentTokens: number;
		targetTokens: number;
		outputCount: number;
		outputDepth: number;
	},
): Promise<Array<{
	startMessage: number;
	endMessage: number;
	startMessageId: string;
	endMessageId: string;
	title: string;
	content: string;
}> | null> {
	const prompt = buildCompressorPrompt(
		args.compartments,
		args.currentTokens,
		args.targetTokens,
		args.outputDepth,
		args.outputCount,
	);

	try {
		const result = await args.runner.run({
			agent: COMPRESSOR_AGENT_NAME,
			systemPrompt: COMPARTMENT_AGENT_SYSTEM_PROMPT,
			userMessage: prompt,
			model: args.historianModel,
			fallbackModels: args.fallbackModels,
			timeoutMs: args.historianTimeoutMs ?? DEFAULT_HISTORIAN_TIMEOUT_MS,
			cwd: args.directory,
			thinkingLevel: args.thinkingLevel,
		});
		if (!result.ok) {
			sessionLog(
				args.sessionId,
				`pi-compressor: subagent failed (${result.reason}): ${result.error}`,
			);
			return null;
		}

		const parsed = parseCompartmentOutput(result.assistantText);
		if (parsed.compartments.length === 0) {
			sessionLog(
				args.sessionId,
				"pi-compressor: historian returned no compartments",
			);
			return null;
		}

		const snapped = snapLLMOutputToInputBoundaries(
			parsed.compartments,
			args.compartments,
		);
		if (!snapped) {
			sessionLog(
				args.sessionId,
				"pi-compressor: rejecting — LLM output contains ordinal(s) outside input range",
			);
			return null;
		}
		return snapped.result;
	} catch (error) {
		const desc = describeError(error);
		sessionLog(
			args.sessionId,
			`pi-compressor: subagent exception: ${desc.brief}`,
		);
		return null;
	}
}

function snapLLMOutputToInputBoundaries(
	llmOutput: Array<{
		startMessage: number;
		endMessage: number;
		title: string;
		content: string;
	}>,
	inputCompartments: Compartment[],
): {
	result: Array<{
		startMessage: number;
		endMessage: number;
		startMessageId: string;
		endMessageId: string;
		title: string;
		content: string;
	}>;
} | null {
	const sorted = [...inputCompartments].sort(
		(a, b) => a.startMessage - b.startMessage,
	);
	const containing = (ord: number): Compartment | null => {
		let lo = 0;
		let hi = sorted.length - 1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			const c = sorted[mid];
			if (!c) return null;
			if (ord < c.startMessage) hi = mid - 1;
			else if (ord > c.endMessage) lo = mid + 1;
			else return c;
		}
		return null;
	};

	const result = [];
	for (const pc of llmOutput) {
		const startOwner = containing(pc.startMessage);
		const endOwner = containing(pc.endMessage);
		if (!startOwner || !endOwner) return null;
		result.push({
			startMessage: startOwner.startMessage,
			endMessage: endOwner.endMessage,
			startMessageId: startOwner.startMessageId,
			endMessageId: endOwner.endMessageId,
			title: pc.title,
			content: pc.content,
		});
	}
	return { result };
}

function finalizeCompression(args: {
	db: ContextDatabase;
	sessionId: string;
	compartments: Compartment[];
	leadingCount: number;
	trailingIndex: number;
	compressed: Array<{
		startMessage: number;
		endMessage: number;
		startMessageId: string;
		endMessageId: string;
		title: string;
		content: string;
	}>;
	originalStart: number;
	originalEnd: number;
	facts: Array<{ category: string; content: string }>;
	logLabel: string;
}): boolean {
	const {
		db,
		sessionId,
		compartments,
		compressed,
		originalStart,
		originalEnd,
	} = args;
	const compressedStart = compressed[0]?.startMessage ?? 0;
	const compressedEnd = compressed[compressed.length - 1]?.endMessage ?? 0;
	if (compressedStart !== originalStart || compressedEnd !== originalEnd) {
		sessionLog(
			sessionId,
			`pi-compressor: compressed range ${compressedStart}-${compressedEnd} doesn't match original ${originalStart}-${originalEnd}, aborting`,
		);
		return false;
	}

	for (let i = 1; i < compressed.length; i++) {
		const prev = compressed[i - 1];
		const curr = compressed[i];
		if (!prev || !curr || curr.startMessage !== prev.endMessage + 1) {
			sessionLog(
				sessionId,
				`pi-compressor: non-contiguous output at index ${i}`,
			);
			return false;
		}
	}

	const leading = compartments.slice(0, args.leadingCount);
	const trailing = compartments.slice(args.trailingIndex);
	const allCompartments = [
		...leading.map((c, i) => ({ ...c, sequence: i })),
		...compressed.map((c, i) => ({ ...c, sequence: leading.length + i })),
		...trailing.map((c, i) => ({
			...c,
			sequence: leading.length + compressed.length + i,
		})),
	];

	replaceAllCompartmentState(db, sessionId, allCompartments, args.facts);
	incrementCompressionDepth(db, sessionId, originalStart, originalEnd);
	sessionLog(sessionId, `pi-compressor: completed ${args.logLabel}`);
	return true;
}

const lastCompressorRunBySession = new Map<string, number>();

export function isPiCompressorOnCooldown(
	sessionId: string,
	cooldownMs: number,
): boolean {
	const last = lastCompressorRunBySession.get(sessionId);
	return last !== undefined && Date.now() - last < cooldownMs;
}

export function markPiCompressorRun(sessionId: string): void {
	lastCompressorRunBySession.set(sessionId, Date.now());
}

export function clearPiCompressorState(sessionId: string): void {
	lastCompressorRunBySession.delete(sessionId);
}
