import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ReportedProfile } from "../../src/features/magic-context/memory/lifecycle-gates";
import { lifecycleTextHash } from "../../src/features/magic-context/memory/lifecycle-text";
import {
    canonicalLifecycleJson,
    isTurnTwoEntry,
    type TurnTwoEntry,
} from "../../src/features/magic-context/memory/turn-two-allowlist";
import type { TurnOnePrintedBlock } from "../../src/features/magic-context/memory/turn-one-publication";
import type { MemoryCategory } from "../../src/features/magic-context/memory/types";

/** Hash the JSON data actually stored, omitting optional transport metadata that is undefined. */
export const hash = (value: unknown): string => {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("Artifact hash requires JSON data");
    return lifecycleTextHash(canonicalLifecycleJson(JSON.parse(serialized)));
};
export type Reviewer =
    | { kind: "human"; name: string }
    | { kind: "model"; model: string; family: string };
export interface Reviewed<T> {
    value: T;
    sha256: string;
    producer: string;
    reviewers: Reviewer[];
}
export interface Claim {
    id: string;
    family: string;
    text: string;
    anchor: { startOrdinal: number; endOrdinal: number };
}
export interface ReplayCase {
    id: number;
    source: { recording: string; sha256: string; sessionId: string };
    userPrompt: string;
    blocks: TurnOnePrintedBlock[];
    lines: Array<{ ordinal: number; messageId: string }>;
    memories: Array<{ id: number; revision: number; category: MemoryCategory; content: string }>;
    recordedOutput: string;
    inventory: Reviewed<Claim[]>;
}
export interface Corpus {
    version: 1;
    cases: ReplayCase[];
    calibration: Reviewed<{ key: "27:13"; outputHash: string; expectedGrade: string }>;
    controls: Array<{ key: "12:10" | "27:13" | "35:3" | "2:4"; assertion: string }>;
}
export const CONTROL_ASSERTIONS: Readonly<Record<string, string>> = {
    "12:10": "not an accepted blend",
    "27:13": "grade as itself",
    "35:3": "keeps 64 KiB and >512 KiB",
    "2:4": "repairs c4; new is not repair",
};
export interface Tariff {
    inputUSDPerMillion: number;
    outputUSDPerMillion: number;
    source: string;
}
export interface Profile {
    id: string;
    family: string;
    entry: TurnTwoEntry;
    modelRoute: string;
    priceClass: "free" | "paid";
    configuredTemperature?: number | null;
    configuredThinkingLevel?: string | null;
    tariff: Tariff;
    configurationSource: string;
    variantSource: string;
}
export interface GradeBinding {
    runId: string;
    kind: "resolved" | "unresolved" | "claim" | "control" | "calibration";
    key: string;
    inputHash: string;
    outputHash: string;
}
export interface Grade {
    binding: GradeBinding;
    verdict: string;
    actual: Reviewer | null;
    attestation?: string;
    void: boolean;
    replaces?: string;
}
export interface GraderAssignment {
    testedFamily: string;
    grader: Reviewer;
}
export function admissibleGrade(
    binding: GradeBinding,
    verdict: string,
    actual: Reviewer | null,
    testedFamily: string,
    attestation?: string,
): Grade {
    const valid =
        actual?.kind === "human"
            ? !!actual.name.trim() &&
              attestation === hash({ binding, verdict, reviewer: actual.name })
            : actual?.kind === "model" &&
              !!actual.model &&
              !!actual.family &&
              actual.family !== testedFamily;
    return { binding, verdict, actual, attestation, void: !valid };
}
export interface SendRecord {
    kind: "turn_one" | "turn_two" | "check" | "stripped" | "grader" | "regrade" | "calibration" | "unclassified";
    childId: string;
    request: {
        system: string;
        messages: Array<{ role: "user" | "assistant"; content: string }>;
        tools: unknown;
        mode: "best_effort";
        parameters?: unknown;
        transport?: unknown;
    };
    requestHash: string;
    reply?: string;
    replyHash?: string;
    actual?: ReportedProfile | null;
    error?: string;
    ledgerId: number;
}
export interface FactSnapshot {
    id: number;
    content: string;
    state: string;
    fact_attempts: number;
    reason: string | null;
}
export interface RunArtifact {
    runId: string;
    profileId: string;
    caseId: number;
    repeat: number;
    sends: SendRecord[];
    retryCandidates: unknown[];
    turnOneFailures: number;
    turnTwoSends: number;
    schemaValid: boolean;
    stop?: string;
    facts: FactSnapshot[];
    compartments: unknown[];
    stages: unknown[];
    receipts: unknown[];
    projection: { memories: unknown[]; candidates: FactSnapshot[] };
    projectionHash: string;
    grades: Grade[];
}
export interface LedgerRow {
    profileId: string;
    kind: SendRecord["kind"];
    tariff: Tariff;
    reserved: number;
    charged: number;
    settled: boolean;
}
export interface UsageStep {
    inputTokens: number;
    outputTokens: number;
}
export class CostStop extends Error {}
export class CampaignLedger {
    readonly rows: LedgerRow[] = [];
    constructor(
        readonly profileCap = 15,
        readonly campaignCap = 50,
    ) {}
    reserve(
        profile: Profile,
        kind: LedgerRow["kind"],
        inputTokens: number,
        outputCeiling: number,
        maxSteps: number,
        hostRetries = 0,
        tariff = profile.tariff,
    ): number {
        if (
            ![
                inputTokens,
                outputCeiling,
                maxSteps,
                hostRetries,
                tariff.inputUSDPerMillion,
                tariff.outputUSDPerMillion,
            ].every((n) => Number.isFinite(n) && n >= 0) ||
            !tariff.source ||
            tariff.source === "unknown" ||
            maxSteps < 1
        )
            throw new CostStop("no_cost_meter");
        const reserved =
            ((inputTokens * tariff.inputUSDPerMillion +
                outputCeiling * tariff.outputUSDPerMillion) *
                maxSteps *
                (1 + hostRetries)) /
            1e6;
        const total = this.rows.reduce((sum, row) => sum + row.charged, 0);
        const own = this.rows
            .filter((row) => row.profileId === profile.id)
            .reduce((sum, row) => sum + row.charged, 0);
        if (
            total + reserved > this.campaignCap ||
            (profile.priceClass === "paid" && own + reserved > this.profileCap)
        )
            throw new CostStop("cost_cap");
        this.rows.push({
            profileId: profile.id,
            kind,
            tariff,
            reserved,
            charged: reserved,
            settled: false,
        });
        return this.rows.length - 1;
    }
    settle(id: number, steps?: UsageStep[], charge?: number): void {
        const row = this.rows[id];
        if (row.settled) throw new Error("Cost reservation already settled");
        const actual =
            charge ??
            (steps?.length
                ? steps.reduce(
                      (sum, step) =>
                          sum +
                          (step.inputTokens * row.tariff.inputUSDPerMillion +
                              step.outputTokens * row.tariff.outputUSDPerMillion) /
                              1e6,
                      0,
                  )
                : undefined);
        // Unknown outcomes keep the entire reservation, including all provider steps.
        if (actual !== undefined) {
            if (!Number.isFinite(actual) || actual < 0 || actual > row.reserved)
                throw new CostStop("cost_bound_exceeded");
            row.charged = actual;
            row.settled = true;
        }
    }
}

