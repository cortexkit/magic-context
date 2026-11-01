#!/usr/bin/env bun
import { resolve } from "node:path";

export const slowPattern = "\\[slow\\] ";
export const slowUnits = [
    ["plugin", "src/hooks/magic-context/auto-embed-session.test.ts", ["re-embeds old chunks under busy active passes without draining inactive sessions or blocking a turn"]],
    ["plugin", "src/hooks/magic-context/inject-compartments.test.ts", ["opencode", "opencode2"].map((host) => `${host} applied compaction bounds auto-search blob across user messages`)],
    ["plugin", "src/features/magic-context/search-pool.test.ts", ["cold full rebuild returns every row across cooperative slices", "heartbeat CPU samples observe synchronous busy work", "heartbeat stops sampling when the measured operation ends"]],
    ["plugin", "src/shared/stable-json-linear.test.ts", ["copies a deeply nested value once, not once per level"]],
    ["plugin", "src/features/magic-context/smart-notes/http-timeout.test.ts", ["slow sweeps admit fewer notes instead of cutting the next request short"]],
    ["plugin", "src/v2/hooks/oc2-lkg-replay.test.ts", ["2.0.22", "2.1.0"].map((host) => `OC2 replay differential: busy turns serve only matching saved requests, byte for byte (${host})`)],
    ["plugin", "src/v2/hooks/issue-750-defer-after-execute.test.ts", ["openai", "anthropic"].map((provider) => `issue 750 differential: ${provider} defer passes replay their predecessor`)],
    ["plugin", "src/v2/hooks/feature-parity-differential.test.ts", [1, 2, 3, 4].map((shard) => `v2 disabled features preserve baseline bytes over randomized passes shard ${shard}/4`)],
    ["plugin", "src/v2/hooks/issue-709-review.test.ts", ["issue 709 review: features-on real OC2 hook replays defer bytes over seeded passes"]],
    ["plugin", "src/hooks/magic-context/oc-stall-r2-ordinal-review.test.ts", [
        "ordinal differential: compaction, ties, time moves, suffix deletes, reused rowids, reinserted summaries and scan interleaving",
        "ordinal differential: session moves must also match the old whole-prefix count",
        "ordinal differential: invalidating destinations of session moves restores parity",
    ]],
    ["plugin", "src/v2/hooks/storage-gate.test.ts", ["boot wait gives up on an unresolved open after its deadline"]],
    ["plugin", "src/plugin/bridged-session-guard.test.ts", ["randomized passes of unenrolled sessions match the unwrapped real pipeline byte for byte"]],
    ["pi-plugin", "src/queued-drop-batch.test.ts", ["pi", "oc1", "oc2"].map((host) => `queued batch ${host}: 160 drops have three bounded commits`)],
] as const;

const calibration = new Set([
    "heartbeat CPU samples observe synchronous busy work",
    "heartbeat stops sampling when the measured operation ends",
]);

export function expectedSelection(names: readonly string[], slow: boolean): string[] {
    return names.filter((name) => slow || !calibration.has(name)).map((name) => `${slow ? "[slow] " : ""}${name}`).sort();
}

async function run(dry: boolean) {
    let selected = 0;
    for (const [pkg, file, names] of slowUnits) {
        // A fresh process per file isolates latency measurements from other workers.
        for (const slow of dry ? [false, true] : [true]) {
            const command = [process.execPath, "test", `./${file}`, "--timeout=120000", ...(dry ? ["--pass-with-no-tests"] : []), "--test-name-pattern", dry ? "a^" : slowPattern];
            console.log(`${pkg} ${slow ? "slow" : "normal"}: ${command.slice(1).join(" ")}`);
            const child = Bun.spawn(command, {
                cwd: resolve(import.meta.dir, "../..", pkg),
                env: { ...process.env, MC_SLOW_TESTS: slow ? "1" : "0", MC_SLOW_TEST_LIST: dry ? "1" : "0", MC_REVIEW_ASSERT_LIVENESS: "1", BUN_JSC_useOMGJIT: "0" },
                stdout: dry ? "pipe" : "inherit", stderr: dry ? "pipe" : "inherit",
            });
            const output = dry ? await new Response(child.stdout).text() : "";
            const errors = dry ? await new Response(child.stderr).text() : "";
            const code = await child.exited;
            if (code !== 0) throw new Error(`${pkg}/${file} exited ${code}\n${output}\n${errors}`);
            if (dry) {
                const actual = output.split("\n").filter((line) => line.startsWith("SLOW_SELECTION ")).map((line) => JSON.parse(line.slice("SLOW_SELECTION ".length)) as string).sort();
                const expected = expectedSelection(names, slow);
                if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${pkg}/${file}: unexpected ${slow ? "slow" : "normal"} selection\n${JSON.stringify({ expected, actual })}`);
                if (slow && actual.some((name) => !new RegExp(slowPattern).test(name))) throw new Error("slow pattern missed a moved test");
                if (!slow && actual.some((name) => new RegExp(slowPattern).test(name))) throw new Error("normal selection contains slow work");
                selected += actual.length;
                for (const name of actual) console.log(`  ${name}`);
            }
        }
    }
    console.log(dry ? `Dry selection passed: ${selected} registrations (23 normal, 25 slow), no test bodies executed` : "Slow unit lane passed");
}

if (import.meta.main) {
    if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== "--dry-run")) throw new Error("usage: run-slow-unit-tests.ts [--dry-run]");
    await run(process.argv[2] === "--dry-run");
}
