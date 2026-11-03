import { describe, expect, test } from "bun:test";
import {
    CHECK_SYSTEM_PROMPTS,
    type GateContext,
    makeCheckRequest,
    planMemoryRevision,
    type RevisionDecision,
} from "../../src/features/magic-context/memory/lifecycle-gates";
import { lifecycleTextHash } from "../../src/features/magic-context/memory/lifecycle-text";
import { authorizationFixture } from "../../src/features/magic-context/memory/turn-two-test-fixtures.test";
import { type RecordedCheck, replayRecordedChecks } from "./core";
import { type ObservedDecision, replayBarFailures } from "./grading";
import { adaptLegacyDecision, auditRecordedControl, type FrozenCase } from "./recorded";

const authorization = authorizationFixture({ lane: "opencode-1", carrier: "hidden-completion", provider: "test", modelId: "recorded-fixture", variant: null, temperature: 0, thinkingLevel: null }, "historian-en");
const profile = authorization.profile;
const fixtureProfiles = authorization.rows;
const decision: RevisionDecision = {
    key: "fixture:decision:1",
    action: "edit",
    projectPath: "/offline",
    survivorId: 1,
    expectedSources: [{ id: 1, revision: 1 }],
    finalText: "Limit is 64 KiB.\nKeep safety.",
    changes: [
        {
            memoryId: 1,
            ordinal: 1,
            replacement: true,
            evidence: { blockStartOrdinal: 10, excerpt: "Change Limit from 32 KiB to 64 KiB." },
        },
    ],
    added: [
        {
            text: "Limit is 64 KiB.\n",
            evidence: { blockStartOrdinal: 10, excerpt: "Change Limit from 32 KiB to 64 KiB." },
        },
    ],
};
const context: GateContext = {
    enabled: true,
    enforcedJson: true,
    memoryEnabled: true,
    autoPromote: true,
    anchorKnown: true,
    blocks: [
        {
            startOrdinal: 10,
            endOrdinal: 10,
            role: "user",
            parts: ["Change Limit from 32 KiB to 64 KiB."],
            joinedText: "Change Limit from 32 KiB to 64 KiB.",
        },
    ],
    sources: [
        {
            id: 1,
            revision: 1,
            projectPath: "/offline",
            content: "Limit is 32 KiB.\nKeep safety.",
            status: "active",
        },
    ],
    historianProfile: profile,
    validatedProfiles: fixtureProfiles,
};
function checkRecords(): RecordedCheck[] {
    const plan = planMemoryRevision(decision, context);
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.checks.map((check) => check.kind)).toEqual([
        "disproof",
        "support",
        "kept-clause",
        "compatibility",
    ]);
    return plan.checks.map((check) => {
        const request = makeCheckRequest(decision.key, check, profile);
        const reply = {
            usage: null,
            profile: authorization.checkProfile(request.systemHash),
            verdicts: (check.kind === "compatibility" ? check.pairs : check.operands).map(
                (operand) => ({
                    id: operand.id,
                    verdict: (check.kind === "disproof" || check.kind === "support"
                        ? "yes"
                        : "no") as "yes" | "no",
                }),
            ),
        };
        return {
            request,
            requestHash: lifecycleTextHash(JSON.stringify(request)),
            reply,
            outputHash: lifecycleTextHash(JSON.stringify(reply)),
        };
    });
}

describe("recorded isolated checks", () => {
    test("four exact records replay; no missing, corrupted or mismatched profile is accepted", async () => {
        expect(await replayRecordedChecks(decision, context, checkRecords())).toEqual({ ok: true });
        expect(await replayRecordedChecks(decision, context, [])).toEqual({
            ok: false,
            reason: "check_transport",
            retryable: true,
        });
        const corrupt = checkRecords();
        corrupt[0]!.reply.profile.modelId = "fallback-not-replayed";
        expect(await replayRecordedChecks(decision, context, corrupt)).toEqual({
            ok: false,
            reason: "check_transport",
            retryable: true,
        });
        corrupt[0]!.outputHash = lifecycleTextHash(JSON.stringify(corrupt[0]!.reply));
        expect((await replayRecordedChecks(decision, context, corrupt)).ok).toBe(false);
        expect(
            (
                await replayRecordedChecks(
                    decision,
                    { ...context, validatedProfiles: [] },
                    checkRecords(),
                )
            ).ok,
        ).toBe(false);
    });
    test("opposite kept verdict refuses despite identical input and validated fixture profile", async () => {
        const records = checkRecords();
        records[2]!.reply.verdicts[0]!.verdict = "yes";
        records[2]!.outputHash = lifecycleTextHash(JSON.stringify(records[2]!.reply));
        expect(await replayRecordedChecks(decision, context, records)).toEqual({
            ok: false,
            reason: "kept-clause_refused",
            retryable: false,
        });
    });
});

