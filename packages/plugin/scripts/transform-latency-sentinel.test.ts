import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { alertUrgency, formatAlerts, type LatencyAlert, readNewLines, runLatencySentinel } from "./transform-latency-sentinel";

const BASE = Date.parse("2026-09-28T18:00:00Z");
let root: string;
let path: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "latency-sentinel-")); path = join(root, "log"); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
const line = (id: string, second: number, elapsed: number, module?: number) =>
    `[${new Date(BASE + second * 1000).toISOString()}] [magic-context][${id}] ${module === undefined ? `transform completed in ${elapsed}ms` : `rust pass: decision=SOFT+ served_from=transform elapsed=${elapsed} ms module=${module} ms`}\n`;
async function run(now = BASE + 100_000) {
    return runLatencySentinel({ files: [path], stateFile: join(root, "state.json"), db: join(root, "absent.db"), connectionFile: "", send: false, now: () => now, load: () => [1, 2, 3], stdout: () => {}, stderr: () => {} });
}
test("fixture positives fire for each event kind and quiet session does not", async () => {
    writeFileSync(path, readFileSync(join(import.meta.dir, "fixtures/transform-latency.txt")));
    const result = await run();
    expect(result.alerts.map((a) => `${a.sessionId}:${a.kind}`).sort()).toEqual([
        "ses_park:park", "ses_refused2:refusal", "ses_refused3:refusal", "ses_refused:refusal",
        "ses_slow:single", "ses_timeout2:timeout", "ses_timeout3:timeout", "ses_timeout:timeout",
    ].sort());
    expect(result.alerts[0]).toMatchObject({ p50: 13000, p90: 13000, max: 13000, moduleP50: 3000, pluginP50: 10000, load: [1, 2, 3] });
    expect((await run()).alerts).toHaveLength(0);
});
test("p90 over ten passes, module climb over twenty, and quiet controls", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 20; i++) {
        lines.push(line("ses_climb", i, 30 + i * 180, 8 + i * 160));
        lines.push(line("ses_quiet", i, 50, 10));
        if (i < 10) lines.push(line("ses_p90", i, i < 2 ? 7000 : 100, 10));
    }
    writeFileSync(path, lines.join(""));
    const result = await run();
    expect(result.alerts.some((a) => a.sessionId === "ses_p90" && a.kind === "p90")).toBe(true);
    expect(result.alerts.some((a) => a.sessionId === "ses_climb" && a.kind === "module_climb")).toBe(true);
    expect(result.alerts.some((a) => a.sessionId === "ses_quiet")).toBe(false);
});
test("a runner's step render lines count as passes, with the step answer wait as module time", async () => {
    const step = (id: string, second: number, elapsed: number, wait: number) =>
        `${new Date(BASE + second * 1000).toISOString()} INFO  thalamus-harness: step render session=${id} elapsed_ms=${elapsed} wait_ms=${wait} entries=421 view=3 cached=false\n`;
    writeFileSync(path, [
        step("ses_slowstep", 0, 13_500, 13_000),
        step("019de471-4fdc-762d-9286-624dfad0b5fe", 1, 14_000, 200),
        ...Array.from({ length: 10 }, (_, i) => step("ses_quietstep", 2 + i, 123, 111)),
    ].join(""));
    const result = await run();
    expect(result.alerts.map((a) => `${a.sessionId}:${a.kind}`).sort()).toEqual([
        "019de471-4fdc-762d-9286-624dfad0b5fe:single", "ses_slowstep:single",
    ]);
    expect(result.alerts.find((a) => a.sessionId === "ses_slowstep")).toMatchObject({ moduleP50: 13_000, pluginP50: 500 });
});
test("watermark resumes partial lines, handles rotation and re-alerts only at 50% or six hours", async () => {
    writeFileSync(path, line("ses_slow", 0, 13000).trimEnd());
    expect((await run()).alerts).toHaveLength(0);
    appendFileSync(path, "\n");
    expect((await run()).alerts.map((a) => a.kind)).toEqual(["single"]);
    appendFileSync(path, line("ses_slow", 1, 14000));
    expect((await run()).alerts).toHaveLength(0);
    appendFileSync(path, line("ses_slow", 2, 20000));
    expect((await run()).alerts.map((a) => a.kind)).toEqual(["single"]);
    renameSync(path, join(root, "old-log"));
    writeFileSync(path, line("ses_new", 3, 13000));
    expect((await run()).alerts.map((a) => a.sessionId)).toEqual(["ses_new"]);
    appendFileSync(path, line("ses_slow", 7 * 3600, 13000));
    expect((await run(BASE + 8 * 3600_000)).alerts.map((a) => a.sessionId)).toEqual(["ses_slow"]);
});
test("scan is byte bounded and resumes without re-reading earlier events", async () => {
    writeFileSync(path, line("ses_first", 0, 13000) + line("ses_second", 1, 13000));
    const first = await runLatencySentinel({ files: [path], stateFile: join(root, "state.json"), db: "", connectionFile: "", send: false, now: () => BASE + 100_000, load: () => [0, 0, 0], stdout: () => {}, stderr: () => {}, replay: true });
    expect(first.alerts.map((a) => a.sessionId)).toEqual(["ses_first", "ses_second"]);
    expect(first.files[path].offset).toBeGreaterThan(0);
    const fragment = readNewLines(path, undefined, Buffer.byteLength(line("ses_first", 0, 13000)) + 5);
    expect(fragment.lines).toHaveLength(1);
    expect(readNewLines(path, fragment.cursor).lines).toHaveLength(1);
});
test("peer roster name takes precedence over project binding", async () => {
    writeFileSync(path, line("ses_slow", 0, 13000));
    const project = new Database(join(root, "context.db"));
    project.exec("CREATE TABLE session_projects(session_id TEXT, project_path TEXT)");
    project.query("INSERT INTO session_projects VALUES (?, ?)").run("ses_slow", "git:example");
    project.close(false);
    const roster = new Database(join(root, "peers.db"));
    roster.exec("CREATE TABLE agent(name TEXT, residence_address_json TEXT, terminal_reason TEXT); CREATE TABLE peers(name TEXT, session_id TEXT, added_at INTEGER)");
    roster.query("INSERT INTO peers VALUES (?, ?, ?)").run("CEREB", "ses_slow", 1);
    roster.close(false);
    const result = await runLatencySentinel({ files: [path], stateFile: join(root, "state.json"), db: join(root, "context.db"), peerDb: join(root, "peers.db"), connectionFile: "", send: false, now: () => BASE + 100_000, load: () => [0, 0, 0], stdout: () => {}, stderr: () => {} });
    expect(result.alerts[0]?.name).toBe("CEREB");
});
test("a roster without the legacy peers table still names sessions from agent rows", async () => {
    writeFileSync(path, line("ses_slow", 0, 13000));
    const roster = new Database(join(root, "peers.db"));
    roster.exec("CREATE TABLE agent(name TEXT, residence_address_json TEXT, terminal_reason TEXT)");
    roster.query("INSERT INTO agent VALUES (?, ?, NULL)").run("SUBC", JSON.stringify({ session: "ses_slow" }));
    roster.close(false);
    const result = await runLatencySentinel({ files: [path], stateFile: join(root, "state.json"), db: join(root, "missing.db"), peerDb: join(root, "peers.db"), connectionFile: "", send: false, now: () => BASE + 100_000, load: () => [0, 0, 0], stdout: () => {}, stderr: () => {} });
    expect(result.alerts[0]?.name).toBe("SUBC");
});
test("LKG declines count by session and UTC hour, appear on refusals, and summary does not advance the cursor", async () => {
    const decline = (id: string, at: string, reason: string) => `[${at}] [magic-context][${id}] ${reason}\n`;
    const refusal = (id: string, at: string) => `[${at}] [magic-context][${id}] raw_fallback_over_context_limit\n`;
    writeFileSync(path, decline("ses_a", "2026-09-28T18:59:59.000Z", "lkg_unsafe_seam")
        + decline("ses_a", "2026-09-28T19:00:00.000Z", "lkg_anthropic_reasoning_run_invalid")
        + decline("ses_a", "2026-09-28T19:00:01.000Z", "lkg_anthropic_reasoning_run_invalid")
        + decline("ses_b", "2026-09-28T19:00:02.000Z", "lkg_model_mismatch")
        + refusal("ses_a", "2026-09-28T19:00:03.000Z")
        + refusal("ses_b", "2026-09-28T19:00:04.000Z"));
    const output: string[] = [];
    const options = { files: [path], stateFile: join(root, "state.json"), db: "", connectionFile: "", send: false,
        now: () => BASE + 2 * 3600_000, load: () => [0, 0, 0], stdout: (value: string) => output.push(value), stderr: () => {} };
    const summary = await runLatencySentinel({ ...options, summary: true, since: BASE + 3600_000, until: BASE + 2 * 3600_000 });
    expect(summary.declines).toEqual([
        { sessionId: "ses_a", hour: "2026-09-28T19:00:00.000Z", reasons: { lkg_anthropic_reasoning_run_invalid: 2 } },
        { sessionId: "ses_b", hour: "2026-09-28T19:00:00.000Z", reasons: { lkg_model_mismatch: 1 } },
    ]);
    expect(JSON.parse(output[0]!).declines).toEqual(summary.declines);
    expect(readFileSync(path, "utf8")).toContain("lkg_unsafe_seam");
    const result = await runLatencySentinel(options);
    expect(result.alerts.filter((a) => a.kind === "refusal").map((a) => a.lkgDeclines)).toEqual([
        { lkg_anthropic_reasoning_run_invalid: 2 }, { lkg_model_mismatch: 1 },
    ]);
    expect(formatAlerts(result.alerts)).toContain("LKG declines 2 lkg_anthropic_reasoning_run_invalid");
    expect((await runLatencySentinel(options)).alerts).toHaveLength(0);
});

