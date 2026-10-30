import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { failedRequiredJobs, slowUnitRequired } from "./check-ci-results";

const root = resolve(import.meta.dir, "../../..");
const text = await Bun.file(resolve(root, ".github/workflows/ci.yml")).text();
const releaseText = await Bun.file(resolve(root, ".github/workflows/release.yml")).text();
const waitActionText = await Bun.file(resolve(root, ".github/actions/wait-ci-artifact/action.yml")).text();
const differentialBase = (await Bun.file(resolve(root, ".github/standalone-differential-base")).text())
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0 && !line.trim().startsWith("#"))
    ?.trim();
type Step = { name?: string; run?: string; if?: string; uses?: string; with?: Record<string, string>; env?: Record<string, string> };
type Job = { name: string; needs?: string[]; if?: string; "timeout-minutes"?: number; permissions?: Record<string, string>; steps: Step[]; strategy?: { "fail-fast": boolean; matrix: { shard?: number[]; mode?: string[]; version?: string[] } } };
const workflow = Bun.YAML.parse(text) as { jobs: Record<string, Job> };
// Inspect the commands CI actually invokes, not a second copy of their shell bodies.
for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps) {
        const shared = step.run?.match(/^bash (scripts\/ci\/[\w-]+\.sh)(?: |$)/);
        if (shared) step.run += `\n${await Bun.file(resolve(root, shared[1]!)).text()}`;
    }
}
const releaseWorkflow = Bun.YAML.parse(releaseText) as { jobs: Record<string, Job> };
const allWorkflowDocuments = await Promise.all(
    (await readdir(resolve(root, ".github/workflows")))
        .filter((file) => file.endsWith(".yml"))
        .map(async (file) => ({
            file,
            workflow: Bun.YAML.parse(await Bun.file(resolve(root, ".github/workflows", file)).text()) as { jobs: Record<string, Job> },
        })),
);
const waitAction = Bun.YAML.parse(waitActionText) as { inputs: Record<string, { description: string; default?: string; required: boolean }>; runs: { steps: Array<{ env?: Record<string, string>; run?: string }> } };

test("summary requires every job and always runs", () => {
    const summary = workflow.jobs["ci-summary"]!;
    expect(summary.name).toBe("CI (required)");
    expect(summary.if).toBe("${{ always() }}");
    expect([...summary.needs!].sort()).toEqual(Object.keys(workflow.jobs).filter((job) => job !== "ci-summary").sort());
});

test("summary rejects failed, cancelled, skipped and missing legs", () => {
    const required = ["first", "second"];
    expect(failedRequiredJobs(required, { first: { result: "success" }, second: { result: "success" } })).toEqual([]);
    for (const result of ["failure", "cancelled", "skipped", "", undefined]) {
        expect(failedRequiredJobs(required, { first: { result: "success" }, second: { result } })).toEqual(["second"]);
    }
    expect(failedRequiredJobs(required, { first: { result: "success" } })).toEqual(["second"]);
    expect(() => failedRequiredJobs([], {})).toThrow();
});

