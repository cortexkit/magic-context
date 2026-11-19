/**
 * Size a historian prompt to the producer model's window before anything is
 * spawned.
 *
 * A historian prompt has fixed parts (system prompt, seed examples, recent
 * compartments, the project-memory block, instructions) plus the chunk of raw
 * history being summarized. The chunk budget alone used to be a share of the
 * window, so on a small window or with a large memory block the whole prompt
 * could exceed the window; admission then refused it on every trigger and the
 * session was never summarized again.
 *
 * `fitHistorianPrompt` reserves the fixed parts and the output first, then gives
 * the chunk what remains in the smallest window among the models the prompt may
 * be sent to (the primary and its fallbacks): the prompt is built once and every
 * attempt sends the same bytes. When the full requested chunk does not fit, it trims
 * the fixed context in this order until it does: diverse older compartments,
 * recent compartments (oldest first), project-memory lines (lowest priority
 * first), then seed examples. Recent examples preserve continuity without scores
 * to prevent anchoring in one-compartment runs; diverse examples carry scores.
 * When everything is trimmed, the chunk shrinks to whatever room is left. Only
 * when not even a minimal chunk fits is the prompt refused, with a reason that
 * stays identical until the model, its window, or the instructions change, so a
 * caller can back off on it.
 */

import { withContentLanguageDirective } from "../../agents/language-directive";
import type { Memory } from "../../features/magic-context/memory/types";
import { readEnabledProjectMemories } from "../../features/magic-context/memory-enabled";
import type { ModelInput } from "../../shared/model-resolution";
import { getSdkOutputLimit } from "../../shared/models-dev-cache";
import { toModelEntry } from "../../shared/resolve-fallbacks";
import type { Database } from "../../shared/sqlite";
import { buildCompartmentAgentPrompt, COMPARTMENT_AGENT_SYSTEM_PROMPT } from "./compartment-prompt";
import { calibrationForModelKey, providerMass } from "./decision-calibration";
import { resolveHistorianProducerLimits } from "./derive-budgets";
import {
    DEFAULT_MEMORY_BUDGET_TOKENS,
    orderHistorianMemories,
    readM0ProjectMemories,
    renderHistorianMemoryBlock,
    resolveWorkspaceRenderContext,
    sourceNamesForMemories,
    trimMemoriesToBudgetV2,
    trimWorkspaceMemoriesToBudgetV2,
} from "./inject-compartments";
import { historianProducerReserve, producerInputTokenLimit } from "./producer-window-guard";
import { estimateFixedPromptTokens } from "./read-session-formatting";
import {
    type ReferenceCompartment,
    renderSeedExamplesBlock,
    renderSessionReferencesBlock,
    selectSeeds,
    selectSessionReferences,
} from "./reference-retrieval";

/**
 * Smallest chunk worth a historian run. Below this the fixed parts take the
 * whole window and a run could not summarize even one ordinary message.
 */
export const HISTORIAN_MIN_FIT_CHUNK_TOKENS = 1_000;

/**
 * Local tokens held back from the chunk budget. The fixed parts and the chunk
 * are counted separately, and counting their concatenation can differ by a few
 * tokens at the joins.
 */
const FIT_SLACK_TOKENS = 64;

/**
 * Prompt failures caused by the producer window. They repeat until the model,
 * its window or the instructions change, so callers treat them as counted
 * failures and do not retry them on the next trigger.
 */
export const PRODUCER_PROMPT_FIT_FAILURE_PATTERN =
    /producer_prompt_(?:exceeds_window|fit_unavailable|unfit)/;

export interface HistorianProducerWindow {
    /** Producer model id in `provider/model` form; selects the tokenizer calibration. */
    modelKey?: string;
    contextLimitTokens?: number;
    inputLimitTokens?: number;
    /** Output tokens reserved inside a shared context window. */
    maxOutputTokens: number;
}

/**
 * The window that the OpenCode historian checks a prompt against before sending
 * it to `modelKey` (see `historianPromptAdmissionFailure`), so a fitted prompt
 * passes that check. `fallbackContextLimit` stands in when the model catalog
 * knows no window for the model.
 */