function reviewed<T>(record: Reviewed<T>, family: string): boolean {
    return (
        record.producer !== "two-pass-live-replay" &&
        !!record.producer &&
        record.sha256 === hash(record.value) &&
        record.reviewers.some((r) =>
            r.kind === "human" ? !!r.name.trim() : !!r.model && !!r.family && r.family !== family,
        )
    );
}
export function preflight(
    corpus: Corpus,
    matrixBytes: string,
    expectedMatrixHash: string,
    profiles: Profile[],
    assignments: GraderAssignment[],
): void {
    if (lifecycleTextHash(matrixBytes) !== expectedMatrixHash) throw new Error("matrix_hash");
    const matrix = JSON.parse(matrixBytes) as {
        version: number;
        rows: Array<Record<string, unknown>>;
    };
    if (
        matrix.version !== 1 ||
        corpus.version !== 1 ||
        corpus.cases.length !== 40 ||
        new Set(corpus.cases.map((c) => c.id)).size !== 40
    )
        throw new Error("case_completeness");
    for (let id = 0; id < 40; id++) {
        const c = corpus.cases.find((c) => c.id === id);
        if (
            !c ||
            !c.source.recording ||
            !/^[a-f0-9]{64}$/.test(c.source.sha256) ||
            !c.source.sessionId ||
            !c.userPrompt ||
            !c.blocks.length ||
            !c.recordedOutput
        )
            throw new Error("case_source");
        if (
            !c.lines.length ||
            new Set(c.lines.map((l) => l.ordinal)).size !== c.lines.length ||
            c.lines.some((l) => !Number.isInteger(l.ordinal) || !l.messageId) ||
            c.blocks.some(
                (b, i) =>
                    b.startOrdinal > b.endOrdinal ||
                    (i > 0 && c.blocks[i - 1].endOrdinal >= b.startOrdinal) ||
                    !b.role ||
                    !b.parts.length ||
                    !c.lines.some((l) => l.ordinal === b.startOrdinal) ||
                    !c.lines.some((l) => l.ordinal === b.endOrdinal),
            ) ||
            c.memories.some((m) => !Number.isInteger(m.revision) || m.revision < 1)
        )
            throw new Error("anchors_or_revisions");
        if (
            new Set(c.inventory.value.map((v) => v.id)).size !== c.inventory.value.length ||
            c.inventory.value.some(
                (v) =>
                    !v.id ||
                    !v.family ||
                    !v.text ||
                    !v.anchor ||
                    v.anchor.startOrdinal > v.anchor.endOrdinal ||
                    !c.blocks.some(
                        (b) =>
                            b.startOrdinal <= v.anchor.startOrdinal &&
                            b.endOrdinal >= v.anchor.endOrdinal,
                    ),
            )
        )
            throw new Error("inventory_claims");
    }
    if (
        corpus.controls.length !== 4 ||
        new Set(corpus.controls.map((c) => c.key)).size !== 4 ||
        ["12:10", "27:13", "35:3", "2:4"].some(
            (key) =>
                !corpus.controls.some(
                    (c) => c.key === key && c.assertion === CONTROL_ASSERTIONS[key],
                ),
        )
    )
        throw new Error("controls");
    if (
        corpus.calibration.value.key !== "27:13" ||
        !corpus.calibration.value.expectedGrade ||
        corpus.calibration.value.outputHash !==
            lifecycleTextHash(corpus.cases.find((c) => c.id === 27)!.recordedOutput)
    )
        throw new Error("calibration_hash");
    for (const profile of profiles) {
        if (!profile.id || !profile.family || !isTurnTwoEntry(profile.entry))
            throw new Error("profile_identity");
        if (
            !profile.configurationSource ||
            profile.configurationSource === "unknown" ||
            !profile.variantSource ||
            profile.variantSource === "unknown" ||
            profile.configuredTemperature === undefined ||
            profile.configuredThinkingLevel === undefined ||
            !profile.tariff.source ||
            profile.tariff.source === "unknown"
        )
            throw new Error("unresolved_profile");
        if (
            !matrix.rows.some(
                (row) =>
                    row.status === "candidate" &&
                    row.lane === profile.entry.lane &&
                    row.provider === profile.entry.provider &&
                    row.modelId === profile.entry.modelId &&
                    row.modelRoute === profile.modelRoute &&
                    (row.priceClass == null || row.priceClass === profile.priceClass) &&
                    (row.priceClass !== "free" ||
                        (profile.tariff.inputUSDPerMillion === 0 &&
                            profile.tariff.outputUSDPerMillion === 0)) &&
                    (row.variantSource == null ||
                        row.variantSource === "unknown" ||
                        row.variant === profile.entry.variant) &&
                    (row.configurationSource == null ||
                        row.configurationSource === "unknown" ||
                        (row.configuredTemperature === profile.configuredTemperature &&
                            row.configuredThinkingLevel === profile.configuredThinkingLevel)) &&
                    Array.isArray(row.carriers) &&
                    row.carriers.includes(profile.entry.carrier),
            )
        )
            throw new Error("matrix_profile");
        if (
            corpus.cases.some((c) => !reviewed(c.inventory, profile.family)) ||
            !reviewed(corpus.calibration, profile.family)
        )
            throw new Error("reviewer_provenance");
        const grader = assignments.find((a) => a.testedFamily === profile.family)?.grader;
        if (
            !grader ||
            (grader.kind === "model"
                ? !grader.model || !grader.family || grader.family === profile.family
                : !grader.name)
        )
            throw new Error("grader_assignment");
    }
}