test("slow units are required on nightly and check branches, but may skip only on fast runs", () => {
    const job = workflow.jobs["slow-unit"]!;
    expect(job.if).toBe("github.event_name == 'schedule' || startsWith(github.ref, 'refs/heads/train/check-')");
    expect(job.strategy).toEqual({ "fail-fast": false, matrix: { mode: ["normal", "assertions"] } });
    expect(slowUnitRequired("schedule", "refs/heads/master")).toBe(true);
    expect(slowUnitRequired("push", "refs/heads/train/check-pr-123")).toBe(true);
    for (const [event, ref] of [["push", "refs/heads/master"], ["pull_request", "refs/pull/123/merge"], ["push", "refs/heads/train/other"]]) {
        expect(slowUnitRequired(event, ref)).toBe(false);
    }
    expect(failedRequiredJobs(["slow-unit"], { "slow-unit": { result: "skipped" } }, ["slow-unit"])).toEqual([]);
    expect(failedRequiredJobs(["slow-unit"], { "slow-unit": { result: "skipped" } })).toEqual(["slow-unit"]);
    expect(failedRequiredJobs(["slow-unit"], {}, ["slow-unit"])).toEqual(["slow-unit"]);
    expect(failedRequiredJobs(["slow-unit"], { "slow-unit": { result: "failure" } }, ["slow-unit"])).toEqual(["slow-unit"]);
    for (const id of ["publish-npm", "publish-npm-pi", "publish-npm-cli", "github-release"]) {
        expect(releaseWorkflow.jobs[id]!.needs).toContain("slow-unit");
        expect(releaseWorkflow.jobs[id]!.if).toContain("needs.slow-unit.result == 'success'");
    }
    expect(releaseWorkflow.jobs["slow-unit"]!.if).toBeUndefined();
});

test("dists publish before independent checks without removing preflight gates", () => {
    const preflight = workflow.jobs.preflight!;
    const publish = preflight.steps.findIndex((step) => step.uses === "actions/upload-artifact@v4");
    expect(publish).toBeGreaterThan(preflight.steps.findIndex((step) => step.name === "Check compiled contracts"));
    for (const name of ["Layout, manifest and shard contracts", "Format check", "TypeScript typecheck", "Lint"]) {
        const index = preflight.steps.findIndex((step) => step.name === name);
        expect(index).toBeGreaterThan(publish);
        expect(preflight.steps[index]!.if).toBe("${{ !cancelled() }}");
    }
    expect(workflow.jobs["ci-summary"]!.needs).toContain("preflight");
});

test("native producers start without waiting for unrelated preflight checks", () => {
    for (const id of ["rust-clippy", "rust-lib-archive", "e2e-rust-hermetic-build"]) {
        expect(workflow.jobs[id]!.needs).toBeUndefined();
        expect(workflow.jobs["ci-summary"]!.needs).toContain(id);
    }
});

test("artifact consumers start setup immediately and gate tests on artifacts", () => {
    for (const id of ["unit-plugin", "unit-pi-plugin", "check-plugin-compat", "e2e-opencode", "e2e-opencode2", "e2e-pi", "e2e-omp", "e2e-host-opencode", "e2e-host-opencode2", "e2e-host-pi", "e2e-host-omp", "rust-mc-module-integration", "rust-workspace-crates", "rust-mc-module-lib", "rust-mc-module-parity", "e2e-rust-hermetic"]) {
        const job = workflow.jobs[id]!;
        expect(job.needs).toBeUndefined();
        expect(job.steps[0]!.uses).toBe("actions/checkout@v5");
        expect(job.steps.some((step) => step.uses === "./.github/actions/restore-ci-dists" || step.uses === "./.github/actions/wait-ci-artifact")).toBe(true);
        const gate = job.steps.findIndex((step) => step.uses === "./.github/actions/restore-ci-dists" || step.uses === "./.github/actions/wait-ci-artifact");
        for (const [index, step] of job.steps.entries()) {
            if (step.run && (/cargo (test |nextest run )|bun (test |run --cwd .*? test\b)|run-rust-hermetic-e2e\.sh/.test(step.run) || step.name?.startsWith("Smoke"))) {
                expect(index).toBeGreaterThan(gate);
            }
        }
    }
    expect(workflow.jobs["e2e-host-opencode"]!.strategy).toEqual({ "fail-fast": false, matrix: { shard: [0, 1, 2, 3] } });
    expect(workflow.jobs["e2e-host-opencode2"]!.strategy).toEqual({ "fail-fast": false, matrix: { shard: [0, 1], version: ["2.0.22", "2.1.0"] } });
});

