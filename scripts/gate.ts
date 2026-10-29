import { closeSync, openSync } from "node:fs";
import { copyFile, mkdir, readFile, utimes } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createTestHome, prepareTestTools } from "./gate-tools";

type Step = {
    name?: string;
    run?: string;
    if?: string;
    env?: Record<string, string>;
    uses?: string;
    with?: Record<string, string>;
};
type Job = {
    name: string;
    if?: string;
    "timeout-minutes"?: number;
    env?: Record<string, string>;
    needs?: string | string[];
    steps: Step[];
    strategy?: { matrix: Record<string, Array<string | number>> };
};
type Lane = { id: string; job: Job; matrix: Record<string, string | number>; key: string };
const root = resolve(import.meta.dir, "..");
export const githubOnly = new Set([
    "Package same-commit dists",
    "Resolve Cargo.lock crate pins",
    "Link locked daemon source for integration tests",
    "Download lib archive (retry transient failures and verify digest)",
    "Download hermetic binaries (retry transient failures and verify digest)",
    "Derive hermetic Cargo cache key",
    "Record ck-subc source revision",
]);
const aggregates = new Set(["check-plugin", "check-pi-plugin", "rust-crates", "ci-summary"]);
// Remove these exclusions when build jobs have an approved Docker-compatible engine with Linux/amd64 support.
export const ciOnlyJobs = new Map([
    ["e2e-opencode", "OpenCode Docker"],
    ["e2e-opencode2", "OpenCode 2.0.22 Docker"],
    ["e2e-pi", "Pi Docker"],
    ["e2e-omp", "Oh My Pi real Docker"],
]);
const localActions = new Set([
    "actions/checkout@v5",
    "oven-sh/setup-bun@v2",
    "actions/setup-node@v4",
    "dtolnay/rust-toolchain@stable",
    "taiki-e/install-action@v2",
    "actions/cache@v4",
    "actions/upload-artifact@v4",
    "./.github/actions/restore-ci-dists",
    "./.github/actions/wait-ci-artifact",
]);

export function area(id: string): string {
    if (id.startsWith("rust-") || id.startsWith("e2e-rust-")) return "native";
    return id.startsWith("e2e-host-") ? "host" : "unit";
}

export function cpuBudget(value = "8"): number {
    const cpus = Number(value);
    if (!Number.isInteger(cpus) || cpus < 2 || cpus > 16)
        throw new Error("GATE_CPUS must be an integer from 2 to 16");
    return cpus;
}

export function expand(value: string, matrix: Lane["matrix"], workspace = root, temp = ""): string {
    return value.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_, expression: string) => {
        if (expression.startsWith("matrix.") && expression.slice(7) in matrix)
            return String(matrix[expression.slice(7)]);
        if (expression === "github.workspace") return workspace;
        if (expression === "runner.temp") return temp;
        throw new Error(`Unsupported local workflow expression: ${expression}`);
    });
}

export function lanes(jobs: Record<string, Job>): Lane[] {
    validateJobs(jobs);
    return Object.entries(jobs).flatMap(([id, job]) => {
        if (aggregates.has(id)) return [];
        let combinations: Lane["matrix"][] = [{}];
        for (const [key, values] of Object.entries(job.strategy?.matrix ?? {})) {
            combinations = combinations.flatMap((matrix) =>
                values.map((value) => ({ ...matrix, [key]: value })),
            );
        }
        return combinations.map((matrix) => ({
            id,
            job,
            matrix,
            key: [id, ...Object.values(matrix)].join("-"),
        }));
    });
}

// Unknown conditions fail closed instead of silently dropping a newly added CI check.
export function condition(
    value: string | undefined,
    matrix: Lane["matrix"],
    failed: boolean,
    distsRestored = false,
): boolean {
    if (!value) return !failed;
    if (!value.includes("!cancelled()"))
        throw new Error(`Unsupported local step condition: ${value}`);
    const shard = value.match(/matrix\.shard == (\d+)/);
    const remainder = value.replace(
        /\$\{\{|\}\}|!cancelled\(\)|&&|matrix\.shard == \d+|steps\.dists\.outcome == 'success'|\s/g,
        "",
    );
    if (remainder) throw new Error(`Unsupported local step condition: ${value}`);
    return (
        (!shard || matrix.shard === Number(shard[1])) &&
        (!value.includes("steps.dists.outcome") || distsRestored)
    );
}

