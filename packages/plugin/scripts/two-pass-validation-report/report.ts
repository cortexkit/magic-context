import {
    admissibleGrade,
    hash,
    preflight,
    schedule,
    type Corpus,
    type Grade,
    type GradeBinding,
    type Profile,
    type Reviewer,
    type RunArtifact,
    type SendRecord,
} from "../two-pass-live-replay/artifact-schema";
import { gradeInputs, type CampaignArtifact } from "../two-pass-live-replay/runner";
import {
    expandTurnTwoEntry,
    matchesReportedProfile,
} from "../../src/features/magic-context/memory/turn-two-profile";
import { parseTurnTwoEnvelope } from "../../src/features/magic-context/memory/turn-two-envelope";
import { lifecycleTextHash } from "../../src/features/magic-context/memory/lifecycle-text";
import { parseTurnTwoStageEnvelope } from "../../src/features/magic-context/memory/turn-two";

export type Outcome = "pass" | "fail" | "not-run" | "unavailable" | "safe-but-not-useful";
type Disposition = "new" | "edit" | "merge" | "replaces" | "conflict" | "covered" | "abstain";

/**
 * Grader verdicts are JSON, not prose searched for keywords. The Grade record carries reviewer
 * identity, attestation and input/output binding. Unrecognized verdicts leave grading incomplete.
 * Calibration alone uses the corpus calibration record's exact expectedGrade string.
 */
export type Assessment =
    | {
          version: 1;
          kind: "fact";
          disposition: Disposition;
          assessment: "correct" | "wrong" | "ambiguous";
          invented?: boolean;
      }
    | { version: 1; kind: "claim"; status: "held" | "deferred" | "lost" }
    | { version: 1; kind: "control"; status: "pass" | "fail" };

const changes = new Set(["new", "edit", "merge", "replaces", "conflict"]);
const dispositions = new Set([...changes, "covered", "abstain"]);
const projectedStates = new Set(["retryable", "in_flight", "decided_pending"]);
const object = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
const json = (text: unknown): unknown => {
    if (typeof text !== "string") return undefined;
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
};

export function assessment(verdict: string): Assessment | undefined {
    const v = object(json(verdict));
    if (v?.version !== 1) return undefined;
    if (
        v.kind === "fact" &&
        dispositions.has(String(v.disposition)) &&
        ["correct", "wrong", "ambiguous"].includes(String(v.assessment)) &&
        (v.invented === undefined || typeof v.invented === "boolean")
    )
        return v as unknown as Assessment;
    if (v.kind === "claim" && ["held", "deferred", "lost"].includes(String(v.status)))
        return v as unknown as Assessment;
    if (v.kind === "control" && ["pass", "fail"].includes(String(v.status)))
        return v as unknown as Assessment;
    return undefined;
}

export interface Count {
    numerator: number;
    denominator: number;
    rate: number | null;
}
const count = (numerator: number, denominator: number): Count => ({
    numerator,
    denominator,
    rate: denominator === 0 ? null : numerator / denominator,
});
interface RepeatCounts {
    repeat: number;
    runs: number;
    b: Count;
    c: Count;
}
interface Losses {
    evaluated: number;
    lost: number;
    deferred: number;
    byFamily: Record<string, { evaluated: number; lost: number; deferred: number }>;
}
interface GradeReport {
    grade: Grade;
    admissible: boolean;
    effective: boolean;
    assessment?: Assessment;
}
export interface ProfileReport {
    id: string;
    identity: {
        lane: string;
        carrier: string;
        provider: string;
        modelRoute: string;
        modelId: string;
        variant: string | null;
    };
    priceClass: Profile["priceClass"];
    tariff: Profile["tariff"];
    configuredTemperature: number | null | undefined;
    configuredThinkingLevel: string | null | undefined;
    outcome: Outcome;
    precedence: number;
    reasons: string[];
    preflightErrors: string[];
    runCount: Count;
    completedRuns: number;
    repeats: RepeatCounts[];
    a: { failures: string[]; mechanical: string[] };
    b: Count;
    c: Count;
    d: { production: Losses; stripped: Losses };
    pending: number;
    abstained: number;
    retries: { turnOne: number; turnTwo: number };
    formatFailures: Count;
    exhaustion: Count;
    grades: GradeReport[];
    calibrations: GradeReport[];
    sends: SendRecord[];
    controls: Array<{ runId: string; key: string; status: string }>;
    runs: Array<{
        runId: string;
        caseId: number;
        repeat: number;
        stop?: string;
        schemaValid: boolean;
        sends: Array<{
            kind: SendRecord["kind"];
            mode: "best_effort";
            actual: SendRecord["actual"];
            ledgerId: number;
        }>;
        decisions: unknown[];
        receipts: unknown[];
        checkCalls: SendRecord[];
        pending: number;
        abstained: number;
    }>;
    cost: {
        chargedUSD: number;
        capUSD: 15;
        capApplies: boolean;
        remainingUSD: number | null;
        rows: CampaignArtifact["ledger"];
    };
}
export interface ValidationReport {
    version: 1;
    matrixHash: string;
    corpusHash: string;
    inventories: CampaignArtifact["inventories"];
    calibration: CampaignArtifact["calibration"];
    graderAssignments: CampaignArtifact["assignments"];
    omittedCandidates: unknown[];
    ledger: {
        chargedUSD: number;
        capUSD: 50;
        remainingUSD: number;
        rows: CampaignArtifact["ledger"];
    };
    profiles: ProfileReport[];
}

