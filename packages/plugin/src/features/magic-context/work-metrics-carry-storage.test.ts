import { expect, spyOn, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { sessionDecisionCalibration } from "./session-decision-calibration";
import {
    emptyWorkMetricsCarry,
    foldWorkMetricsRows,
    metricsFromCarry,
    type WorkMetrics,
    type WorkMetricsCarry,
} from "./work-metrics";
import {
    readSessionWorkMetricsCarry,
    setSessionWorkMetricsCarry,
} from "./work-metrics-carry-storage";

test("usage carry preserves sibling namespaces and survives calibration writes", () => {
    const db = new Database(":memory:");
    try {
        db.exec(`CREATE TABLE session_meta (
            session_id TEXT PRIMARY KEY, harness TEXT, deferred_execute_state TEXT,
            new_work_tokens INTEGER, total_input_tokens INTEGER,
            cached_m0_model_key TEXT, last_observed_model_key TEXT,
            last_nudge_undropped INTEGER, last_nudge_level TEXT)`);
        const sibling = { unrelated: { enabled: true }, magicContextTokenizerCalibration: {} };
        db.prepare(
            "INSERT INTO session_meta (session_id, deferred_execute_state) VALUES (?, ?)",
        ).run("s", JSON.stringify(sibling));
        const carry = foldWorkMetricsRows(
            [{ agent: null, id: "m", timeCreated: 7, prompt: 100, output: 3 }],
            emptyWorkMetricsCarry(),
        );
        setSessionWorkMetricsCarry(db, "s", "v2:/host.db", carry, metricsFromCarry(carry));
        sessionDecisionCalibration(db, "s", { bustPermitted: true, modelKey: "test/model" });
        expect(readSessionWorkMetricsCarry(db, "s", "v2:/host.db")).toEqual(carry);
        expect(readSessionWorkMetricsCarry(db, "s", "v1:/host.db")).toBeUndefined();
        expect(readSessionWorkMetricsCarry(db, "s", "v2:/another.db")).toBeUndefined();
        const row = db.prepare("SELECT * FROM session_meta WHERE session_id = 's'").get()!;
        expect(JSON.parse(row.deferred_execute_state as string).unrelated).toEqual(
            sibling.unrelated,
        );
        expect(row.new_work_tokens).toBe(103);
        expect(row.total_input_tokens).toBe(100);

        for (const raw of [
            "not json",
            "null",
            "[]",
            JSON.stringify({ magicContextWorkMetrics: { version: 99 } }),
            JSON.stringify({
                magicContextWorkMetrics: {
                    ...carry,
                    version: 1,
                    source: "v2:/host.db",
                    perAgent: [["build", { prevPrompt: "invalid" }]],
                },
            }),
        ]) {
            db.prepare(
                "UPDATE session_meta SET deferred_execute_state = ? WHERE session_id = 's'",
            ).run(raw);
            expect(readSessionWorkMetricsCarry(db, "s", "v2:/host.db")).toBeUndefined();
        }
    } finally {
        db.close();
    }
});

const changes: Array<{
    name: string;
    apply: (carry: WorkMetricsCarry, metrics: WorkMetrics) => void;
}> = [
    { name: "newWorkSum", apply: (carry) => carry.newWorkSum++ },
    { name: "lastTimeCreated", apply: (carry) => carry.lastTimeCreated++ },
    {
        name: "lastId",
        apply: (carry) => {
            carry.lastId += "-next";
        },
    },
    { name: "prevPrompt", apply: (carry) => carry.perAgent.get("build")!.prevPrompt++ },
    { name: "phaseId", apply: (carry) => carry.perAgent.get("build")!.phaseId++ },
    { name: "phasePeak", apply: (carry) => carry.perAgent.get("build")!.phasePeak++ },
    { name: "closedPhaseSum", apply: (carry) => carry.perAgent.get("build")!.closedPhaseSum++ },
    { name: "lastOutput", apply: (carry) => carry.perAgent.get("build")!.lastOutput++ },
    {
        name: "phaseHasQualifying",
        apply: (carry) => {
            carry.perAgent.get("build")!.phaseHasQualifying = false;
        },
    },
    {
        name: "seen",
        apply: (carry) => {
            carry.perAgent.get("build")!.seen = false;
        },
    },
    {
        name: "agent key",
        apply: (carry) => {
            const agent = carry.perAgent.get("build")!;
            carry.perAgent.delete("build");
            carry.perAgent.set("other", agent);
        },
    },
    {
        name: "agent count",
        apply: (carry) => {
            carry.perAgent.delete("plan");
        },
    },
    { name: "newWorkTokens", apply: (_carry, metrics) => metrics.newWorkTokens++ },
    { name: "totalInputTokens", apply: (_carry, metrics) => metrics.totalInputTokens++ },
];

for (const change of changes) {
    test(`usage carry writes once for changed ${change.name} and never for unchanged state`, () => {
        const db = new Database(":memory:");
        const transaction = spyOn(db, "transaction");
        try {
            db.exec(`CREATE TABLE session_meta (
                session_id TEXT PRIMARY KEY, deferred_execute_state TEXT,
                new_work_tokens INTEGER, total_input_tokens INTEGER);
                INSERT INTO session_meta (session_id) VALUES ('s')`);
            const carry = foldWorkMetricsRows(
                [
                    { agent: "build", id: "a", timeCreated: 1, prompt: 100, output: 3 },
                    { agent: "plan", id: "b", timeCreated: 2, prompt: 200, output: 4 },
                ],
                emptyWorkMetricsCarry(),
            );
            const metrics = metricsFromCarry(carry);
            setSessionWorkMetricsCarry(db, "s", "v2:/host.db", carry, metrics);
            const changesBefore = db.prepare("SELECT total_changes() AS n").get()!.n as number;
            transaction.mockClear();
            const equivalent = {
                ...carry,
                perAgent: new Map(
                    [...carry.perAgent]
                        .reverse()
                        .map(([key, agent]) => [key, { ...agent }] as const),
                ),
            };
            setSessionWorkMetricsCarry(db, "s", "v2:/host.db", equivalent, { ...metrics });
            expect(transaction).not.toHaveBeenCalled();
            expect(db.prepare("SELECT total_changes() AS n").get()!.n).toBe(changesBefore);

            change.apply(carry, metrics);
            setSessionWorkMetricsCarry(db, "s", "v2:/host.db", carry, metrics);
            expect(transaction).toHaveBeenCalledTimes(1);
            expect(db.prepare("SELECT total_changes() AS n").get()!.n).toBe(changesBefore + 1);
            setSessionWorkMetricsCarry(db, "s", "v2:/host.db", carry, metrics);
            expect(transaction).toHaveBeenCalledTimes(1);
            expect(db.prepare("SELECT total_changes() AS n").get()!.n).toBe(changesBefore + 1);
        } finally {
            transaction.mockRestore();
            db.close();
        }
    });
}
