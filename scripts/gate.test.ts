import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
    area,
    budgetedCommand,
    ciOnlyJobs,
    condition,
    cpuBudget,
    dependencies,
    dependencyState,
    expand,
    githubOnly,
    JobBudget,
    laneDependencies,
    lanes,
    preflightGroups,
    resources,
    serializeTasks,
    workflowTimeoutMs,
    writesWorkspace,
} from "./gate";

const root = resolve(import.meta.dir, "..");
const workflow = Bun.YAML.parse(await Bun.file(join(root, ".github/workflows/ci.yml")).text()) as {
    jobs: Parameters<typeof lanes>[0];
};

test("full gate fits an eight-core slot by default and uses sixteen only explicitly", () => {
    expect(cpuBudget()).toBe(8);
    expect(cpuBudget("4")).toBe(4);
    expect(cpuBudget("16")).toBe(16);
    for (const value of ["1", "17", "NaN", "3.5"])
        expect(() => cpuBudget(value)).toThrow("GATE_CPUS");
});

test("shared workspace installs and package wrappers serialize without blocking after a rejection", async () => {
    const serial = serializeTasks();
    let active = 0;
    let peak = 0;
    const results = await Promise.all(
        [0, 1, 2, 3].map((number) =>
            serial(async () => {
                active++;
                peak = Math.max(peak, active);
                await Bun.sleep(2);
                active--;
                return number;
            }),
        ),
    );
    expect(results).toEqual([0, 1, 2, 3]);
    expect(peak).toBe(1);
    await expect(
        serial(async () => {
            throw new Error("install failed");
        }),
    ).rejects.toThrow("install failed");
    expect(await serial(async () => "next install ran")).toBe("next install ran");
    expect(writesWorkspace("bun install --frozen-lockfile\n", "e2e-rust-hermetic")).toBe(true);
    expect(writesWorkspace("bash scripts/ci/unit.sh", "unit-plugin")).toBe(true);
    expect(writesWorkspace("bash scripts/ci/slow.sh", "slow-unit")).toBe(true);
    expect(writesWorkspace("bun install --cwd target/private-host", "e2e-host-opencode2")).toBe(
        false,
    );
    expect(writesWorkspace("cargo test", "rust-workspace-crates")).toBe(false);
});

test("local full expands CI's matrices, including both slow modes and every Rust shard", () => {
    const full = lanes(workflow.jobs);
    expect(full.filter((lane) => lane.id === "unit-plugin")).toHaveLength(8);
    expect(full.filter((lane) => lane.id === "unit-pi-plugin")).toHaveLength(8);
    expect(full.filter((lane) => lane.id === "slow-unit").map((lane) => lane.matrix.mode)).toEqual([
        "normal",
        "assertions",
    ]);
    expect(
        full.filter((lane) => lane.id === "e2e-rust-hermetic").map((lane) => lane.matrix.shard),
    ).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(
        full.filter((lane) => lane.id === "rust-mc-module-lib").map((lane) => lane.matrix.shard),
    ).toEqual([1, 2, 3, 4]);
    expect(
        full.filter((lane) => lane.id === "e2e-host-opencode2").map((lane) => lane.matrix.version),
    ).toEqual(["2.0.22", "2.1.0", "2.0.22", "2.1.0"]);
    expect(full.some((lane) => lane.id === "rust-raw-replay-review")).toBe(true);
});

test("matrix substitutions and once-only checks fail closed on unknown workflow syntax", () => {
    expect(expand('bash shard.sh "${{ matrix.shard }}"', { shard: 3 })).toBe('bash shard.sh "3"');
    expect(() => expand("${{ matrix.missing }}", {})).toThrow("Unsupported");
    expect(condition(undefined, {}, true)).toBe(false);
    expect(condition("${{ !cancelled() }}", {}, true)).toBe(true);
    expect(
        condition(
            "${{ !cancelled() && matrix.shard == 0 && steps.dists.outcome == 'success' }}",
            { shard: 0 },
            true,
            true,
        ),
    ).toBe(true);
    expect(condition("${{ !cancelled() && matrix.shard == 0 }}", { shard: 1 }, false)).toBe(false);
    expect(() => condition("${{ success() }}", {}, false)).toThrow("Unsupported");
    // Local runs are never the scheduled drift run; a failure still skips the step.
    expect(condition("${{ github.event_name != 'schedule' }}", {}, false)).toBe(true);
    expect(condition("${{ github.event_name == 'schedule' }}", {}, false)).toBe(false);
    expect(condition("${{ github.event_name != 'schedule' }}", {}, true)).toBe(false);
    expect(() => condition("${{ github.event_name != 'push' }}", {}, false)).toThrow("Unsupported");
    expect(
        condition("${{ !cancelled() && steps.dists.outcome == 'success' }}", {}, false, false),
    ).toBe(false);
    expect(
        condition("${{ !cancelled() && steps.dists.outcome == 'success' }}", {}, true, true),
    ).toBe(true);
});

