import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

let checks = 0;
const assert = (condition: unknown, description: string) => {
    if (!condition) throw new Error(description);
    checks++;
};
for (const directory of process.argv.slice(2)) {
    const summary = JSON.parse(readFileSync(join(directory, "summary.json"), "utf8"));
    assert(summary.fake === true, "Proof must not use a real provider");
    assert(/^opencode v2\.2\.\d+$/.test(summary.hostVersion), "Real OpenCode 2.2.x host required");
    assert(summary.completedSteps > 0, "CSV must have billed steps");
    assert(summary.unmatchedUsageRows === 0, "Every billed row must match a pass");
    assert(summary.stepsAboveThreshold > 0, "Scripted usage should exercise execute pressure");
    assert(summary.toolOutputByteShare > 0, "Shell output must reach the provider requests");
    assert(summary.estimateToBilledRatio > 0, "Estimator telemetry must be joined to billed usage");
    assert(summary.wireBodies >= summary.completedSteps, "Native HTTP dump must capture each step");
    assert(summary.compositionSteps === summary.completedSteps, "Every billed step must have composition columns");
    assert(summary.maxInstructionRows > 0, "Real host must persist system/instruction rows");
    assert(summary.maxInstructionRevisionRows > 0, "AGENTS.md revisions must appear in persisted system rows");
    assert(summary.maxServedInstructionRows > 0 && summary.maxServedInstructionTokens > 0, "Id-less instruction composition columns must be nonzero");
    assert(summary.maxHistoryHeadMessages === 2, "Both m0 and m1 must be classified as history head");
    assert(summary.maxDbCodemodeRows > 0 && summary.maxDbMcpGuidanceRows > 0, "MCP churn must persist core/codemode and core/mcp-guidance rows");
    assert(summary.maxServedCodemodeCount > 0 && summary.maxServedMcpGuidanceCount > 0, "Composition must count both MCP instruction sources on the wire");
    assert(summary.totalEstimatedCostUSD <= summary.dollarCap, "Spend must remain below the configured cap");
    if (summary.stopReason === "step_cap") {
        assert(summary.completedSteps === summary.stepCap, "Step cap must stop at the configured count");
        assert(summary.authorizedMainPasses === summary.stepCap, "No extra head request may escape the cap");
        assert(summary.turns >= 3, "Proof must exercise early stop, continuation, and second batch");
        assert(summary.batches >= 4, "Proof must send at least four batch messages");
        assert(summary.maxInstructionRevisionRows >= 2, "Changing AGENTS.md must add instruction rows, not merely seed a file");
    } else {
        assert(summary.stopReason === "spend_guard", "Expected spend-guard stop");
        assert(summary.completedSteps < summary.stepCap, "Spend guard must stop before the step cap");
    }
    const csv = readFileSync(join(directory, "steps.csv"), "utf8");
    assert(csv.includes('"billed_input"') && csv.includes('"wire_file"'), "CSV must contain usage and request references");
    assert(csv.includes(summary.sessionID) && csv.includes("final-wire telemetry"), "CSV must join the real session and MC pass logs");
    const dbPaths = JSON.parse(readFileSync(join(directory, "db-paths.json"), "utf8")) as string[];
    assert(dbPaths.length > 0 && dbPaths.every((path) => path.startsWith(`${summary.runRoot}/`)), "All DB handles must be throwaway paths");
    assert(readFileSync(join(directory, "lsof.txt"), "utf8").includes("opencode2.db"), "lsof must include the host database");
    for (const name of readdirSync(join(directory, "wire")).filter((name) => name.endsWith(".meta.json"))) {
        const meta = JSON.parse(readFileSync(join(directory, "wire", name), "utf8"));
        assert(meta.url.startsWith("http://127.0.0.1:"), "Fake requests must not reach a real provider");
    }
    console.log(`${directory}: ${summary.completedSteps} billed steps, ${summary.stopReason}, $${summary.totalEstimatedCostUSD.toFixed(6)}`);
}
assert(process.argv.length > 2, "Name at least one proof directory");
console.log(`${checks} proof assertions passed`);