/** Read only hash-pinned JSON inputs; corpus paths cannot escape the specimens root. */
export function readCorpus(specimensRoot: string, manifestPath: string): Corpus {
    const root = realpathSync(specimensRoot);
    const read = (path: string): string => {
        const file = realpathSync(resolve(root, path));
        const rel = relative(root, file);
        if (
            !rel ||
            rel === ".." ||
            rel.startsWith(`..${sep}`) ||
            isAbsolute(rel) ||
            !file.endsWith(".json")
        )
            throw new Error("corpus_path");
        return readFileSync(file, "utf8");
    };
    const manifest = JSON.parse(read(manifestPath)) as {
        version: 1;
        cases: Array<{ path: string; sha256: string }>;
        calibration: Corpus["calibration"];
        controls: Corpus["controls"];
    };
    const cases = manifest.cases.map((ref) => {
        const bytes = read(ref.path);
        if (lifecycleTextHash(bytes) !== ref.sha256) throw new Error("case_hash");
        const entry = JSON.parse(bytes) as ReplayCase;
        if (lifecycleTextHash(read(entry.source.recording)) !== entry.source.sha256)
            throw new Error("recording_hash");
        return entry;
    });
    return {
        version: manifest.version,
        cases,
        calibration: manifest.calibration,
        controls: manifest.controls,
    };
}

export const schedule = (): Array<{ caseId: number; repeat: number }> =>
    Array.from({ length: 120 }, (_, i) => ({ caseId: i % 40, repeat: Math.floor(i / 40) }));