test("every non-transport CI check is runnable locally and shared scripts have no Actions expressions", async () => {
    const files = new Set<string>();
    for (const lane of lanes(workflow.jobs)) {
        for (const step of lane.job.steps) {
            if (!step.run || githubOnly.has(step.name ?? "")) continue;
            expand(step.run, lane.matrix, root, "target/test-temp");
            const match = step.run.match(/^bash (scripts\/ci\/[\w-]+\.sh)/);
            if (match) files.add(match[1]!);
            else if (step.run.trim() !== "bun install --frozen-lockfile")
                expect([
                    "Reject tracked ignored CortexKit files",
                    "Reject internal documentation in docs",
                    "Exercise planted layout violations",
                    "Verify archive provenance",
                    "Restore executable and auxiliary binaries",
                    "Restore staged native driver",
                    "Fetch pinned master baseline",
                ]).toContain(step.name ?? step.run);
        }
    }
    expect(files.size).toBeGreaterThan(35);
    for (const path of files) expect(await Bun.file(join(root, path)).text()).not.toContain("${{");
});

test("local producer dependencies and writable output locks preserve the CI handoffs", () => {
    expect(dependencies("rust-mc-module-lib")).toEqual(["rust-lib-archive"]);
    expect(dependencies("rust-raw-replay-review")).toEqual(["e2e-rust-hermetic-build"]);
    expect(dependencies("e2e-rust-hermetic")).toEqual(["e2e-rust-hermetic-build"]);
    expect(dependencies("rust-mc-module-integration")).toEqual([]);
    expect(resources("rust-mc-module-lib").lock).toBe("nextest-junit");
    expect(resources("rust-lib-archive").lock).toBe(resources("rust-clippy").lock);
});

test("workflow job timeouts are shared across commands instead of resetting per step", () => {
    expect(workflowTimeoutMs({ name: "default", steps: [] })).toBe(360 * 60_000);
    expect(workflowTimeoutMs({ name: "CI cap", steps: [], "timeout-minutes": 10 })).toBe(600_000);
    for (const minutes of [0, -1, 1.5, 361])
        expect(() =>
            workflowTimeoutMs({ name: "invalid", steps: [], "timeout-minutes": minutes }),
        ).toThrow("timeout-minutes");
    let time = 0;
    const budget = new JobBudget(1000, () => time);
    expect(budgetedCommand("first", budget)[2]).toBe("1.000s");
    time = 700;
    expect(budgetedCommand("second", budget)[2]).toBe("0.300s");
    time = 999.9;
    expect(budgetedCommand("last fraction", budget)[2]).toBe("0.001s");
    time = 1000;
    expect(budget.expired()).toBe(true);
    expect(() => budgetedCommand("must not start", budget)).toThrow("budget exhausted");
});

test("unknown job-level conditions and uninterpretable needs fail before execution", () => {
    expect(() =>
        lanes({
            surprise: { name: "surprise", if: "${{ github.event_name == 'push' }}", steps: [] },
        }),
    ).toThrow("Unsupported local job condition");
    expect(() =>
        lanes({ surprise: { name: "surprise", needs: "${{ inputs.producer }}", steps: [] } }),
    ).toThrow("Unsupported local job needs");
    expect(() => lanes({ surprise: { name: "surprise", needs: ["missing"], steps: [] } })).toThrow(
        "Unknown job dependency",
    );
    const jobs = lanes({
        producer: { name: "producer", steps: [] },
        consumer: { name: "consumer", needs: "producer", steps: [] },
    });
    const consumer = jobs.find((lane) => lane.id === "consumer")!;
    expect(laneDependencies(consumer)).toEqual(["producer"]);
    expect(dependencyState(consumer, jobs, new Map(), false)).toBe("wait");
    expect(dependencyState(consumer, jobs, new Map([["producer", false]]), false)).toBe("blocked");
    expect(dependencyState(consumer, jobs, new Map([["producer", true]]), false)).toBe("ready");
});

