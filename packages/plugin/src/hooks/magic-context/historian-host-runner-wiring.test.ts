import { expect, test } from "bun:test";

import { runMigrations } from "../../features/magic-context/migrations";
import type { ContextDatabase } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage-meta";
import { Database } from "../../shared/sqlite";
import { resetLkgSlotsForTest } from "./lkg-slot";
import { setRawMessageProvider } from "./read-session-chunk";
import { closeReadOnlySessionDb } from "./read-session-db";
import { createRustModeTransform, type RustModeModuleClient } from "./rust-mode-transform";
import type { TransformDeps } from "./transform";
import type { MessageLike } from "./transform-operations";

/**
 * Where the pull loop meets a transform pass.
 *
 * This transform serves only OpenCode 1 and OpenCode 2, whose runner is the host
 * when the user names none, so an unset runner polls. An explicit "broca" is the
 * one setting under which NOTHING new runs: a loop that polled there would be a
 * per-pass module round trip that no configuration asked for, and it would not
 * show up in any output-shape comparison.
 */

const project = process.cwd();
const providerID = "host-runner-wiring-provider";
const modelID = "host-runner-wiring-model";

function createFixture(
    sessionId: string,
    runner: TransformDeps["historianRunner"],
    hostRunnerEnabled?: boolean,
) {
    const db = new Database(":memory:") as ContextDatabase;
    initializeDatabase(db);
    runMigrations(db);
    const row = { id: "m1", timeCreated: 1, contributesOrdinal: true, hasValidInfo: true };
    const unregister = setRawMessageProvider(sessionId, {
        readMessages: () => [row],
        readMessageOrdinalPage: (after, limit) => (after ? [] : [row].slice(0, limit)),
        getStoredMessageCount: () => 1,
        readMessagePartsById: () => ({
            id: "m1",
            role: "user",
            parts: [{ type: "text", text: "hello" }],
            createdAt: 1,
        }),
    });
    const messages: MessageLike[] = [
        {
            info: { id: "m1", role: "user", sessionID: sessionId, model: { providerID, modelID } },
            parts: [{ type: "text", text: "hello" }],
        },
    ];
    const methods: string[] = [];
    const bodies: Array<{ method: string; body: unknown }> = [];
    let rowVersion = 0;
    const moduleClient: RustModeModuleClient = {
        call: async ({ method, body }) => {
            methods.push(method);
            bodies.push({ method, body });
            if (method === "historian.pending") return { ok: true, runs: [] };
            if (method !== "transform") return { ok: true };
            return {
                decision: "HARD",
                row_version: ++rowVersion,
                rendered_memory_ids: [],
                native_messages: structuredClone(messages),
            };
        },
    };
    const deps: TransformDeps = {
        tagger: {} as TransformDeps["tagger"],
        scheduler: {} as TransformDeps["scheduler"],
        contextUsageMap: new Map(),
        db,
        protectedTokens: 4,
        clearReasoningAge: 50,
        historyRefreshSessions: new Set(),
        pendingMaterializationSessions: new Set(),
        lastHeuristicsTurnId: new Map(),
        directory: project,
        projectPath: project,
        memoryConfig: { enabled: false, injectionBudgetTokens: 1, autoPromote: false },
        liveModelBySession: new Map([[sessionId, { providerID, modelID }]]),
        sessionDirectoryBySession: new Map([[sessionId, project]]),
        transformMode: "rust",
        rustModeModuleClient: moduleClient,
        rustModeAllowAuthorityProtocolBypassForTests: true,
        ...(runner ? { historianRunner: runner } : {}),
        ...(hostRunnerEnabled !== undefined
            ? { historianHostRunnerEnabled: hostRunnerEnabled }
            : {}),
    };
    const transform = createRustModeTransform(deps, {
        moduleClient,
        allowAuthorityProtocolBypassForTests: true,
        scheduleLkgCapture: (capture) => capture(),
    });
    return {
        methods,
        bodies,
        async run() {
            const input = structuredClone(messages);
            await transform.run(
                sessionId,
                input,
                { messages: structuredClone(input) },
                getOrCreateSessionMeta(db, sessionId),
            );
            // The poll is started by the pass and deliberately not awaited by it.
            await new Promise((resolve) => setTimeout(resolve, 0));
        },
        async dispose() {
            await transform.stopHostRunner();
            unregister();
            closeReadOnlySessionDb();
            resetLkgSlotsForTest();
            db.close();
        },
    };
}

test("an explicit broca runner never reaches the claim lane", async () => {
    const fixture = createFixture("wiring-broca", "broca");
    try {
        await fixture.run();
        await fixture.run();
        expect(fixture.methods.filter((method) => method.startsWith("historian."))).toEqual([]);
    } finally {
        await fixture.dispose();
    }
});

test("an unset runner polls the claim lane, because OpenCode's default is the host", async () => {
    const fixture = createFixture("wiring-default", undefined);
    try {
        await fixture.run();
        await fixture.run();
        expect(fixture.methods.filter((method) => method.startsWith("historian."))).toEqual([
            "historian.pending",
            "historian.pending",
        ]);
    } finally {
        await fixture.dispose();
    }
});

test("every claim-lane request names its op in the body the module dispatches on", async () => {
    const fixture = createFixture("wiring-body", "host");
    try {
        await fixture.run();
        const lane = fixture.bodies.filter(({ method }) => method.startsWith("historian."));
        expect(lane.length).toBeGreaterThan(0);
        for (const { method, body } of lane) {
            expect(body).toMatchObject({ method, v: 1 });
        }
    } finally {
        await fixture.dispose();
    }
});

test("the host runner polls the claim lane once per pass", async () => {
    const fixture = createFixture("wiring-host", "host");
    try {
        await fixture.run();
        expect(fixture.methods.filter((method) => method.startsWith("historian."))).toEqual([
            "historian.pending",
        ]);
        await fixture.run();
        expect(fixture.methods.filter((method) => method.startsWith("historian."))).toEqual([
            "historian.pending",
            "historian.pending",
        ]);
    } finally {
        await fixture.dispose();
    }
});

test("the kill switch stops the poll without changing the runner", async () => {
    const fixture = createFixture("wiring-host-off", "host", false);
    try {
        await fixture.run();
        await fixture.run();
        expect(fixture.methods.filter((method) => method.startsWith("historian."))).toEqual([]);
    } finally {
        await fixture.dispose();
    }
});