test("same-run artifact downloads retry transient failures and guard consumers", () => {
    const ciConsumers = ["rust-mc-module-lib", "rust-mc-module-parity", "e2e-rust-hermetic"];
    const actualCiConsumers = Object.entries(workflow.jobs)
        .filter(([, job]) => job.steps.some((step) => step.run?.includes("scripts/download-ci-artifact.py") && /--artifact-(?:id|name)/.test(step.run)))
        .map(([id]) => id)
        .sort();
    expect(actualCiConsumers).toEqual([...ciConsumers].sort());

    const actualReleaseConsumers = Object.entries(releaseWorkflow.jobs)
        .filter(([, job]) => job.steps.some((step) => step.run?.includes("scripts/download-ci-artifact.py")))
        .map(([id]) => id);
    expect(actualReleaseConsumers).toEqual(["e2e-rust-hermetic"]);
    const actualRetryConsumers = allWorkflowDocuments.flatMap(({ file, workflow: current }) =>
        Object.entries(current.jobs)
            .filter(([, job]) => (job.steps ?? []).some((step) => step.run?.includes("scripts/download-ci-artifact.py") && /--artifact-(?:id|name)/.test(step.run)))
            .map(([id]) => `${file}:${id}`),
    ).sort();
    expect(actualRetryConsumers).toEqual([
        "ci.yml:e2e-rust-hermetic",
        "ci.yml:rust-mc-module-lib",
        "ci.yml:rust-mc-module-parity",
        "release.yml:e2e-rust-hermetic",
    ]);
    for (const { workflow: current } of allWorkflowDocuments) {
        expect(Object.values(current.jobs).flatMap((job) => job.steps ?? []).filter((step) => step.uses?.startsWith("actions/download-artifact@"))).toEqual([]);
    }
    for (const id of ciConsumers) {
        const job = workflow.jobs[id]!;
        const downloadIndex = job.steps.findIndex((step) => step.run?.includes("scripts/download-ci-artifact.py"));
        const download = job.steps[downloadIndex]!;
        const guardIndex = job.steps.findIndex((step) => step.run?.includes("artifact not downloaded"));
        const testIndex = job.steps.findIndex((step) => /cargo nextest run|run-rust-hermetic-e2e\.sh|test-rust-raw-replay\.sh/.test(step.run ?? ""));
        expect(download.run).toContain("--artifact-id");
        expect(download.env!.GH_TOKEN).toBe("${{ github.token }}");
        expect(guardIndex).toBeGreaterThan(downloadIndex);
        expect(guardIndex).toBeLessThan(testIndex);
    }

    const releaseJob = releaseWorkflow.jobs["e2e-rust-hermetic"]!;
    const releaseDownloadIndex = releaseJob.steps.findIndex((step) => step.run?.includes("scripts/download-ci-artifact.py"));
    const releaseDownload = releaseJob.steps[releaseDownloadIndex]!;
    const releaseGuardIndex = releaseJob.steps.findIndex((step) => step.run?.includes("artifact not downloaded"));
    const releaseTestIndex = releaseJob.steps.findIndex((step) => step.run?.includes("run-rust-hermetic-e2e.sh"));
    expect(releaseDownload.run).toContain("--artifact-name rust-hermetic-binaries");
    expect(releaseDownload.env!.GH_TOKEN).toBe("${{ github.token }}");
    expect(releaseJob.permissions!.actions).toBe("read");
    expect(releaseGuardIndex).toBeGreaterThan(releaseDownloadIndex);
    expect(releaseGuardIndex).toBeLessThan(releaseTestIndex);
});

test("artifact waits allow runner queue time without extending the producer runtime", () => {
    expect(waitAction.inputs["max-wait-minutes"]).toEqual({
        description: "Optional total-wait override; must be at least the producer timeout",
        required: false,
    });
    expect(waitAction.runs.steps[0]!.env!.WAIT_TIMEOUT).toBe("${{ inputs.timeout-minutes }}");
    expect(waitAction.runs.steps[0]!.env!.WAIT_MAX_WAIT).toBe("${{ inputs.max-wait-minutes }}");
    expect(waitAction.runs.steps[0]!.run).toContain("--timeout-minutes \"$WAIT_TIMEOUT\"");
    expect(waitAction.runs.steps[0]!.run).toContain('if [[ -n "$WAIT_MAX_WAIT" ]]');
    expect(waitAction.runs.steps[0]!.run).toContain("--max-wait-minutes \"$WAIT_MAX_WAIT\"");
});

