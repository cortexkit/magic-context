import { readFileSync } from "node:fs";
import { analyzeOpenCodeCacheBustSession } from "../analyze-cache-busts";

type Host = "opencode" | "opencode2";
type Pass = {
    host: Host;
    host_version: string;
    pipeline: "provider" | "full_request";
    pass_kind: "ordinary" | "rebuild" | "full";
    pass_ms: number;
    hook_count: number;
    hook_module_ms: number[];
    appended: number;
    comparison_id?: string;
    starting_store_sha256?: string;
    fixture?: "large-replace" | "many-text-block" | "post-publication";
    ingest_json_bytes: number;
    hook_ops_json_bytes: number;
    appended_message_bytes: number;
    answer_json_bytes: number;
    tag_row_bytes: number;
    host_logical_payload_bytes: number;
    module_logical_payload_bytes: number;
    background_delta_bytes: number;
    background_page_rows: number[];
    host_db_bytes: number;
    host_wal_bytes: number;
    module_db_bytes: number;
    module_wal_bytes: number;
};
type Canary = {
    session_id: string;
    host: Host;
    started_at: string;
    ended_at: string;
    anthropic_dir: string;
    openai_dir: string;
    events: { at: string; kind: "applied_view" | "host_prefix_event" | "exit_pass"; evidence_id: string }[];
};
export type MeasurementBundle = {
    schema: 1;
    measurement_kind: "live" | "synthetic";
    machine: string;
    session_copy_sha256: string;
    message_count: number;
    frozen_unit_count: number;
    timing_scope: "handler_entry_to_output_assignment_including_sync_and_mirror";
    passes: Pass[];
    canary: Canary;
};

function requireThat(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}
function number(value: unknown, field: string, integer = false): asserts value is number {
    requireThat(typeof value === "number" && Number.isFinite(value) && value >= 0 &&
        (!integer || Number.isSafeInteger(value)), `missing/invalid ${field}`);
}
function hash(value: unknown): boolean {
    return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
export function percentile(values: readonly number[], quantile: number): number {
    requireThat(values.length > 0, "empty timing population");
    values.forEach(value => number(value, "timing"));
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)]!;
}

