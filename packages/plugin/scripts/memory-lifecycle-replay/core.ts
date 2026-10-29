import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { KEPT_CHECK_INPUT_MAX } from "../../src/features/magic-context/memory/lifecycle-constants";
import {
    type CheckOutcome,
    type CheckReply,
    type CheckRequest,
    type GateContext,
    planMemoryRevision,
    type RevisionDecision,
    runMemoryChecks,
} from "../../src/features/magic-context/memory/lifecycle-gates";
import {
    lifecycleTextHash,
    splitMemoryClauses,
} from "../../src/features/magic-context/memory/lifecycle-text";
import { resolveTurnOneFactAnchor } from "../../src/features/magic-context/memory/turn-one-publication";
import { parseCompartmentOutput } from "../../src/hooks/magic-context/compartment-parser";
import {
    buildCompartmentAgentPrompt,
    type CompartmentPromptInputs,
} from "../../src/hooks/magic-context/compartment-prompt";

export const GEMINI_MODEL = "google/antigravity-gemini-3.8-flash";
export const CONTROL_IDS = ["12:10", "27:13", "35:3", "2:4"] as const;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const ordinal = z.number().int().positive();
export const fileSchema = z.object({ path: z.string().min(1), sha256: hash }).strict();
const blockSchema = z.object({ start: ordinal, end: ordinal, sha256: hash }).strict();
const factSchema = z
    .object({
        id: ordinal,
        contentHash: hash,
        origin: z.enum(["reply", "reconstructed-control"]),
        anchor: z.object({ start: ordinal, end: ordinal }).strict().nullable(),
    })
    .strict();
const caseSchema = z
    .object({
        id: z.number().int().nonnegative(),
        input: fileSchema,
        firstReply: fileSchema,
        frozen: fileSchema.nullable(),
        candidates: fileSchema,
        records: z.array(fileSchema),
        blocks: z.array(blockSchema),
        facts: z.array(factSchema),
        replyFactHashes: z.array(hash),
        keptCheckInputUnits: z.number().int().nonnegative().nullable(),
    })
    .strict();
export const manifestSchema = z
    .object({
        version: z.literal(1),
        corpusRoot: z.string().min(1),
        durablePrivateCopyConfirmed: z.boolean(),
        models: z
            .object({
                gemini: z.literal(GEMINI_MODEL),
                deepseek: z
                    .string()
                    .regex(/^[a-z0-9_.-]+\/[A-Za-z0-9_./-]+$/)
                    .nullable(),
            })
            .strict(),
        cases: z.array(caseSchema),
        evidence: z.array(fileSchema),
    })
    .strict();
export type CorpusManifest = z.infer<typeof manifestSchema>;
export type FileRecord = z.infer<typeof fileSchema>;

export const frozenSchema = z.object({
    firstReplyHash: hash,
    facts: z.array(z.object({ category: z.string(), content: z.string() })),
    origins: z.array(z.string()),
    matches: z.array(z.array(z.object({ id: ordinal, content: z.string() }))),
    input: z.object({ prompt: z.string() }),
});
export function recordedFirstReply(text: string): string {
    const record = z
        .object({
            request: z.object({
                messages: z.array(z.object({ role: z.string(), content: z.string() })),
            }),
        })
        .parse(JSON.parse(text));
    const first = record.request.messages.find((message) => message.role === "assistant");
    if (!first) throw new Error("recorded first reply missing");
    return first.content;
}

export function printedBlocks(prompt: string) {
    const body = prompt.match(/<new_messages>([\s\S]*?)<\/new_messages>/)?.[1];
    if (!body) throw new Error("new_messages missing");
    const prefixes = [...body.matchAll(/^\[(\d+)(?:-(\d+))?\][ \t]*/gm)];
    return prefixes.map((match, index) => {
        const text = body.slice(
            match.index! + match[0].length,
            prefixes[index + 1]?.index ?? body.length,
        );
        return {
            startOrdinal: Number(match[1]),
            endOrdinal: Number(match[2] ?? match[1]),
            role: "rendered",
            parts: [text],
            joinedText: text,
        };
    });
}

/** A conservative bound includes every rendered block and each possible target's kept clauses. */
export function keptInputBound(frozen: z.infer<typeof frozenSchema>): number {
    const blocks = printedBlocks(frozen.input.prompt)
        .map((block) => block.joinedText)
        .join("\n");
    return Math.max(
        0,
        ...frozen.matches.flat().map((source) => {
            const kept = splitMemoryClauses(source.content)
                .map(
                    (clause) =>
                        `memory:${source.id}:revision:1:clause:${clause.ordinal}: ${clause.text}`,
                )
                .join("\n");
            return blocks.length + 1 + kept.length;
        }),
    );
}