test("--summary CLI reads rotated logs and filters the window without sending or writing state", () => {
    writeFileSync(`${path}.1`, "[2026-09-28T19:35:29.780Z] [magic-context][ses_cereb] lkg_anthropic_reasoning_run_invalid\n");
    writeFileSync(path, "[2026-09-28T21:55:43.431Z] [magic-context][ses_cereb] lkg_unsafe_seam\n");
    const stateFile = join(root, "state.json");
    const run = Bun.spawnSync([process.execPath, join(import.meta.dir, "transform-latency-sentinel.ts"),
        "--summary", "--opencode-log", path, "--pi-log", join(root, "missing-pi"),
        "--module-log", join(root, "missing-module"), "--db", join(root, "missing-db"),
        "--state-file", stateFile, "--since", "2026-09-28T19:00:00Z", "--until", "2026-09-28T20:00:00Z"]);
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout.toString()).declines).toEqual([
        { sessionId: "ses_cereb", hour: "2026-09-28T19:00:00.000Z", reasons: { lkg_anthropic_reasoning_run_invalid: 1 } },
    ]);
    expect(existsSync(stateFile)).toBe(false);
});

test("children of one project collapse to one line; only parks and refusals are high urgency", () => {
    const base = { at: "2026-09-28T19:44:40.015Z", detail: "", count: 10, p50: 500, moduleP50: 50, moduleP90: 300, pluginP50: 450, pluginP90: 8000, pluginMax: 9000, load: [279, 262, 235], loadSampledAt: "", lkgDeclines: {} };
    const alerts: LatencyAlert[] = [
        { ...base, kind: "timeout", sessionId: "ses_a", name: "git:3fba", p90: 8000, max: 9000, moduleMax: 400 },
        { ...base, kind: "single", sessionId: "ses_b", name: "git:3fba", p90: 14000, max: 26000, moduleMax: 330 },
        { ...base, kind: "p90", sessionId: "ses_c", name: "ses_c", p90: 6000, max: 7000, moduleMax: 100 },
        { ...base, kind: "p90", sessionId: "ses_head", name: "ALF", p90: 6100, max: 7100, moduleMax: 5800 },
    ];
    const text = formatAlerts(alerts);
    expect(text.split("\n").filter((l) => l.startsWith("- "))).toEqual([
        "- git:3fba (2 unnamed sessions): 1 timeout, 1 slow pass; worst pass 26.0 s (module 0.3 s); p90 up to 14.0 s",
        "- ses_c (1 unnamed session): 1 slow p90; worst pass 7.0 s (module 0.1 s); p90 up to 6.0 s",
        "- ALF: 1 slow p90; worst pass 7.1 s (module 5.8 s); p90 up to 6.1 s",
    ]);
    expect(text).toContain("load now 279/262/235");
    expect(alertUrgency(alerts)).toBe("normal");
    expect(alertUrgency([...alerts, { ...base, kind: "refusal", sessionId: "ses_head", name: "ALF", p90: 0, max: 0, moduleMax: 0 }])).toBe("high");
    expect(alertUrgency([{ ...base, kind: "park", sessionId: "ses_x", name: "CEREB", p90: 0, max: 0, moduleMax: 0 }])).toBe("high");
});