test("cache oracle and separate OC2 regressions run exactly once even after a suite failure", () => {
    const oracle = workflow.jobs["e2e-host-opencode"]!.steps.filter((step) => step.run?.includes("src/cache-analysis.test.ts"));
    expect(oracle).toHaveLength(1);
    expect(oracle[0]!.if).toContain("matrix.shard == 0");
    expect(oracle[0]!.if).toContain("!cancelled()");
    const regressions = workflow.jobs["e2e-host-opencode2"]!.steps.filter((step) => step.run?.includes("store-generation-conversion.test.ts"));
    expect(regressions).toHaveLength(1);
    expect(regressions[0]!.run).toContain("marker-s3-runtime.test.ts || status=1");
    expect(regressions[0]!.if).toContain("matrix.shard == 0");
    expect(regressions[0]!.if).toContain("!cancelled()");
});

test("Rust archive consumers preserve all lib partitions and remaining target kinds", () => {
    const lib = workflow.jobs["rust-mc-module-lib"]!;
    expect(lib.strategy).toEqual({ "fail-fast": false, matrix: { shard: [1, 2, 3, 4] } });
    for (const id of ["rust-mc-module-lib", "rust-mc-module-parity"]) {
        const job = workflow.jobs[id]!;
        const wait = job.steps.find((step) => step.uses === "./.github/actions/wait-ci-artifact")!;
        expect(wait.with!.producer).toBe(workflow.jobs["rust-lib-archive"]!.name);
        expect(Number(wait.with!["timeout-minutes"])).toBe(workflow.jobs["rust-lib-archive"]!["timeout-minutes"]!);
        expect(job["timeout-minutes"]).toBe(90);
        expect(job.steps.some((step) => step.run?.includes("--archive-file ci-rust-lib/archive.tar.zst"))).toBe(true);
        expect(job.steps.some((step) => step.run?.includes("--failure-output immediate-final"))).toBe(true);
    }
    const commands = workflow.jobs["rust-mc-module-integration"]!.steps.map((step) => step.run ?? "").join("\n");
    expect(commands).toContain("--test '*' --bins --no-fail-fast");
    expect(commands).toContain("--doc --no-fail-fast");
    for (const job of Object.values(workflow.jobs)) {
        for (const step of job.steps) {
            for (const line of (step.run ?? "").split("\n")) {
                if (/cargo test/.test(line) && !/--list/.test(line)) expect(line).toContain("--no-fail-fast");
            }
        }
    }
});

test("unit matrices preserve both modes, package wrappers and Pi assertion isolation", () => {
    for (const id of ["unit-plugin", "unit-pi-plugin"]) {
        expect(workflow.jobs[id]!.strategy).toEqual({ "fail-fast": false, matrix: { mode: ["normal", "assertions"], shard: [0, 1, 2, 3] } });
    }
    expect(workflow.jobs["check-plugin"]!.needs).toEqual(["unit-plugin", "check-plugin-compat"]);
    expect(workflow.jobs["check-pi-plugin"]!.needs).toEqual(["unit-pi-plugin"]);
    const plugin = workflow.jobs["unit-plugin"]!.steps.map((step) => step.run).join("\n");
    const pi = workflow.jobs["unit-pi-plugin"]!.steps.map((step) => step.run).join("\n");
    expect(plugin).toContain("bun run --cwd packages/plugin test");
    expect(plugin).toContain("export MAGIC_CONTEXT_DEBUG_ASSERTIONS=1");
    expect(pi).toContain("MAGIC_CONTEXT_DEBUG_ASSERTIONS=1 bun run --cwd packages/pi-plugin test --parallel=1 --timeout=60000");
});