test("failed dist production cannot feed consumers, while unrelated static failures do not suppress good dists", async () => {
    const jobs = lanes({
        preflight: { name: "preflight", steps: [] },
        consumer: { name: "consumer", steps: [{ uses: "./.github/actions/restore-ci-dists" }] },
        docs: { name: "docs", needs: ["preflight"], steps: [] },
    });
    const consumer = jobs.find((lane) => lane.id === "consumer")!;
    const docs = jobs.find((lane) => lane.id === "docs")!;
    const staticsFailed = new Map([["preflight", false]]);
    expect(dependencyState(consumer, jobs, staticsFailed, false)).toBe("blocked");
    expect(dependencyState(consumer, jobs, staticsFailed, true)).toBe("ready");
    expect(dependencyState(docs, jobs, staticsFailed, true)).toBe("blocked");
    const outcome = await preflightGroups(
        workflow.jobs.preflight!.steps,
        async (_steps, label) => label !== "dists",
    );
    expect(outcome).toEqual({ ok: false, distsReady: false });
    const staticFailure = await preflightGroups(
        workflow.jobs.preflight!.steps,
        async (_steps, label) => !label.startsWith("independent"),
    );
    expect(staticFailure).toEqual({ ok: false, distsReady: true });
});

test("preflight overlaps independent checks but keeps generated-output readers after the producer", async () => {
    const events: string[] = [];
    await preflightGroups(workflow.jobs.preflight!.steps, async (_steps, label) => {
        events.push(`start:${label}`);
        await Bun.sleep(label === "dists" ? 15 : 1);
        events.push(`end:${label}`);
        return true;
    });
    expect(events.indexOf("start:independent-0")).toBeLessThan(events.indexOf("end:dists"));
    expect(events.indexOf("start:after-build-0")).toBeGreaterThan(events.indexOf("end:dists"));
});

test("split full parts partition the CI graph and only the four Docker lanes are CI-only", () => {
    expect([...ciOnlyJobs.keys()].sort()).toEqual([
        "e2e-omp",
        "e2e-opencode",
        "e2e-opencode2",
        "e2e-pi",
    ]);
    for (const lane of lanes(workflow.jobs))
        expect(["unit", "native", "host"]).toContain(area(lane.id));
    expect(area("rust-raw-replay-review")).toBe("native");
    expect(area("e2e-rust-hermetic")).toBe("native");
    expect(area("e2e-host-opencode2")).toBe("host");
    expect(area("slow-unit")).toBe("unit");
    expect(area("check-dashboard")).toBe("unit");
});

test("shared Bun checks select exact package paths rather than archived scratch copies", async () => {
    const compiled = await Bun.file(
        join(root, "scripts/ci/preflight-check-compiled-contracts.sh"),
    ).text();
    const pins = await Bun.file(join(root, "scripts/ci/preflight-pins-and-lockfiles.sh")).text();
    expect(compiled).toContain("cd packages/e2e-tests");
    expect(compiled).toContain("bun test ./scripts/ci-dists.test.ts");
    expect(pins).toContain("cd packages/e2e-tests");
    expect(pins).toContain("bun test ./tests/opencode2/pins.test.ts");
});

async function scratch<T>(body: (path: string) => Promise<T>): Promise<T> {
    await mkdir(join(root, "target/scratch"), { recursive: true });
    const path = await mkdtemp(join(root, "target/scratch/gate-test-"));
    try {
        return await body(path);
    } finally {
        await rm(path, { recursive: true, force: true });
    }
}

test("independent preflight checks continue after a failure and return nonzero", async () =>
    scratch(async (path) => {
        const command = `source scripts/ci/checks.sh; check broken bash -c 'exit 7'; check later printf reached; exit "$status"`;
        const child = Bun.spawn(["bash", "-euo", "pipefail", "-c", command], {
            cwd: root,
            stdout: "pipe",
            stderr: "pipe",
        });
        expect(await child.exited).toBe(1);
        expect(await new Response(child.stdout).text()).toContain("reachedPASS later");
        expect(await new Response(child.stderr).text()).toContain("FAIL broken (exit 7)");
        expect(path).toContain("gate-test-");
    }));