export function resolveHistorianProducerWindow(
    modelKey: string | undefined,
    configuredMaxOutputTokens: number | undefined,
    fallbackContextLimit?: number,
): HistorianProducerWindow {
    const limits = resolveHistorianProducerLimits(modelKey);
    const context =
        limits.context ?? (limits.input === undefined ? fallbackContextLimit : undefined);
    const slash = modelKey?.indexOf("/") ?? -1;
    const catalogOutput =
        modelKey && slash > 0
            ? getSdkOutputLimit(modelKey.slice(0, slash), modelKey.slice(slash + 1))
            : undefined;
    return {
        modelKey,
        contextLimitTokens: context,
        inputLimitTokens: limits.input,
        maxOutputTokens: historianProducerReserve(
            context,
            configuredMaxOutputTokens,
            catalogOutput,
        ),
    };
}

export interface HistorianPromptFitArgs {
    window: HistorianProducerWindow;
    /**
     * The other models the same prompt may be sent to, in chain order (the
     * configured fallbacks, or the session model when no historian primary is
     * configured). Every attempt
     * sends the bytes built once from this fit, so the chunk is sized to the
     * smallest window among `window` and each of these that can hold a minimal
     * prompt on its own. Models with an unknown window add no limit.
     */
    fallbackWindows?: readonly HistorianProducerWindow[];
    systemPrompt: string;
    /** Chunk budget the caller would use without a window, in local tokens. */
    requestedChunkTokens: number;
    sessionId: string;
    /** First ordinal of the chunk; helps select diverse session references. */
    chunkStart: number;
    /** Highest ordinal the chunk can end at; sizes the `Messages X-Y:` header. */
    lastOrdinal: number;
    sessionCompartments: ReferenceCompartment[];
    /** Project and workspace source the main session reads when rebuilding its memory baseline. */
    memoryProject?: { db: Database; projectPath?: string };
    /** Preloaded rows when there is no project source. */
    memories?: Memory[] | (() => Memory[]);
    memoryInjectionBudgetTokens?: number;
    memoryEnabled: boolean;
    /** Whether the historian is asked for user observations; see buildCompartmentAgentPrompt. */
    userObservationsRequested?: boolean;
    extractionFree?: boolean;
}

export interface HistorianPromptFitKept {
    sessionReferences: number;
    memories: number;
    memoriesTotal: number;
    seeds: number;
    seedsTotal: number;
}

export type HistorianPromptFit =
    | {
          ok: true;
          /** False when the window is unknown and the prompt goes out unguarded. */
          guarded: boolean;
          /** Chunk budget in local tokens. */
          chunkTokens: number;
          /**
           * Most source tokens the window holds next to the chosen fixed parts, at
           * least `chunkTokens`. An atomic unit the chunk reader cannot split may
           * use up to this much. Undefined when the window is unknown.
           */
          roomTokens?: number;
          seedExamples: string;
          sessionReferences: string;
          projectMemory: string;
          /** True when any fixed context was dropped to make room. */
          trimmed: boolean;
          kept: HistorianPromptFitKept;
      }
    | { ok: false; reason: string };

/**
 * Fit a recomp prompt (rebuilds compartments only: no memory block, no fact
 * extraction) to the window of the model the recomp's first attempt runs on.
 * It is measured against the main historian system prompt, which is what the
 * pre-send window check counts for recomp prompts too.
 */
export function fitRecompHistorianPrompt(args: {
    model?: ModelInput;
    fallbackModelId?: string;
    language?: string;
    requestedChunkTokens: number;
    sessionId: string;
    chunkStart: number;
    lastOrdinal: number;
    sessionCompartments: ReferenceCompartment[];
}): HistorianPromptFit {
    const modelKey = toModelEntry(args.model)?.model ?? args.fallbackModelId;
    return fitHistorianPrompt({
        window: resolveHistorianProducerWindow(modelKey, undefined),
        systemPrompt: withContentLanguageDirective(COMPARTMENT_AGENT_SYSTEM_PROMPT, args.language),
        requestedChunkTokens: args.requestedChunkTokens,
        sessionId: args.sessionId,
        chunkStart: Math.max(1, args.chunkStart),
        lastOrdinal: args.lastOrdinal,
        sessionCompartments: args.sessionCompartments,
        memories: [],
        memoryEnabled: false,
        extractionFree: true,
    });
}

/** Describe what a fit dropped, for the session log. */
export function describeHistorianPromptTrim(
    fit: Extract<HistorianPromptFit, { ok: true }>,
): string {
    const { kept } = fit;
    return `chunkTokens=${fit.chunkTokens} sessionReferences=${kept.sessionReferences} memories=${kept.memories}/${kept.memoriesTotal} seeds=${kept.seeds}/${kept.seedsTotal}`;
}

/** One model's input limit and the calibrated prompt size it is checked against. */
interface FitLimit {
    modelKey?: string;
    limit: number;
    /** Calibrated prompt tokens for the system prompt plus `proseLocal` local tokens. */
    mass: (proseLocal: number) => number;
}