const frozen: FrozenCase = {
    firstReplyHash: lifecycleTextHash("first"),
    facts: [{ category: "ARCHITECTURE", content: "Pages use escaped bytes." }],
    origins: ["reconstructed control"],
    matches: [[{ id: 23094, content: "Paging >512 KiB uses 64 KiB frames." }]],
    input: {
        prompt: "<new_messages>\n[10] A: Pages are now cut by their escaped size.\n</new_messages>",
    },
};
const oldRecord = JSON.stringify({
    requestHash: lifecycleTextHash("old request"),
    request: { model: "old-sonnet", system: "historian-old" },
    response: { model: "old-sonnet" },
    text: "recorded output",
});
describe("legacy diagnostic is not validation", () => {
    test("recorded 35:3 shape loses 64 KiB and fails the token gate with zero calls", () => {
        const raw = {
            fact: 1,
            action: "update",
            target: 23094,
            claims: [
                { clause: 1, quote: "Paging >512 KiB uses 64 KiB frames.", status: "replaced" },
            ],
            edits: [
                {
                    op: "edit",
                    clause: 1,
                    text: "Paging >512 KiB uses escaped bytes.",
                    evidence: "Pages are now cut by their escaped size.",
                },
            ],
        };
        const audit = auditRecordedControl("35:3", raw, frozen, oldRecord, { start: 10, end: 10 });
        expect(audit.gate).toBe("dropped_token");
        expect(audit.plannedChecks).toBe(0);
    });
    test("append-only blends are refused, retire and promote are never adapted", () => {
        const raw = {
            fact: 1,
            action: "merge",
            target: 23094,
            claims: [],
            edits: [{ op: "append", text: "Or it detaches." }],
        };
        expect(auditRecordedControl("12:10", raw, frozen, oldRecord).gate).toBe("append_only");
        for (const action of ["retire", "promote_rule"])
            expect(adaptLegacyDecision("x", { ...raw, action }, frozen)).toEqual({
                reason: "historian_action_forbidden",
            });
    });
});

function observations(): ObservedDecision[] {
    return ["12:10", "27:13", "35:3", "2:4"].map((control) => ({
        key: control,
        control,
        action: "edit",
        accepted: true,
        input: "Evidence",
        output: "Recorded output",
        targetBefore: "Old rule",
        targetAfter: control === "35:3" ? "Paging >512 KiB uses 64 KiB frames." : "Repaired rule",
    }));
}
function grades(observed: ObservedDecision[]) {
    return {
        reviewer: "human-independent",
        producer: "model-fixture",
        rubric: "v6",
        grades: observed.map((entry) => ({
            decisionKey: entry.key,
            inputHash: lifecycleTextHash(entry.input),
            outputHash: lifecycleTextHash(entry.output),
            grade: "correct",
            wrongKinds: [],
            reason: "Supported change; valid claims retained.",
        })),
    };
}
describe("v6 acceptance bar", () => {
    test("complete independent grades with all controls pass; absent grades fail closed", () => {
        const observed = observations();
        expect(replayBarFailures(observed, grades(observed))).toEqual([]);
        expect(replayBarFailures(observed, null)).toEqual([
            "independent_v6_grades_missing_or_malformed",
        ]);
    });
    test("lost bounds, stale c4, wrong accepted edits and missing controls fail", () => {
        const observed = observations();
        observed[2]!.targetAfter = "Paging uses escaped bytes.";
        observed[3]!.targetAfter = "that is the gap to close with a host-runner default.";
        const ledger = grades(observed);
        ledger.grades[0]!.grade = "wrong";
        expect(replayBarFailures(observed, ledger)).toEqual([
            "12:10: wrong_or_ambiguous_accepted_decision",
            "35:3: transport_bounds_lost",
            "2:4: outdated_c4_not_repaired",
        ]);
        expect(replayBarFailures(observed.slice(1), grades(observed.slice(1)))).toContain(
            "12:10: control_not_replayed",
        );
    });
});
