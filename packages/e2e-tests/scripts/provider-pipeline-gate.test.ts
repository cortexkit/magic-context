import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateCanary, evaluatePerformance, percentile, type MeasurementBundle } from "../../plugin/scripts/perf-audit/provider-pipeline-gate";

function fixture(): MeasurementBundle {
    const passes: MeasurementBundle["passes"] = [];
    for (const host of ["opencode", "opencode2"] as const) {
        const base = { host, host_version: host === "opencode" ? "1.18.30" : "2.0.22", pass_ms: 10, hook_count: 1, hook_module_ms: [2], appended: 1,
            ingest_json_bytes: 100, hook_ops_json_bytes: 20, appended_message_bytes: 100, answer_json_bytes: 30, tag_row_bytes: 10,
            host_logical_payload_bytes: 150, module_logical_payload_bytes: 180, background_delta_bytes: 0, background_page_rows: [],
            host_db_bytes: 100000, host_wal_bytes: 10000, module_db_bytes: 100000, module_wal_bytes: 10000 };
        for (let i = 0; i < 20; i++) passes.push({ ...base, pipeline: "provider", pass_kind: "ordinary",
            ...(i === 0 ? { fixture: "large-replace", hook_ops_json_bytes: 200000, host_logical_payload_bytes: 200200, answer_json_bytes: 200000, module_logical_payload_bytes: 200200 } : {}),
            ...(i === 1 ? { fixture: "many-text-block" } : {}),
            ...(i === 2 ? { fixture: "post-publication", appended: 0, ingest_json_bytes: 0, hook_ops_json_bytes: 0, appended_message_bytes: 0, answer_json_bytes: 0, tag_row_bytes: 0, hook_count: 0, hook_module_ms: [], background_delta_bytes: 5000000, background_page_rows: [1000], host_logical_payload_bytes: 900, module_logical_payload_bytes: 900 } : {}) });
        for (let i = 0; i < 5; i++) for (const pass_kind of ["rebuild", "full"] as const)
            passes.push({ ...base, pipeline: pass_kind === "full" ? "full_request" : "provider", pass_kind, pass_ms: pass_kind === "full" ? 100 : 110, comparison_id: `${host}-${i}`, starting_store_sha256: "b".repeat(64) });
    }
    return { schema: 1, measurement_kind: "live", machine: "unit-test, not a capture", session_copy_sha256: "a".repeat(64), message_count: 7500, frozen_unit_count: 49000,
        timing_scope: "handler_entry_to_output_assignment_including_sync_and_mirror", passes,
        canary: { host: "opencode", session_id: "ses_fixture", started_at: "2026-01-01T00:00:00.000Z", ended_at: "2026-01-02T00:00:00.000Z", anthropic_dir: "", openai_dir: "", events: [] } };
}

