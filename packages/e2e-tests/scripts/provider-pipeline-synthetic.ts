import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { updateSessionMeta } from "../../plugin/src/features/magic-context/storage-meta";
import { setLogLineForwarder } from "../../plugin/src/shared/logger";
import { percentile } from "../../plugin/scripts/perf-audit/provider-pipeline-gate";
import { buildDriver, Driver, fixture, message, tools } from "./provider-pipeline-differential";

export async function syntheticReplay(count = 17000, samples = 20) {
    assert.ok(count >= 7500 && samples >= 5);
    // The driver is a test build, where every replayed policy summary is also
    // checked against a full recomputation. Timing runs measure the replay alone;
    // the differential runs keep that check.
    process.env.MC_POLICY_SUMMARY_SKIP_FULL_CHECK = "1";
    const root = resolve(import.meta.dir, "../../..");
    const work = join(root, "target/provider-pipeline-driver");
    mkdirSync(join(work, "synthetic"), { recursive: true });
    const driver = new Driver(buildDriver(work), join(work, "synthetic"));
    const logs: string[] = [];
    setLogLineForwarder(line => { logs.push(line); if (logs.length > 100) logs.shift(); });
    const lanes = [];
    try {
        for (const host of ["OpenCode1", "OpenCode2"] as const) {
            const directory = join(work, "synthetic", host);
            rmSync(directory, { recursive: true, force: true });
            const f = await fixture(driver, host, directory);
            try {
                updateSessionMeta(f.db, "session", { lastUsageContextLimit: 4000000 });
                // Five-message cycles: one user, three tool-bearing assistants and
                // one final assistant. Each tool message has text and two results.
                const history = Array.from({ length: count }, (_, i) => i % 5 === 0
                    ? message(`synthetic-${i}`, "user", `Inspect fixture ${i}: café 🦀`)
                    : i % 5 === 4 ? message(`synthetic-${i}`, "assistant", `Fixture ${i} complete`)
                    : tools(`synthetic-${i}`));
                const fullOnly: number[] = [];
                for (let n = 0; n < 5; n++) {
                    const started = performance.now();
                    await f.full(history);
                    fullOnly.push(performance.now() - started);
                }
                for (let attempt = 0; attempt < 3 && !f.adapter.isProviderSession("session"); attempt++) {
                    await f.pass(history);
                    if (f.fallbacks.length) break;
                }
                if (!f.adapter.isProviderSession("session")) {
                    lanes.push({ host, message_count: count, tool_messages: Math.floor(count / 5) * 3, tool_parts: Math.floor(count / 5) * 6,
                        full_request_engine_and_codec: { samples: fullOnly.length, p50_ms: percentile(fullOnly, .5), p95_ms: percentile(fullOnly, .95) },
                        provider: "blocked", provider_error: f.callErrors.at(-1) ?? logs.slice(-3), provider_answer: f.answers.at(-1),
                        ordinary: null, provider_rebuild: null, rebuild_vs_full_ratio: null });
                    continue;
                }
                const ordinary: number[] = [], full: number[] = [], rebuild: number[] = [];
                const hookRoundTrips: number[] = [];
                let rebuildBlocked: Record<string, unknown> | undefined;
                for (let n = 0; n < samples + 3; n++) {
                    history.push(message(`append-${n}`, "user"), tools(`tool-append-${n}`), message(`reply-${n}`, "assistant"));
                    // Advance the fixture's logical clock between host turns
                    // without adding sleeps to the wall-clock measurements.
                    f.advance(1000);
                    const calls = f.callTimes.length;
                    const answer = await f.timedPass(history);
                    assert.equal(f.fallbacks.length, 0, "ordinary provider pass cannot silently fall back");
                    assert.ok(answer.messages.some(m => m.info.id === `append-${n}`));
                    if (n >= 3) {
                        ordinary.push(answer.pass_ms);
                        hookRoundTrips.push(...f.callTimes.slice(calls).filter(c => c.method === "transform.hook").map(c => c.ms));
                    }
                }
                for (let n = 0; n < 5; n++) {
                    f.advance(1000);
                    // A flush alone can leave output unchanged. Publish history
                    // and change the model so the full-request and provider
                    // handlers both recompose the prefix and return a replacement.
                    await f.event("publish", { start: n * 5 + 1, end: (n + 1) * 5, mid: `synthetic-${(n + 1) * 5 - 1}` });
                    const model = `openai/gpt-5.6-synthetic-rebuild-${n}`;
                    const appended = message(`rebuild-${n}`, "assistant");
                    (appended.info as any).model.modelID = model.slice("openai/".length);
                    history.push(appended);
                    await f.event("flush");
                    f.deps.historyRefreshSessions.add("session");
                    const baseline = join(directory, `baseline-${n}`);
                    mkdirSync(baseline, { recursive: true });
                    // The handler is idle while both isolated fixture databases
                    // are copied. store.db holds cache state; context.db holds
                    // published history. Neither copy is inside the timed region.
                    await f.sql(`VACUUM INTO '${join(baseline, "store.db").replaceAll("'", "''")}'`, true);
                    const context = new Database(join(directory, "context.db"));
                    try { context.exec(`VACUUM INTO '${join(baseline, "context.db").replaceAll("'", "''")}'`); }
                    finally { context.close(); }
                    const rig = `baseline-${host}-${n}`;
                    await driver.send({ op: "create", rig, harness: host === "OpenCode1" ? "opencode" : "opencode2", directory: baseline });
                    try {
                        const started = performance.now();
                        const expected = await f.fullFrom(rig, history, undefined, { model_key: model });
                        full.push(performance.now() - started);
                        const before = f.answers.length;
                        const answer = await f.timedPass(history);
                        const view = f.answers.slice(before).find(a => a.answer === "compaction_message");
                        if (!view) {
                            // Drain the outstanding handler reply before retrying.
                            // The first pass applied no view and the retry starts
                            // from changed durable state, so neither is a paired
                            // starting-snapshot rebuild measurement.
                            await f.noReads();
                            const late = f.answers.slice(before).find(a => a.answer === "compaction_message");
                            const retryStart = f.answers.length;
                            f.advance(1000);
                            const retry = await f.timedPass(history);
                            const retried = f.answers.slice(retryStart).find(a => a.answer === "compaction_message");
                            rebuildBlocked = { reason: "first rebuild pass did not apply a view", sample: n, first_pass_ms: answer.pass_ms,
                                late_step_answer: late?.answer ?? null, retry_pass_ms: retry.pass_ms,
                                retry_applied: !!retried && f.stored()!.views.some(v => v.compaction_id === retried.compaction.compaction_id && v.version === retried.compaction.version && v.state === "applied"),
                                errors: f.callErrors, fallback_count: f.fallbacks.length };
                            break;
                        }
                        assert.ok(f.stored()!.views.some(v => v.compaction_id === view.compaction.compaction_id && v.version === view.compaction.version && v.state === "applied"),
                            "rebuild sample must apply the produced view");
                        assert.equal(f.fallbacks.length, 0, "rebuild sample cannot silently fall back");
                        assert.deepEqual([...answer.messages], expected, "paired rebuild must match the full-request output");
                        rebuild.push(answer.pass_ms);
                    } finally { await driver.send({ op: "drop", rig }); }
                }
                const summary = (values: number[]) => ({ samples: values.length, p50_ms: percentile(values, .5), p95_ms: percentile(values, .95) });
                lanes.push({ host, message_count: count, tool_messages: Math.floor(count / 5) * 3, tool_parts: Math.floor(count / 5) * 6, provider: "completed",
                    ordinary: summary(ordinary), hook_round_trip: summary(hookRoundTrips), full_request_engine_and_codec: summary(full),
                    provider_rebuild: rebuildBlocked ? null : summary(rebuild), rebuild_blocked: rebuildBlocked ?? null,
                    rebuild_vs_full_ratio: rebuildBlocked ? null : percentile(rebuild, .5) / percentile(full, .5) });
                await f.noReads();
            } finally { await f.close(); }
        }
        return { schema: 1, measurement_kind: "synthetic", acceptance: "blocked", platform: process.platform, arch: process.arch, bun: Bun.version,
            timing_scope: "provider adapter entry to output assignment; fixture sync included; no mirror pages; full arm is engine + codec + pipe, not legacy host handler; hook times are round trips, not module-only",
            rebuild_trigger: "synthetic publication and model switch with one append; paired cache and authority snapshots", lanes };
    } finally { await driver.close(); setLogLineForwarder(null); }
}

if (import.meta.main) {
    const result = await syntheticReplay();
    console.log(JSON.stringify(result, null, 2));
    if (Bun.argv[2]) writeFileSync(Bun.argv[2], JSON.stringify(result, null, 2) + "\n");
}
