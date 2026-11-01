import { expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { sessionDecisionCalibration } from "./session-decision-calibration";
import { emptyWorkMetricsCarry, foldWorkMetricsRows, metricsFromCarry } from "./work-metrics";
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
