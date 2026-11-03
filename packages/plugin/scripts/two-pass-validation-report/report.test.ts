import { describe, expect, test } from "bun:test";
import {
    admissibleGrade,
    CampaignLedger,
    CONTROL_ASSERTIONS,
    hash,
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
import { buildTurnOneAuthorizationRequest } from "../../src/features/magic-context/memory/turn-two";
import { expandTurnTwoEntry } from "../../src/features/magic-context/memory/turn-two-profile";
import { lifecycleTextHash } from "../../src/features/magic-context/memory/lifecycle-text";
import { validationReport, type Assessment } from "./report";

const independent: Reviewer = { kind: "model", model: "judge-exact", family: "independent" };
const human: Reviewer = { kind: "human", name: "Named reviewer" };
const verdict = (a: Assessment) => JSON.stringify(a);
const factVerdict = (
    disposition: "new" | "covered" = "new",
    assessment: "correct" | "wrong" | "ambiguous" = "correct",
) => verdict({ version: 1, kind: "fact", disposition, assessment });
function grade(binding: GradeBinding, value: string, reviewer = independent): Grade {
    return admissibleGrade(
        binding,
        value,
        reviewer,
        "tested",
        reviewer.kind === "human"
            ? hash({ binding, verdict: value, reviewer: reviewer.name })
            : undefined,
    );
}

// These are synthetic offline report artifacts, not substitutes for the private validation corpus.
function fixture() {
    const entry = buildTurnOneAuthorizationRequest(
        {
            lane: "opencode-2",
            carrier: "hidden-completion",
            provider: "fixture",
            modelId: "exact-tested",
            variant: null,
            temperature: null,
            thinkingLevel: null,
        },
        { system: "system", formatInstruction: "format", toolSurface: [], checkToolSurface: [] },
    ).requestedIdentity;
    const profile: Profile = {
        id: "profile",
        family: "tested",
        entry,
        modelRoute: "fixture/exact-tested",
        priceClass: "paid",
        configuredTemperature: 0.1,
        configuredThinkingLevel: null,
        tariff: { inputUSDPerMillion: 1, outputUSDPerMillion: 1, source: "fixture tariff" },
        configurationSource: "fixture settings",
        variantSource: "fixture variant",
    };
    const claims = [
        {
            id: "claim",
            family: "constraints",
            text: "Keep the rule.",
            anchor: { startOrdinal: 1, endOrdinal: 1 },
        },
    ];
    const corpus: Corpus = {
        version: 1,
        cases: Array.from({ length: 40 }, (_, id) => ({
            id,
            source: {
                recording: "fixture.json",
                sha256: "a".repeat(64),
                sessionId: `recording-${id}`,
            },
            userPrompt: "<project-memory>Old rule.</project-memory>\n[1] user: Keep the rule.",
            blocks: [{ role: "user", startOrdinal: 1, endOrdinal: 1, parts: ["Keep the rule."] }],
            lines: [{ ordinal: 1, messageId: "message" }],
            memories: [],
            recordedOutput: "recorded 27:13",
            inventory: {
                value: claims,
                sha256: hash(claims),
                producer: "independent extraction",
                reviewers: [human],
            },
        })),
        controls: Object.entries(CONTROL_ASSERTIONS).map(([key, assertion]) => ({
            key: key as Corpus["controls"][number]["key"],
            assertion,
        })),
        calibration: {
            value: {
                key: "27:13",
                outputHash: lifecycleTextHash("recorded 27:13"),
                expectedGrade: "expected-bad",
            },
            sha256: "",
            producer: "independent S10 review",
            reviewers: [human],
        },
    };
    corpus.calibration.sha256 = hash(corpus.calibration.value);
    const matrix = JSON.stringify({
        version: 1,
        rows: [
            {
                status: "candidate",
                lane: entry.lane,
                carriers: [entry.carrier],
                provider: entry.provider,
                modelId: entry.modelId,
                modelRoute: profile.modelRoute,
            },
        ],
    });
    const calibration = grade(
        {
            runId: "profile:calibration",
            kind: "calibration",
            key: "27:13",
            inputHash: corpus.calibration.sha256,
            outputHash: corpus.calibration.value.outputHash,
        },
        "expected-bad",
    );
    const actual = expandTurnTwoEntry(entry)[0];
    const send = (kind: SendRecord["kind"], text: string): SendRecord => ({
        kind,
        childId: "child",
        request: { system: "system", messages: [], tools: [], mode: "best_effort" },
        requestHash: "request",
        reply: text,
        replyHash: lifecycleTextHash(text),
        actual,
        ledgerId: -1,
    });
    const artifact: CampaignArtifact = {
        version: 1,
        matrixHash: lifecycleTextHash(matrix),
        corpusHash: hash(corpus),
        inventories: corpus.cases.map((c) => ({
            caseId: c.id,
            hash: c.inventory.sha256,
            reviewers: c.inventory.reviewers,
        })),
        calibration: corpus.calibration,
        controls: corpus.controls,
        assignments: [{ testedFamily: "tested", grader: independent }],
        schedule: schedule(),
        ledger: [],
        matrix: JSON.parse(matrix),
        profiles: [{ profile, calibrations: [calibration], sends: [], runs: [] }],
    };
    const runs = artifact.profiles[0].runs;
    for (const { caseId, repeat } of schedule()) {
        const runId = `run:${caseId}:${repeat}`;
        const stageKey = `stage:${runId}`;
        const decisions = Array.from({ length: 5 }, (_, i) => ({ fact_id: i + 1, check: "Audit fixture.", action: i === 4 ? "abstain" : "new",  }));
        const text = JSON.stringify({ result: { step: "turn_two", decisions, scores: [] } });
        const wrapped = JSON.stringify({ result: { step: "turn_one", xml: "<compartment/>" } });
        const run: RunArtifact = {
            runId,
            profileId: profile.id,
            caseId,
            repeat,
            sends: [send("turn_one", wrapped), send("turn_two", text), send("stripped", "XML")],
            retryCandidates: [],
            turnOneFailures: 0,
            turnTwoSends: 1,
            schemaValid: true,
            facts: Array.from({ length: 5 }, (_, i) => ({
                id: i + 1,
                content: "Keep the rule.",
                state: i === 4 ? "decided_pending" : "applied",
                fact_attempts: 0,
                reason: i === 4 ? "abstain" : "new",
            })),
            compartments: [],
            stages: [
                {
                    stage: "turn_one",
                    stage_key: `first:${stageKey}`,
                    reply_json: JSON.stringify({ text: wrapped }),
                },
                {
                    stage: "turn_two",
                    stage_key: stageKey,
                    request_json: JSON.stringify({
                        factAttempts: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
                        items: [],
                        lexicalOnly: false,
                        prompt: "request",
                    }),
                    reported_profile_json: JSON.stringify(actual),
                    reply_json: JSON.stringify({ text, schemaValid: true, envelopeValid: true }),
                },
            ],
            receipts: decisions.map((d, i) => ({
                fact_id: i + 1,
                decision_key: JSON.stringify(["root", i + 1, 0, i, [], stageKey]),
                receipt_json: JSON.stringify({
                    state: i === 4 ? "decided_pending" : "applied",
                    reason: d.action,
                    adoptionClass: "live",
                    memoryId: i + 1,
                }),
            })),
            projection: {
                memories: [
                    {
                        id: 1,
                        category: "CONSTRAINTS",
                        content: "Keep the rule.",
                        revision: 1,
                        status: "active",
                    },
                ],
                candidates: [],
            },
            projectionHash: "",
            grades: [],
        };
        run.projectionHash = hash(run.projection);
        runs.push(run);
    }
    function regrade(run: RunArtifact, reviewer = independent) {
        const c = corpus.cases[run.caseId];
        run.grades = gradeInputs(run, c, corpus).map((task) =>
            grade(
                task.binding,
                task.binding.kind === "claim"
                    ? verdict({ version: 1, kind: "claim", status: "held" })
                    : task.binding.kind === "control"
                      ? verdict({ version: 1, kind: "control", status: "pass" })
                      : factVerdict(),
                reviewer,
            ),
        );
    }
    for (const run of runs) regrade(run);
    const report = () => validationReport(artifact, corpus, matrix).profiles[0];
    const refresh = () => {
        artifact.corpusHash = hash(corpus);
        artifact.inventories = corpus.cases.map((c) => ({
            caseId: c.id,
            hash: c.inventory.sha256,
            reviewers: c.inventory.reviewers,
        }));
    };
    return { artifact, corpus, profile, runs, report, refresh, regrade, send };
}
function replaceGrade(
    run: RunArtifact,
    predicate: (g: Grade) => boolean,
    value: string,
    reviewer = independent,
) {
    const index = run.grades.findIndex(predicate);
    if (index < 0) throw new Error("missing test grade");
    run.grades[index] = grade(run.grades[index].binding, value, reviewer);
}
function invalidate(run: RunArtifact) {
    run.schemaValid = false;
    const stage = run.stages[1] as { reply_json: string };
    const reply = JSON.parse(stage.reply_json);
    reply.schemaValid = false;
    stage.reply_json = JSON.stringify(reply);
}

describe("C8 report boundaries and accounting", () => {
    test("114/120 and exactly 20% deferred pass with per-repeat counts", () => {
        const f = fixture();
        f.runs.slice(0, 6).forEach(invalidate);
        const r = f.report();
        expect(r.preflightErrors).toEqual([]);
        expect(r.outcome).toBe("pass");
        expect(r.b).toEqual({ numerator: 114, denominator: 120, rate: 0.95 });
        expect(r.c).toEqual({ numerator: 120, denominator: 600, rate: 0.2 });
        expect(
            r.repeats.map((r) => [r.b.numerator, r.b.denominator, r.c.numerator, r.c.denominator]),
        ).toEqual([
            [34, 40, 40, 200],
            [40, 40, 40, 200],
            [40, 40, 40, 200],
        ]);
        expect(r.pending).toBe(120);
        expect(r.abstained).toBe(120);
        expect(r.runCount.numerator).toBe(120);
        expect(r.identity.modelId).toBe("exact-tested");
        expect(r.runs[0].sends[0].actual?.temperature).toBeNull();
        expect(r.runs[0].sends[0].actual?.thinkingLevel).toBeNull();
        expect(r.runs.every((run) => run.sends.every((s) => s.mode === "best_effort"))).toBe(true);
    });
    test("113 schema-valid plus 7 envelope-valid invalid-score replies fail (b)", () => {
        const f = fixture();
        for (const run of f.runs.slice(0, 7)) {
            const stage = run.stages[1] as { reply_json: string };
            const reply = JSON.parse(stage.reply_json);
            const envelope = JSON.parse(reply.text);
            envelope.result.scores = [{ memory_id: 1, score: "bad" }];
            reply.text = JSON.stringify(envelope);
            reply.schemaValid = false;
            stage.reply_json = JSON.stringify(reply);
            run.schemaValid = false;
            f.regrade(run);
        }
        const r = f.report();
        expect(r.outcome).toBe("fail");
        expect(r.precedence).toBe(4);
        expect(r.b.numerator).toBe(113);
        expect(r.c.numerator).toBe(120);
    });
    test("cached schema-valid flags cannot credit an unwrapped turn one", () => {
        const f = fixture();
        for (const run of f.runs.slice(0, 7)) run.stages.splice(0, 1);
        const r = f.report();
        expect(r.b.numerator).toBe(113);
        expect(r.outcome).toBe("fail");
    });
    test("schema-valid flags cannot credit unsent score items", () => {
        const f = fixture();
        for (const run of f.runs.slice(0, 7)) {
            const stage = run.stages[1] as { reply_json: string };
            const reply = JSON.parse(stage.reply_json);
            const envelope = JSON.parse(reply.text);
            envelope.result.scores = [{ item: 99, importance: 80, class: "context" }];
            reply.text = JSON.stringify(envelope);
            stage.reply_json = JSON.stringify(reply);
            f.regrade(run);
        }
        expect(f.report().b.numerator).toBe(113);
        expect(f.report().precedence).toBe(4);
    });
    test("cached schema-valid flags cannot credit invalid scores", () => {
        const f = fixture();
        for (const run of f.runs.slice(0, 7)) {
            const stage = run.stages[1] as { reply_json: string };
            const reply = JSON.parse(stage.reply_json);
            const envelope = JSON.parse(reply.text);
            envelope.result.scores = [null];
            reply.text = JSON.stringify(envelope);
            stage.reply_json = JSON.stringify(reply);
            f.regrade(run);
        }
        expect(f.report().b.numerator).toBe(113);
    });
    test("over 20% is safe-but-not-useful; zero eligible is not-run", () => {
        const f = fixture();
        const receipt = f.runs[0].receipts[0] as { receipt_json: string };
        receipt.receipt_json = JSON.stringify({
            state: "decided_pending",
            reason: "check_refused",
        });
        f.regrade(f.runs[0]);
        expect(f.report().outcome).toBe("safe-but-not-useful");
        for (const run of f.runs)
            for (const g of run.grades)
                if (["resolved", "unresolved"].includes(g.binding.kind))
                    g.verdict = factVerdict("covered");
        expect(f.report().outcome).toBe("not-run");
        expect(f.report().precedence).toBe(5);
    });
    test("never-wrapped turn ones and exhausted runs remain in the 120 denominator", () => {
        const f = fixture();
        for (const run of f.runs.slice(0, 7)) {
            run.schemaValid = false;
            run.turnOneFailures = 3;
            run.turnTwoSends = 0;
            run.stop = "turn_one_exhausted";
            run.facts = [];
            run.receipts = [];
            run.stages = [];
            run.sends = [f.send("turn_one", "bad")];
            f.regrade(run);
        }
        const r = f.report();
        expect(r.outcome).toBe("fail");
        expect(r.b.numerator).toBe(113);
        expect(r.exhaustion.numerator).toBe(7);
        expect(r.b.denominator).toBe(120);
    });
    for (const position of ["first_turn_one", "retry_turn_one", "turn_two", "check"])
        test(`identity mismatch at ${position} is counted, not reassigned`, () => {
            const f = fixture();
            for (const run of f.runs.slice(0, 7)) {
                run.stop = "identity_mismatch";
                if (position !== "check") {
                    invalidate(run);
                    run.receipts = [];
                    f.regrade(run);
                }
                run.sends.push({
                    ...f.send(
                        position === "check"
                            ? "check"
                            : position === "turn_two"
                              ? "turn_two"
                              : "turn_one",
                        "reply",
                    ),
                    actual: { ...f.send("turn_one", "").actual!, modelId: "fallback" },
                });
            }
            const r = f.report();
            expect(r.runCount.numerator).toBe(120);
            expect(r.b.denominator).toBe(120);
            expect(r.b.numerator).toBe(position === "check" ? 120 : 113);
            expect(r.outcome).toBe(position === "check" ? "pass" : "fail");
        });
    test("no completed runs is not-run even after a free-tier stop", () => {
        const f = fixture();
        f.artifact.profiles[0].runs = [];
        f.artifact.profiles[0].stop = "unavailable";
        expect(f.report().outcome).toBe("not-run");
        expect(f.report().reasons).toContain("no_completed_runs");
    });
    test("pending, accepted and exhausted facts count once, including malformed siblings", () => {
        const f = fixture();
        const run = f.runs[0];
        invalidate(run);
        run.turnTwoSends = 3;
        run.stop = "turn_two_exhausted";
        run.facts[4].state = "retryable";
        const r = f.report();
        expect(r.c).toEqual({ numerator: 120, denominator: 600, rate: 0.2 });
        expect(r.retries.turnTwo).toBe(2);
        expect(r.exhaustion.numerator).toBe(1);
    });
});

describe("C8 claim projection and accepted-operation safety", () => {
    test("one lost claim in one of three repeats fails the profile, with both arms by omission family", () => {
        const f = fixture();
        const run = f.runs[40];
        replaceGrade(
            run,
            (g) => g.binding.kind === "claim" && g.binding.runId === run.runId,
            verdict({ version: 1, kind: "claim", status: "lost" }),
        );
        replaceGrade(
            run,
            (g) => g.binding.kind === "claim" && g.binding.runId.endsWith(":S"),
            verdict({ version: 1, kind: "claim", status: "lost" }),
        );
        const r = f.report();
        expect(r.outcome).toBe("fail");
        expect(r.precedence).toBe(1);
        expect(r.d.production.byFamily.constraints).toEqual({
            evaluated: 120,
            lost: 1,
            deferred: 0,
        });
        expect(r.d.stripped.byFamily.constraints.lost).toBe(1);
    });
    for (const location of ["source", "evidence"])
        test(`claim held only in ${location} rows is lost`, () => {
            const f = fixture();
            const run = f.runs[0];
            run.projection.memories = [];
            run.projection.candidates = [];
            run.compartments = [{ content: "Keep the rule." }];
            if (location === "evidence") run.stages.push({ evidence: "Keep the rule." });
            run.projectionHash = hash(run.projection);
            f.regrade(run);
            replaceGrade(
                run,
                (g) => g.binding.kind === "claim" && g.binding.runId === run.runId,
                verdict({ version: 1, kind: "claim", status: "lost" }),
            );
            expect(f.report().outcome).toBe("fail");
            expect(f.report().d.production.lost).toBe(1);
        });
    test("claim only in a retryable candidate is deferred, not lost", () => {
        const f = fixture();
        const run = f.runs[0];
        run.facts[4].state = "retryable";
        run.projection.memories = [];
        run.projection.candidates = [run.facts[4]];
        run.projectionHash = hash(run.projection);
        f.regrade(run);
        replaceGrade(
            run,
            (g) => g.binding.kind === "claim" && g.binding.runId === run.runId,
            verdict({ version: 1, kind: "claim", status: "deferred" }),
        );
        const r = f.report();
        expect(r.outcome).toBe("pass");
        expect(r.d.production.lost).toBe(0);
        expect(r.d.production.deferred).toBe(1);
        expect(r.c.numerator).toBe(120);
    });
    test("a stripped-arm loss has no gate effect", () => {
        const f = fixture();
        replaceGrade(
            f.runs[0],
            (g) => g.binding.kind === "claim" && g.binding.runId.endsWith(":S"),
            verdict({ version: 1, kind: "claim", status: "lost" }),
        );
        expect(f.report().outcome).toBe("pass");
        expect(f.report().d.stripped.lost).toBe(1);
    });
    test("projection hashes cannot credit inactive memories or source rows", () => {
        const f = fixture();
        const run = f.runs[0];
        run.projection.memories = [{ id: 1, content: "Keep the rule.", status: "archived" }];
        run.projectionHash = hash(run.projection);
        f.regrade(run);
        expect(f.report().outcome).toBe("not-run");
    });
    for (const action of ["merge", "replaces", "new", "edit", "conflict"])
        test(`authorized ${action} receipt passes (a), including unit archival`, () => {
            const f = fixture();
            const run = f.runs[0];
            const c = f.corpus.cases[0];
            if (["merge", "replaces"].includes(action)) {
                c.memories = [
                    { id: 7, revision: 1, category: "CONSTRAINTS", content: "Old rule." },
                ];
                for (const other of f.runs.filter((r) => r.caseId === 0 && r !== run))
                    other.projection.memories.push({
                        id: 7,
                        revision: 1,
                        category: "CONSTRAINTS",
                        content: "Old rule.",
                        status: "active",
                    });
            }
            const stage = run.stages[1] as { reply_json: string };
            const reply = JSON.parse(stage.reply_json);
            const envelope = JSON.parse(reply.text);
            envelope.result.decisions[0] =
                action === "merge"
                    ? { fact_id: 1, check: "Audit fixture.", action, sources: [
                        { id: 1, revision: 1 },
                        { id: 7, revision: 1 },
                    ],
                    survivor_id: 1,
                    kept: [],
                    added: [],
                    final_text: "Keep the rule.", }
                    : action === "replaces" || action === "edit"
                      ? { fact_id: 1, check: "Audit fixture.", action, target_id: 7,
                      revision: 1,
                      removed: [],
                      replaced: [],
                      kept: [],
                      added: [],
                      final_text: "Keep the rule.", }
                      : action === "conflict"
                        ? { fact_id: 1, check: "Audit fixture.", action, target_id: 7 }
                         : { fact_id: 1, check: "Audit fixture.", action };
            reply.text = JSON.stringify(envelope);
            stage.reply_json = JSON.stringify(reply);
            const receipt = run.receipts[0] as { receipt_json: string };
            receipt.receipt_json = JSON.stringify({
                state: "applied",
                reason: action,
                adoptionClass: "live",
                memoryId: 1,
                supersededIds: [7],
            });
            f.refresh();
            for (const r of f.runs) {
                r.projectionHash = hash(r.projection);
                f.regrade(r);
            }
            const r = f.report();
            expect(r.a.mechanical).toEqual([]);
            expect(r.outcome).toBe("pass");
        });
    for (const action of ["retire", "promote_rule"])
        test(`accepted standalone ${action} fails, but a parsed-and-dropped proposal does not`, () => {
            const f = fixture();
            const run = f.runs[0];
            const stage = run.stages[1] as { reply_json: string };
            const reply = JSON.parse(stage.reply_json);
            const envelope = JSON.parse(reply.text);
            envelope.result.decisions[0] = { fact_id: 1, check: "Audit fixture.", action, target_id: 1 };
            reply.text = JSON.stringify(envelope);
            stage.reply_json = JSON.stringify(reply);
            f.regrade(run);
            expect(f.report().outcome).toBe("fail");
            (run.receipts[0] as { receipt_json: string }).receipt_json = JSON.stringify({
                state: "decided_pending",
                reason: `${action}_dropped`,
                adoptionClass: "live",
            });
            f.regrade(run);
            expect(f.report().a.mechanical).toEqual([]);
        });
    test("invented dates composed of existing numeric tokens fail mechanically", () => {
        const f = fixture();
        const run = f.runs[0];
        f.corpus.cases[0].userPrompt += " Dates: April 1, 2026 and May 17, 2026.";
        run.facts[0].content = "Deadline: April 17, 2026.";
        f.refresh();
        for (const r of f.runs) f.regrade(r);
        f.artifact.profiles[0].calibrations = [];
        expect(f.report().a.mechanical.some((failure) => failure.includes("invented_date"))).toBe(
            true,
        );
        expect(f.report().outcome).toBe("fail");
    });
    test("invented accepted number fails even with void grades", () => {
        const f = fixture();
        f.runs[0].facts[0].content = "Invented 314159.";
        f.regrade(f.runs[0]);
        f.artifact.profiles[0].calibrations = [];
        expect(f.report().outcome).toBe("fail");
        expect(f.report().a.mechanical.some((failure) => failure.includes("invented_number"))).toBe(
            true,
        );
    });
    test("a failed non-calibration control fails the profile", () => {
        const f = fixture();
        const run = f.runs[12];
        replaceGrade(
            run,
            (g) => g.binding.kind === "control",
            verdict({ version: 1, kind: "control", status: "fail" }),
        );
        expect(f.report().outcome).toBe("fail");
        expect(f.report().reasons).toContain("failed_control");
    });
});

describe("C8 calibration, provenance and outcome precedence", () => {
    test("failed calibration with passing independent regrade retains both without blocking", () => {
        const f = fixture();
        const p = f.artifact.profiles[0];
        const original = p.calibrations[0];
        original.verdict = "incorrect";
        original.void = true;
        const replacementReviewer: Reviewer = {
            kind: "model",
            model: "replacement",
            family: "third-family",
        };
        const replacement = grade(original.binding, "expected-bad", replacementReviewer);
        replacement.replaces = hash(original);
        p.calibrations.push(replacement);
        for (const run of f.runs) {
            const originals = run.grades;
            f.regrade(run, replacementReviewer);
            run.grades.forEach((g, i) => {
                g.replaces = hash(originals[i]);
            });
            run.grades = [...originals, ...run.grades];
        }
        const r = f.report();
        expect(r.outcome).toBe("pass");
        expect(r.calibrations).toHaveLength(2);
        expect(r.calibrations.map((g) => g.effective)).toEqual([false, true]);
        expect(r.grades.some((g) => !g.admissible)).toBe(true);
    });
    for (const unfinished of [false, true])
        for (const detector of [false, true])
            test(`void grader with ${unfinished ? "unfinished" : "failing"} regrade and detector=${detector}`, () => {
                const f = fixture();
                const original = f.artifact.profiles[0].calibrations[0];
                original.verdict = "wrong calibration";
                original.void = true;
                if (!unfinished) {
                    const regrade = grade(original.binding, "also wrong", human);
                    regrade.replaces = hash(original);
                    f.artifact.profiles[0].calibrations.push(regrade);
                }
                if (detector) {
                    const stage = f.runs[0].stages[1] as { reported_profile_json: string };
                    stage.reported_profile_json = JSON.stringify({
                        ...f.send("turn_two", "").actual,
                        modelId: "unmatched",
                    });
                }
                expect(f.report().outcome).toBe(detector ? "fail" : "not-run");
            });
    test("multiple failed calibrations can be replaced transitively by a passing regrade", () => {
        const f = fixture();
        const p = f.artifact.profiles[0];
        const first = p.calibrations[0];
        first.verdict = "wrong";
        first.void = true;
        const second = grade(first.binding, "also wrong", {
            kind: "model",
            model: "third",
            family: "third-family",
        });
        second.void = true;
        second.replaces = hash(first);
        const final = grade(first.binding, "expected-bad", human);
        final.replaces = hash(second);
        p.calibrations.push(second, final);
        for (const run of f.runs) f.regrade(run, human);
        expect(f.report().outcome).toBe("pass");
        expect(f.report().calibrations.map((g) => g.effective)).toEqual([false, false, true]);
    });
    test("a calibration regrade from the failed grader's family cannot replace it", () => {
        const f = fixture();
        const p = f.artifact.profiles[0];
        const original = p.calibrations[0];
        original.verdict = "wrong";
        original.void = true;
        const sameFamily: Reviewer = {
            kind: "model",
            model: "another-model",
            family: "independent",
        };
        const replacement = grade(original.binding, "expected-bad", sameFamily);
        replacement.replaces = hash(original);
        p.calibrations.push(replacement);
        for (const run of f.runs) f.regrade(run, sameFamily);
        expect(f.report().outcome).toBe("not-run");
    });
    test("correctly graded wrong fresh 27:13 decision fails (a), not calibration", () => {
        const f = fixture();
        const run = f.runs[27];
        replaceGrade(run, (g) => g.binding.kind === "resolved", factVerdict("new", "wrong"));
        expect(f.report().outcome).toBe("fail");
        expect(f.report().precedence).toBe(1);
    });
    for (const missing of ["calibration", "ordinary"])
        test(`unanswered or missing ${missing} grade is not-run`, () => {
            const f = fixture();
            if (missing === "calibration") f.artifact.profiles[0].calibrations = [];
            else f.runs[0].grades.shift();
            expect(f.report().outcome).toBe("not-run");
        });
    for (const actual of [
        null,
        { kind: "model", model: "tested-judge", family: "tested" } as Reviewer,
    ])
        test(`${actual ? "same-family" : "unattributed"} model grade is void even if artifact says otherwise`, () => {
            const f = fixture();
            f.runs[0].grades[0].actual = actual;
            f.runs[0].grades[0].void = false;
            expect(f.report().outcome).toBe("not-run");
            expect(f.report().grades[0].admissible).toBe(false);
        });
    test("same-family calibration and grades remain void when artifact flags are forged", () => {
        const f = fixture();
        const actual: Reviewer = { kind: "model", model: "tested-grader", family: "tested" };
        for (const g of [
            ...f.artifact.profiles[0].calibrations,
            ...f.runs.flatMap((r) => r.grades),
        ]) {
            g.actual = actual;
            g.void = false;
        }
        expect(f.report().outcome).toBe("not-run");
    });
    test("attributed, attested human calibration and grades are admissible", () => {
        const f = fixture();
        const cal = f.artifact.profiles[0].calibrations[0];
        f.artifact.profiles[0].calibrations = [grade(cal.binding, cal.verdict, human)];
        for (const run of f.runs) f.regrade(run, human);
        expect(f.report().outcome).toBe("pass");
        f.runs[0].grades[0].attestation = "forged";
        expect(f.report().outcome).toBe("not-run");
    });
    test("failed 12:10 control evidenced only by a void grader is not-run", () => {
        const f = fixture();
        const run = f.runs[12];
        replaceGrade(
            run,
            (g) => g.binding.kind === "control",
            verdict({ version: 1, kind: "control", status: "fail" }),
            { kind: "model", model: "same", family: "tested" },
        );
        expect(f.report().outcome).toBe("not-run");
    });
    test("inventory reviewed only by the tested family is rejected at preflight", () => {
        const f = fixture();
        f.corpus.cases[0].inventory.reviewers = [
            { kind: "model", model: "same", family: "tested" },
        ];
        f.refresh();
        expect(f.report().outcome).toBe("not-run");
        expect(f.report().preflightErrors.length).toBeGreaterThan(0);
    });
    for (const stop of ["cost_cap", "unavailable"])
        test(`wrong acceptance outranks ${stop}`, () => {
            const f = fixture();
            f.artifact.profiles[0].stop = stop;
            f.artifact.profiles[0].runs = f.runs.slice(0, 2);
            if (stop === "unavailable") f.profile.priceClass = "free";
            replaceGrade(
                f.runs[0],
                (g) => g.binding.kind === "resolved",
                factVerdict("new", "ambiguous"),
            );
            expect(f.report().outcome).toBe("fail");
            expect(f.report().precedence).toBe(1);
        });
    test("partial free-tier stop is unavailable, but incomplete grades outrank it", () => {
        const f = fixture();
        f.profile.priceClass = "free";
        f.artifact.profiles[0].runs = f.runs.slice(0, 2);
        f.artifact.profiles[0].stop = "unavailable";
        expect(f.report().outcome).toBe("unavailable");
        f.runs[0].grades = [];
        expect(f.report().outcome).toBe("not-run");
    });
    test("each accepted attempt needs its own hash-bound grade without doubling eligible facts", () => {
        const f = fixture();
        const run = f.runs[0];
        const copy = structuredClone(run.receipts[0]) as {
            fact_id: number;
            decision_key: string;
            receipt_json: string;
        };
        const key = JSON.parse(copy.decision_key);
        key[2] = 1;
        copy.decision_key = JSON.stringify(key);
        run.receipts.push(copy);
        expect(f.report().outcome).toBe("not-run");
        const stage = run.stages[1] as { request_json: string; reply_json: string };
        run.grades.push(
            grade(
                {
                    runId: run.runId,
                    kind: "resolved",
                    key: copy.decision_key,
                    inputHash: lifecycleTextHash(stage.request_json),
                    outputHash: lifecycleTextHash(JSON.parse(stage.reply_json).text),
                },
                factVerdict(),
            ),
        );
        expect(f.report().outcome).toBe("pass");
        expect(f.report().c.denominator).toBe(600);
    });
    test("an orphaned accepted receipt cannot escape complete grading", () => {
        const f = fixture();
        f.runs[0].facts.shift();
        f.regrade(f.runs[0]);
        expect(f.report().outcome).toBe("not-run");
    });
    test("hash-mismatched grades and unrecognized verdict prose are incomplete", () => {
        const f = fixture();
        f.runs[0].grades[0].binding.inputHash = "wrong";
        expect(f.report().outcome).toBe("not-run");
        f.regrade(f.runs[0]);
        f.runs[0].grades[0].verdict = "seems correct, perhaps wrong";
        expect(f.report().outcome).toBe("not-run");
    });
});

describe("C8 cost reporting at inclusive caps", () => {
    test("exactly USD 15 is charged; a next-call bound above it is refused", () => {
        const f = fixture();
        const ledger = new CampaignLedger();
        const id = ledger.reserve(f.profile, "turn_one", 15_000_000, 0, 1);
        ledger.settle(id);
        expect(() => ledger.reserve(f.profile, "turn_two", 1, 0, 1)).toThrow("cost_cap");
        f.artifact.ledger = ledger.rows;
        const r = f.report();
        expect(r.cost.chargedUSD).toBe(15);
        expect(r.cost.remainingUSD).toBe(0);
        expect(r.outcome).toBe("pass");
        expect(ledger.rows).toHaveLength(1);
    });
    test("exactly USD 50 includes a paid grader for a free profile; next bound is refused", () => {
        const f = fixture();
        f.profile.priceClass = "free";
        const ledger = new CampaignLedger();
        const id = ledger.reserve(f.profile, "grader", 50_000_000, 0, 1);
        ledger.settle(id);
        expect(() => ledger.reserve(f.profile, "regrade", 1, 0, 1)).toThrow("cost_cap");
        f.artifact.ledger = ledger.rows;
        const report = validationReport(f.artifact, f.corpus, JSON.stringify(f.artifact.matrix));
        expect(report.ledger.chargedUSD).toBe(50);
        expect(report.ledger.remainingUSD).toBe(0);
        expect(report.profiles[0].cost.capApplies).toBe(false);
        expect(report.profiles[0].cost.chargedUSD).toBe(50);
        expect(report.profiles[0].outcome).toBe("pass");
        expect(ledger.rows).toHaveLength(1);
    });
    test("over-cap or unmetered ledger rows cannot pass without a recorded stop", () => {
        const f = fixture();
        f.artifact.ledger = [
            {
                profileId: f.profile.id,
                kind: "grader",
                tariff: f.profile.tariff,
                reserved: 16,
                charged: 16,
                settled: true,
            },
        ];
        expect(f.report().outcome).toBe("not-run");
        f.artifact.ledger[0] = {
            ...f.artifact.ledger[0],
            reserved: 1,
            charged: 1,
            tariff: { ...f.profile.tariff, source: "unknown" },
        };
        expect(f.report().outcome).toBe("not-run");
    });
    test("cap stop before completion or missing meter is not-run", () => {
        const f = fixture();
        f.artifact.profiles[0].runs = f.runs.slice(0, 2);
        f.artifact.profiles[0].stop = "cost_cap";
        expect(f.report().outcome).toBe("not-run");
        f.artifact.profiles[0].stop = "no_cost_meter";
        expect(f.report().outcome).toBe("not-run");
    });
});