// Missing observations must never look like zero cost or a cache-stable canary.
export function evaluatePerformance(bundle: MeasurementBundle) {
    requireThat(bundle.schema === 1 && bundle.measurement_kind === "live", "live measurement bundle required; synthetic is not acceptance");
    requireThat(typeof bundle.machine === "string" && bundle.machine.trim(), "machine required");
    requireThat(hash(bundle.session_copy_sha256), "session-copy SHA256 required");
    number(bundle.message_count, "message_count", true);
    number(bundle.frozen_unit_count, "frozen_unit_count", true);
    requireThat(bundle.message_count >= 7500 && bundle.frozen_unit_count >= 49000, "ALF-size copy required (>=7500 messages, >=49000 frozen units)");
    requireThat(bundle.timing_scope === "handler_entry_to_output_assignment_including_sync_and_mirror", "incorrect timing scope");
    requireThat(Array.isArray(bundle.passes) && bundle.passes.length > 0, "pass observations required");
    for (const [i, pass] of bundle.passes.entries()) {
        requireThat(pass.host === "opencode" || pass.host === "opencode2", `pass ${i}: invalid host`);
        requireThat(typeof pass.host_version === "string" && (pass.host === "opencode" ? /^1\.18\.\d+$/ : /^2\.0\.\d+$/).test(pass.host_version), `pass ${i}: unsupported host version`);
        requireThat((pass.pipeline === "provider" && ["ordinary", "rebuild"].includes(pass.pass_kind)) || (pass.pipeline === "full_request" && pass.pass_kind === "full"), `pass ${i}: invalid pipeline/pass kind`);
        number(pass.pass_ms, `pass ${i}.pass_ms`);
        number(pass.appended, `pass ${i}.appended`, true);
        number(pass.hook_count, `pass ${i}.hook_count`, true);
        requireThat(Array.isArray(pass.hook_module_ms), `pass ${i}: hook timings required`);
        requireThat(pass.hook_module_ms.length === pass.hook_count, `pass ${i}: incomplete per-hook timing population`);
        pass.hook_module_ms.forEach(value => number(value, `pass ${i}.hook_module_ms`));
        for (const key of ["ingest_json_bytes", "hook_ops_json_bytes", "appended_message_bytes", "answer_json_bytes", "tag_row_bytes", "host_logical_payload_bytes", "module_logical_payload_bytes", "background_delta_bytes", "host_db_bytes", "host_wal_bytes", "module_db_bytes", "module_wal_bytes"] as const)
            number(pass[key], `pass ${i}.${key}`, true);
        requireThat(Array.isArray(pass.background_page_rows), `pass ${i}: background pages required`);
        pass.background_page_rows.forEach(rows => number(rows, `pass ${i}.background_page_rows`, true));
    }
    const failures: string[] = [];
    const lanes = (["opencode", "opencode2"] as const).map(host => {
        const ordinary = bundle.passes.filter(pass => pass.host === host && pass.pass_kind === "ordinary");
        requireThat(ordinary.length >= 20, `${host}: at least 20 ordinary samples required`);
        requireThat(ordinary.every(pass => pass.appended <= 3), `${host}: ordinary sample has >3 appends`);
        const hooks = ordinary.flatMap(pass => pass.hook_module_ms);
        requireThat(hooks.length > 0, `${host}: per-hook module measurements required`);
        for (const fixture of ["large-replace", "many-text-block", "post-publication"] as const)
            requireThat(ordinary.some(pass => pass.fixture === fixture && (fixture !== "post-publication" || (pass.appended === 0 && pass.background_delta_bytes > 0))), `${host}: ${fixture} fixture missing`);
        const p1 = { samples: ordinary.length, p50_ms: percentile(ordinary.map(p => p.pass_ms), .5), p95_ms: percentile(ordinary.map(p => p.pass_ms), .95), hook_samples: hooks.length, hook_module_p50_ms: percentile(hooks, .5) };
        if (p1.p50_ms > 30 || p1.p95_ms > 120 || p1.hook_module_p50_ms > 5) failures.push(`${host}: P1`);
        const rebuild = bundle.passes.filter(pass => pass.host === host && pass.pass_kind === "rebuild");
        const full = bundle.passes.filter(pass => pass.host === host && pass.pass_kind === "full");
        requireThat(rebuild.length >= 5 && rebuild.length === full.length, `${host}: >=5 paired rebuild/full samples required`);
        requireThat(new Set(rebuild.map(p => p.comparison_id)).size === rebuild.length && new Set(full.map(p => p.comparison_id)).size === full.length, `${host}: duplicate comparison id`);
        for (const pass of rebuild) {
            const baseline = full.find(p => p.comparison_id === pass.comparison_id);
            requireThat(pass.comparison_id && baseline && hash(pass.starting_store_sha256) && baseline.starting_store_sha256 === pass.starting_store_sha256, `${host}: same-starting-store comparison required`);
        }
        const p2 = { samples: rebuild.length, rebuild_p50_ms: percentile(rebuild.map(p => p.pass_ms), .5), full_p50_ms: percentile(full.map(p => p.pass_ms), .5) };
        requireThat(p2.full_p50_ms > 0, `${host}: zero baseline timing`);
        if (p2.rebuild_p50_ms > p2.full_p50_ms * 1.1) failures.push(`${host}: P2`);
        const violations = ordinary.filter(pass =>
            pass.host_logical_payload_bytes > pass.ingest_json_bytes + pass.hook_ops_json_bytes + 1024 ||
            pass.module_logical_payload_bytes > pass.appended_message_bytes + pass.answer_json_bytes + pass.tag_row_bytes + 1024 ||
            (pass.appended === 0 && (pass.ingest_json_bytes !== 0 || pass.hook_ops_json_bytes !== 0 || pass.appended_message_bytes !== 0 || pass.answer_json_bytes !== 0 || pass.tag_row_bytes !== 0)) ||
            pass.background_page_rows.length > 20 || pass.background_page_rows.some(rows => rows > 1000));
        if (violations.length) failures.push(`${host}: P3 (${violations.length} passes)`);
        const p3 = { violations: violations.length, background_delta_bytes: ordinary.reduce((sum, p) => sum + p.background_delta_bytes, 0), physical_bytes: ordinary.map(p => ({ host_db: p.host_db_bytes, host_wal: p.host_wal_bytes, module_db: p.module_db_bytes, module_wal: p.module_wal_bytes })) };
        return { host, p1, p2, p3 };
    });
    return { lanes, failures };
}

