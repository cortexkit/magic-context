import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { failedRequiredJobs, slowUnitRequired } from "./check-ci-results";

const root = resolve(import.meta.dir, "../../..");
const text = await Bun.file(resolve(root, ".github/workflows/ci.yml")).text();
const releaseText = await Bun.file(resolve(root, ".github/workflows/release.yml")).text();
const waitActionText = await Bun.file(resolve(root, ".github/actions/wait-ci-artifact/action.yml")).text();
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
    for (const id of ["unit-plugin", "unit-pi-plugin", "check-plugin-compat", "e2e-opencode", "e2e-opencode2", "e2e-pi", "e2e-omp", "e2e-host-opencode", "e2e-host-opencode2", "e2e-host-pi", "e2e-host-omp", "rust-mc-module-integration", "rust-workspace-crates", "rust-mc-module-lib", "e2e-rust-hermetic"]) {
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
    const ciConsumers = ["rust-mc-module-lib", "e2e-rust-hermetic", "rust-raw-replay-review"];
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
        "ci.yml:rust-raw-replay-review",
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
    const wait = lib.steps.find((step) => step.uses === "./.github/actions/wait-ci-artifact")!;
    expect(wait.with!.producer).toBe(workflow.jobs["rust-lib-archive"]!.name);
    expect(Number(wait.with!["timeout-minutes"])).toBe(workflow.jobs["rust-lib-archive"]!["timeout-minutes"]!);
    expect(lib["timeout-minutes"]).toBe(90);
    expect(lib.steps.some((step) => step.run?.includes("--archive-file ci-rust-lib/archive.tar.zst"))).toBe(true);
    expect(lib.steps.some((step) => step.run?.includes("--failure-output immediate-final"))).toBe(true);
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

test("raw replay review reuses the hermetic driver and requires the pinned live witnesses", async () => {
    const producer = workflow.jobs["e2e-rust-hermetic-build"]!;
    const build = producer.steps.find((step) => step.name === "Build hermetic binary pair (including fault-injection variant)")!;
    expect(build.run).toContain("--example transform_replay");
    expect(build.run).toContain("rust-raw-replay-probe");

    const review = workflow.jobs["rust-raw-replay-review"]!;
    expect(review.name).toBe("Rust (raw replay review)");
    expect(review.needs).toEqual(["e2e-rust-hermetic-build"]);
    expect(review["timeout-minutes"]).toBe(120);
    const wait = review.steps.find((step) => step.uses === "./.github/actions/wait-ci-artifact")!;
    expect(wait.with!.artifact).toBe("rust-hermetic-binaries-${{ github.sha }}");

    const fetch = review.steps.find((step) => step.name === "Fetch pinned master baseline")!;
    expect(fetch.run).toContain("scripts/rust-raw-replay-baseline.commit");
    expect(fetch.run).toContain("git fetch --no-tags --depth=1 origin");
    const pin = await Bun.file(resolve(root, "scripts/rust-raw-replay-baseline.commit")).text();
    expect(pin.trim()).toMatch(/^[0-9a-f]{40}$/);

    const run = review.steps.find((step) => step.name === "Run staged raw replay witnesses")!;
    expect(run.env!.MC_RAW_REPLAY_REQUIRED).toBe("1");
    expect(run.env!.MC_REVIEW_ASSERT_LIVENESS).toBe("1");
    expect(run.run).toContain("rust-cache-review.test.ts");
    expect(run.run).toContain("rust-cache-r2.test.ts");
    expect(run.run).toContain("rust-cache-restart.test.ts");
    expect(run.run).toContain("release recovery census");
    expect(run.run).toContain("no-freeze SQL");
    expect(run.run).toContain("seed (a19f37|badc0de|c001d00d|92e41b|67d5a3)");
});
