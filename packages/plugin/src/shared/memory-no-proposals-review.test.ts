import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { acquireLeaseWithAcquisition } from "../features/magic-context/dreamer/lease";
import { applyVerifyManifest } from "../features/magic-context/dreamer/verify";
import * as lifecycle from "../features/magic-context/memory/lifecycle-applier";
import {
    applyAgentMemoryMutation,
    applyHistorianRevision,
    applyMemoryAdmission,
    getMemoryRevision,
} from "../features/magic-context/memory/lifecycle-applier";
import { getMemoryById, insertMemory } from "../features/magic-context/memory/storage-memory";
import { authorizationFixture } from "../features/magic-context/memory/turn-two-test-fixtures.test";
import {
    createProjectionFixture,
    type ProjectionDriver,
    type ProjectionFixture,
} from "./memory-projection-fixtures.test";

const enabled = process.env.MC_NOPROP_REVIEW === "1";

async function automate(f: ProjectionFixture, kind: number, step: number) {
    const session = f.sessions[0];
    if (kind === 4) {
        const target = getMemoryById(f.db, 7)!;
        const leaseKey = `review:${step}`;
        const holderId = "review-verify";
        const leaseAcquisition = acquireLeaseWithAcquisition(f.db, holderId, leaseKey)!;
        const result = await applyVerifyManifest(
            {
                db: f.db,
                projectIdentity: f.projectPath,
                sessionDirectory: f.directory,
                holderId,
                leaseKey,
                leaseAcquisition,
                deadline: Date.now() + 10_000,
                normalizeFiles: async (files) => [...files],
            },
            [
                {
                    id: 7,
                    category: target.category,
                    content: target.content,
                    mappedFiles: ["config.ts"],
                },
            ],
            '<verify><archive id="7" reason="obsolete code fact"/></verify>',
        );
        expect(result.archived).toBe(1);
        return;
    }
    if (kind === 1) {
        const target = getMemoryById(f.db, 3)!;
        const oldClause = target.content.split(". ")[0]!;
        const newClause = `Revised ${"very ".repeat(step + 1)}claim`;
        const authorization = authorizationFixture(
            {
                lane: "opencode-1",
                carrier: "hidden-completion",
                provider: "review",
                modelId: "review",
                variant: null,
                temperature: 0,
                thinkingLevel: null,
            },
            "historian",
        );
        const profile = authorization.profile;
        const evidence = { blockStartOrdinal: 42, excerpt: `${newClause}.` };
        const receipt = await applyHistorianRevision(
            f.db,
            {
                key: `historian:${step}`,
                action: "edit",
                projectPath: f.projectPath,
                expectedSources: [{ id: 3, revision: getMemoryRevision(f.db, 3)! }],
                survivorId: 3,
                finalText: `${newClause}. Keep rule.`,
                changes: [{ memoryId: 3, ordinal: 1, replacement: true, evidence }],
                added: [{ text: `${newClause}. `, evidence }],
            },
            {
                memoryEnabled: true,
                autoPromote: true,
                enabled: true,
                enforcedJson: true,
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
                sources: [{ ...target, revision: getMemoryRevision(f.db, 3)! }],
                historianProfile: profile,
                validatedProfiles: authorization.rows,
            },
            { sessionId: session, harness: "review" },
            async (request) => ({
                profile: authorization.checkProfile(request.systemHash),
                usage: { tokens: 1 },
                verdicts: (request.kind === "compatibility" ? request.pairs : request.operands).map(
                    (operand) => ({
                        id: operand.id,
                        verdict:
                            request.kind === "disproof" || request.kind === "support"
                                ? ("yes" as const)
                                : ("no" as const),
                    }),
                ),
            }),
        );
        expect(oldClause.length).toBeGreaterThan(0);
        expect(receipt).toMatchObject({ state: "applied" });
        return;
    }
    const ids = kind === 2 ? [4] : kind === 3 ? [5, 6] : [2];
    expect(
        lifecycle.applyCurateMemoryMutation(f.db, {
            key: `curate:${step}`,
            projectPath: f.projectPath,
            sourceSessionId: session,
            operation: kind === 2 ? "archive" : kind === 3 ? "merge" : "update",
            targets: ids.map((id) => ({ id, revision: getMemoryRevision(f.db, id)! })),
            content: `Automated correction ${step}.`,
            reason: "review correction",
        }).state,
    ).toBe("applied");
}

