import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
    area,
    ciOnlyJobs,
    condition,
    dependencies,
    expand,
    githubOnly,
    lanes,
    resources,
} from "./gate";

const root = resolve(import.meta.dir, "..");
const workflow = Bun.YAML.parse(await Bun.file(join(root, ".github/workflows/ci.yml")).text()) as {
    jobs: Parameters<typeof lanes>[0];
};

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
        ),
    ).toBe(true);
    expect(condition("${{ !cancelled() && matrix.shard == 0 }}", { shard: 1 }, false)).toBe(false);
    expect(() => condition("${{ success() }}", {}, false)).toThrow("Unsupported");
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
    expect(resources("rust-mc-module-lib").lock).toBe("nextest-junit");
    expect(resources("rust-lib-archive").lock).toBe(resources("rust-clippy").lock);
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

test("root Bun test arguments select exact paths rather than matching archived scratch copies", async () => {
    const compiled = await Bun.file(
        join(root, "scripts/ci/preflight-check-compiled-contracts.sh"),
    ).text();
    const pins = await Bun.file(join(root, "scripts/ci/preflight-pins-and-lockfiles.sh")).text();
    expect(compiled).toContain("bun test ./packages/e2e-tests/scripts/ci-dists.test.ts");
    expect(pins).toContain("bun test ./packages/e2e-tests/tests/opencode2/pins.test.ts");
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