test("Bun oracle consumers restore one same-attempt Rust test binary before running tests", async () => {
    const producer = workflow.jobs["rust-lib-archive"]!;
    const build = producer.steps.find((step) => step.name === "Package conformance oracle test binary")!;
    expect(build.run).toContain("cargo test --locked -p mc-module --lib --profile ci-test --no-run --no-fail-fast --message-format=json");
    expect(build.run).toContain('cp "$binary" ci-conformance-oracle/mc-module-lib-test');
    expect(build.run).toContain('printf \'%s\\n\' "$GITHUB_SHA" > ci-conformance-oracle/commit.txt');
    expect(build.run).toContain("sha256sum ci-conformance-oracle/mc-module-lib-test");
    const uploads = Object.values(workflow.jobs).flatMap((job) => job.steps).filter(
        (step) => step.uses === "actions/upload-artifact@v4" && step.with?.name === "conformance-oracle-${{ github.sha }}-${{ github.run_attempt }}",
    );
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.with!.path).toBe("ci-conformance-oracle/");
    expect(uploads[0]!.with!["if-no-files-found"]).toBe("error");
    for (const id of ["unit-plugin", "unit-pi-plugin", "rust-mc-module-integration"]) {
        const job = workflow.jobs[id]!;
        const restores = job.steps.filter((step) => step.uses === "./.github/actions/restore-conformance-oracle");
        expect(restores).toHaveLength(1);
        const restore = job.steps.indexOf(restores[0]!);
        expect(job["timeout-minutes"]).toBe(90);
        for (const [index, step] of job.steps.entries()) {
            if (step.run && /bun (test |run --cwd .*? test\b)/.test(step.run)) expect(index).toBeGreaterThan(restore);
            expect(step.run ?? "").not.toMatch(/cargo test .*--lib/);
        }
    }
    const integration = workflow.jobs["rust-mc-module-integration"]!.steps.find(
        (step) => step.name === "Run system-prompt-delivery integration test",
    )!;
    expect(integration.run).toContain('MC_SYSTEM_DELIVERY_FIXTURE_BINARY="$MC_CONFORMANCE_ORACLE_BINARY"');
    const actionText = await Bun.file(resolve(root, ".github/actions/restore-conformance-oracle/action.yml")).text();
    const action = Bun.YAML.parse(actionText) as { runs: { steps: Step[] } };
    const wait = action.runs.steps.find((step) => step.uses === "./.github/actions/wait-ci-artifact")!;
    expect(wait.with!.artifact).toBe("conformance-oracle-${{ github.sha }}");
    expect(wait.with!.producer).toBe(producer.name);
    expect(Number(wait.with!["timeout-minutes"])).toBe(producer["timeout-minutes"]!);
    const download = action.runs.steps.find((step) => step.uses === "actions/download-artifact@v4")!;
    expect(download.with!["artifact-ids"]).toBe("${{ steps.oracle.outputs.artifact-id }}");
    expect(actionText).toContain('test "$(cat ci-conformance-oracle/commit.txt)" = "$GITHUB_SHA"');
    expect(actionText).toContain("sha256sum --check ci-conformance-oracle/oracle.sha256");
    expect(actionText).toContain('test -x "$binary"');
    expect(actionText).toContain('echo "MC_CONFORMANCE_ORACLE_BINARY=$binary" >> "$GITHUB_ENV"');
});

