import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import fixture from "../testdata/score-projection-parity.json";
import { renderM0 } from "../../../packages/plugin/src/hooks/magic-context/inject-compartments.ts";
import { renderM0Pi } from "../../../packages/pi-plugin/src/inject-compartments-pi.ts";
import { computeBudgetPressure } from "../../../packages/plugin/src/hooks/magic-context/decay-curve.ts";

// Expected detail tiers and budget-pressure multipliers were calculated with
// the decay thresholds and token costs, independently of the renderers. Invoke
// both host renderers, rather than copying their implementation.
test("TS and Pi renders match the Rust fixed-schedule tier and pressure oracle", () => {
    const db = new Database(":memory:");
    try {
        const rows = Array.from({ length: fixture.rowCount }, (_, index) => ({
            id: index + 1, sessionId: "ses", sequence: index + 1,
            startMessage: index + 1, endMessage: index + 1,
            startMessageId: `m${index + 1}`, endMessageId: `m${index + 1}`,
            title: `C${index + 1}`, content: `detail-P1-${index + 1};`,
            p1: `detail-P1-${index + 1};`, p2: `detail-P2-${index + 1};`,
            p3: `detail-P3-${index + 1};`, p4: `detail-P4-${index + 1};`,
            importance: fixture.baseImportance, legacy: 0, createdAt: 0, episodeType: null,
        }));
        const workspace = { isWorkspaced: false, expandedIdentities: [], ownIdentities: [], shareCategories: [] };
        for (const step of fixture.steps.filter(step => step.tiers)) {
            const effective = rows.map((row, index) => ({ ...row, importance: step.effective[index] }));
            const ts = renderM0({ projectDocs: "", userProfileBaseline: [], compartments: effective,
                memories: [], facts: [], historyBudgetTokens: fixture.historyBudgetTokens, modelKey: "" });
            const pi = renderM0Pi({ sessionId: "ses", memoryEnabled: false, injectDocs: false,
                historyBudgetTokens: fixture.historyBudgetTokens }, db, "", 1, [], effective, [], workspace);
            expect(ts).toBe(pi);
            for (const [index, tier] of step.tiers.entries()) {
                expect(ts).toContain(`detail-P${tier}-${index + 1};`);
            }
            expect(computeBudgetPressure(effective.map((row, index) => ({
                index: rows.length - index, importance: row.importance,
            })), fixture.historyBudgetTokens)).toBeCloseTo(step.pressure, 10);
        }
    } finally {
        db.close();
    }
});
