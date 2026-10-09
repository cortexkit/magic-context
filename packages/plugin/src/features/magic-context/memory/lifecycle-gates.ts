import { KEPT_CHECK_INPUT_MAX, NARROW_CHECK_CALL_CEILING } from "./lifecycle-constants";
import {
    type EvidenceBlock,
    type EvidenceSpan,
    lifecycleTextHash,
    matchFactEvidence,
    scanConcreteTokens,
    splitMemoryClauses,
} from "./lifecycle-text";

export type CheckKind = "disproof" | "support" | "kept-clause" | "compatibility";
export interface ReportedProfile {
    provider: string;
    modelId: string;
    variant: string | null;
    temperature: number | null;
    systemHash: string;
}
export interface ClauseCitation {
    blockStartOrdinal: number;
    excerpt: string;
}
export interface ChangedClause {
    memoryId: number;
    ordinal: number;
    evidence: ClauseCitation;
    replacement: boolean;
}
export interface AddedClause {
    text: string;
    evidence: ClauseCitation;
}
export interface RevisionSource {
    id: number;
    revision: number;
    projectPath: string;
    status: string;
    content: string;
}
export interface RevisionDecision {
    key: string;
    action: "edit" | "merge" | "replaces";
    projectPath: string;
    expectedSources: Array<{ id: number; revision: number }>;
    survivorId: number;
    finalText: string;
    changes: ChangedClause[];
    added: AddedClause[];
}
export interface GateContext {
    enabled: boolean;
    enforcedJson: boolean;
    memoryEnabled: boolean;
    autoPromote: boolean;
    anchorKnown: boolean;
    blocks: EvidenceBlock[];
    sources: RevisionSource[];
    historianProfile: ReportedProfile;
    validatedProfiles: ReportedProfile[];
}
export interface CheckOperand {
    id: string;
    text: string;
}
export interface CheckPair {
    id: string;
    left: CheckOperand;
    right: CheckOperand;
}
export interface PlannedCheck {
    kind: CheckKind;
    operands: CheckOperand[];
    pairs: CheckPair[];
    input: string;
    spans: EvidenceSpan[];
}
export type GatePlan =
    | { ok: false; reason: string }
    | { ok: true; checks: PlannedCheck[]; kept: CheckOperand[]; spans: EvidenceSpan[] };
const refused = (reason: string): GatePlan => ({ ok: false, reason });
export function existingOperandId(id: number, revision: number, ordinal: number): string {
    return JSON.stringify([id, revision, ordinal]);
}
export function proposedOperandId(key: string, index: number, text: string): string {
    return JSON.stringify([key, "proposed", index, lifecycleTextHash(text)]);
}
export function compatibilityPair(left: CheckOperand, right: CheckOperand): CheckPair {
    const ordered = [left, right].sort((a, b) =>
        Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)),
    );
    return {
        id: JSON.stringify(ordered.map((operand) => operand.id)),
        left: ordered[0]!,
        right: ordered[1]!,
    };
}