export function fitHistorianPrompt(args: HistorianPromptFitArgs): HistorianPromptFit {
    const requested = Math.max(0, Math.floor(args.requestedChunkTokens));
    const seeds = selectSeeds(args.sessionId, args.chunkStart);
    const references = selectSessionReferences(
        args.sessionCompartments,
        seeds,
        args.sessionId,
        args.chunkStart,
    );
    const memories = readEnabledProjectMemories(args.memoryEnabled, () => {
        const project = args.memoryProject;
        const projectPath = project?.projectPath;
        const workspace = project && resolveWorkspaceRenderContext(project);
        const rows = project
            ? projectPath && workspace
                ? readM0ProjectMemories(project.db, projectPath, workspace)
                : []
            : ((typeof args.memories === "function" ? args.memories() : args.memories) ?? []);
        const budget = args.memoryInjectionBudgetTokens ?? DEFAULT_MEMORY_BUDGET_TOKENS;
        const { selected } = workspace?.isWorkspaced
            ? trimWorkspaceMemoriesToBudgetV2(args.sessionId, rows, budget, workspace, {
                  sourceNameByMemoryId: sourceNamesForMemories({
                      memories: rows,
                      projectPath,
                      workspace,
                  }),
              })
            : trimMemoriesToBudgetV2(args.sessionId, rows, budget);
        const selectedIds = new Set(selected.map((memory) => memory.id));
        // Keep the historian's rendering and suffix-trim priority after the
        // main session's selector decides which facts fit its memory budget.
        return orderHistorianMemories(rows.filter((memory) => selectedIds.has(memory.id)));
    });
    const render = (refs: number, memoryCount: number, seedCount: number) => ({
        seedExamples: renderSeedExamplesBlock(seeds.slice(0, seedCount)),
        sessionReferences: renderSessionReferencesBlock(references, refs),
        projectMemory: renderHistorianMemoryBlock(memories.slice(0, memoryCount)) ?? "",
    });
    const kept = (refs: number, memoryCount: number, seedCount: number) => ({
        sessionReferences: refs,
        memories: memoryCount,
        memoriesTotal: memories.length,
        seeds: seedCount,
        seedsTotal: seeds.length,
    });

    let systemLocal: number | undefined;
    const fitLimitFor = (window: HistorianProducerWindow): FitLimit | undefined => {
        const limit = producerInputTokenLimit(
            window.contextLimitTokens,
            window.maxOutputTokens,
            window.inputLimitTokens,
        );
        if (limit === undefined) return undefined;
        const calibration = calibrationForModelKey(window.modelKey);
        systemLocal ??= estimateFixedPromptTokens(args.systemPrompt);
        const system = systemLocal;
        return {
            modelKey: window.modelKey,
            limit,
            mass: (proseLocal: number) =>
                providerMass({ prose: proseLocal, system }, calibration, true),
        };
    };
    const primary = fitLimitFor(args.window);
    if (primary && (!Number.isFinite(primary.mass(0)) || primary.mass(0) <= 0)) {
        return {
            ok: false,
            reason: `producer_prompt_fit_unavailable model=${args.window.modelKey ?? "unknown"}`,
        };
    }
    const fallbackLimits = (args.fallbackWindows ?? [])
        .map(fitLimitFor)
        .filter(
            (entry): entry is FitLimit =>
                entry !== undefined && Number.isFinite(entry.mass(0)) && entry.mass(0) > 0,
        );
    // An unknown window sends the budgeted fixed context without producer trimming.
    const unguarded = (): HistorianPromptFit => ({
        ok: true,
        guarded: false,
        chunkTokens: requested,
        ...render(references.length, memories.length, seeds.length),
        trimmed: false,
        kept: kept(references.length, memories.length, seeds.length),
    });
    if (!primary && fallbackLimits.length === 0) return unguarded();

    const chunkHeader = `Messages ${args.chunkStart}-${args.lastOrdinal}:\n\n`;
    // Trimming levels often render the same text (fewer compartments than the
    // reference window, say), so count each distinct prompt once.
    const counted = new Map<string, number>();
    const fixedLocal = (blocks: ReturnType<typeof render>, header = chunkHeader) => {
        const text = buildCompartmentAgentPrompt({
            ...blocks,
            inputSource: header,
            memoryEnabled: args.memoryEnabled,
            userObservationsRequested: args.userObservationsRequested,
            extractionFree: args.extractionFree,
        });
        let tokens = counted.get(text);
        if (tokens === undefined) {
            tokens = estimateFixedPromptTokens(text);
            counted.set(text, tokens);
        }
        return tokens;
    };
    // Largest chunk (local tokens) that keeps the calibrated prompt within one
    // model's limit, before the slack, or -1 when the fixed parts alone do not fit.
    const roomUnder = ({ mass, limit }: FitLimit, fixed: number): number => {
        if (mass(fixed) > limit) return -1;
        let lo = 0;
        let hi = 1;
        while (mass(fixed + hi) <= limit) {
            lo = hi;
            hi *= 2;
        }
        while (hi - lo > 1) {
            const mid = Math.floor((lo + hi) / 2);
            if (mass(fixed + mid) <= limit) lo = mid;
            else hi = mid;
        }
        return lo;
    };
    // Largest chunk (local tokens) that keeps the calibrated prompt within the
    // limit of every model in `limits`, or -1 when the fixed parts alone do not
    // fit one of them.
    const roomAmong = (limits: readonly FitLimit[], blocks: ReturnType<typeof render>): number => {
        const fixed = fixedLocal(blocks);
        let room = Infinity;
        for (const entry of limits) {
            const one = roomUnder(entry, fixed);
            if (one < 0) return -1;
            room = Math.min(room, one);
        }
        return Math.max(0, room - FIT_SLACK_TOKENS);
    };
    const floor = Math.min(requested, HISTORIAN_MIN_FIT_CHUNK_TOKENS);
    // The primary always takes part, so a primary that cannot hold the prompt is
    // refused exactly as before. A fallback that cannot hold even a minimal
    // prompt on its own is left out: shrinking the chunk for it would not make it
    // fit, and its own pre-send check refuses it anyway.
    const sizedFor: FitLimit[] = primary ? [primary] : [];
    for (const entry of fallbackLimits) {
        const alone = roomAmong([entry], render(0, 0, 0));
        if (alone >= floor && alone > 0) sizedFor.push(entry);
    }
    if (sizedFor.length === 0) return unguarded();
    const roomFor = (blocks: ReturnType<typeof render>): number => roomAmong(sizedFor, blocks);
    const accept = (refs: number, memoryCount: number, seedCount: number, chunkTokens: number) => ({
        ok: true as const,
        guarded: true,
        chunkTokens,
        roomTokens: Math.max(chunkTokens, roomFor(render(refs, memoryCount, seedCount))),
        ...render(refs, memoryCount, seedCount),
        trimmed:
            refs < references.length || memoryCount < memories.length || seedCount < seeds.length,
        kept: kept(refs, memoryCount, seedCount),
    });

    // 1. Diverse compartments first, then recent compartments oldest first.
    for (let refs = references.length; refs >= 0; refs -= 1) {
        if (roomFor(render(refs, memories.length, seeds.length)) >= requested) {
            return accept(refs, memories.length, seeds.length, requested);
        }
    }
    // 2. Project-memory lines, lowest priority dropped first. Fewer lines never
    //    need more room, so binary-search the longest prefix that fits.
    if (memories.length > 0 && roomFor(render(0, 0, seeds.length)) >= requested) {
        let lo = 0;
        let hi = memories.length;
        while (hi - lo > 1) {
            const mid = Math.floor((lo + hi) / 2);
            if (roomFor(render(0, mid, seeds.length)) >= requested) lo = mid;
            else hi = mid;
        }
        return accept(0, lo, seeds.length, requested);
    }
    // 3. Seed examples.
    for (let seedCount = seeds.length; seedCount >= 0; seedCount -= 1) {
        if (roomFor(render(0, 0, seedCount)) >= requested) {
            return accept(0, 0, seedCount, requested);
        }
    }
    // 4. Everything trimmed: the chunk takes whatever room is left.
    const room = roomFor(render(0, 0, 0));
    if (room >= floor && room > 0) return accept(0, 0, 0, Math.min(requested, room));

    // The refusal reason is what callers back off on, so it must not move as the
    // session grows: count the fixed parts with a constant header, not the
    // chunk's ordinals. Only the primary can be the model that does not fit,
    // because a fallback joins the fit only when it holds a minimal prompt.
    const refused = sizedFor[0];
    const fixedTokens = refused.mass(fixedLocal(render(0, 0, 0), "Messages 1-1:\n\n"));
    return {
        ok: false,
        reason: `producer_prompt_unfit model=${refused.modelKey ?? "unknown"} limit=${refused.limit} fixed_tokens=${fixedTokens} min_chunk_tokens=${floor}`,
    };
}