export function dependencies(id: string): string[] {
    if (id === "rust-mc-module-lib") return ["rust-lib-archive"];
    if (["e2e-rust-hermetic", "rust-raw-replay-review"].includes(id))
        return ["e2e-rust-hermetic-build"];
    return [];
}

const slowUnitCondition =
    "github.event_name == 'schedule' || startsWith(github.ref, 'refs/heads/train/check-')";

export function yamlNeeds(job: Job): string[] {
    const value = job.needs;
    if (value === undefined) return [];
    const needs = typeof value === "string" ? [value] : value;
    if (!Array.isArray(needs) || needs.some((id) => typeof id !== "string" || !/^[\w-]+$/.test(id)))
        throw new Error(`Unsupported local job needs: ${JSON.stringify(value)}`);
    return needs;
}

export function validateJobs(jobs: Record<string, Job>): void {
    for (const [id, job] of Object.entries(jobs)) {
        // Full deliberately represents a check-candidate run, where both slow modes are required.
        if (
            job.if !== undefined &&
            !(id === "slow-unit" && job.if === slowUnitCondition) &&
            !(aggregates.has(id) && job.if === "${{ always() }}")
        )
            throw new Error(`Unsupported local job condition for ${id}: ${job.if}`);
        for (const needed of yamlNeeds(job)) {
            if (!(needed in jobs)) throw new Error(`Unknown job dependency ${needed} for ${id}`);
            if (!aggregates.has(id) && (aggregates.has(needed) || ciOnlyJobs.has(needed)))
                throw new Error(`Local job ${id} cannot consume CI-only dependency ${needed}`);
        }
        workflowTimeoutMs(job);
    }
}

export function workflowTimeoutMs(job: Job): number {
    const minutes = job["timeout-minutes"] ?? 360;
    if (!Number.isInteger(minutes) || minutes <= 0 || minutes > 360)
        throw new Error(`Unsupported workflow timeout-minutes: ${minutes}`);
    return minutes * 60_000;
}

export class JobBudget {
    private readonly deadline: number;
    constructor(
        readonly milliseconds: number,
        private readonly now = () => performance.now(),
    ) {
        this.deadline = now() + milliseconds;
    }
    expired(): boolean {
        return this.now() >= this.deadline;
    }
    remaining(): number {
        const remaining = this.deadline - this.now();
        if (remaining <= 0) throw new Error("Workflow job timeout budget exhausted");
        return remaining;
    }
    timeoutArgument(): string {
        return `${(Math.ceil(this.remaining()) / 1000).toFixed(3)}s`;
    }
}

export function budgetedCommand(command: string, budget: JobBudget): string[] {
    return [
        "timeout",
        "--kill-after=30s",
        budget.timeoutArgument(),
        "bash",
        "-euo",
        "pipefail",
        "-c",
        command,
    ];
}

export function requiresDists(job: Job): boolean {
    return job.steps.some((step) => step.uses === "./.github/actions/restore-ci-dists");
}

export function laneDependencies(lane: Lane): string[] {
    return [...new Set([...yamlNeeds(lane.job), ...dependencies(lane.id)])];
}

export function dependencyState(
    lane: Lane,
    all: Lane[],
    results: ReadonlyMap<string, boolean>,
    distsReady: boolean,
): "ready" | "wait" | "blocked" {
    if (requiresDists(lane.job) && !distsReady) return "blocked";
    const producers = all.filter((candidate) => laneDependencies(lane).includes(candidate.id));
    if (producers.some((producer) => !results.has(producer.key))) return "wait";
    return producers.some((producer) => !results.get(producer.key)) ? "blocked" : "ready";
}