function reviewerKey(reviewer: Reviewer | null): string {
    return reviewer ? hash(reviewer) : "unattributed";
}
function bindingKey(binding: GradeBinding): string {
    return hash(binding);
}
function provenance(g: Grade, family: string): boolean {
    return !g.void && !admissibleGrade(g.binding, g.verdict, g.actual, family, g.attestation).void;
}
function blankLosses(): Losses {
    return { evaluated: 0, lost: 0, deferred: 0, byFamily: {} };
}
function loss(target: Losses, family: string, status: "held" | "deferred" | "lost"): void {
    const row = (target.byFamily[family] ??= { evaluated: 0, lost: 0, deferred: 0 });
    target.evaluated++;
    row.evaluated++;
    if (status === "lost") {
        target.lost++;
        row.lost++;
    }
    if (status === "deferred") {
        target.deferred++;
        row.deferred++;
    }
}

function calibrationState(profile: CampaignArtifact["profiles"][number], corpus?: Corpus) {
    const expected = corpus?.calibration.value;
    const invalidReviewers = new Set<string>();
    const reports: GradeReport[] = profile.calibrations.map((g) => ({
        grade: g,
        admissible: provenance(g, profile.profile.family),
        effective: false,
    }));
    for (const r of reports) {
        if (
            !r.admissible ||
            !expected ||
            r.grade.binding.kind !== "calibration" ||
            r.grade.binding.key !== "27:13" ||
            r.grade.binding.inputHash !== corpus?.calibration.sha256 ||
            r.grade.binding.outputHash !== expected.outputHash ||
            r.grade.verdict !== expected.expectedGrade
        )
            invalidReviewers.add(reviewerKey(r.grade.actual));
    }
    const invalidFamilies = new Set(
        reports
            .filter((r) => invalidReviewers.has(reviewerKey(r.grade.actual)))
            .flatMap((r) => (r.grade.actual?.kind === "model" ? [r.grade.actual.family] : [])),
    );
    for (const r of reports) {
        const prior = reports.find((old) => r.grade.replaces === hash(old.grade));
        const independentReplacement =
            !r.grade.replaces ||
            (prior &&
                (r.grade.actual?.kind === "human" ||
                    (r.grade.actual?.kind === "model" &&
                        (prior.grade.actual?.kind !== "model" ||
                            r.grade.actual.family !== prior.grade.actual.family))));
        r.effective =
            r.admissible &&
            !invalidReviewers.has(reviewerKey(r.grade.actual)) &&
            !(r.grade.actual?.kind === "model" && invalidFamilies.has(r.grade.actual.family)) &&
            !!independentReplacement;
    }
    const calibrated = new Set(
        reports.filter((r) => r.effective).map((r) => reviewerKey(r.grade.actual)),
    );
    const replaced = new Set<string>();
    for (const effective of reports.filter((r) => r.effective)) {
        let pointer = effective.grade.replaces;
        while (pointer && !replaced.has(pointer)) {
            replaced.add(pointer);
            pointer = reports.find((r) => hash(r.grade) === pointer)?.grade.replaces;
        }
    }
    const complete =
        calibrated.size > 0 && reports.every((r) => r.effective || replaced.has(hash(r.grade)));
    return { reports, calibrated, complete };
}

