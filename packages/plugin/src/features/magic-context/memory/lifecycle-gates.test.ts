import { describe, expect, test } from "bun:test";
import {
    CHECK_SYSTEM_PROMPTS,
    type CheckRequest,
    type GateContext,
    makeCheckRequest,
    planMemoryRevision,
    type ReportedProfile,
    type RevisionDecision,
    runMemoryChecks,
} from "./lifecycle-gates";
import { lifecycleTextHash } from "./lifecycle-text";

function fixture(): { decision: RevisionDecision; context: GateContext } {
    const profile: ReportedProfile = {
        provider: "test",
        modelId: "reported",
        variant: null,
        temperature: 0,
        systemHash: "historian-hash",
    };
    const evidence = { blockStartOrdinal: 42, excerpt: "The limit was 32 KiB; it is now 64 KiB." };
    return {
        decision: {
            key: "decision:fact:1:revision:1",
            action: "edit",
            projectPath: "project",
            expectedSources: [{ id: 1, revision: 1 }],
            survivorId: 1,
            finalText: "Limit is 64 KiB. Keep the rule.",
            changes: [{ memoryId: 1, ordinal: 1, evidence, replacement: true }],
            added: [{ text: "Limit is 64 KiB. ", evidence }],
        },
        context: {
            enabled: true,
            enforcedJson: true,
            memoryEnabled: true,
            autoPromote: true,
            anchorKnown: true,
            blocks: [
                {
                    startOrdinal: 42,
                    endOrdinal: 42,
                    role: "user",
                    parts: [evidence.excerpt],
                    joinedText: evidence.excerpt,
                },
            ],
            sources: [
                {
                    id: 1,
                    revision: 1,
                    projectPath: "project",
                    status: "active",
                    content: "Limit is 32 KiB. Keep the rule.",
                },
            ],
            historianProfile: profile,
            validatedProfiles: [
                profile,
                ...Object.values(CHECK_SYSTEM_PROMPTS).map((system) => ({
                    ...profile,
                    systemHash: lifecycleTextHash(system),
                })),
            ],
        },
    };
}
async function assess(f: ReturnType<typeof fixture>, fail?: (request: CheckRequest) => boolean) {
    const plan = planMemoryRevision(f.decision, f.context);
    const calls: CheckRequest[] = [];
    if (!plan.ok) return { ok: false, reason: plan.reason, calls };
    const outcome = await runMemoryChecks(f.decision.key, plan, f.context, async (request) => {
        calls.push(request);
        const passing = request.kind === "disproof" || request.kind === "support" ? "yes" : "no";
        return {
            profile: { ...f.context.historianProfile, systemHash: request.systemHash },
            usage: { tokens: 1 },
            verdicts: (request.kind === "compatibility" ? request.pairs : request.operands).map(
                (operand) => ({
                    id: operand.id,
                    verdict: fail?.(request) ? (passing === "yes" ? "no" : "yes") : passing,
                }),
            ),
        };
    });
    return { ...outcome, calls };
}

