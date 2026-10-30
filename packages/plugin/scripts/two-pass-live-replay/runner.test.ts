import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CampaignLedger, admissibleGrade, hash, schedule, type Profile } from "./artifact-schema";
import { buildTurnOneAuthorizationRequest } from "../../src/features/magic-context/memory/turn-two";
import { lifecycleTextHash } from "../../src/features/magic-context/memory/lifecycle-text";
import { expandTurnTwoEntry } from "../../src/features/magic-context/memory/turn-two-profile";
import { HISTORIAN_FORMAT_INSTRUCTION } from "../../src/features/magic-context/memory/turn-one-publication";
import { historianSystemPrompt } from "../../src/hooks/magic-context/compartment-prompt";
import {
    preflight,
    type Corpus,
    type GraderAssignment,
    type ReplayCase,
    type SendRecord,
} from "./artifact-schema";
import {
    disposableEnvironment,
    openCodeDriver,
    piRpcDriver,
    verifyIsolation,
    type Isolation,
    type HostDriver,
    type HostReply,
} from "./host-drivers";
import { gradeInputs, runCampaign, runCase, strippedPrompt, writeArtifact } from "./runner";
import type { HiddenCompletionExecutor } from "../../src/hooks/magic-context/compartment-runner-types";

const roots: string[] = [];
function isolation(): Isolation {
    const parent = join(realpathSync(tmpdir()), "magic-context");
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, "v1-test-"));
    roots.push(root);
    const file = join(root, "host.db");
    writeFileSync(file, "");
    return {
        root,
        env: disposableEnvironment(root),
        proof: { pid: 42, tool: "fake-open-handles", output: file, paths: [file] },
    };
}
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const paid = {
    id: "oc2",
    priceClass: "paid",
    tariff: { inputUSDPerMillion: 1, outputUSDPerMillion: 2, source: "fixture tariff" },
} as Profile;

describe("C8 ledger and provenance", () => {
    test("a three-step OpenCode 2 send settles to the sum of host steps", () => {
        const ledger = new CampaignLedger();
        const id = ledger.reserve(paid, "turn_two", 1000, 1000, 4);
        ledger.settle(id, [
            { inputTokens: 100, outputTokens: 10 },
            { inputTokens: 200, outputTokens: 20 },
            { inputTokens: 300, outputTokens: 30 },
        ]);
        expect(ledger.rows[id].charged).toBeCloseTo(0.00072, 10);
        expect(ledger.rows[id].settled).toBe(true);
    });
    test("a multi-step bound over the remaining cap is refused before sending", () => {
        const ledger = new CampaignLedger(0.01, 50);
        expect(() => ledger.reserve(paid, "turn_one", 1000, 1000, 4)).toThrow("cost_cap");
        expect(ledger.rows).toHaveLength(0);
    });
    test("a paid grader for a free profile still consumes the campaign cap", () => {
        const ledger = new CampaignLedger(15, 0.01);
        expect(() =>
            ledger.reserve({ ...paid, priceClass: "free" }, "grader", 1000, 1000, 4),
        ).toThrow("cost_cap");
    });
    test("unknown outcomes keep their bound and exact caps are inclusive", () => {
        const ledger = new CampaignLedger(0.012, 0.012);
        const id = ledger.reserve(paid, "turn_one", 1000, 1000, 4);
        ledger.settle(id);
        expect(ledger.rows[id].charged).toBe(0.012);
        expect(() => ledger.reserve(paid, "turn_two", 1, 1, 1)).toThrow("cost_cap");
    });
    test("a model grader answering in the tested family is void", () => {
        const binding = {
            runId: "run",
            kind: "claim" as const,
            key: "claim-1",
            inputHash: "input",
            outputHash: "projection",
        };
        expect(
            admissibleGrade(
                binding,
                "held",
                { kind: "model", model: "fallback", family: "tested" },
                "tested",
            ).void,
        ).toBe(true);
        expect(admissibleGrade(binding, "held", null, "tested").void).toBe(true);
        expect(
            admissibleGrade(
                binding,
                "held",
                { kind: "model", model: "other", family: "independent" },
                "tested",
            ).void,
        ).toBe(false);
        const actual = { kind: "human" as const, name: "Reviewer" };
        expect(
            admissibleGrade(
                binding,
                "held",
                actual,
                "tested",
                hash({ binding, verdict: "held", reviewer: "Reviewer" }),
            ).void,
        ).toBe(false);
    });
    test("the interleaved schedule has exactly three nonadjacent repeats per case", () => {
        const runs = schedule();
        expect(runs).toHaveLength(120);
        for (let id = 0; id < 40; id++)
            expect(runs.filter((r) => r.caseId === id).map((r) => r.repeat)).toEqual([0, 1, 2]);
        expect(runs.slice(1).every((r, i) => r.caseId !== runs[i].caseId)).toBe(true);
    });
    test("host open-handle evidence rejects a live store", () => {
        const proof = isolation();
        expect(() => verifyIsolation(proof)).not.toThrow();
        proof.proof.paths.push("/home/person/.local/share/opencode/opencode.db");
        expect(() => verifyIsolation(proof)).toThrow("live_store_handle");
    });
});