function selectedGrades(
    run: RunArtifact,
    profile: Profile,
    calibrated: Set<string>,
    expected: GradeBinding[],
) {
    const expectedKeys = new Set(expected.map(bindingKey));
    const reports: GradeReport[] = run.grades.map((g) => ({
        grade: g,
        admissible:
            provenance(g, profile.family) &&
            calibrated.has(reviewerKey(g.actual)) &&
            expectedKeys.has(bindingKey(g.binding)),
        effective: false,
        assessment: assessment(g.verdict),
    }));
    const selected = new Map<string, GradeReport>();
    for (const r of reports) {
        if (!r.admissible || !r.assessment) continue;
        const key = bindingKey(r.grade.binding);
        const previous = selected.get(key);
        if (!previous || r.grade.replaces === hash(previous.grade)) {
            if (previous) previous.effective = false;
            r.effective = true;
            selected.set(key, r);
        }
    }
    return { reports, selected };
}

function schemaValid(run: RunArtifact): boolean {
    const wrapped = run.stages.some((raw) => {
        const stage = object(raw);
        const reply = object(json(stage?.reply_json));
        const result = object(object(json(reply?.text))?.result);
        return (
            stage?.stage === "turn_one" &&
            result?.step === "turn_one" &&
            typeof result.xml === "string"
        );
    });
    return (
        wrapped &&
        run.schemaValid &&
        run.turnTwoSends > 0 &&
        run.turnTwoSends <= 3 &&
        run.stages.some((s) => {
            const stage = object(s);
            const reply = object(json(stage?.reply_json));
            const request = object(json(stage?.request_json));
            const attempts = object(request?.factAttempts);
            const items = request?.items;
            const ids = attempts ? Object.keys(attempts).map(Number) : [];
            const parsed =
                typeof reply?.text === "string" &&
                attempts &&
                ids.every(Number.isInteger) &&
                Array.isArray(items) &&
                items.every(Number.isInteger)
                    ? parseTurnTwoStageEnvelope(
                          {
                              text: reply.text,
                              lengthCapped: reply.lengthCapped === true,
                              toolActivity: reply.toolActivity === true,
                          },
                          ids,
                          items,
                      )
                    : undefined;
            return (
                stage?.stage === "turn_two" &&
                reply?.schemaValid === true &&
                parsed?.ok === true &&
                parsed.schemaValid
            );
        })
    );
}

/** Read-only aggregation: no provider, store, activation or allowlist writes are performed. */
export function validationReport(
    artifact: CampaignArtifact,
    corpus?: Corpus,
    matrixBytes?: string,
): ValidationReport {
    const total = artifact.ledger.reduce((n, row) => n + row.charged, 0);
    return {
        version: 1,
        matrixHash: artifact.matrixHash,
        corpusHash: artifact.corpusHash,
        inventories: artifact.inventories,
        calibration: artifact.calibration,
        graderAssignments: artifact.assignments,
        omittedCandidates: artifact.omittedCandidates ?? [],
        ledger: {
            chargedUSD: total,
            capUSD: 50,
            remainingUSD: Math.max(0, 50 - total),
            rows: artifact.ledger,
        },
        profiles: artifact.profiles.map((p) => profileReport(artifact, p, corpus, matrixBytes)),
    };
}

function receiptDetails(run: RunArtifact) {
    return run.receipts.map((raw) => {
        const row = object(raw);
        const key = json(row?.decision_key);
        const body = object(json(row?.receipt_json));
        const stage =
            Array.isArray(key) && key.length === 6
                ? run.stages.map(object).find((s) => s?.stage_key === key[5])
                : undefined;
        const reply = object(json(stage?.reply_json));
        const envelope =
            typeof reply?.text === "string"
                ? parseTurnTwoEnvelope(
                      reply.text,
                      reply.lengthCapped === true,
                      reply.toolActivity === true,
                  )
                : undefined;
        const decision =
            envelope?.ok && typeof row?.fact_id === "number"
                ? envelope.decisions.get(row.fact_id)
                : undefined;
        return {
            row,
            key,
            body,
            stage,
            decision: decision && decision !== "malformed" ? decision : undefined,
        };
    });
}