/** Check clause bytes, evidence, tokens and input bounds before spending any check calls. */
export function planMemoryRevision(decision: RevisionDecision, context: GateContext): GatePlan {
    if (!context.memoryEnabled) return refused("memory_disabled");
    if (!context.autoPromote) return refused("auto_promote_disabled");
    if (!context.enabled || !context.enforcedJson) return refused("lane_dormant");
    if (
        !Array.isArray(decision.changes) ||
        !Array.isArray(decision.added) ||
        !Array.isArray(decision.expectedSources)
    )
        return refused("shape");
    if (
        decision.changes.some(
            (change) =>
                !change ||
                !Number.isInteger(change.memoryId) ||
                !Number.isInteger(change.ordinal) ||
                typeof change.replacement !== "boolean" ||
                !change.evidence ||
                !Number.isInteger(change.evidence.blockStartOrdinal) ||
                typeof change.evidence.excerpt !== "string",
        ) ||
        decision.added.some(
            (clause) =>
                !clause ||
                typeof clause.text !== "string" ||
                !clause.evidence ||
                !Number.isInteger(clause.evidence.blockStartOrdinal) ||
                typeof clause.evidence.excerpt !== "string",
        )
    )
        return refused("shape");
    if (
        !decision.key ||
        !decision.finalText ||
        !["edit", "merge", "replaces"].includes(decision.action)
    )
        return refused("shape");
    if (decision.changes.length === 0) return refused("append_only");
    const expected = new Map(
        decision.expectedSources.map((source) => [source.id, source.revision]),
    );
    if (
        expected.size !== decision.expectedSources.length ||
        expected.size !== context.sources.length ||
        !expected.has(decision.survivorId) ||
        (decision.action !== "merge" && expected.size !== 1)
    )
        return refused("shape");
    if (
        context.sources.some(
            (source) =>
                source.projectPath !== decision.projectPath ||
                source.status === "archived" ||
                expected.get(source.id) !== source.revision,
        )
    )
        return refused("source_revision");
    const changed = new Map<string, ChangedClause>();
    const kept: CheckOperand[] = [];
    const removed: Array<{ operand: CheckOperand; change: ChangedClause }> = [];
    const sourceForOperand = new Map<string, number>();
    for (const change of decision.changes) {
        const key = `${change.memoryId}:${change.ordinal}`;
        if (changed.has(key)) return refused("clauses");
        changed.set(key, change);
    }
    for (const source of context.sources) {
        for (const clause of splitMemoryClauses(source.content)) {
            const operand = {
                id: existingOperandId(source.id, source.revision, clause.ordinal),
                text: clause.text,
            };
            sourceForOperand.set(operand.id, source.id);
            const change = changed.get(`${source.id}:${clause.ordinal}`);
            if (change) removed.push({ operand, change });
            else kept.push(operand);
        }
    }
    if (removed.length !== changed.size) return refused("clauses");
    const added = decision.added.map((clause, index) => ({
        id: proposedOperandId(decision.key, index, clause.text),
        text: clause.text,
    }));
    if (added.some((operand) => !operand.text || splitMemoryClauses(operand.text).length !== 1))
        return refused("clauses");
    // Each unchanged clause must survive byte-for-byte; additions cannot rewrite a clause omitted from changes.
    const remaining = [...kept, ...added].map((operand) => operand.text);
    for (const clause of splitMemoryClauses(decision.finalText)) {
        const index = remaining.indexOf(clause.text);
        if (index < 0) return refused("clauses");
        remaining.splice(index, 1);
    }
    if (remaining.length) return refused("clauses");
    if (
        decision.action === "merge" &&
        removed.every(
            ({ operand, change }) =>
                !change.replacement &&
                scanConcreteTokens(operand.text).every((token) =>
                    kept.some((item) => scanConcreteTokens(item.text).includes(token)),
                ),
        )
    )
        return refused("paraphrase_only");
    if (!context.anchorKnown) return refused("unknown_anchor");
    const spans: EvidenceSpan[] = [];
    const checks: PlannedCheck[] = [];
    const finalTokens = scanConcreteTokens(decision.finalText);
    for (const { operand, change } of removed) {
        const span = matchFactEvidence(
            context.blocks,
            change.evidence.blockStartOrdinal,
            change.evidence.excerpt,
        );
        if (!span) return refused("evidence_or_window");
        const evidenceTokens = scanConcreteTokens(span.text);
        if (
            scanConcreteTokens(operand.text).some(
                (token) => !finalTokens.includes(token) && !evidenceTokens.includes(token),
            )
        )
            return refused("dropped_token");
        spans.push(span);
        checks.push({
            kind: "disproof",
            operands: [operand],
            pairs: [],
            input: span.window,
            spans: [span],
        });
    }
    for (const [index, operand] of added.entries()) {
        const citation = decision.added[index]!.evidence;
        const span = matchFactEvidence(
            context.blocks,
            citation.blockStartOrdinal,
            citation.excerpt,
        );
        if (!span) return refused("evidence_or_window");
        if (
            scanConcreteTokens(operand.text).some(
                (token) => !scanConcreteTokens(span.text).includes(token),
            )
        )
            return refused("new_token");
        spans.push(span);
        checks.push({
            kind: "support",
            operands: [operand],
            pairs: [],
            input: span.window,
            spans: [span],
        });
    }
    const keptInput =
        [...context.blocks]
            .sort((a, b) => a.startOrdinal - b.startOrdinal)
            .map((block) => block.joinedText)
            .join("\n") +
        "\n" +
        kept.map((operand) => `${operand.id}: ${operand.text}`).join("\n");
    if (kept.length) {
        if (keptInput.length > KEPT_CHECK_INPUT_MAX) return refused("kept_input_limit");
        checks.push({
            kind: "kept-clause",
            operands: kept,
            pairs: [],
            input: keptInput,
            spans: [],
        });
    }
    for (const operand of added) {
        const others = [...kept, ...added].filter((other) => other.id !== operand.id);
        if (others.length)
            checks.push({
                kind: "compatibility",
                operands: [],
                pairs: others.map((other) => compatibilityPair(operand, other)),
                input: "",
                spans: [],
            });
    }
    if (decision.action === "merge") {
        const pairs: CheckPair[] = [];
        for (let i = 0; i < kept.length; i++)
            for (let j = i + 1; j < kept.length; j++) {
                if (sourceForOperand.get(kept[i]!.id) !== sourceForOperand.get(kept[j]!.id))
                    pairs.push(compatibilityPair(kept[i]!, kept[j]!));
            }
        if (pairs.length)
            checks.push({ kind: "compatibility", operands: [], pairs, input: "", spans: [] });
    }
    if (checks.length > NARROW_CHECK_CALL_CEILING) return refused("call_ceiling");
    return { ok: true, checks, kept, spans };
}