export async function preflightGroups(
    steps: Step[],
    runGroup: (steps: Step[], label: string) => Promise<boolean>,
): Promise<{ ok: boolean; distsReady: boolean }> {
    const build = steps.findIndex((step) => step.name === "Build complete dists");
    const publish = steps.findIndex(
        (step) =>
            step.uses === "actions/upload-artifact@v4" && step.with?.name?.startsWith("ci-dists-"),
    );
    if (build < 0 || publish <= build)
        throw new Error("Preflight dist producer/publication boundary is not supported");
    const setup = await runGroup(steps.slice(0, build), "setup");
    const checks = steps.slice(publish + 1);
    const independent: Step[] = [];
    const afterBuild: Step[] = [];
    for (const step of checks) {
        const phase = step.env?.GATE_PREFLIGHT_PHASE;
        if (phase !== undefined && phase !== "independent")
            throw new Error(`Unsupported preflight phase: ${phase}`);
        (phase === "independent" ? independent : afterBuild).push(step);
    }
    const production = setup
        ? runGroup(steps.slice(build, publish), "dists")
        : Promise.resolve(false);
    const work = independent.map((step, index) => runGroup([step], `independent-${index}`));
    // Typechecks emit retina declarations and lint reads generated TUI files, so both follow the build.
    const dependent = production.then(() =>
        Promise.all(afterBuild.map((step, index) => runGroup([step], `after-build-${index}`))),
    );
    const [produced, first, rest] = await Promise.all([production, Promise.all(work), dependent]);
    return {
        ok: setup && produced && [...first, ...rest].every(Boolean),
        distsReady: setup && produced,
    };
}

export function resources(id: string): { cpu: number; lock: string } {
    if (id === "rust-mc-module-lib") return { cpu: 4, lock: "nextest-junit" };
    if (id.startsWith("rust-") || id === "e2e-rust-hermetic-build")
        return { cpu: 8, lock: "cargo-build" };
    if (id.startsWith("e2e-host-opencode2")) return { cpu: 2, lock: "oc2-install" };
    if (id.startsWith("unit-") || id === "slow-unit" || id === "check-plugin-compat")
        return { cpu: 4, lock: "package-tests" };
    return { cpu: 2, lock: "" };
}

export function serializeTasks() {
    let queue: Promise<unknown> = Promise.resolve();
    return <T>(task: () => Promise<T>): Promise<T> => {
        const result = queue.then(task);
        queue = result.catch(() => undefined);
        return result;
    };
}

// CI jobs install into separate checkouts. Local lanes share the workspace,
// including installs inside package test wrappers, so serialize those writers.
export function writesWorkspace(command: string, id: string): boolean {
    return (
        command.trim() === "bun install --frozen-lockfile" || resources(id).lock === "package-tests"
    );
}