export class ReplayRefused extends Error {
    constructor(readonly failures: string[]) {
        super(`Replay refused:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
    }
}

/** Corpus paths are relative to the private copy, never to a live store or the old trial root. */
export function readCorpusFile(root: string, record: FileRecord): string {
    const base = realpathSync(root);
    const path = realpathSync(resolve(base, record.path));
    const rel = relative(base, path);
    if (isAbsolute(record.path) || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
        throw new Error(`Corpus path escapes private root: ${record.path}`);
    }
    const bytes = readFileSync(path);
    if (new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== record.sha256) {
        throw new Error(`Corpus hash mismatch: ${record.path}`);
    }
    return bytes.toString("utf8");
}

/** Collect all unmet prerequisites before a replay can send even its first request. */
export function startFailures(raw: unknown, read: (file: FileRecord) => string): string[] {
    const parsed = manifestSchema.safeParse(raw);
    if (!parsed.success) return [`manifest_schema: ${parsed.error.message}`];
    const manifest = parsed.data;
    const failures: string[] = [];
    if (!manifest.durablePrivateCopyConfirmed) failures.push("durable_private_corpus_unconfirmed");
    if (!manifest.models.deepseek) failures.push("owner_literal_deepseek_model_missing");
    const ids = manifest.cases.map((item) => item.id);
    if (ids.length !== 40 || new Set(ids).size !== 40 || ids.some((id) => id > 39)) {
        failures.push("historical_corpus_must_contain_cases_0_through_39_once");
    }
    for (const item of manifest.cases) {
        for (const file of [item.input, item.firstReply, item.candidates, ...item.records]) {
            try {
                read(file);
            } catch (error) {
                failures.push(String(error));
            }
        }
        if (item.frozen) {
            try {
                read(item.frozen);
            } catch (error) {
                failures.push(String(error));
            }
        }
        try {
            const reply = recordedFirstReply(read(item.firstReply));
            const actual = parseCompartmentOutput(reply).facts.map((fact) =>
                lifecycleTextHash(fact.content),
            );
            if (JSON.stringify(actual) !== JSON.stringify(item.replyFactHashes))
                failures.push(`${item.id}: actual_reply_mapping_mismatch`);
            const frozen = frozenSchema.parse(JSON.parse(read(item.candidates)));
            if (
                frozen.firstReplyHash !== lifecycleTextHash(reply) ||
                JSON.stringify(frozen.facts.map((fact) => lifecycleTextHash(fact.content))) !==
                    JSON.stringify(item.facts.map((fact) => fact.contentHash))
            )
                failures.push(`${item.id}: frozen_candidates_mismatch`);
            const blocks = printedBlocks(frozen.input.prompt).map((block) => ({
                start: block.startOrdinal,
                end: block.endOrdinal,
                sha256: lifecycleTextHash(block.joinedText),
            }));
            if (JSON.stringify(blocks) !== JSON.stringify(item.blocks))
                failures.push(`${item.id}: recorded_blocks_mismatch`);
            if (item.keptCheckInputUnits !== keptInputBound(frozen))
                failures.push(`${item.id}: kept_input_bound_mismatch`);
        } catch (error) {
            failures.push(`${item.id}: unmappable_reply_or_blocks: ${String(error)}`);
        }
        if (!item.facts.length || item.facts.some((fact, index) => fact.id !== index + 1)) {
            failures.push(`${item.id}: facts_not_sequential_reply_order`);
        }
        const replyFacts = item.facts
            .filter((fact) => fact.origin === "reply")
            .map((fact) => fact.contentHash);
        if (JSON.stringify(replyFacts) !== JSON.stringify(item.replyFactHashes)) {
            failures.push(`${item.id}: frozen_reply_fact_mapping_missing`);
        }
        for (const fact of item.facts) {
            const anchor = fact.anchor;
            const block = item.blocks.find(
                (block) => anchor && block.start === anchor.start && block.end === anchor.end,
            );
            if (!anchor || anchor.start > anchor.end || !block) {
                failures.push(`${item.id}:${fact.id}: recorded_source_block_anchor_missing`);
            }
        }
        if ([2, 12, 27, 35].includes(item.id)) {
            if (!item.frozen) failures.push(`${item.id}: problem_case_frozen_input_missing`);
            if (
                item.keptCheckInputUnits === null ||
                item.keptCheckInputUnits > KEPT_CHECK_INPUT_MAX
            ) {
                failures.push(`${item.id}: problem_kept_check_input_unproven_or_oversize`);
            }
        }
    }
    for (const control of CONTROL_IDS) {
        const [caseId, factId] = control.split(":").map(Number);
        const item = manifest.cases.find((entry) => entry.id === caseId);
        if (!item?.facts.some((fact) => fact.id === factId))
            failures.push(`${control}: control_candidate_missing`);
    }
    for (const file of manifest.evidence) {
        try {
            read(file);
        } catch (error) {
            failures.push(String(error));
        }
    }
    return failures;
}

export function requireStart(raw: unknown, read: (file: FileRecord) => string): CorpusManifest {
    const failures = startFailures(raw, read);
    if (failures.length) throw new ReplayRefused(failures);
    return manifestSchema.parse(raw);
}

export function productionTurnOne(inputs: CompartmentPromptInputs): string {
    return buildCompartmentAgentPrompt({
        ...inputs,
        projectMemory: "",
        anchoredFacts: true,
        extractionFree: false,
        memoryEnabled: true,
    });
}

/** An invalid emitted prefix is a failure, not an implicitly unknown anchor. */
export function turnOneAnchorFailures(reply: string, newMessages: string): string[] {
    const parsed = parseCompartmentOutput(reply);
    const failures: string[] = [];
    const blocks = [...newMessages.matchAll(/^\[(\d+)(?:-(\d+))?\]/gm)].map((match) => ({
        startOrdinal: Number(match[1]),
        endOrdinal: Number(match[2] ?? match[1]),
    }));
    const bullets = [...reply.matchAll(/<facts>([\s\S]*?)<\/facts>/g)].flatMap((match) =>
        [...match[1]!.matchAll(/^\s*\*\s*(.+)$/gm)].map((bullet) => bullet[1]!),
    );
    if (parsed.droppedFacts || bullets.length !== parsed.facts.length)
        failures.push("discarded_or_unmapped_fact");
    const compartments = parsed.compartments.filter(
        (compartment) =>
            parsed.unprocessedFrom === null || compartment.endMessage < parsed.unprocessedFrom,
    );
    // A partial reply does not shrink the input covered by the whole-chunk refusal.
    const chunk = {
        startOrdinal: blocks[0]?.startOrdinal,
        endOrdinal: blocks.at(-1)?.endOrdinal,
    };
    bullets.forEach((bullet, index) => {
        if (
            /^[[(]\s*(?:at_compartment|origin_compartment)\s*=\s*"?unknown"?\s*[\])]\s*\S/.test(
                bullet,
            )
        )
            return;
        const fact = parsed.facts[index];
        if (!fact?.anchor || !resolveTurnOneFactAnchor(fact.anchor, compartments, blocks, chunk)) {
            failures.push(`fact_${index + 1}: anchor_not_reply_local_printed_range`);
        }
    });
    return failures;
}

const gradeSchema = z.enum(["episode", "duplicate", "already-covered", "loss"]);
const omissionSchema = z
    .object({
        caseId: ordinal,
        family: z.string().min(1),
        safetyShaped: z.boolean(),
        missedBy: z.array(z.enum(["new", "S"])).min(1),
        new: gradeSchema.nullable(),
        S: gradeSchema.nullable(),
    })
    .strict();
export const omissionsSchema = z
    .object({
        corpusManifestHash: hash,
        extractor: z.string().min(1),
        reviewer: z.string().min(1),
        families: z.array(omissionSchema).min(1),
    })
    .strict();
export type OmissionsLedger = z.infer<typeof omissionsSchema>;

export function omissionsFailures(
    raw: unknown,
    manifestHash: string,
    expectedFamilies: string[],
): string[] {
    const parsed = omissionsSchema.safeParse(raw);
    if (!parsed.success) return ["omissions_ledger_missing_or_malformed"];
    const ledger = parsed.data;
    const failures: string[] = [];
    if (ledger.corpusManifestHash !== manifestHash) failures.push("omissions_corpus_mismatch");
    if (ledger.reviewer === ledger.extractor) failures.push("omissions_reviewer_not_independent");
    const keys = ledger.families.map((family) => `${family.caseId}:${family.family}`);
    if (
        new Set(keys).size !== keys.length ||
        JSON.stringify([...keys].sort()) !== JSON.stringify([...expectedFamilies].sort())
    )
        failures.push("omissions_family_inventory_mismatch");
    const losses = new Map<number, { new: number; S: number }>();
    for (const family of ledger.families) {
        if (!family.new || !family.S)
            failures.push(`${family.caseId}:${family.family}: both_arm_grades_required`);
        if (family.safetyShaped && family.new === "loss")
            failures.push(`${family.caseId}:${family.family}: safety_rule_loss`);
        const counts = losses.get(family.caseId) ?? { new: 0, S: 0 };
        counts.new += Number(family.new === "loss");
        counts.S += Number(family.S === "loss");
        losses.set(family.caseId, counts);
    }
    for (const [caseId, counts] of losses)
        if (counts.new > counts.S) failures.push(`${caseId}: new_losses_exceed_S`);
    return failures;
}

export interface RecordedCheck {
    requestHash: string;
    request: CheckRequest;
    reply: CheckReply;
    outputHash: string;
}

/** Recorded checks require identical current requests; matching request types alone is not enough. */
export async function replayRecordedChecks(
    decision: RevisionDecision,
    context: GateContext,
    records: RecordedCheck[],
): Promise<CheckOutcome> {
    const plan = planMemoryRevision(decision, context);
    if (!plan.ok) return { ...plan, retryable: false };
    return runMemoryChecks(decision.key, plan, context, async (request) => {
        const requestHash = lifecycleTextHash(JSON.stringify(request));
        const matches = records.filter((record) => record.requestHash === requestHash);
        if (matches.length !== 1) throw new Error("recorded_check_missing_or_ambiguous");
        const record = matches[0]!;
        if (
            lifecycleTextHash(JSON.stringify(record.request)) !== requestHash ||
            lifecycleTextHash(JSON.stringify(record.reply)) !== record.outputHash
        )
            throw new Error("recorded_check_hash_mismatch");
        return record.reply;
    });
}