export const CHECK_SYSTEM_PROMPTS: Record<CheckKind, string> = {
    disproof:
        "Does the evidence disprove each statement? Return exactly one identity-keyed verdict (yes, no, unclear) per operand.",
    support:
        "Does the evidence support each statement? Return exactly one identity-keyed verdict (yes, no, unclear) per operand.",
    "kept-clause":
        "Do the stored blocks disprove any kept statement? Return exactly one identity-keyed verdict (yes, no, unclear) per operand.",
    compatibility:
        "Do the statements in each pair contradict each other? Return exactly one identity-keyed verdict (yes, no, unclear) per pair.",
};
export interface CheckReply {
    verdicts: Array<{ id: string; verdict: "yes" | "no" | "unclear" }>;
    profile: ReportedProfile;
    usage: unknown;
}
export interface CheckRequest {
    key: string;
    system: string;
    systemHash: string;
    kind: CheckKind;
    operands: CheckOperand[];
    pairs: CheckPair[];
    input: string;
}
export type CheckOutcome =
    | { ok: true }
    | { ok: false; reason: string; retryable: boolean; reportedProfile?: ReportedProfile };
export function sameInferenceTuple(a: ReportedProfile, b: ReportedProfile): boolean {
    return (
        a.provider === b.provider &&
        a.modelId === b.modelId &&
        a.variant === b.variant &&
        a.temperature === b.temperature
    );
}
function validated(profile: ReportedProfile, profiles: ReportedProfile[]): boolean {
    return profiles.some(
        (candidate) =>
            sameInferenceTuple(candidate, profile) && candidate.systemHash === profile.systemHash,
    );
}
export function makeCheckRequest(
    decisionKey: string,
    check: PlannedCheck,
    profile: ReportedProfile,
): CheckRequest {
    const system = CHECK_SYSTEM_PROMPTS[check.kind];
    const systemHash = lifecycleTextHash(system);
    const identity = {
        decisionKey,
        kind: check.kind,
        operands: check.operands,
        pairs: check.pairs,
        inputHash: lifecycleTextHash(check.input),
        profile: { ...profile, systemHash },
    };
    return {
        key: lifecycleTextHash(JSON.stringify(identity)),
        system,
        systemHash,
        kind: check.kind,
        operands: check.operands,
        pairs: check.pairs,
        input: check.input,
    };
}
export async function runMemoryChecks(
    key: string,
    plan: Extract<GatePlan, { ok: true }>,
    context: GateContext,
    send: (request: CheckRequest) => Promise<CheckReply>,
): Promise<CheckOutcome> {
    if (!validated(context.historianProfile, context.validatedProfiles))
        return {
            ok: false,
            reason: "unvalidated_profile",
            retryable: true,
            reportedProfile: context.historianProfile,
        };
    for (const check of plan.checks) {
        const request = makeCheckRequest(key, check, context.historianProfile);
        const expectedProfile = { ...context.historianProfile, systemHash: request.systemHash };
        if (
            request.systemHash === context.historianProfile.systemHash ||
            !validated(expectedProfile, context.validatedProfiles)
        )
            return { ok: false, reason: "unvalidated_profile", retryable: true };
        let reply: CheckReply;
        try {
            reply = await send(request);
        } catch {
            return { ok: false, reason: "check_transport", retryable: true };
        }
        if (
            !reply?.profile ||
            !sameInferenceTuple(reply.profile, context.historianProfile) ||
            reply.profile.systemHash !== request.systemHash ||
            !validated(reply.profile, context.validatedProfiles)
        )
            return {
                ok: false,
                reason: "unvalidated_profile",
                retryable: true,
                reportedProfile: reply?.profile,
            };
        const expected =
            check.kind === "compatibility"
                ? check.pairs.map((pair) => pair.id)
                : check.operands.map((operand) => operand.id);
        if (
            !Array.isArray(reply.verdicts) ||
            reply.verdicts.length !== expected.length ||
            new Set(reply.verdicts.map((entry) => entry.id)).size !== expected.length ||
            reply.verdicts.some((entry) => !expected.includes(entry.id))
        )
            return { ok: false, reason: "malformed_check", retryable: false };
        const passing = check.kind === "disproof" || check.kind === "support" ? "yes" : "no";
        if (reply.verdicts.some((entry) => entry.verdict !== passing))
            return { ok: false, reason: `${check.kind}_refused`, retryable: false };
    }
    return { ok: true };
}