const xml = `<compartment start="1" end="2" title="Rules"><p1>New rule. Keep rule.</p1><p2>Rules</p2><p3>Rules</p3><p4/></compartment>
<facts><CONSTRAINTS>
* [at_compartment=1 messages=1-1] New rule.
* [at_compartment=1 messages=1-1] Keep rule.
* [at_compartment=1 messages=1-1] Third rule.
</CONSTRAINTS></facts>`;
const turnOne = JSON.stringify({ result: { step: "turn_one", xml } });
const example: ReplayCase = {
    id: 0,
    source: { recording: "recording.json", sha256: "a".repeat(64), sessionId: "recorded-session" },
    userPrompt:
        "Prefix\n<project-memory>Old rule. Keep rule.</project-memory>\n<new_messages>[1] user: New rule. Keep rule. Third rule.\n[2] assistant: Acknowledged.</new_messages>\nSuffix",
    blocks: [
        {
            role: "user",
            startOrdinal: 1,
            endOrdinal: 1,
            parts: ["New rule. Keep rule. Third rule."],
        },
        { role: "assistant", startOrdinal: 2, endOrdinal: 2, parts: ["Acknowledged."] },
    ],
    lines: [{ ordinal: 1, messageId: "source-message-1" }, { ordinal: 2, messageId: "source-message-2" }],
    memories: [],
    recordedOutput: "recorded",
    inventory: {
        value: [],
        sha256: hash([]),
        producer: "corpus-review",
        reviewers: [{ kind: "human", name: "Reviewer" }],
    },
};
function fixture(
    script?: (
        kind: SendRecord["kind"],
        count: number,
        prompt: string,
        normal: HostReply,
    ) => HostReply | Error,
) {
    const root = isolation();
    const entry = buildTurnOneAuthorizationRequest(
        {
            lane: "opencode-2",
            carrier: "hidden-completion",
            provider: "fixture",
            modelId: "tested",
            variant: null,
            temperature: null,
            thinkingLevel: null,
        },
        {
            system: historianSystemPrompt(true),
            formatInstruction: HISTORIAN_FORMAT_INSTRUCTION,
            toolSurface: [],
            checkToolSurface: [],
        },
    ).requestedIdentity;
    const profile: Profile = {
        ...paid,
        entry,
        family: "tested",
        modelRoute: "fixture/tested",
        configurationSource: "fixture effective settings",
        variantSource: "fixture null variant",
        configuredTemperature: 0.1,
        configuredThinkingLevel: null,
    };
    const closed: string[] = [];
    const sent: Array<{
        kind: SendRecord["kind"];
        id: string;
        prompt: string;
        continuation: boolean;
    }> = [];
    const counts = new Map<SendRecord["kind"], number>();
    let children = 0;
    const driver: HostDriver = {
        lane: entry.lane,
        carrier: entry.carrier,
        isolation: root,
        transport: "fake",
        async attest() {
            return root;
        },
        historianTools: [],
        checkTools: [],
        maxSteps: 4,
        hostRetryLimit: 0,
        async open(system, format, kind) {
            const id = `child-${++children}`;
            return {
                id,
                async send(prompt, continuation) {
                    const actualKind = continuation ? "turn_two" : kind;
                    sent.push({ kind: actualKind, id, prompt, continuation });
                    const count = (counts.get(actualKind) ?? 0) + 1;
                    counts.set(actualKind, count);
                    const factIds = [...prompt.matchAll(/## Fact (\d+)/g)].map((m) => Number(m[1]));
                    const normal: HostReply = {
                        text:
                            actualKind === "turn_two"
                                ? JSON.stringify({
                                      result: {
                                          step: "turn_two",
                                          decisions: factIds.map((fact_id) => ({
                                               fact_id,
                                               check: "Audit fixture.",
                                               action: "new",
                                          })),
                                          scores: [],
                                      },
                                  })
                                : actualKind === "stripped"
                                  ? xml
                                  : turnOne,
                        profile: {
                            ...expandTurnTwoEntry(entry)[0],
                            systemHash: lifecycleTextHash(system),
                            schemaHash: lifecycleTextHash(format),
                        },
                        lengthCapped: false,
                        steps: [{ inputTokens: 100, outputTokens: 100 }],
                    };
                    const result = script?.(actualKind, count, prompt, normal) ?? normal;
                    if (result instanceof Error) throw result;
                    return result;
                },
                async close() {
                    closed.push(id);
                },
            };
        },
    };
    return {
        profile,
        driver,
        sent,
        closed,
        ledger: new CampaignLedger(),
        outputCeiling: 4096,
        case: structuredClone(example),
        repeat: 0,
    };
}
describe("fresh live replay through fake host transport", () => {
    test("an envelope failure then valid turn two keeps fact ids, charges one attempt and applies", async () => {
        const f = fixture((kind, count, _prompt, normal) =>
            kind === "turn_two" && count === 1 ? { ...normal, text: "invalid envelope" } : normal,
        );
        const run = await runCase(f);
        expect(run.turnTwoSends).toBe(2);
        expect(run.facts.map((f) => [f.id, f.state, f.fact_attempts])).toEqual([
            [1, "applied", 1],
            [2, "applied", 1],
            [3, "applied", 1],
        ]);
        expect(run.projection.memories).toHaveLength(3);
        expect(run.retryCandidates).toHaveLength(1);
        expect(run.schemaValid).toBe(true);
        const seconds = run.sends.filter((s) => s.kind === "turn_two");
        expect(seconds.map((s) => s.request.messages[2].content.match(/## Fact \d+/g))).toEqual([
            ["## Fact 1", "## Fact 2", "## Fact 3"],
            ["## Fact 1", "## Fact 2", "## Fact 3"],
        ]);
        for (const second of seconds) {
            const first = run.sends.find(
                (s) => s.kind === "turn_one" && s.childId === second.childId,
            )!;
            expect(second.request.messages.slice(0, 2)).toEqual([
                ...first.request.messages,
                { role: "assistant", content: first.reply! },
            ]);
            expect(second.request.system).toBe(first.request.system);
        }
        expect(f.closed).toHaveLength(3);
        expect(new Set(f.closed).size).toBe(f.closed.length);
    });
    test("a mixed reply leaves malformed facts terminal while valid siblings stay applied", async () => {
        const f = fixture((kind, _count, _prompt, normal) =>
            kind === "turn_two"
                ? {
                      ...normal,
                      text: JSON.stringify({
                          result: {
                              step: "turn_two",
                              decisions: [
                                  { fact_id: 1, check: "Audit fixture.", action: "new" },
                                  { fact_id: 2, check: "Audit fixture.", action: "not-an-action" },
                                  { fact_id: 3, check: "Audit fixture.", action: "new" },
                              ],
                              scores: [],
                          },
                      }),
                  }
                : normal,
        );
        const run = await runCase(f);
        expect(run.facts.map((f) => f.state)).toEqual(["applied", "decided_pending", "applied"]);
        expect(run.turnTwoSends).toBe(1);
        expect(run.schemaValid).toBe(false);
        expect(run.projection.memories).toHaveLength(2);
        expect(run.projection.candidates.map((f) => f.id)).toEqual([2]);
    });
    test("repeated envelope failures end after three turn-two sends", async () => {
        const f = fixture((kind, _count, _prompt, normal) =>
            kind === "turn_two" ? { ...normal, text: "invalid envelope" } : normal,
        );
        const run = await runCase(f);
        expect(run.turnTwoSends).toBe(3);
        expect(f.sent.filter((s) => s.kind === "turn_two")).toHaveLength(3);
        expect(f.sent.filter((s) => s.kind === "turn_one")).toHaveLength(3);
        expect(run.facts.map((f) => f.fact_attempts)).toEqual([3, 3, 3]);
        expect(run.projection.memories).toHaveLength(0);
    });
    test("three turn-one failures end with no compartments, candidates or promotion", async () => {
        const f = fixture((kind, _count, _prompt, normal) =>
            kind === "turn_one" ? { ...normal, text: "not a wrapper" } : normal,
        );
        const run = await runCase(f);
        expect(run.stop).toBe("turn_one_exhausted");
        expect(run.turnOneFailures).toBe(3);
        expect(run.turnTwoSends).toBe(0);
        expect(run.facts).toHaveLength(0);
        expect(run.compartments).toHaveLength(0);
        expect(run.stages).toHaveLength(3);
        expect(run.projection.memories).toHaveLength(0);
        expect(f.sent.filter((s) => s.kind === "turn_one")).toHaveLength(3);
    });
    for (const position of ["turn_one", "turn_two"] as const)
        test(`identity mismatch on ${position} applies nothing and is not credited to fallback`, async () => {
            const f = fixture((kind, _count, _prompt, normal) =>
                kind === position
                    ? { ...normal, profile: { ...normal.profile!, modelId: "fallback" } }
                    : normal,
            );
            const run = await runCase(f);
            expect(run.stop).toBe("identity_mismatch");
            expect(run.profileId).toBe(f.profile.id);
            expect(run.projection.memories).toHaveLength(0);
            expect(run.facts.every((f) => f.state === "retryable" && f.fact_attempts === 1)).toBe(
                true,
            );
            expect(f.sent.filter((s) => s.kind === position)).toHaveLength(1);
            expect(run.sends.find((s) => s.kind === position)?.actual?.modelId).toBe("fallback");
            expect(run.schemaValid).toBe(false);
        });
    test("T3 ordered check mismatch keeps earlier receipt and charges the reserved siblings", async () => {
        const f = fixture((kind, _count, _prompt, normal) => {
            if (kind === "turn_two")
                return {
                    ...normal,
                    text: JSON.stringify({
                        result: {
                            step: "turn_two",
                            decisions: [
                                { fact_id: 1, check: "Audit fixture.", action: "new" },
                                { fact_id: 2, check: "Audit fixture.", action: "edit", target_id: 10,
                                revision: 1,
                                replaced: [
                                    {
                                        memory_id: 10,
                                        clause: 1,
                                        block: 1,
                                        excerpt: "New rule.",
                                    },
                                ],
                                kept: [{ memory_id: 10, clause: 2 }],
                                added: [{ text: "New rule. ", block: 1, excerpt: "New rule." }],
                                final_text: "New rule. Keep rule.", },
                                { fact_id: 3, check: "Audit fixture.", action: "new" },
                            ],
                            scores: [],
                        },
                    }),
                };
            if (kind === "check")
                return {
                    ...normal,
                    text: JSON.stringify({ verdicts: [] }),
                    profile: { ...normal.profile!, modelId: "fallback" },
                };
            return normal;
        });
        f.case.memories = [
            { id: 10, revision: 1, category: "CONSTRAINTS", content: "Old rule. Keep rule." },
        ];
        const run = await runCase(f);
        expect(run.stop).toBe("identity_mismatch");
        expect(run.facts.map((f) => [f.state, f.fact_attempts])).toEqual([
            ["applied", 0],
            ["retryable", 1],
            ["retryable", 1],
        ]);
        expect(run.projection.memories).toHaveLength(2);
        expect(run.projection.memories).toContainEqual({
            id: 10,
            category: "CONSTRAINTS",
            content: "Old rule. Keep rule.",
            revision: 1,
            status: "active",
        });
        expect(f.sent.filter((s) => s.kind === "check")).toHaveLength(1);
        expect(new Set(f.closed).size).toBe(f.closed.length);
    });
    test("stripped arm sends XML without authorization and cannot change the store or projection", async () => {
        const f = fixture();
        const run = await runCase(f);
        const stripped = run.sends.find((s) => s.kind === "stripped")!;
        expect(stripped.request.system).toBe(historianSystemPrompt(false));
        expect(stripped.request.messages).toEqual([
            { role: "user", content: strippedPrompt(example.userPrompt) },
        ]);
        expect(stripped.request.messages[0].content).not.toContain("<project-memory>");
        expect(stripped.request.messages[0].content).not.toContain(HISTORIAN_FORMAT_INSTRUCTION);
        expect(stripped.reply).toBe(xml);
        expect(run.projection.memories).toHaveLength(3);
        expect(run.projectionHash).toBe(hash(run.projection));
        expect(run.stages).toHaveLength(2);
    });
    test("a send over the remaining multi-step cap never reaches transport", async () => {
        const f = fixture();
        f.ledger = new CampaignLedger(0.001, 50);
        const run = await runCase(f);
        expect(run.stop).toBe("cost_cap");
        expect(f.sent).toHaveLength(0);
        expect(run.sends).toHaveLength(0);
    });
    test("a retry turn-one identity mismatch ends the original profile's run", async () => {
        const f = fixture((kind, count, _prompt, normal) => {
            if (kind === "turn_two") return { ...normal, text: "bad envelope" };
            if (kind === "turn_one" && count === 2)
                return { ...normal, profile: { ...normal.profile!, modelId: "fallback" } };
            return normal;
        });
        const run = await runCase(f);
        expect(run.stop).toBe("identity_mismatch");
        expect(run.turnTwoSends).toBe(1);
        expect(run.facts.map((f) => [f.state, f.fact_attempts])).toEqual([
            ["retryable", 1],
            ["retryable", 1],
            ["retryable", 1],
        ]);
        expect(run.projection.memories).toHaveLength(0);
    });
    test("resolved grades bind the actual resolving attempt and raw output hash", async () => {
        const f = fixture((kind, count, _prompt, normal) =>
            kind === "turn_two" && count === 1 ? { ...normal, text: "bad envelope" } : normal,
        );
        const run = await runCase(f);
        const corpus = corpusFixture();
        const inputs = gradeInputs(run, f.case, corpus);
        const last = run.sends.filter((s) => s.kind === "turn_two")[1];
        expect(inputs.filter((i) => i.binding.kind === "resolved")).toHaveLength(3);
        for (const task of inputs)
            if (task.binding.kind === "resolved") {
                expect(task.binding.outputHash).toBe(last.replyHash!);
                expect(JSON.parse(task.binding.key)[5]).toBe(
                    (task.input as { attempt: { stage_key: string } }).attempt.stage_key,
                );
            }
    });
});

function corpusFixture(): Corpus {
    const calibrationValue = {
        key: "27:13" as const,
        outputHash: lifecycleTextHash(example.recordedOutput),
        expectedGrade: "correct",
    };
    return {
        version: 1,
        cases: Array.from({ length: 40 }, (_, id) => ({ ...structuredClone(example), id })),
        calibration: {
            value: calibrationValue,
            sha256: hash(calibrationValue),
            producer: "independent-S10-review",
            reviewers: [{ kind: "human", name: "Reviewer" }],
        },
        controls: [
            { key: "12:10", assertion: "not an accepted blend" },
            { key: "27:13", assertion: "grade as itself" },
            { key: "35:3", assertion: "keeps 64 KiB and >512 KiB" },
            { key: "2:4", assertion: "repairs c4; new is not repair" },
        ],
    };
}
function matrixFixture(profile: Profile): string {
    return JSON.stringify({
        version: 1,
        rows: [
            {
                status: "candidate",
                lane: profile.entry.lane,
                carriers: [profile.entry.carrier],
                provider: profile.entry.provider,
                modelId: profile.entry.modelId,
                modelRoute: profile.modelRoute,
            },
        ],
    });
}
const assignments: GraderAssignment[] = [
    { testedFamily: "tested", grader: { kind: "human", name: "Reviewer" } },
];
describe("C8 preflight and campaign", () => {
    test("preflight accepts forty anchored independently reviewed cases and rejects incomplete or runner-written inputs", () => {
        const { profile } = fixture();
        const c = corpusFixture();
        const matrix = matrixFixture(profile);
        const check = () => preflight(c, matrix, lifecycleTextHash(matrix), [profile], assignments);
        expect(check).not.toThrow();
        c.cases.pop();
        expect(check).toThrow("case_completeness");
        c.cases.push({ ...structuredClone(example), id: 39 });
        c.cases[1].inventory.producer = "two-pass-live-replay";
        expect(check).toThrow("reviewer_provenance");
    });
    test("preflight rejects same-family inventory, unanchored claims and a wrong calibration hash", () => {
        const { profile } = fixture();
        const matrix = matrixFixture(profile);
        for (const mutation of [
            "same-family",
            "anchor",
            "calibration",
            "matrix",
            "config",
            "tariff",
        ] as const) {
            const c = corpusFixture();
            const p = structuredClone(profile);
            if (mutation === "same-family")
                c.cases[0].inventory.reviewers = [
                    { kind: "model", model: "review-model", family: "tested" },
                ];
            if (mutation === "anchor") {
                c.cases[0].inventory.value = [
                    {
                        id: "claim",
                        family: "omission",
                        text: "rule",
                        anchor: { startOrdinal: 2, endOrdinal: 3 },
                    },
                ];
                c.cases[0].inventory.sha256 = hash(c.cases[0].inventory.value);
            }
            if (mutation === "calibration") c.calibration.value.outputHash = "b".repeat(64);
            if (mutation === "config") p.configurationSource = "unknown";
            if (mutation === "tariff") p.tariff.source = "unknown";
            expect(() =>
                preflight(
                    c,
                    matrix,
                    mutation === "matrix" ? "c".repeat(64) : lifecycleTextHash(matrix),
                    [p],
                    assignments,
                ),
            ).toThrow();
        }
        const tampered = corpusFixture();
        tampered.controls[0].assertion = "accept the blend";
        expect(() =>
            preflight(tampered, matrix, lifecycleTextHash(matrix), [profile], assignments),
        ).toThrow("controls");
    });
    test("a full fake campaign records 120 runs, the matrix hash, calibration and actual human graders", async () => {
        const f = fixture();
        const c = corpusFixture();
        for (const entry of c.cases) {
            entry.inventory.value = [
                {
                    id: "claim-1",
                    family: "omitted-rule",
                    text: "New rule.",
                    anchor: { startOrdinal: 1, endOrdinal: 1 },
                },
            ];
            entry.inventory.sha256 = hash(entry.inventory.value);
        }
        const root = f.driver.isolation.root;
        const recording = JSON.stringify({ fixture: "private recording" });
        writeFileSync(join(root, "recording.json"), recording);
        const refs = c.cases.map((entry) => {
            entry.source.sha256 = lifecycleTextHash(recording);
            const path = `case-${entry.id}.json`;
            const bytes = JSON.stringify(entry);
            writeFileSync(join(root, path), bytes);
            return { path, sha256: lifecycleTextHash(bytes) };
        });
        writeFileSync(join(root, "manifest.json"), JSON.stringify({ ...c, cases: refs }));
        const matrix = matrixFixture(f.profile);
        const matrixPath = join(root, "matrix.json");
        writeFileSync(matrixPath, matrix);
        const primary = { kind: "model" as const, model: "grader-a", family: "independent" };
        let sameFamilyRegrades = 0;
        const result = await runCampaign({
            specimensRoot: root,
            manifestPath: "manifest.json",
            matrixPath,
            expectedMatrixHash: lifecycleTextHash(matrix),
            profiles: [f.profile],
            assignments: [{ testedFamily: "tested", grader: primary }],
            graders: [
                {
                    identity: primary,
                    tariff: paid.tariff,
                    maxSteps: 1,
                    async grade() {
                        return {
                            verdict: "wrong-calibration",
                            actual: primary,
                            raw: "wrong-calibration",
                            steps: [{ inputTokens: 10, outputTokens: 2 }],
                        };
                    },
                },
                {
                    identity: { kind: "model", model: "grader-b", family: "independent" },
                    tariff: paid.tariff,
                    maxSteps: 1,
                    async grade() {
                        sameFamilyRegrades++;
                        throw new Error("must use another family or human");
                    },
                },
                {
                    identity: assignments[0].grader,
                    async grade({ binding }) {
                        const verdict = "correct";
                        return {
                            verdict,
                            actual: assignments[0].grader,
                            raw: verdict,
                            attestation: hash({ binding, verdict, reviewer: "Reviewer" }),
                        };
                    },
                },
            ],
            ledger: f.ledger,
            outputCeiling: 4096,
            async driver() {
                return f.driver;
            },
        });
        expect(result.preflightError).toBeUndefined();
        expect(result.matrixHash).toBe(lifecycleTextHash(matrix));
        expect(result.profiles[0].runs).toHaveLength(120);
        expect(result.profiles[0].calibrations).toHaveLength(2);
        expect(result.profiles[0].calibrations[0].void).toBe(true);
        expect(result.profiles[0].calibrations[1].void).toBe(false);
        expect(result.profiles[0].calibrations[1].replaces).toBe(
            hash(result.profiles[0].calibrations[0]),
        );
        expect(sameFamilyRegrades).toBe(0);
        expect(result.profiles[0].transport).toBe("fake");
        expect(result.profiles[0].runs.every((r) => r.schemaValid)).toBe(true);
        expect(
            result.profiles[0].runs
                .flatMap((r) => r.grades)
                .every((g) => !g.void && g.actual?.kind === "human"),
        ).toBe(true);
        expect(
            result.profiles[0].runs[0].grades.some(
                (g) =>
                    g.binding.kind === "claim" &&
                    g.binding.outputHash === result.profiles[0].runs[0].projectionHash,
            ),
        ).toBe(true);
        const output = join(root, "artifact.json");
        result.profiles[0].isolation!.env.CLINE_API_KEY = "do-not-record";
        writeArtifact(output, result, ["private recording"]);
        expect(readFileSync(output, "utf8")).not.toContain("do-not-record");
        expect(readFileSync(output, "utf8")).not.toContain("private recording");
        expect(
            JSON.parse(readFileSync(output, "utf8")).profiles[0].isolation.env.XDG_DATA_HOME,
        ).toBe(f.driver.isolation.env.XDG_DATA_HOME);
        const failed = await runCampaign({
            specimensRoot: root,
            manifestPath: "missing.json",
            matrixPath,
            expectedMatrixHash: lifecycleTextHash(matrix),
            profiles: [f.profile],
            assignments,
            graders: [],
            ledger: f.ledger,
            outputCeiling: 4096,
            async driver() {
                throw new Error("must not launch");
            },
        });
        expect(failed.preflightError).toBe("preflight_failed");
        expect(failed.profiles[0].stop).toBe("not-run");
        expect(failed.profiles[0].runs).toHaveLength(0);
    }, 30000);
});

describe("real-host adapter contracts on fake transports", () => {
    for (const lane of ["opencode-1", "opencode-2"] as const)
        test(`${lane} preserves child and roles without fallback or second-turn overrides`, async () => {
            const f = fixture();
            const attempts: Parameters<HiddenCompletionExecutor["attempt"]>[] = [];
            const opens: Parameters<HiddenCompletionExecutor["open"]>[0][] = [];
            const executor: HiddenCompletionExecutor = {
                capabilities: {
                    tools: false,
                    harness: lane === "opencode-1" ? "opencode" : "opencode2",
                },
                async open(input) {
                    opens.push(input);
                    return { id: "child" };
                },
                async attempt(...args) {
                    attempts.push(args);
                },
                async collect() {
                    return {
                        text: "reply",
                        lengthCapped: false,
                        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
                        providerId: "fixture",
                        modelId: "tested",
                        observedToolSurface: [],
                    };
                },
                async close() {},
            };
            const driver = openCodeDriver({
                executor,
                host: {
                    pid: f.driver.isolation.proof.pid,
                    harness: lane === "opencode-1" ? "opencode" : "opencode2",
                    carrier: "hidden-completion",
                },
                async testHandleListing() {
                    return f.driver.isolation;
                },
                isolation: f.driver.isolation,
                entry: { ...f.profile.entry, lane },
                parentSessionId: "parent",
                agent: "historian",
                timeoutMs: 1000,
                outputCeiling: 4096,
                hostRetryLimit: 0,
                observedToolSurface: [],
                async observeUsage(_id, key) {
                    expect(key).toMatch(/^key/);
                    return { steps: [{ inputTokens: 1, outputTokens: 1 }] };
                },
            });
            const child = await driver.open(
                historianSystemPrompt(true),
                HISTORIAN_FORMAT_INSTRUCTION,
                "turn_one",
            );
            await child.send("first", false, "key1");
            const second = await child.send("second", true, "key2");
            await child.close();
            expect(opens).toHaveLength(1);
            expect(opens[0].configuredModels).toHaveLength(1);
            expect(attempts.map((a) => a[0].id)).toEqual(["child", "child"]);
            expect(attempts[1][1].continueConversation).toBe(true);
            expect(attempts[1][1].body).not.toHaveProperty("system");
            expect(attempts[1][1].body).not.toHaveProperty("tools");
            expect(second.profile?.lane).toBe(lane);
            expect(child.lastRequest).toEqual({
                open: opens[0],
                attempt: attempts[1][1],
                sendKey: "key2",
            });
        });
    test("OMP uses retained RPC with the actual harness and no fallback models", async () => {
        const f = fixture();
        let retained = 0;
        const entry = {
            ...f.profile.entry,
            lane: "omp" as const,
            carrier: "pi-historian-rpc" as const,
        };
        const driver = piRpcDriver({
            entry,
            harness: "omp",
            hostPid: f.driver.isolation.proof.pid,
            async testHandleListing() {
                return f.driver.isolation;
            },
            isolation: f.driver.isolation,
            timeoutMs: 1000,
            outputCeiling: 4096,
            runner: {
                async runRetainedHistorian(options) {
                    expect(options.agent).toBe("historian");
                    expect(options.fallbackModels).toBeUndefined();
                    expect(options.maxOutputTokens).toBe(4096);
                    const result = {
                        ok: true as const,
                        assistantText: turnOne,
                        durationMs: 1,
                        meta: { reportedProvider: "fixture", reportedModel: "tested" },
                    };
                    return {
                        result,
                        child: {
                            id: "rpc-child",
                            async send() {
                                retained++;
                                return result;
                            },
                            async close() {},
                        },
                    };
                },
            },
            async observeUsage() {
                return { steps: [{ inputTokens: 1, outputTokens: 1 }] };
            },
        });
        const child = await driver.open(
            historianSystemPrompt(true),
            HISTORIAN_FORMAT_INSTRUCTION,
            "turn_one",
        );
        const first = await child.send("first", false, "one");
        await child.send("second", true, "two");
        expect(first.profile?.lane).toBe("omp");
        expect(child.id).toBe("rpc-child");
        expect(retained).toBe(1);
        await child.close();
    });
});