test("standalone differential jobs fetch the shared pinned base before tests", () => {
    expect(differentialBase).toMatch(/^[0-9a-f]{40}$/);
    for (const id of ["unit-plugin", "rust-mc-module-integration"]) {
        const steps = workflow.jobs[id]!.steps;
        const fetch = steps.findIndex((step) => step.name === "Fetch pinned standalone differential base");
        expect(fetch).toBeGreaterThan(0);
        expect(steps[fetch]!.run).toBe(
            'git fetch --no-tags --depth=1 origin "$(grep -v \'^#\' .github/standalone-differential-base)"',
        );
        const test = steps.findIndex((step) => step.run && (/bun run --cwd packages\/plugin test|cargo test --locked -p mc-module --test/.test(step.run)));
        expect(test).toBeGreaterThan(fetch);
    }
});

test("remaining Rust crates retain Bun migration oracles and hermetic archives retain executable variants", () => {
    const remaining = workflow.jobs["rust-workspace-crates"]!.steps;
    expect(remaining.some((step) => step.uses === "oven-sh/setup-bun@v2")).toBe(true);
    expect(remaining.some((step) => step.run === "bun install --frozen-lockfile")).toBe(true);
    const hermetic = workflow.jobs["e2e-rust-hermetic"]!;
    const wait = hermetic.steps.find((step) => step.uses === "./.github/actions/wait-ci-artifact")!;
    expect(Number(wait.with!["timeout-minutes"])).toBe(workflow.jobs["e2e-rust-hermetic-build"]!["timeout-minutes"]!);
    expect(hermetic["timeout-minutes"]).toBe(180);
    const setup = hermetic.steps.findIndex((step) => step.name === "Install pinned OpenCode");
    expect(setup).toBeLessThan(hermetic.steps.indexOf(wait));
    const unpack = hermetic.steps.find((step) => step.name === "Restore executable and auxiliary binaries")!.run!;
    expect(unpack).toContain("ckdev-mc-e2e ckdev-mc-e2e-drive-fault ckdev-subc");
    expect(unpack).toContain('test -x "packages/e2e-tests/.cache/prebuilt/$binary"');
});

test("raw replay review stays retired with the TypeScript full-array Rust transform", async () => {
    // Its witnesses were plugin review tests of the deleted full-array transform.
    // A job that still pointed at them could only fail with "matched 0 tests".
    expect(workflow.jobs["rust-raw-replay-review"]).toBeUndefined();
    expect(workflow.jobs["ci-summary"]!.needs).not.toContain("rust-raw-replay-review");
    const text = await Bun.file(resolve(root, ".github/workflows/ci.yml")).text();
    expect(text).toContain("Rust (raw replay review) is retired.");
    for (const path of [
        "packages/plugin/review-tests/rust-cache-review.test.ts",
        "packages/plugin/review-tests/rust-cache-r2.test.ts",
        "packages/plugin/review-tests/rust-cache-restart.test.ts",
        "packages/plugin/src/hooks/magic-context/rust-mode-transform.ts",
    ]) {
        expect(await Bun.file(resolve(root, path)).exists()).toBe(false);
    }
    for (const step of Object.values(workflow.jobs).flatMap((job) => job.steps ?? [])) {
        expect(step.run ?? "").not.toContain("test-rust-raw-replay.sh");
    }
});

