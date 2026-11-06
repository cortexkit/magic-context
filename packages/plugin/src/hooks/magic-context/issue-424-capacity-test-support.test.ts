import { expect, test } from "bun:test";
import { acquireCompartmentLease } from "../../features/magic-context/compartment-lease";
import {
    appendCompartments,
    getCompartments,
} from "../../features/magic-context/compartment-storage";
import { getHistorianFailureState } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { validateHistorianOutput } from "./compartment-runner-validation";
import { issue424Fixture } from "./issue-424-fixture";
import {
    type ProtectedTailBoundarySnapshot,
    resolveProtectedTailBoundary,
    selectPerRunCap,
} from "./protected-tail-boundary";
import { readSessionChunk, setRawMessageProvider } from "./read-session-chunk";
import { estimateTokens } from "./read-session-formatting";
import type { RawMessage } from "./read-session-raw";

export interface Issue424CapacityRun {
    db: Database;
    sessionId: string;
    raw: RawMessage[];
    boundary: ProtectedTailBoundarySnapshot;
    xml: string;
    holderId: string;
    historianChunkTokens: number;
    historianContextLimit?: number;
    maxOutputTokens?: number;
}

export function registerIssue424CapacityTests(
    harness: "pi" | "opencode",
    convert: (fixture: ReturnType<typeof issue424Fixture>) => RawMessage[],
    run: (args: Issue424CapacityRun) => Promise<string[]>,
) {
    for (const steering of [false, true]) {
        test(`issue 424 ${harness} six-cap component reaches producer and publishes whole (${steering ? "large steering" : "tool inputs"})`, async () => {
            // Outputs no longer count toward the run cap. Write inputs or steering
            // text must exceed six times that cap to keep proving whole admission.
            const fixture = issue424Fixture(
                60,
                steering ? 1 : 15,
                1,
                steering ? "outputs" : "inputs",
            );
            if (steering) {
                const text = `${"result value\n".repeat(65000)}CAPACITY_STEERING_END`;
                fixture.raw.splice(3, 0, {
                    ordinal: 0,
                    id: "capacity-steer",
                    role: "user",
                    parts: [{ type: "text", text }],
                });
                fixture.raw = fixture.raw.map((m, i) => ({ ...m, ordinal: i + 1 }));
                fixture.entries.splice(3, 0, {
                    type: "message",
                    id: "capacity-steer",
                    message: { role: "user", content: text },
                });
            }
            const raw = convert(fixture);
            const sessionId = `issue424-capacity-${harness}-${steering}`;
            const dispose = setRawMessageProvider(sessionId, { readMessages: () => raw });
            const db = new Database(":memory:");
            initializeDatabase(db);
            try {
                appendCompartments(db, sessionId, [
                    {
                        sequence: 0,
                        startMessage: 1,
                        endMessage: 1,
                        startMessageId: "m1",
                        endMessageId: "m1",
                        title: "Request",
                        content: "Investigate.",
                    },
                ]);
                const boundary = resolveProtectedTailBoundary({
                    sessionId,
                    mode: harness === "pi" ? "pi-runner" : "incremental-runner",
                    contextLimit: 206464,
                    executeThresholdPercentage: 60,
                    triggerBudget: 18582,
                    usage: { percentage: 73.8, inputTokens: 152274 },
                    usageSource: "live",
                    lastCompartmentEndOrdinal: 1,
                    priorBoundaryOrdinal: 1,
                    protectedTailPolicyVersion: 3,
                    migrationFloorActive: false,
                    providerShapeVersion: harness === "pi" ? "pi-folded-v1" : "opencode-v1",
                    cacheNamespace: sessionId,
                });
                const cap = selectPerRunCap(boundary);
                const summaryMass = boundary.diagnostics!.head.completedFence.tokenMass;
                expect(cap).toBe(30970);
                expect(summaryMass).toBeGreaterThan(6 * cap);
                expect(summaryMass).toBeLessThan(7 * cap);
                expect(boundary.eligibleEndOrdinal).toBe(
                    (harness === "pi" ? 4 : 5) + Number(steering),
                );
                const historianChunkTokens = 32000;
                const chunk = readSessionChunk(
                    sessionId,
                    historianChunkTokens,
                    boundary.offset,
                    boundary.eligibleEndOrdinal,
                );
                expect(chunk.endIndex).toBe(boundary.eligibleEndOrdinal - 1);
                expect(chunk.hasMore).toBe(false);
                if (steering) {
                    expect(estimateTokens(chunk.text)).toBeGreaterThan(historianChunkTokens);
                    expect(chunk.text).toContain("CAPACITY_STEERING_END");
                } else {
                    expect(estimateTokens(chunk.text)).toBeLessThan(100);
                }
                const xml = `<compartment start="2" end="${chunk.endIndex}" title="Complete batch"><p1>Inspected both files and received all results.</p1></compartment>`;
                expect(validateHistorianOutput(xml, sessionId, chunk, [], 0).ok).toBe(true);
                const holderId = `capacity-holder-${harness}-${steering}`;
                expect(acquireCompartmentLease(db, sessionId, holderId)).not.toBeNull();
                const prompts = await run({
                    db,
                    sessionId,
                    raw,
                    boundary,
                    xml,
                    holderId,
                    historianChunkTokens,
                });
                expect(prompts.length).toBeGreaterThan(0);
                expect(prompts[0]?.includes(chunk.text)).toBe(true);
                expect(
                    getCompartments(db, sessionId).map((c) => [c.startMessage, c.endMessage]),
                ).toEqual([
                    [1, 1],
                    [2, chunk.endIndex],
                ]);
                console.log(
                    `capacity ${harness} ${steering ? "steering" : "tools"}: summaryRemoved=${summaryMass} cap=${cap} producerSourceTokens=${estimateTokens(chunk.text)} range=2-${chunk.endIndex} validated=true`,
                );
            } finally {
                dispose();
                db.close();
            }
        });
    }

    test(`issue 467 ${harness} clips a raw-window-sized atomic component to the room the fixed prompt parts leave`, async () => {
        const fixture = issue424Fixture(60, 1);
        const steeringText = `${"oversize steering value\n".repeat(20_000)}OVERSIZE_STEERING_END`;
        fixture.raw.splice(3, 0, {
            ordinal: 0,
            id: "issue467-steer",
            role: "user",
            parts: [{ type: "text", text: steeringText }],
        });
        fixture.raw = fixture.raw.map((message, index) => ({ ...message, ordinal: index + 1 }));
        fixture.entries.splice(3, 0, {
            type: "message",
            id: "issue467-steer",
            message: { role: "user", content: steeringText },
        });
        const raw = convert(fixture);
        const sessionId = `issue467-window-${harness}`;
        const dispose = setRawMessageProvider(sessionId, { readMessages: () => raw });
        const db = new Database(":memory:");
        initializeDatabase(db);
        try {
            appendCompartments(db, sessionId, [
                {
                    sequence: 0,
                    startMessage: 1,
                    endMessage: 1,
                    startMessageId: "m1",
                    endMessageId: "m1",
                    title: "Request",
                    content: "Investigate.",
                },
            ]);
            const boundary = resolveProtectedTailBoundary({
                sessionId,
                mode: harness === "pi" ? "pi-runner" : "incremental-runner",
                contextLimit: 206_464,
                executeThresholdPercentage: 60,
                triggerBudget: 18_582,
                usage: { percentage: 73.8, inputTokens: 152_274 },
                usageSource: "live",
                lastCompartmentEndOrdinal: 1,
                priorBoundaryOrdinal: 1,
                protectedTailPolicyVersion: 3,
                migrationFloorActive: false,
                providerShapeVersion: harness === "pi" ? "pi-folded-v1" : "opencode-v1",
                cacheNamespace: sessionId,
            });
            const historianChunkTokens = 32_000;
            const chunk = readSessionChunk(
                sessionId,
                historianChunkTokens,
                boundary.offset,
                boundary.eligibleEndOrdinal,
            );
            expect(chunk.oversizeAtomicUnit).toBe(true);
            const sourceTokens = estimateTokens(chunk.text);
            const maxOutputTokens = 32_000;
            const usableInputTokens = Math.floor(sourceTokens / 1.02);
            expect(sourceTokens / usableInputTokens).toBeGreaterThanOrEqual(1.019);
            expect(sourceTokens / usableInputTokens).toBeLessThanOrEqual(1.021);
            const historianContextLimit = usableInputTokens + maxOutputTokens;
            const xml = `<compartment start="2" end="${chunk.endIndex}" title="Complete batch"><p1>Inspected both files and received all results.</p1></compartment>`;
            const holderId = `issue467-holder-${harness}`;
            expect(acquireCompartmentLease(db, sessionId, holderId)).not.toBeNull();

            const firstPrompts = await run({
                db,
                sessionId,
                raw,
                boundary,
                xml,
                holderId,
                historianChunkTokens,
                historianContextLimit,
                maxOutputTokens,
            });
            // The component fills the raw window on its own, so with the system
            // prompt, references and the unknown-model fit margin added it cannot be
            // sent whole. It used to be clipped to the raw window only, and the full
            // prompt was then refused on every run. Clipping it to the room the fixed
            // parts leave sends one prompt and publishes the whole range.
            expect(firstPrompts).toHaveLength(1);
            expect(firstPrompts[0]).toContain("OVERSIZE_STEERING_END");
            expect(firstPrompts[0]).toContain("tokens truncated by Magic Context");
            expect(estimateTokens(firstPrompts[0] ?? "")).toBeLessThan(sourceTokens);
            expect(getHistorianFailureState(db, sessionId).lastError ?? "").not.toMatch(
                /producer_prompt/,
            );
            expect(
                getCompartments(db, sessionId).map((compartment) => [
                    compartment.startMessage,
                    compartment.endMessage,
                ]),
            ).toEqual([
                [1, 1],
                [2, chunk.endIndex],
            ]);
        } finally {
            dispose();
            db.close();
        }
    });
}
