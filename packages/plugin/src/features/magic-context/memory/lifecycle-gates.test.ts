import { describe, expect, test } from "bun:test";
import { CHECK_SCHEMA_CONTRACT } from "./historian-schema";
import {
    CHECK_SYSTEM_PROMPTS,
    type CheckRequest,
    type GateContext,
    makeCheckRequest,
    planMemoryRevision,
    type ReportedProfile,
    type RevisionDecision,
    runMemoryChecks,
    sameInferenceTuple,
} from "./lifecycle-gates";
import { lifecycleTextHash } from "./lifecycle-text";

function fixture(): { decision: RevisionDecision; context: GateContext } {
    const profile: ReportedProfile = {
        lane: "opencode-2",
        carrier: "hidden-completion",
        provider: "test",
        modelId: "reported",
        variant: null,
        temperature: 0,
        thinkingLevel: null,
        systemHash: lifecycleTextHash("historian system"),
        schemaHash: lifecycleTextHash("schema contract"),
        toolHash: lifecycleTextHash('["historian"]'),
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
                    schemaHash: lifecycleTextHash(CHECK_SCHEMA_CONTRACT),
                    toolHash: lifecycleTextHash("[]"),
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
            profile: {
                ...f.context.historianProfile,
                systemHash: request.systemHash,
                schemaHash: lifecycleTextHash(CHECK_SCHEMA_CONTRACT),
                toolHash: lifecycleTextHash("[]"),
            },
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
    test("sameInferenceTuple compares thinkingLevel separately from variant", () => {
        const profile = fixture().context.historianProfile;
        expect(sameInferenceTuple(profile, { ...profile })).toBe(true);
        expect(sameInferenceTuple(profile, { ...profile, thinkingLevel: "high" })).toBe(false);
        expect(sameInferenceTuple(profile, { ...profile, thinkingLevel: undefined })).toBe(false);
    });

    test("absent thinkingLevel against a null entry refuses before sending checks", async () => {
        const f = fixture();
        f.context.historianProfile = { ...f.context.historianProfile };
        delete f.context.historianProfile.thinkingLevel;
        expect(await assess(f)).toMatchObject({
            ok: false,
            reason: "unvalidated_profile",
            calls: [],
        });
    });

    for (const [field, value] of [
        ["lane", "opencode-1"],
        ["carrier", "opencode-session"],
        ["thinkingLevel", "high"],
    ] as const) {
        test(`check completion substituted ${field} refuses even with its own validated row`, async () => {
            const f = fixture();
            const lane = field === "lane" ? "opencode-2" : "opencode-1";
            f.context.historianProfile.lane = lane;
            for (const row of f.context.validatedProfiles) row.lane = lane;
            const plan = planMemoryRevision(f.decision, f.context);
            if (!plan.ok) throw new Error("fixture must plan checks");
            const otherRows = f.context.validatedProfiles.map((row) => ({
                ...row,
                [field]: value,
            }));
            f.context.validatedProfiles.push(...otherRows);
            const result = await runMemoryChecks(
                f.decision.key,
                plan,
                f.context,
                async (request) => ({
                    profile: {
                        ...f.context.historianProfile,
                        [field]: value,
                        systemHash: request.systemHash,
                        schemaHash: lifecycleTextHash(CHECK_SCHEMA_CONTRACT),
                        toolHash: lifecycleTextHash("[]"),
                    },
                    usage: {},
                    verdicts: (request.kind === "compatibility"
                        ? request.pairs
                        : request.operands
                    ).map((operand) => ({
                        id: operand.id,
                        verdict:
                            request.kind === "disproof" || request.kind === "support"
                                ? "yes"
                                : "no",
                    })),
                }),
            );
            expect(result).toMatchObject({
                ok: false,
                reason: "unvalidated_profile",
                retryable: true,
            });
        });
    }

    test("null check entry is refused as malformed_check without throwing", async () => {
        const f = fixture();
        const plan = planMemoryRevision(f.decision, f.context);
        expect(plan.ok).toBe(true);
        if (!plan.ok) throw new Error("fixture must plan checks");
        const result = await runMemoryChecks(f.decision.key, plan, f.context, async (request) => ({
            profile: {
                ...f.context.historianProfile,
                systemHash: request.systemHash,
                schemaHash: lifecycleTextHash(CHECK_SCHEMA_CONTRACT),
                toolHash: lifecycleTextHash("[]"),
            },
            usage: {},
            verdicts: [null] as never,
        }));
        expect(result).toEqual({ ok: false, reason: "malformed_check", retryable: false });
    });

    test("tool-bearing check is refused even with passing verdicts", async () => {
        const f = fixture();
        const plan = planMemoryRevision(f.decision, f.context);
        if (!plan.ok) throw new Error("fixture must plan checks");
        expect(
            await runMemoryChecks(f.decision.key, plan, f.context, async (request) => ({
                profile: {
                    ...f.context.historianProfile,
                    systemHash: request.systemHash,
                    schemaHash: lifecycleTextHash(CHECK_SCHEMA_CONTRACT),
                    toolHash: lifecycleTextHash("[]"),
                },
                usage: {},
                toolActivity: true,
                verdicts: request.operands.map((operand) => ({ id: operand.id, verdict: "yes" })),
            })),
        ).toEqual({ ok: false, reason: "malformed_check", retryable: false });
    });

    test("revision planning does not require provider enforcement", async () => {
        for (const enforcedJson of [false, undefined]) {
            const f = fixture();
            f.context.enforcedJson = enforcedJson;
            expect((await assess(f)).ok).toBe(true);
        }
    });
    test("narrow-check system hashes are fixed goldens", () => {
        expect(Object.values(CHECK_SYSTEM_PROMPTS).map(lifecycleTextHash)).toEqual([
            "4095e6562973ff12671fe563a619df4028a6c7224ffc46059ebdb6b7b617b61d",
            "1cb083b67add7897cbc9a637e1123cc802ef4e13bbd20cc79f5c9afbd90d1ec0",
            "bcb0eeb523595fc5ecbbbb150f64d6b9c1e84a02edf4e50e4e094834a0669545",
            "a1b70c1eab9d8330f4071d97e3b5d175e1fafe1ac717dff57f9890dfa8083f25",
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
        f.decision.added = [
            { text: "Limit remains 32 KiB. ", evidence: f.decision.changes[0]!.evidence },
        ];
        f.context.sources[0]!.content = "Limit is 32 KiB. Keep the rule. ";
        f.context.sources.push({
            id: 2,
            revision: 1,
            projectPath: "project",
            status: "active",
            content: "Other rule.",
        });
        f.decision.expectedSources.push({ id: 2, revision: 1 });
        f.decision.finalText = "Limit remains 32 KiB. Keep the rule. Other rule.";
        expect((await assess(f)).calls.map((request) => request.kind)).toEqual([
            "disproof",
            "support",
            "kept-clause",
            "compatibility",
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
            profile: {
                ...f.context.historianProfile,
                systemHash: request.systemHash,
                schemaHash: lifecycleTextHash(CHECK_SCHEMA_CONTRACT),
                toolHash: lifecycleTextHash("[]"),
            },
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

for (const [name, text, preserved] of [
    ["keeps each source identifier and number in the survivor", "retry_limit remains 17. ", true],
    ["refuses a lost identifier even if evidence repeats it", "The limit remains 17. ", false],
    ["refuses a lost number even if evidence repeats it", "retry_limit remains bounded. ", false],
] as const) {
    test(`merge ${name}`, async () => {
        const f = fixture();
        const evidence = { blockStartOrdinal: 42, excerpt: "retry_limit was 17 and remains 17." };
        f.decision.action = "merge";
        f.context.sources[0]!.content = "retry_limit was 17. Keep the rule. ";
        f.context.sources.push({
            id: 2,
            revision: 1,
            projectPath: "project",
            status: "active",
            content: "Other rule.",
        });
        f.decision.expectedSources.push({ id: 2, revision: 1 });
        f.decision.changes[0]!.evidence = evidence;
        f.decision.added = [{ text, evidence }];
        f.decision.finalText = `${text}Keep the rule. Other rule.`;
        f.context.blocks[0]!.parts = [evidence.excerpt];
        f.context.blocks[0]!.joinedText = evidence.excerpt;
        const result = await assess(f);
        expect(result.ok).toBe(preserved);
        if (preserved) expect(result.calls.length).toBeGreaterThan(0);
        else {
            expect(result.reason).toBe("dropped_token");
            expect(result.calls).toHaveLength(0);
        }
    });
}

describe("C1 check identity", () => {
    test("each kind accepts its own system and check schema/tool hashes", async () => {
        const result = await assess(fixture());
        expect(result.ok).toBe(true);
        expect(result.calls.map((request) => request.kind)).toEqual([
            "disproof",
            "support",
            "kept-clause",
            "compatibility",
        ]);
    });
    for (const substitution of [
        "historian schema",
        "historian tool",
        "historian system",
        "another kind",
        "tuple",
    ] as const) {
        test(`check identity refuses ${substitution}`, async () => {
            const f = fixture();
            const plan = planMemoryRevision(f.decision, f.context);
            if (!plan.ok) throw new Error(plan.reason);
            const result = await runMemoryChecks(
                f.decision.key,
                plan,
                f.context,
                async (request) => {
                    const profile: ReportedProfile = {
                        ...f.context.historianProfile,
                        systemHash: request.systemHash,
                        schemaHash: lifecycleTextHash(CHECK_SCHEMA_CONTRACT),
                        toolHash: lifecycleTextHash("[]"),
                    };
                    if (substitution === "historian schema")
                        profile.schemaHash = f.context.historianProfile.schemaHash;
                    if (substitution === "historian tool")
                        profile.toolHash = f.context.historianProfile.toolHash;
                    if (substitution === "historian system")
                        profile.systemHash = f.context.historianProfile.systemHash;
                    if (substitution === "another kind")
                        profile.systemHash = lifecycleTextHash(CHECK_SYSTEM_PROMPTS.support);
                    if (substitution === "tuple") profile.modelId = "B";
                    return {
                        profile,
                        usage: null,
                        verdicts: request.operands.map((operand) => ({
                            id: operand.id,
                            verdict: "yes" as const,
                        })),
                    };
                },
            );
            expect(result).toMatchObject({
                ok: false,
                reason: "unvalidated_profile",
                retryable: true,
            });
        });
    }
});