test("raw replay baseline assembly keeps release sources separate from train sources", () => {
    const fixture = mkdtempSync(resolve(tmpdir(), "raw-replay-assembly-"));
    const put = (path: string, contents: string) => {
        const full = resolve(fixture, path);
        mkdirSync(resolve(full, ".."), { recursive: true });
        writeFileSync(full, contents);
    };
    try {
        for (const path of ["scripts", "node_modules", "packages/plugin/node_modules", "baseline/crates/mc-module/examples"])
            mkdirSync(resolve(fixture, path), { recursive: true });
        put("scripts/test-rust-raw-replay.sh", readFileSync(resolve(root, "scripts/test-rust-raw-replay.sh"), "utf8"));
        put("scripts/rust-raw-replay-baseline.rs", "offline driver");
        for (const prefix of ["", "baseline/"]) {
            const revision = prefix ? "release" : "train";
            put(`${prefix}Cargo.toml`, revision);
            put(`${prefix}Cargo.lock`, revision);
            put(`${prefix}crates/mc-module/src/transform.rs`, `${revision} transform`);
            put(`${prefix}crates/mc-module/src/transform/active_anthropic_turn.rs`, `${revision} helper`);
            put(`${prefix}packages/plugin/src/hooks/magic-context/rust-mode-transform.ts`, `${revision} adapter`);
        }
        const archive = resolve(fixture, "baseline.tar");
        expect(Bun.spawnSync(["tar", "-cf", archive, "-C", resolve(fixture, "baseline"), "."]).exitCode).toBe(0);
        put("bin/cargo", `#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == --version ]] && { echo 'cargo fixture'; exit; }
manifest= target= profile=debug locked=0
while (($#)); do
    case "$1" in
        --manifest-path) manifest="$2"; shift;;
        --target-dir) target="$2"; shift;;
        --release) profile=release;;
        --locked) locked=1;;
    esac
    shift
done
[[ "$locked" == 1 && -n "$manifest" && -n "$target" ]]
base="$(dirname "$manifest")"
[[ "$(< "$manifest")" == release && "$(< "$base/Cargo.lock")" == release ]]
[[ "$(< "$base/crates/mc-module/src/transform.rs")" == 'release transform' ]]
[[ "$(< "$base/crates/mc-module/src/transform/active_anthropic_turn.rs")" == 'release helper' ]]
[[ "$(< "$base/crates/mc-module/examples/transform_replay.rs")" == 'offline driver' ]]
mkdir -p "$target/$profile/examples"
printf '#!/bin/sh\\nexit 0\\n' > "$target/$profile/examples/transform_replay"
chmod +x "$target/$profile/examples/transform_replay"
`);
        put("bin/bun", `#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == --version ]] && { echo 'bun fixture'; exit; }
[[ -x "$MC_RAW_REPLAY_PROBE" && -x "$MC_RAW_REPLAY_BASELINE" ]]
[[ "$(< "$MC_RAW_REPLAY_BASELINE_ADAPTER")" == 'release adapter' ]]
[[ "$(< "$MC_REVIEW_BASELINE_ROOT/Cargo.lock")" == release ]]
echo 'baseline witnesses invoked'
`);
        put("bin/rustc", "#!/bin/sh\necho 'rustc fixture'\n");
        for (const binary of ["cargo", "bun", "rustc"]) chmodSync(resolve(fixture, "bin", binary), 0o755);
        for (const release of ["0", "1"]) {
            const result = Bun.spawnSync(["bash", "scripts/test-rust-raw-replay.sh"], {
                cwd: fixture,
                env: { ...process.env, PATH: `${resolve(fixture, "bin")}:${process.env.PATH}`, MC_RAW_REPLAY_BASELINE_ARCHIVE: archive, MC_RAW_REPLAY_BASELINE_RELEASE: release, MC_RAW_REPLAY_PROBE: resolve(fixture, "bin/bun") },
            });
            expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toEqual({ exitCode: 0, stderr: "" });
            expect(result.stdout.toString()).toContain("baseline witnesses invoked");
            expect(readFileSync(resolve(fixture, "crates/mc-module/src/transform.rs"), "utf8")).toBe("train transform");
            expect(readFileSync(resolve(fixture, "crates/mc-module/src/transform/active_anthropic_turn.rs"), "utf8")).toBe("train helper");
        }
    } finally {
        rmSync(fixture, { recursive: true, force: true });
    }
});

test("required raw replay lane names a missing baseline archive instead of skipping", () => {
    const result = Bun.spawnSync(["bash", "scripts/test-rust-raw-replay.sh"], {
        cwd: root,
        env: { ...process.env, MC_RAW_REPLAY_REQUIRED: "1", MC_RAW_REPLAY_BASELINE_ARCHIVE: "" },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Required MC_RAW_REPLAY_BASELINE_ARCHIVE");
    expect(result.stdout.toString()).not.toContain("skipped");
});