async function main() {
    const args = process.argv.slice(2);
    const mode = args.shift();
    let base: string | undefined;
    let part = "all";
    let plan = false;
    while (args.length) {
        const arg = args.shift();
        if (arg === "--changed" && args[0]) base = args.shift();
        else if (arg === "--part" && args[0]) part = args.shift()!;
        else if (arg === "--plan") plan = true;
        else throw new Error(`Unknown or incomplete option: ${arg}`);
    }
    if (
        !["preflight", "full", "smoke"].includes(mode ?? "") ||
        (base && mode !== "full") ||
        !["all", "unit", "native", "host"].includes(part) ||
        (part !== "all" && mode !== "full")
    ) {
        throw new Error(
            "Usage: scripts/gate.sh preflight|full|smoke [--plan] [--changed <base>] [--part unit|native|host (full only)]",
        );
    }
    process.chdir(root);
    const workflow = Bun.YAML.parse(
        await readFile(join(root, ".github/workflows/ci.yml"), "utf8"),
    ) as { jobs: Record<string, Job>; env?: Record<string, string | number | boolean> };
    const smoke = Bun.YAML.parse(
        await readFile(join(root, ".github/workflows/smoke-opencode-linux.yml"), "utf8"),
    ) as { jobs: Record<string, Job>; env?: Record<string, string | number | boolean> };
    let selected = lanes(mode === "smoke" ? smoke.jobs : workflow.jobs);
    if (mode === "preflight") selected = selected.filter((lane) => lane.id === "preflight");
    for (const [id, label] of ciOnlyJobs) {
        if (selected.some((lane) => lane.id === id))
            console.log(`${label}: runs on GitHub CI only: no Docker on the build servers`);
    }
    selected = selected.filter((lane) => !ciOnlyJobs.has(lane.id));
    if (part !== "all")
        selected = selected.filter((lane) => {
            if (lane.id === "preflight") return true;
            return area(lane.id) === part;
        });
    if (base) {
        const diff = Bun.spawnSync(["git", "diff", "--name-only", base, "--"], { cwd: root });
        if (diff.exitCode) throw new Error(diff.stderr.toString());
        const files = diff.stdout.toString().trim().split("\n").filter(Boolean);
        // Only public prose-only diffs are provably independent of runtime behavior.
        // All source/config/script changes retain the complete graph, including cross-language oracles.
        if (
            files.length &&
            files.every((file) => file.startsWith("docs/") && file.endsWith(".md"))
        ) {
            selected = selected.filter((lane) =>
                ["preflight", "check-docs-layout"].includes(lane.id),
            );
        }
    }
    const allSelected = [...selected];
    for (const lane of selected) {
        for (const producer of laneDependencies(lane)) {
            if (!selected.some((candidate) => candidate.id === producer))
                throw new Error(
                    `Selected job ${lane.id} requires unselected dependency ${producer}`,
                );
        }
    }
    if (plan) {
        for (const lane of selected) {
            console.log(lane.key);
            for (const step of lane.job.steps) {
                if (
                    step.run &&
                    !githubOnly.has(step.name ?? "") &&
                    condition(step.if, lane.matrix, false, true)
                )
                    console.log(`  ${expand(step.run, lane.matrix)}`);
            }
        }
        return;
    }
    const started = Date.now();
    const cpus = cpuBudget(process.env.GATE_CPUS);
    const run = join(root, "target/gate", `${Date.now()}-${process.pid}`);
    await mkdir(run, { recursive: true });
    const nodeMajor =
        mode === "smoke"
            ? ""
            : String(
                  workflow.jobs.preflight?.steps.find((step) =>
                      step.uses?.startsWith("actions/setup-node@"),
                  )?.with?.["node-version"] ?? "",
              );
    const prerequisiteMode =
        mode === "full" &&
        !selected.some((lane) => !["preflight", "check-docs-layout"].includes(lane.id))
            ? "preflight"
            : mode!;
    const nextest =
        prerequisiteMode === "full" && ["all", "native"].includes(part)
            ? workflow.jobs["rust-lib-archive"]?.steps
                  .find((step) => step.uses?.startsWith("taiki-e/install-action@"))
                  ?.with?.tool?.match(/^cargo-nextest@(.+)$/)?.[1]
            : "";
    if (mode !== "smoke" && !/^\d+$/.test(nodeMajor))
        throw new Error("CI must declare a literal Node major for local prerequisite verification");
    if (prerequisiteMode === "full" && ["all", "native"].includes(part) && !nextest)
        throw new Error(
            "CI must declare the cargo-nextest version for local prerequisite verification",
        );
    const testToolsPath = await prepareTestTools(
        root,
        prerequisiteMode,
        part,
        nodeMajor,
        nextest ?? "",
    );
    const sha = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root }).stdout.toString().trim();
    const results = new Map<string, boolean>();
    const records: Array<{
        lane: string;
        check: string;
        command: string;
        ok: boolean;
        seconds: number;
        log: string;
    }> = [];
    const active = new Map<string, { promise: Promise<void>; cpu: number; lock: string }>();
    const workspaceWriter = serializeTasks();
    let nativeReady: Promise<void> | undefined;
    let preflightOK = true;
    let distsReady = false;

    async function execute(lane: Lane) {
        const budget = new JobBudget(workflowTimeoutMs(lane.job));
        const temp = join(run, lane.key);
        await mkdir(temp, { recursive: true });
        // A HOME inside the checkout resolves to that project instead of a directory fallback.
        // Keep runtime homes outside any .git ancestor, as on CI.
        const home = await createTestHome();
        const env: Record<string, string> = Object.fromEntries(
            Object.entries(process.env).filter(
                (item): item is [string, string] => item[1] !== undefined,
            ),
        );
        // Match GitHub's workspace-local Cargo targets; some integration fixtures resolve binaries there.
        delete env.CARGO_TARGET_DIR;
        Object.assign(env, {
            HOME: home,
            CARGO_HOME: process.env.CARGO_HOME ?? join(process.env.HOME!, ".cargo"),
            RUSTUP_HOME: process.env.RUSTUP_HOME ?? join(process.env.HOME!, ".rustup"),
            GITHUB_WORKSPACE: root,
            GITHUB_SHA: sha,
            RUNNER_TEMP: temp,
            GITHUB_ENV: join(temp, "env"),
            GITHUB_PATH: join(temp, "path"),
            GITHUB_OUTPUT: join(temp, "output"),
            GITHUB_STEP_SUMMARY: join(temp, "summary"),
            GATE_DAEMON_CARGO_HOME: join(run, "cargo-home-daemon"),
            GATE_CPUS: String(cpus),
            // Build-server checkout copies can be root-owned. Preserve Git access after isolating HOME.
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "safe.directory",
            GIT_CONFIG_VALUE_0: root,
            UNIT_JUNIT_FILE: join(temp, "unit-junit.xml"),
            CARGO_BUILD_JOBS: String(Math.min(8, cpus)),
            RUST_TEST_THREADS: String(Math.min(4, cpus)),
            NEXTEST_TEST_THREADS: String(Math.min(4, cpus)),
        });
        if (testToolsPath && lane.id !== "preflight") env.PATH = `${testToolsPath}:${env.PATH}`;
        for (const [key, value] of Object.entries((mode === "smoke" ? smoke : workflow).env ?? {}))
            env[key] = expand(String(value), lane.matrix, root, temp);
        for (const [key, value] of Object.entries(lane.job.env ?? {}))
            env[key] = expand(value, lane.matrix, root, temp);
        for (const file of [
            env.GITHUB_ENV!,
            env.GITHUB_PATH!,
            env.GITHUB_OUTPUT!,
            env.GITHUB_STEP_SUMMARY!,
        ])
            await Bun.write(file, "");
        let failed = false;
        async function check(
            name: string,
            command: string,
            extra: Record<string, string> = {},
            checkEnv = env,
        ) {
            const operation = async () => {
                const log = join(
                    temp,
                    `${records.length}-${name.replace(/[^a-z0-9]+/gi, "-")}.log`,
                );
                const before = Date.now();
                const invocation = budgetedCommand(command, budget);
                const output = openSync(log, "w");
                const child = Bun.spawn(invocation, {
                    cwd: root,
                    env: { ...checkEnv, ...extra },
                    stdout: output,
                    stderr: output,
                });
                const exit = await child.exited;
                const ok = exit === 0 && !budget.expired();
                closeSync(output);
                const seconds = (Date.now() - before) / 1000;
                records.push({ lane: lane.key, check: name, command, ok, seconds, log });
                console.log(
                    `${ok ? "PASS" : "FAIL"} ${lane.key}: ${name} (${seconds.toFixed(1)}s) ${log}`,
                );
                if (!ok) failed = true;
                return ok;
            };
            return writesWorkspace(command, lane.id) ? workspaceWriter(operation) : operation();
        }
        try {
            if (["e2e-rust-hermetic-build", "rust-mc-module-integration"].includes(lane.id)) {
                nativeReady ??= (async () => {
                    if (
                        !(await check(
                            "Prepare locked daemon source",
                            "bash scripts/gate-native-source.sh",
                        ))
                    )
                        throw new Error("locked daemon source unavailable");
                })();
                await nativeReady;
            }
            if (["e2e-rust-hermetic", "rust-raw-replay-review"].includes(lane.id)) {
                const artifact = join(
                    temp,
                    lane.id === "e2e-rust-hermetic" ? "hermetic-artifact" : "raw-replay-download",
                );
                await mkdir(artifact, { recursive: true });
                const producer = join(run, "e2e-rust-hermetic-build");
                for (const name of [
                    "rust-hermetic-binaries.tar.gz",
                    "rust-hermetic-binaries.sha256",
                ])
                    await copyFile(join(producer, name), join(artifact, name));
            }
            const runSteps = async (
                steps: Step[],
                groupEnv: Record<string, string>,
            ): Promise<boolean> => {
                let sequenceFailed = false;
                let restored = false;
                try {
                    for (const step of steps) {
                        budget.remaining();
                        if (
                            step.uses &&
                            (!localActions.has(step.uses) ||
                                (step.with?.repository &&
                                    step.with.repository !== "cortexkit/subconscious"))
                        )
                            throw new Error(
                                `Local implementation required for workflow action: ${step.uses}`,
                            );
                        if (!condition(step.if, lane.matrix, sequenceFailed, restored)) continue;
                        if (step.uses === "./.github/actions/restore-ci-dists") {
                            if (!distsReady)
                                throw new Error(
                                    "Dist production did not succeed; stale outputs cannot be consumed",
                                );
                            const now = new Date();
                            await utimes(join(root, "packages/plugin/dist/index.js"), now, now);
                            restored = true;
                        }
                        if (!step.run || githubOnly.has(step.name ?? "")) continue;
                        const extra = Object.fromEntries(
                            Object.entries(step.env ?? {}).map(([key, value]) => [
                                key,
                                expand(value, lane.matrix, root, groupEnv.RUNNER_TEMP),
                            ]),
                        );
                        if (
                            !(await check(
                                step.name ?? step.run,
                                expand(step.run, lane.matrix, root, groupEnv.RUNNER_TEMP),
                                extra,
                                groupEnv,
                            ))
                        )
                            sequenceFailed = true;
                        // Each parallel group has its own handoff files, while sequential steps retain their environment.
                        for (const line of (await readFile(groupEnv.GITHUB_ENV!, "utf8"))
                            .split("\n")
                            .filter(Boolean)) {
                            const equals = line.indexOf("=");
                            if (equals < 1 || line.includes("<<"))
                                throw new Error(`Unsupported GITHUB_ENV record: ${line}`);
                            groupEnv[line.slice(0, equals)] = line.slice(equals + 1);
                        }
                        const paths = (await readFile(groupEnv.GITHUB_PATH!, "utf8"))
                            .split("\n")
                            .filter(Boolean);
                        if (paths.length)
                            groupEnv.PATH = `${paths.reverse().join(":")}:${groupEnv.PATH}`;
                        await Bun.write(groupEnv.GITHUB_ENV!, "");
                        await Bun.write(groupEnv.GITHUB_PATH!, "");
                    }
                } catch (error) {
                    console.error(`FAIL ${lane.key}: ${error}`);
                    sequenceFailed = true;
                }
                if (sequenceFailed) failed = true;
                return !sequenceFailed;
            };
            if (lane.id === "preflight") {
                const outcome = await preflightGroups(lane.job.steps, async (steps, label) => {
                    if (label === "setup") return runSteps(steps, env);
                    const directory = join(temp, label);
                    await mkdir(directory, { recursive: true });
                    const groupEnv: Record<string, string> = { ...env, RUNNER_TEMP: directory };
                    for (const name of [
                        "GITHUB_ENV",
                        "GITHUB_PATH",
                        "GITHUB_OUTPUT",
                        "GITHUB_STEP_SUMMARY",
                    ]) {
                        groupEnv[name] = join(directory, name);
                        await Bun.write(groupEnv[name]!, "");
                    }
                    return runSteps(steps, groupEnv);
                });
                distsReady = outcome.distsReady;
                if (!outcome.ok) failed = true;
            } else {
                await runSteps(lane.job.steps, env);
            }
            if (budget.expired())
                throw new Error(
                    `Workflow job ${lane.key} exceeded its ${workflowTimeoutMs(lane.job) / 60_000}-minute timeout`,
                );
        } catch (error) {
            console.error(`FAIL ${lane.key}: ${error}`);
            failed = true;
        }
        results.set(lane.key, !failed);
    }

    // Preflight always runs whole; independent native producers still run if a static check failed.
    const preflight = selected.find((lane) => lane.id === "preflight");
    if (preflight) {
        await execute(preflight);
        preflightOK = results.get(preflight.key)!;
        selected = selected.filter((lane) => lane !== preflight);
    }
    const pending = [...selected];
    while (pending.length || active.size) {
        let launched = false;
        for (let index = 0; index < pending.length; ) {
            const lane = pending[index]!;
            const readiness = dependencyState(lane, allSelected, results, distsReady);
            if (readiness === "wait") {
                index++;
                continue;
            }
            if (readiness === "blocked") {
                console.error(`FAIL ${lane.key}: prerequisite production failed; lane not run`);
                results.set(lane.key, false);
                pending.splice(index, 1);
                continue;
            }
            const allocation = resources(lane.id);
            const cpu = Math.min(allocation.cpu, cpus);
            const { lock } = allocation;
            const running = [...active.values()];
            if (
                running.length >= 4 ||
                running.reduce((total, item) => total + item.cpu, 0) + cpu > cpus ||
                (lock && running.some((item) => item.lock === lock))
            ) {
                index++;
                continue;
            }
            pending.splice(index, 1);
            const promise = execute(lane).finally(() => active.delete(lane.key));
            active.set(lane.key, { promise, cpu, lock });
            launched = true;
        }
        if (active.size) await Promise.race([...active.values()].map((item) => item.promise));
        else if (pending.length && !launched) throw new Error("Local gate dependency deadlock");
    }
    const failed = [...results].filter(([, ok]) => !ok).map(([key]) => key);
    const summary = {
        mode,
        part,
        cpus,
        testToolsPath: testToolsPath ?? "system PATH",
        seconds: (Date.now() - started) / 1000,
        checks: records.length,
        passed: records.filter((item) => item.ok).length,
        failed,
        preflightOK,
        distsReady,
        records,
    };
    await Bun.write(join(run, "results.json"), `${JSON.stringify(summary, null, 2)}\n`);
    if (process.env.GATE_REPORT_PREFIX) {
        const prefix = resolve(root, process.env.GATE_REPORT_PREFIX);
        await Bun.write(`${prefix}.json`, `${JSON.stringify(summary, null, 2)}\n`);
        const evidence: string[] = [];
        for (const record of records) {
            const text = await readFile(record.log, "utf8");
            evidence.push(
                `\n## ${record.lane}: ${record.check} (${record.ok ? "PASS" : "FAIL"}, ${record.seconds.toFixed(1)}s)\n$ ${record.command}\n`,
            );
            evidence.push(
                record.ok
                    ? text
                          .split("\n")
                          .filter((line) =>
                              /pass|fail|error|warning|tests? |checked |packages|vectors|cases|matches|stale|drift|expected|received|actual|pinned|cargo home|skip|caused by|^\s*(left|right):|^PASS|^FAIL/i.test(
                                  line,
                              ),
                          )
                          .join("\n")
                    : text,
            );
        }
        await Bun.write(`${prefix}.txt`, `${evidence.join("\n")}\n`);
    }
    console.log(
        `Gate ${mode}: ${results.size - failed.length}/${results.size} lanes passed; ${summary.passed}/${records.length} checks passed; ${summary.seconds.toFixed(1)}s. Results: ${run}/results.json`,
    );
    console.log(
        "GitHub-only: the Docker lanes listed above, artifact upload/download/wait, cache service, status aggregation, and scheduled upstream-HEAD drift. Local runs use same-checkout producer outputs and the Cargo.lock daemon revision. Slow units run in both modes even on a fast-push checkout. Smoke uses HTTP, not Docker, and runs locally via the smoke target.",
    );
    process.exitCode = failed.length ? 1 : 0;
}

if (import.meta.main)
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