export function registerNoProposalReviewWitnesses(driver: ProjectionDriver): void {
    if (!enabled) return;
    test(`${driver.host} noprop randomized automated-versus-delayed differential`, async () => {
        let passes = 0;
        const counts = [0, 0, 0, 0, 0];
        for (const seed of [0x941aac21, 0x287cf89b, 0xb41c137e, 0x1799fdd3]) {
            // The delayed store applies the same curate, verify and historian edits only before a full prompt rebuild.
            const actual = createProjectionFixture("noprop", driver.open);
            const delayed = createProjectionFixture("noprop", driver.open);
            try {
                for (const f of [actual, delayed]) {
                    for (const content of [
                        "Agent baseline.",
                        "Curate baseline.",
                        "Old rule. Keep rule.",
                        "Archive baseline.",
                        "Merge first.",
                        "Merge second.",
                        "Verify baseline.",
                    ])
                        insertMemory(f.db, {
                            projectPath: f.projectPath,
                            category: "ARCHITECTURE",
                            content,
                        });
                    driver.hard(f, f.sessions[0], { memoryBudget: 8_000, historyBudget: 16_000 });
                }
                let rng = seed;
                const next = () => {
                    rng ^= rng << 13;
                    rng ^= rng >>> 17;
                    rng ^= rng << 5;
                    return rng >>> 0;
                };
                const once = [2, 3, 4].sort(() => (next() & 1 ? 1 : -1));
                const pending: Array<[number, number]> = [];
                let previous = driver.pass(actual, actual.sessions[0], false, {
                    memoryBudget: 8_000,
                    historyBudget: 16_000,
                });
                for (let step = 0; step < 80; step++) {
                    const kind = step < 3 ? once[step]! : next() % 2;
                    const beforeSignals = actual.db
                        .prepare("SELECT COUNT(*) AS n FROM memory_agent_fragments")
                        .get();
                    const beforeLog = actual.db
                        .prepare("SELECT COUNT(*) AS n FROM memory_mutation_log")
                        .get();
                    await automate(actual, kind, step);
                    pending.push([kind, step]);
                    counts[kind]!++;
                    expect(
                        actual.db.prepare("SELECT COUNT(*) AS n FROM memory_agent_fragments").get(),
                    ).toEqual(beforeSignals);
                    expect(
                        actual.db.prepare("SELECT COUNT(*) AS n FROM memory_mutation_log").get(),
                    ).toEqual(beforeLog);
                    if (next() % 2 === 0) {
                        const owner = next() % 2 === 0 ? actual.sessions[0] : actual.sessions[1];
                        for (const f of [actual, delayed])
                            expect(
                                applyAgentMemoryMutation(f.db, {
                                    key: `agent:${step}`,
                                    projectPath: f.projectPath,
                                    sourceSessionId: owner,
                                    operation: "update",
                                    targets: [{ id: 1, revision: getMemoryRevision(f.db, 1)! }],
                                    content: `Agent correction ${step} & <quoted>.`,
                                }).state,
                            ).toBe("applied");
                    }
                    const pass = step === 79 ? 2 : next() % 3;
                    if (pass === 2) {
                        for (const [queuedKind, queuedStep] of pending)
                            await automate(delayed, queuedKind, queuedStep);
                        pending.length = 0;
                    }
                    const options = {
                        memoryBudget: 8_000,
                        historyBudget: 16_000,
                        cacheExpired: pass === 2,
                    };
                    const a = driver.pass(actual, actual.sessions[0], pass !== 0, options);
                    const b = driver.pass(delayed, delayed.sessions[0], pass !== 0, options);
                    expect(a).toEqual(b);
                    expect(a.materialized).toBe(pass === 2);
                    if (pass === 0) expect(a).toEqual({ ...previous, materialized: false });
                    if (pass === 1) expect(a.m0).toBe(previous.m0);
                    previous = a;
                    passes++;
                }
                expect(
                    actual.db.prepare("SELECT COUNT(*) AS n FROM memory_tool_proposals").get(),
                ).toEqual({ n: 0 });
                expect(
                    actual.db
                        .prepare(
                            "SELECT COUNT(*) AS n FROM memory_history WHERE memory_id=4 AND previous_text='Archive baseline.'",
                        )
                        .get(),
                ).toEqual({ n: 1 });
                for (const id of [5, 6])
                    expect(
                        actual.db
                            .prepare("SELECT COUNT(*) AS n FROM memory_history WHERE memory_id=?")
                            .get(id),
                    ).toEqual({ n: 1 });
            } finally {
                actual.close();
                delayed.close();
            }
        }
        expect(counts.every((count) => count > 0)).toBe(true);
        console.log(
            `${driver.host} noprop differential: ${passes} passes, operation counts=${counts}`,
        );
    });

    test(`${driver.host} noprop baseline agent fragment fingerprint`, () => {
        const f = createProjectionFixture("noprop-agent", driver.open);
        try {
            const session = f.sessions[0];
            const seed = insertMemory(f.db, {
                projectPath: f.projectPath,
                category: "ARCHITECTURE",
                content: "Baseline agent target.",
            });
            driver.hard(f, session);
            const outputs: string[] = [];
            const admission = applyMemoryAdmission(f.db, {
                key: "agent-save",
                operation: "agent_save",
                input: {
                    projectPath: f.projectPath,
                    category: "ARCHITECTURE",
                    content: "Saved & <quoted> memory.",
                    sourceSessionId: session,
                    sourceType: "agent",
                },
            });
            expect(admission.state).toBe("applied");
            outputs.push(driver.pass(f, session, true).m1);
            for (const operation of ["update", "merge", "archive"] as const) {
                const ids = operation === "merge" ? [seed.id, admission.memoryId!] : [seed.id];
                const result = applyAgentMemoryMutation(f.db, {
                    key: `agent-${operation}`,
                    projectPath: f.projectPath,
                    sourceSessionId: session,
                    operation,
                    targets: ids.map((id) => ({ id, revision: getMemoryRevision(f.db, id)! })),
                    content:
                        operation === "update"
                            ? "Updated & <quoted> memory."
                            : "Merged & <quoted> memory.",
                });
                // A merge supersedes the original target, so archive its surviving canonical row instead.
                if (operation === "merge") seed.id = result.memoryId!;
                expect(result.state).toBe("applied");
                outputs.push(driver.pass(f, session, true).m1);
            }
            expect(outputs[0]).toContain('<added id="2"');
            expect(outputs[1]).toContain('<updated id="1"');
            expect(outputs[2]).toContain('<superseded id="1"');
            expect(outputs[3]).toContain('<removed id="3"');
            const hash = createHash("sha256").update(JSON.stringify(outputs)).digest("hex");
            expect(hash).toBe("109feba9b464b0247ace2cdde6ab2f9b811e1a0de4088670b7088c656d2742d6");
            console.log(`${driver.host} noprop agent m[1] SHA256 ${hash}`);
        } finally {
            f.close();
        }
    });
}