test("busy-storage markers count by session and hour, threshold and dedupe; lock holders report site statistics", async () => {
    writeFileSync(path, readFileSync(join(import.meta.dir, "fixtures/transform-storage-busy.txt")));
    const output: string[] = [];
    const options = { files: [path], stateFile: join(root, "state.json"), db: "", connectionFile: "", send: false,
        now: () => BASE + 100_000, load: () => [0, 0, 0], stdout: (value: string) => output.push(value), stderr: () => {} };
    const first = await runLatencySentinel(options);
    expect(first.alerts.map((alert) => alert.kind)).toEqual(["busy_refusal", "busy_replay", "long_lock"]);
    expect(first.alerts[0]).toMatchObject({ sessionId: "unknown-session", busy: { refusals: 1, replays: 0 } });
    expect(first.alerts[2]).toMatchObject({ sessionId: "unknown-session", lock: { site: "smart_note_commit", count: 2, max: 5100, p90: 5100 } });
    expect(first.alerts[1]).toMatchObject({ sessionId: "ses_pi", busy: { refusals: 0, replays: 3 } });
    expect(formatAlerts(first.alerts)).toContain("smart_note_commit max 5.1 s, p90 5.1 s");
    expect(alertUrgency(first.alerts)).toBe("normal");
    expect(output.filter((value) => JSON.parse(value).kind === "transform_latency_daily_summary")).toHaveLength(1);
    appendFileSync(path, "[2026-09-28T18:00:10.000Z] [magic-context] storage-busy refusal stage=rust-mode-emergency: locked\n"
        + "[2026-09-28T18:00:11.000Z] [magic-context] slow write transaction: site=smart_note_commit held=5200.0ms\n"
        + "[2026-09-28T18:00:12.000Z] [magic-context][ses_pi] TRANSIENT STORAGE FAILURE sqlite_busy: LKG replay served 4 messages instead of raw 9\n");
    expect((await runLatencySentinel(options)).alerts).toHaveLength(0);
    expect(output.filter((value) => JSON.parse(value).kind === "transform_latency_daily_summary")).toHaveLength(1);
    const next: string[] = [];
    const following = await runLatencySentinel({ ...options, now: () => BASE + 24 * 3600_000 + 100_000, stdout: (value) => next.push(value) });
    expect(following.alerts).toHaveLength(0);
    expect(next.map((value) => JSON.parse(value))).toEqual([{
        kind: "transform_latency_daily_summary", day: "2026-09-28",
        busy: [
            { sessionId: "unknown-session", hour: "2026-09-28T18:00:00.000Z", refusals: 2, replays: 0 },
            { sessionId: "ses_busy", hour: "2026-09-28T18:00:00.000Z", refusals: 0, replays: 1 },
            { sessionId: "ses_pi", hour: "2026-09-28T18:00:00.000Z", refusals: 0, replays: 4 },
        ], holds: 4, longHolds: 2,
    }]);
});