function dates(text: string): string[] {
    const found: string[] = [];
    const add = (month: number, day: number, year?: string) => {
        found.push(`${year ?? ""}-${month}-${day}`);
        if (year) found.push(`-${month}-${day}`);
    };
    for (const m of text.matchAll(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/g))
        add(Number(m[2]), Number(m[3]), m[1]);
    const months = [
        "january",
        "february",
        "march",
        "april",
        "may",
        "june",
        "july",
        "august",
        "september",
        "october",
        "november",
        "december",
    ];
    const names = months.join("|");
    for (const m of text.matchAll(
        new RegExp(`\\b(${names})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, "gi"),
    ))
        add(months.indexOf(m[1].toLowerCase()) + 1, Number(m[2]), m[3]);
    for (const m of text.matchAll(
        new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${names})(?:,?\\s+(\\d{4}))?\\b`, "gi"),
    ))
        add(months.indexOf(m[2].toLowerCase()) + 1, Number(m[1]), m[3]);
    return found;
}

function mechanicalFailures(
    run: RunArtifact,
    profile: Profile,
    c?: Corpus["cases"][number],
): string[] {
    const failures: string[] = [];
    const details = receiptDetails(run);
    const authorizedArchives = new Set<number>();
    const sourceText = c
        ? [
              c.userPrompt,
              ...c.memories.map((m) => m.content),
              ...c.inventory.value.map((claim) => claim.text),
              JSON.stringify(c.blocks),
          ].join("\n")
        : "";
    const numbers = (text: string) => text.match(/\b\d+(?:[.,]\d+)*\b/g) ?? [];
    const sourceNumbers = new Set(numbers(sourceText));
    const sourceDates = new Set(dates(sourceText));
    for (const r of details) {
        if (r.body?.state !== "applied") continue;
        const key = r.key;
        const complete =
            Array.isArray(key) &&
            key.length === 6 &&
            key[1] === r.row?.fact_id &&
            r.decision &&
            r.decision.ordinal === key[3] &&
            typeof r.body.reason === "string" &&
            typeof r.body.adoptionClass === "string" &&
            typeof r.body.memoryId === "number";
        if (!complete || !r.decision || !changes.has(r.decision.action)) {
            failures.push(`unauthorized_operation:${String(r.row?.decision_key)}`);
            continue;
        }
        if (
            !matchesReportedProfile(
                json(r.stage?.reported_profile_json),
                expandTurnTwoEntry(profile.entry)[0],
            )
        )
            failures.push(`unmatched_identity:${String(r.row?.decision_key)}`);
        const archived = Array.isArray(r.body.supersededIds) ? r.body.supersededIds : [];
        if (r.decision.action === "merge") {
            for (const source of r.decision.sources ?? [])
                if (source.id !== r.decision.survivorId && archived.includes(source.id))
                    authorizedArchives.add(source.id);
        }
        if (
            r.decision.action === "replaces" &&
            r.decision.targetId !== undefined &&
            archived.includes(r.decision.targetId)
        )
            authorizedArchives.add(r.decision.targetId);
        const content =
            r.decision.finalText ?? run.facts.find((f) => f.id === r.row?.fact_id)?.content;
        if (c && typeof content === "string" && numbers(content).some((n) => !sourceNumbers.has(n)))
            failures.push(`invented_number:${String(r.row?.decision_key)}`);
        if (
            c &&
            typeof content === "string" &&
            dates(content).some((date) => !sourceDates.has(date))
        )
            failures.push(`invented_date:${String(r.row?.decision_key)}`);
    }
    if (c) {
        const active = run.projection.memories.map(object).filter((m) => m?.status === "active");
        for (const before of c.memories) {
            if (!active.some((m) => m?.id === before.id) && !authorizedArchives.has(before.id))
                failures.push(`standalone_retirement:${before.id}`);
        }
    }
    return failures;
}