export function evaluateCanary(canary: Canary) {
    requireThat(canary && typeof canary.session_id === "string" && canary.session_id.trim(), "exact ALF session id required");
    requireThat(canary.host === "opencode" || canary.host === "opencode2", "invalid canary host");
    const start = Date.parse(canary.started_at), end = Date.parse(canary.ended_at);
    requireThat(Number.isFinite(start) && Number.isFinite(end) && end - start >= 86400000, "24-hour canary required");
    requireThat(typeof canary.anthropic_dir === "string" && typeof canary.openai_dir === "string", "explicit captured dump directories required");
    requireThat(Array.isArray(canary.events), "prefix-event ledger required");
    for (const event of canary.events)
        requireThat(["applied_view", "host_prefix_event", "exit_pass"].includes(event.kind) && event.evidence_id?.trim() && Number.isFinite(Date.parse(event.at)), "invalid prefix-event evidence");
    requireThat(new Set(canary.events.map(e => e.at)).size === canary.events.length, "ambiguous prefix-event timestamp");
    const analysis = analyzeOpenCodeCacheBustSession({ sessionId: canary.session_id, sinceExclusiveMs: start - 1, untilInclusiveMs: end, anthropicDir: canary.anthropic_dir, openaiDir: canary.openai_dir, mcLogPath: null });
    const requests = analysis.requests;
    requireThat(requests.length >= 2 && !analysis.scanBounded, "empty/incomplete canary analysis");
    requireThat(requests[0]!.timestampMs - start <= 300000 && end - requests.at(-1)!.timestampMs <= 300000, "dumps do not cover the canary window (five-minute edge tolerance)");
    requireThat(requests.every(r => !["UNMETERED", "LATENCY"].includes(r.verdict)), "unpriced/unmetered requests leave P4 unknown");
    const busts = requests.filter(r => r.verdict === "BUST");
    const unexpected = busts.filter(r => !canary.events.some(event => Date.parse(event.at) === r.timestampMs));
    return { requests: requests.length, priced_busts: busts.length, unexpected_busts: unexpected.length, unexpected };
}

if (import.meta.main) {
    try {
        requireThat(Bun.argv.length === 3, "usage: bun packages/plugin/scripts/perf-audit/provider-pipeline-gate.ts <measurement-bundle.json>");
        const bundle = JSON.parse(readFileSync(Bun.argv[2]!, "utf8")) as MeasurementBundle;
        const performance = evaluatePerformance(bundle);
        const p4 = evaluateCanary(bundle.canary);
        const failures = [...performance.failures, ...(p4.unexpected_busts ? ["P4"] : [])];
        console.log(JSON.stringify({ schema: 1, status: failures.length ? "failed" : "passed", bun: Bun.version, ...performance, p4, failures }, null, 2));
        process.exitCode = failures.length ? 1 : 0;
    } catch (error) {
        console.error(JSON.stringify({ status: "blocked", error: String(error), bun: Bun.version }));
        process.exitCode = 2;
    }
}