for (const selection of ["empty", "failed", "selected"]) {
    test(`unit wrapper refuses ${selection} selectors unless a file was selected`, async () =>
        scratch(async (path) => {
            const mock = join(path, "bun");
            await Bun.write(
                mock,
                `#!/bin/bash\nif [[ "$1" == *select-unit-shard.ts ]]; then\n case "$SELECT" in empty) exit 0;; failed) exit 9;; selected) echo ./src/example.test.ts;; esac\nelse\n printf '%s\\n' "$MAGIC_CONTEXT_DEBUG_ASSERTIONS $*" > "$CAPTURE"\nfi\n`,
            );
            const chmod = Bun.spawnSync(["chmod", "+x", mock]);
            expect(chmod.exitCode).toBe(0);
            const capture = join(path, "capture");
            const child = Bun.spawn(
                ["bash", "scripts/ci/unit-plugin-run-whole-file-plugin-shard.sh", "2"],
                {
                    cwd: root,
                    env: {
                        ...process.env,
                        PATH: `${path}:${process.env.PATH}`,
                        SELECT: selection,
                        CAPTURE: capture,
                        UNIT_MODE: "assertions",
                        RUNNER_TEMP: path,
                        GITHUB_WORKSPACE: root,
                    },
                    stdout: "pipe",
                    stderr: "pipe",
                },
            );
            const code = await child.exited;
            if (selection === "selected") {
                expect(code).toBe(0);
                expect(await Bun.file(capture).text()).toContain(
                    "1 run --cwd packages/plugin test",
                );
                expect(await Bun.file(capture).text()).toContain("./src/example.test.ts");
            } else {
                expect(code).not.toBe(0);
                expect(await Bun.file(capture).exists()).toBe(false);
            }
        }));
}

for (const probe of ["hit", "miss"]) {
    test(`daemon Cargo cache ${probe} preserves the module home and chooses a locked graph`, async () =>
        scratch(async (path) => {
            const bin = join(path, "cargo");
            await Bun.write(
                bin,
                '#!/bin/bash\nif [[ "$*" == "fetch --locked --offline" ]]; then [[ "$PROBE" == hit ]]; else [[ "$*" == "fetch --locked" ]] || exit 8; printf "%s" "$CARGO_HOME" > "$CAPTURE"; fi\n',
            );
            expect(Bun.spawnSync(["chmod", "+x", bin]).exitCode).toBe(0);
            const selected = join(path, "daemon-home");
            const capture = join(path, "fetch-home");
            const child = Bun.spawn(
                [
                    "bash",
                    "-euo",
                    "pipefail",
                    "-c",
                    'source scripts/ci/daemon-cargo-home.sh; prepare_daemon_cargo_home "$RUNNER_TEMP"; printf "SELECTED=%s\\nMODULE=%s\\n" "$DAEMON_CARGO_HOME" "$CARGO_HOME"',
                ],
                {
                    cwd: root,
                    env: {
                        ...process.env,
                        PATH: `${path}:${process.env.PATH}`,
                        PROBE: probe,
                        CAPTURE: capture,
                        CARGO_HOME: "shared-module-home",
                        RUNNER_TEMP: path,
                        GATE_DAEMON_CARGO_HOME: selected,
                    },
                    stdout: "pipe",
                    stderr: "pipe",
                },
            );
            const output = await new Response(child.stdout).text();
            expect(await child.exited).toBe(0);
            expect(output).toContain("MODULE=shared-module-home");
            if (probe === "hit") {
                expect(output).toContain("SELECTED=shared-module-home");
                expect(await Bun.file(capture).exists()).toBe(false);
            } else {
                expect(output).toContain(`SELECTED=${selected}`);
                expect(await Bun.file(capture).text()).toBe(selected);
            }
        }));
}

test("package typechecks overlap and still collect every result after a failure", async () =>
    scratch(async (path) => {
        const barrier = join(path, "barrier");
        await mkdir(barrier);
        const mock = join(path, "bun");
        await Bun.write(
            mock,
            `#!/bin/bash
if [[ "$*" == *tsconfig.build.json* ]]; then exit 0; fi
package="$3"
touch "$BARRIER/\${package##*/}"
for ((attempt=0; attempt<200; attempt++)); do
  shopt -s nullglob
  files=("$BARRIER"/*)
  if [[ "\${#files[@]}" == 6 ]]; then
    [[ "$package" == packages/cli ]] && exit 7
    exit 0
  fi
  sleep 0.01
done
exit 8
`,
        );
        expect(Bun.spawnSync(["chmod", "+x", mock]).exitCode).toBe(0);
        const child = Bun.spawn(["bash", "scripts/ci/preflight-typescript-typecheck.sh"], {
            cwd: root,
            env: {
                ...process.env,
                PATH: `${path}:${process.env.PATH}`,
                BARRIER: barrier,
                RUNNER_TEMP: path,
                TYPECHECK_JOBS: "6",
            },
            stdout: "pipe",
            stderr: "pipe",
        });
        const [code, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
        ]);
        expect(code).toBe(1);
        expect(stderr).toContain("FAIL typecheck cli (exit 7)");
        for (const packageName of [
            "plugin",
            "retina-local-fs",
            "pi-plugin",
            "dashboard",
            "e2e-tests",
        ])
            expect(stdout).toContain(`PASS typecheck ${packageName}`);
    }));