test("P1 nearest-rank quantiles enforce ordinary and hook timing limits per host", () => {
    expect(percentile([120, 1, 30, 2], .5)).toBe(2);
    const input = fixture();
    expect(evaluatePerformance(input).failures).toEqual([]);
    for (const p of input.passes.filter(p => p.pass_kind === "ordinary" && p.host === "opencode")) p.pass_ms = 31;
    expect(evaluatePerformance(input).failures).toEqual(["opencode: P1"]);
    for (const p of input.passes.filter(p => p.pass_kind === "ordinary" && p.host === "opencode")) { p.pass_ms = 10; p.hook_count = 1; p.hook_module_ms = [6]; }
    expect(evaluatePerformance(input).failures).toEqual(["opencode: P1"]);
});
test("P2 requires paired identical starting stores and the ten-percent rebuild bound", () => {
    const input = fixture();
    for (const p of input.passes.filter(p => p.pass_kind === "rebuild" && p.host === "opencode2")) p.pass_ms = 111;
    expect(evaluatePerformance(input).failures).toEqual(["opencode2: P2"]);
    input.passes.find(p => p.pass_kind === "full")!.starting_store_sha256 = "c".repeat(64);
    expect(() => evaluatePerformance(input)).toThrow("same-starting-store");
});
test("P3 gates logical payload while reporting and excluding background delta bytes", () => {
    const input = fixture();
    expect(evaluatePerformance(input).lanes[0]!.p3.background_delta_bytes).toBe(5000000);
    expect(evaluatePerformance(input).failures).toEqual([]);
    input.passes[3]!.host_logical_payload_bytes = 1145;
    expect(evaluatePerformance(input).failures).toEqual(["opencode: P3 (1 passes)"]);
    input.passes[3]!.host_logical_payload_bytes = 150;
    input.passes[3]!.module_logical_payload_bytes = 1165;
    expect(evaluatePerformance(input).failures).toEqual(["opencode: P3 (1 passes)"]);
});
test("P3 enforces zero-append accounting and background page and row bounds", () => {
    const input = fixture();
    input.passes[2]!.host_logical_payload_bytes = 1025;
    expect(evaluatePerformance(input).failures).toEqual(["opencode: P3 (1 passes)"]);
    input.passes[2]!.host_logical_payload_bytes = 900;
    input.passes[2]!.background_page_rows = [1001];
    expect(evaluatePerformance(input).failures).toEqual(["opencode: P3 (1 passes)"]);
    input.passes[2]!.background_page_rows = Array(21).fill(1);
    expect(evaluatePerformance(input).failures).toEqual(["opencode: P3 (1 passes)"]);
});
test("missing counters, small corpora, wrong hosts and synthetic measurements fail closed", () => {
    for (const change of [
        (input: MeasurementBundle) => { input.measurement_kind = "synthetic"; },
        (input: MeasurementBundle) => { input.message_count = 12; },
        (input: MeasurementBundle) => { input.passes[0]!.host_version = "1.17.1"; },
        (input: MeasurementBundle) => { input.passes[0]!.background_delta_bytes = NaN; },
        (input: MeasurementBundle) => { input.passes[0]!.hook_module_ms = []; },
        (input: MeasurementBundle) => { input.passes = input.passes.filter(p => p.host !== "opencode2"); },
    ]) { const input = fixture(); change(input); expect(() => evaluatePerformance(input)).toThrow(); }
});

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
test("P4 rejects an empty or short canary instead of treating no dumps as no busts", () => {
    const dir = mkdtempSync(join(tmpdir(), "provider-gate-")); directories.push(dir);
    const canary = { ...fixture().canary, anthropic_dir: dir, openai_dir: dir };
    expect(() => evaluateCanary(canary)).toThrow("empty/incomplete");
    canary.ended_at = "2026-01-01T23:59:59.999Z";
    expect(() => evaluateCanary(canary)).toThrow("24-hour");
});
test("P4 uses real dump analysis and requires exact declared-event attribution for priced busts", () => {
    const dir = mkdtempSync(join(tmpdir(), "provider-gate-")); directories.push(dir);
    const canary = { ...fixture().canary, anthropic_dir: dir, openai_dir: join(dir, "absent") };
    const start = Date.parse(canary.started_at);
    for (let i = 0; i <= 288; i++) {
        const at = new Date(start + i * 300000).toISOString();
        const stem = `${at.replaceAll(":", "-").replace(".", "-")}-${String(i).padStart(6, "0")}-${canary.session_id}`;
        writeFileSync(join(dir, `${stem}.meta.json`), JSON.stringify({ session: canary.session_id, createdAt: at }));
        writeFileSync(join(dir, `${stem}.body.json`), JSON.stringify({ system: [], messages: [{ role: "user", content: [{ type: "text", text: i === 288 ? "changed prefix" : "same prefix", cache_control: { type: "ephemeral" } }] }] }));
        writeFileSync(join(dir, `${stem}.response.json`), JSON.stringify({ status: 200, usage: { input_tokens: 2, cache_read_input_tokens: i === 288 ? 1 : 10000, cache_creation_input_tokens: i === 288 ? 9999 : 0 } }));
    }
    expect(evaluateCanary(canary).unexpected_busts).toBe(1);
    canary.events.push({ at: canary.ended_at, kind: "applied_view", evidence_id: "fixture-compaction-1" });
    expect(evaluateCanary(canary).unexpected_busts).toBe(0);
    canary.events[0]!.at = "2026-01-01T23:59:59.999Z";
    expect(evaluateCanary(canary).unexpected_busts).toBe(1);
});