function profileReport(
    artifact: CampaignArtifact,
    p: CampaignArtifact["profiles"][number],
    corpus?: Corpus,
    matrixBytes?: string,
): ProfileReport {
    const profile = p.profile;
    const preflightErrors: string[] = [];
    if (artifact.preflightError) preflightErrors.push(artifact.preflightError);
    try {
        if (artifact.version !== 1 || !corpus || !matrixBytes)
            throw new Error("missing_report_inputs");
        preflight(
            corpus,
            matrixBytes,
            artifact.matrixHash,
            artifact.profiles.map((p) => p.profile),
            artifact.assignments,
        );
        if (
            hash(corpus) !== artifact.corpusHash ||
            hash(artifact.calibration) !== hash(corpus.calibration)
        )
            throw new Error("corpus_hash");
        const inventories = corpus.cases.map((c) => ({
            caseId: c.id,
            hash: c.inventory.sha256,
            reviewers: c.inventory.reviewers,
        }));
        if (hash(inventories) !== hash(artifact.inventories)) throw new Error("inventory_hash");
        if (hash(artifact.schedule) !== hash(schedule())) throw new Error("schedule");
        if (
            p.runs.length > 120 ||
            new Set(p.runs.map((r) => r.runId)).size !== p.runs.length ||
            p.runs.some(
                (r, i) =>
                    r.profileId !== profile.id ||
                    r.caseId !== artifact.schedule[i]?.caseId ||
                    r.repeat !== artifact.schedule[i]?.repeat,
            )
        )
            throw new Error("run_schedule");
    } catch (error) {
        preflightErrors.push(error instanceof Error ? error.message : String(error));
    }
    const calibration = calibrationState(p, corpus);
    const rows = artifact.ledger.filter((r) => r.profileId === profile.id);
    const charged = rows.reduce((n, r) => n + r.charged, 0);
    const result: ProfileReport = {
        id: profile.id,
        identity: {
            lane: profile.entry.lane,
            carrier: profile.entry.carrier,
            provider: profile.entry.provider,
            modelRoute: profile.modelRoute,
            modelId: profile.entry.modelId,
            variant: profile.entry.variant,
        },
        priceClass: profile.priceClass,
        tariff: profile.tariff,
        configuredTemperature: profile.configuredTemperature,
        configuredThinkingLevel: profile.configuredThinkingLevel,
        outcome: "not-run",
        precedence: 2,
        reasons: [],
        preflightErrors,
        runCount: count(p.runs.length, 120),
        completedRuns: 0,
        repeats: [0, 1, 2].map((repeat) => ({ repeat, runs: 0, b: count(0, 40), c: count(0, 0) })),
        a: { failures: [], mechanical: [] },
        b: count(0, 120),
        c: count(0, 0),
        d: { production: blankLosses(), stripped: blankLosses() },
        pending: 0,
        abstained: 0,
        retries: { turnOne: 0, turnTwo: 0 },
        formatFailures: count(0, 0),
        exhaustion: count(0, p.runs.length),
        grades: [],
        calibrations: calibration.reports,
        sends: p.sends,
        controls: [],
        runs: [],
        cost: {
            chargedUSD: charged,
            capUSD: 15,
            capApplies: profile.priceClass === "paid",
            remainingUSD: profile.priceClass === "paid" ? Math.max(0, 15 - charged) : null,
            rows,
        },
    };
    let incomplete = !calibration.complete;
    let validRuns = 0,
        eligible = 0,
        deferred = 0,
        formatFailures = 0,
        formatSends = 0,
        exhausted = 0;
    for (const run of p.runs) {
        const c = corpus?.cases.find((c) => c.id === run.caseId);
        const repeat = result.repeats.find((r) => r.repeat === run.repeat);
        if (repeat) repeat.runs++;
        const valid = schemaValid(run);
        if (valid) {
            validRuns++;
            if (repeat) repeat.b.numerator++;
        }
        const completed =
            run.sends.some((s) => s.kind === "turn_one") &&
            !["cost_cap", "no_cost_meter", "cost_bound_exceeded", "outcome_unknown"].includes(
                run.stop ?? "",
            );
        if (completed) result.completedRuns++;
        result.retries.turnOne += Math.max(
            0,
            run.sends.filter((s) => s.kind === "turn_one").length - 1,
        );
        result.retries.turnTwo += Math.max(0, run.turnTwoSends - 1);
        if (run.stop === "turn_one_exhausted" || run.stop === "turn_two_exhausted") exhausted++;
        for (const raw of run.stages) {
            const stage = object(raw);
            if (!["turn_one", "turn_two"].includes(String(stage?.stage))) continue;
            formatSends++;
            const reply = object(json(stage?.reply_json));
            if (
                stage?.state === "format_failed" ||
                (stage?.stage === "turn_two" && reply?.schemaValid === false)
            )
                formatFailures++;
        }
        const receipts = receiptDetails(run);
        const accepted = new Set(
            receipts
                .filter(
                    (r) =>
                        r.body?.state === "applied" && r.decision && changes.has(r.decision.action),
                )
                .map((r) => r.row?.fact_id),
        );
        const pending = run.facts.filter((f) => f.state === "decided_pending").length;
        const abstained = run.facts.filter((f) => f.reason === "abstain").length;
        result.pending += pending;
        result.abstained += abstained;
        const mechanical = mechanicalFailures(run, profile, c);
        result.a.mechanical.push(...mechanical.map((f) => `${run.runId}:${f}`));
        let tasks: ReturnType<typeof gradeInputs> = [];
        try {
            const projection = {
                memories: run.projection.memories.filter((m) => object(m)?.status === "active"),
                candidates: run.projection.candidates.filter((f) => projectedStates.has(f.state)),
            };
            if (hash(projection) !== run.projectionHash) incomplete = true;
            if (c && corpus)
                tasks = gradeInputs(
                    { ...run, projection, projectionHash: hash(projection) },
                    c,
                    corpus,
                );
            else incomplete = true;
        } catch {
            incomplete = true;
        }
        for (const receipt of receipts.filter((r) => r.body?.state === "applied")) {
            const reply = object(json(receipt.stage?.reply_json));
            const fact = run.facts.find((f) => f.id === receipt.row?.fact_id);
            if (
                !fact ||
                typeof receipt.row?.decision_key !== "string" ||
                typeof receipt.stage?.request_json !== "string" ||
                typeof reply?.text !== "string"
            ) {
                incomplete = true;
                continue;
            }
            const binding: GradeBinding = {
                runId: run.runId,
                kind: "resolved",
                key: receipt.row.decision_key,
                inputHash: lifecycleTextHash(receipt.stage.request_json),
                outputHash: lifecycleTextHash(reply.text),
            };
            if (!tasks.some((t) => bindingKey(t.binding) === bindingKey(binding)))
                tasks.push({ binding, input: { fact } });
        }
        const seenFacts = new Set<unknown>();
        const graded = selectedGrades(
            run,
            profile,
            calibration.calibrated,
            tasks.map((t) => t.binding),
        );
        result.grades.push(...graded.reports);
        for (const task of tasks) {
            const r = graded.selected.get(bindingKey(task.binding));
            const a = r?.assessment;
            if (!a) {
                incomplete = true;
                if (task.binding.kind === "control")
                    result.controls.push({
                        runId: run.runId,
                        key: task.binding.key,
                        status: "void_or_missing",
                    });
                continue;
            }
            const kind = task.binding.kind;
            if (kind === "resolved" || kind === "unresolved") {
                if (a.kind !== "fact") {
                    incomplete = true;
                    continue;
                }
                const fact = object(task.input)?.fact;
                const id = object(fact)?.id;
                if (accepted.has(id) && (a.assessment !== "correct" || a.invented))
                    result.a.failures.push(
                        `${run.runId}:${task.binding.key}:${a.assessment}${a.invented ? ":invented" : ""}`,
                    );
                if (seenFacts.has(id)) continue;
                seenFacts.add(id);
                if (changes.has(a.disposition)) {
                    eligible++;
                    if (repeat) repeat.c.denominator++;
                    if (!accepted.has(id)) {
                        deferred++;
                        if (repeat) repeat.c.numerator++;
                    }
                }
            } else if (kind === "claim") {
                if (a.kind !== "claim") {
                    incomplete = true;
                    continue;
                }
                const claim = c?.inventory.value.find((claim) => claim.id === task.binding.key);
                if (!claim) {
                    incomplete = true;
                    continue;
                }
                const stripped = task.binding.runId.endsWith(":S");
                loss(stripped ? result.d.stripped : result.d.production, claim.family, a.status);
            } else if (kind === "control") {
                if (a.kind !== "control") {
                    incomplete = true;
                    continue;
                }
                result.controls.push({ runId: run.runId, key: task.binding.key, status: a.status });
            }
        }
        result.runs.push({
            runId: run.runId,
            caseId: run.caseId,
            repeat: run.repeat,
            stop: run.stop,
            schemaValid: valid,
            sends: run.sends.map((s) => ({
                kind: s.kind,
                mode: s.request.mode,
                actual: s.actual,
                ledgerId: s.ledgerId,
            })),
            decisions: run.stages.flatMap((raw) => {
                const reply = object(json(object(raw)?.reply_json));
                const envelope = object(json(reply?.text));
                const decisions = object(envelope?.result)?.decisions;
                return Array.isArray(decisions) ? decisions : [];
            }),
            receipts: run.receipts,
            checkCalls: run.sends.filter((s) => s.kind === "check"),
            pending,
            abstained,
        });
    }
    result.b = count(validRuns, 120);
    result.c = count(deferred, eligible);
    for (const repeat of result.repeats) {
        repeat.b = count(repeat.b.numerator, 40);
        repeat.c = count(repeat.c.numerator, repeat.c.denominator);
    }
    result.formatFailures = count(formatFailures, formatSends);
    result.exhaustion = count(exhausted, p.runs.length);
    const stops = [p.stop, ...p.runs.map((r) => r.stop)];
    const freeStop = profile.priceClass === "free" && stops.includes("unavailable");
    const invalidMeter = artifact.ledger.some(
        (row) =>
            !row.tariff.source ||
            row.tariff.source === "unknown" ||
            ![
                row.tariff.inputUSDPerMillion,
                row.tariff.outputUSDPerMillion,
                row.reserved,
                row.charged,
            ].every((n) => Number.isFinite(n) && n >= 0) ||
            row.charged > row.reserved,
    );
    const overCap =
        artifact.ledger.reduce((n, row) => n + row.charged, 0) > 50 ||
        (profile.priceClass === "paid" && charged > 15);
    const costStop =
        invalidMeter ||
        overCap ||
        stops.some((s) => ["no_cost_meter", "cost_bound_exceeded"].includes(s ?? "")) ||
        (stops.includes("cost_cap") && (result.completedRuns < 120 || incomplete));
    const failedControl = result.controls.some((c) => c.key !== "27:13" && c.status === "fail");
    const failures = [
        ...(result.a.failures.length || result.a.mechanical.length
            ? ["wrong_accepted_change"]
            : []),
        ...(result.d.production.lost ? ["lost_valid_claim"] : []),
        ...(failedControl ? ["failed_control"] : []),
    ];
    if (failures.length) {
        result.outcome = "fail";
        result.precedence = 1;
        result.reasons = failures;
    } else if (
        preflightErrors.length ||
        costStop ||
        incomplete ||
        !result.completedRuns ||
        (!freeStop && p.runs.length !== 120) ||
        stops.includes("outcome_unknown")
    ) {
        result.reasons = [
            ...preflightErrors,
            ...(costStop ? ["cost_stop"] : []),
            ...(incomplete ? ["incomplete_grading"] : []),
            ...(!result.completedRuns ? ["no_completed_runs"] : []),
            ...(!freeStop && p.runs.length !== 120 ? ["incomplete_runs"] : []),
        ];
    } else if (freeStop) {
        result.outcome = "unavailable";
        result.precedence = 3;
        result.reasons = ["free_tier_stop"];
    } else if (validRuns < 114) {
        result.outcome = "fail";
        result.precedence = 4;
        result.reasons = ["schema_valid_yield"];
    } else if (!eligible) {
        result.precedence = 5;
        result.reasons = ["zero_eligible"];
    } else if (deferred * 5 > eligible) {
        result.outcome = "safe-but-not-useful";
        result.precedence = 6;
        result.reasons = ["deferred_yield"];
    } else {
        result.outcome = "pass";
        result.precedence = 7;
    }
    return result;
}