describe("memory revision deterministic gates", () => {
    test("narrow-check system hashes are fixed goldens", () => {
        expect(Object.values(CHECK_SYSTEM_PROMPTS).map(lifecycleTextHash)).toEqual([
            "1fd3a4570f756c04a4077211769c8a4d6bdac341051776e368148de9e1ef8792",
            "39ecd8e99026eec9a9ecbd3c8ea4510026f15871aa7be5d3c197a762ee959a5f",
            "650c7f1119f80889701ffc8cb30902c733d8b6108173830f36030a365c866d31",
            "e0c7e6e028509193fc4eb4c020a62e056a5fdd143ac227e124bc8c50722bf608",
        ]);
    });
    test("green single edit plans exactly four isolated calls including full kept input", async () => {
        const f = fixture();
        const outcome = await assess(f);
        expect(outcome.ok).toBe(true);
        expect(outcome.calls.map((call) => call.kind)).toEqual([
            "disproof",
            "support",
            "kept-clause",
            "compatibility",
        ]);
        expect(outcome.calls[2]?.input).toContain("The limit was 32 KiB; it is now 64 KiB.");
        expect(outcome.calls[2]?.input).toContain("Keep the rule.");
        expect(new Set(outcome.calls.map((call) => call.key)).size).toBe(4);
        for (const call of outcome.calls) {
            expect(Object.keys(call).sort()).toEqual([
                "input",
                "key",
                "kind",
                "operands",
                "pairs",
                "system",
                "systemHash",
            ]);
            expect(call.systemHash).not.toBe(f.context.historianProfile.systemHash);
        }
    });
    for (const kind of ["disproof", "support", "kept-clause", "compatibility"] as const)
        test(`reversing ${kind} refuses the whole decision`, async () => {
            const outcome = await assess(fixture(), (request) => request.kind === kind);
            expect(outcome.ok).toBe(false);
            expect(outcome.reason).toBe(`${kind}_refused`);
        });
    const deterministic = [
        [
            "auto_promote false",
            (f: ReturnType<typeof fixture>) => {
                f.context.autoPromote = false;
            },
            "auto_promote_disabled",
        ],
        [
            "memory disabled",
            (f: ReturnType<typeof fixture>) => {
                f.context.memoryEnabled = false;
            },
            "memory_disabled",
        ],
        [
            "dormant lane",
            (f: ReturnType<typeof fixture>) => {
                f.context.enabled = false;
            },
            "lane_dormant",
        ],
        [
            "free text carrier",
            (f: ReturnType<typeof fixture>) => {
                f.context.enforcedJson = false;
            },
            "lane_dormant",
        ],
        [
            "unknown anchor",
            (f: ReturnType<typeof fixture>) => {
                f.context.anchorKnown = false;
            },
            "unknown_anchor",
        ],
        [
            "append only c4",
            (f: ReturnType<typeof fixture>) => {
                f.decision.changes = [];
            },
            "append_only",
        ],
        [
            "archived target",
            (f: ReturnType<typeof fixture>) => {
                f.context.sources[0]!.status = "archived";
            },
            "source_revision",
        ],
        [
            "CAS revision",
            (f: ReturnType<typeof fixture>) => {
                f.context.sources[0]!.revision = 2;
            },
            "source_revision",
        ],
        [
            "foreign project",
            (f: ReturnType<typeof fixture>) => {
                f.context.sources[0]!.projectPath = "elsewhere";
            },
            "source_revision",
        ],
        [
            "unnamed kept blend",
            (f: ReturnType<typeof fixture>) => {
                f.decision.finalText = "Limit is 64 KiB. Keep the rule at 12:10.";
            },
            "clauses",
        ],
        [
            "unrelated passage",
            (f: ReturnType<typeof fixture>) => {
                f.decision.changes[0]!.evidence = {
                    blockStartOrdinal: 42,
                    excerpt: "Unrelated text",
                };
            },
            "evidence_or_window",
        ],
        [
            "wrong block",
            (f: ReturnType<typeof fixture>) => {
                f.decision.changes[0]!.evidence.blockStartOrdinal = 43;
            },
            "evidence_or_window",
        ],
        [
            "paraphrased excerpt",
            (f: ReturnType<typeof fixture>) => {
                f.decision.changes[0]!.evidence.excerpt = "Changed the limit from thirty-two.";
            },
            "evidence_or_window",
        ],
        [
            "marker cut excerpt",
            (f: ReturnType<typeof fixture>) => {
                f.context.blocks[0]!.parts[0] += "…";
                f.decision.changes[0]!.evidence.excerpt += "…";
            },
            "evidence_or_window",
        ],
        [
            "numeric prefix collision 64 vs 164",
            (f: ReturnType<typeof fixture>) => {
                f.context.blocks[0]!.parts = ["The limit was 32 KiB; it is now 164 KiB."];
                f.decision.changes[0]!.evidence.excerpt = f.context.blocks[0]!.parts[0]!;
            },
            "new_token",
        ],
        [
            "dropped 32 token absent",
            (f: ReturnType<typeof fixture>) => {
                f.context.blocks[0]!.parts = ["The limit is now 64 KiB."];
                f.decision.changes[0]!.evidence.excerpt = f.context.blocks[0]!.parts[0]!;
            },
            "dropped_token",
        ],
        [
            "invented date",
            (f: ReturnType<typeof fixture>) => {
                f.decision.added[0]!.text = "Limit is 64 KiB on 2026-10-09. ";
                f.decision.finalText = f.decision.added[0]!.text + "Keep the rule.";
            },
            "new_token",
        ],
        [
            "48,001 kept input",
            (f: ReturnType<typeof fixture>) => {
                f.context.blocks[0]!.joinedText = "x".repeat(48001);
            },
            "kept_input_limit",
        ],
        [
            "oversize matched span",
            (f: ReturnType<typeof fixture>) => {
                f.context.blocks[0]!.parts = ["x".repeat(1201)];
                f.decision.changes[0]!.evidence.excerpt = "x".repeat(1201);
            },
            "evidence_or_window",
        ],
        [
            "two part excerpt",
            (f: ReturnType<typeof fixture>) => {
                f.context.blocks[0]!.parts = ["The limit was 32 KiB;", "it is now 64 KiB."];
            },
            "evidence_or_window",
        ],
    ] as const;
    for (const [name, mutate, reason] of deterministic)
        test(`${name} refuses before any check call`, async () => {
            const f = fixture();
            mutate(f);
            const outcome = await assess(f);
            expect(outcome.ok).toBe(false);
            expect(outcome.reason).toBe(reason);
            expect(outcome.calls).toHaveLength(0);
        });
    test("planned nine calls refuse without sending", async () => {
        const f = fixture();
        f.decision.added = Array.from({ length: 3 }, (_, index) => ({
            text: `Value ${index}. `,
            evidence: { blockStartOrdinal: 42, excerpt: "32 KiB 0 1 2" },
        }));
        f.context.blocks[0]!.parts = ["32 KiB 0 1 2"];
        f.decision.changes[0]!.evidence = f.decision.added[0]!.evidence;
        f.decision.finalText =
            f.decision.added.map((clause) => clause.text).join("") + "Keep the rule.";
        f.context.sources[0]!.content = "A 32 KiB. B 32 KiB. Keep the rule.";
        f.decision.changes.push({ ...f.decision.changes[0]!, ordinal: 2 });
        const outcome = await assess(f);
        expect(outcome.reason).toBe("call_ceiling");
        expect(outcome.calls).toHaveLength(0);
    });
    test("paraphrase-only merge is pending without calls", async () => {
        const f = fixture();
        f.decision.action = "merge";
        f.context.sources[0]!.content = "Keep the rule. Keep the rule.";
        f.decision.finalText = "Keep the rule.";
        f.decision.added = [];
        f.decision.changes[0]!.replacement = false;
        const outcome = await assess(f);
        expect(outcome.reason).toBe("paraphrase_only");
        expect(outcome.calls).toHaveLength(0);
    });
    test("kept c4 check sees host default outside citation window", async () => {
        const f = fixture();
        f.context.blocks[0]!.joinedText += "\nHost completions now run by default.";
        f.context.sources[0]!.content =
            "Limit is 32 KiB. that is the gap to close with a host-runner default.";
        f.decision.finalText =
            "Limit is 64 KiB. that is the gap to close with a host-runner default.";
        const outcome = await assess(f, (request) => request.kind === "kept-clause");
        expect(outcome.reason).toBe("kept-clause_refused");
        expect(outcome.calls[2]?.input).toContain("Host completions now run by default.");
        expect(outcome.calls[2]?.input).toContain("that is the gap to close");
    });
    test("compatible two-source merge plans disproof kept and cross-source checks", async () => {
        const f = fixture();
        f.decision.action = "merge";
        f.decision.added = [];
        f.context.sources[0]!.content = "Limit is 32 KiB. Keep the rule. ";
        f.context.sources.push({
            id: 2,
            revision: 1,
            projectPath: "project",
            status: "active",
            content: "Other rule.",
        });
        f.decision.expectedSources.push({ id: 2, revision: 1 });
        f.decision.finalText = "Keep the rule. Other rule.";
        f.decision.changes[0]!.replacement = false;
        expect((await assess(f)).calls.map((request) => request.kind)).toEqual([
            "disproof",
            "kept-clause",
            "compatibility",
        ]);
        expect((await assess(f, (request) => request.kind === "compatibility")).reason).toBe(
            "compatibility_refused",
        );
    });
    test("reported fallback or tuple mismatch defers", async () => {
        const f = fixture();
        f.context.historianProfile = {
            ...f.context.historianProfile,
            modelId: "fallback-unvalidated",
        };
        expect(await assess(f)).toMatchObject({
            ok: false,
            reason: "unvalidated_profile",
            retryable: true,
            calls: [],
        });
    });
    test("duplicate missing extra pair verdicts are malformed and proposed operands have distinct keys", async () => {
        const f = fixture();
        f.decision.added.push({
            text: "Another rule. ",
            evidence: { blockStartOrdinal: 42, excerpt: "Another rule." },
        });
        f.context.blocks[0]!.parts.push("Another rule.");
        f.decision.finalText = "Limit is 64 KiB. Another rule. Keep the rule.";
        const plan = planMemoryRevision(f.decision, f.context);
        expect(plan.ok).toBe(true);
        if (!plan.ok) return;
        const support = plan.checks.filter((check) => check.kind === "support");
        expect(support[0]?.operands[0]?.id).not.toBe(support[1]?.operands[0]?.id);
        const compatibility = plan.checks.filter((check) => check.kind === "compatibility");
        expect(
            makeCheckRequest(f.decision.key, compatibility[0]!, f.context.historianProfile).key,
        ).not.toBe(
            makeCheckRequest(f.decision.key, compatibility[1]!, f.context.historianProfile).key,
        );
        const result = await runMemoryChecks(f.decision.key, plan, f.context, async (request) => ({
            profile: { ...f.context.historianProfile, systemHash: request.systemHash },
            usage: {},
            verdicts:
                request.kind === "compatibility"
                    ? []
                    : request.operands.map((operand) => ({
                          id: operand.id,
                          verdict: request.kind === "kept-clause" ? "no" : "yes",
                      })),
        }));
        expect(result).toMatchObject({ ok: false, reason: "malformed_check", retryable: false });
    });
});
