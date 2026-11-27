import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { filesForMode, selectHostFiles, selectRustShard } from "./mode-selection";
import type { Host, ValidationResult } from "./validate-mode-manifest";

type Job = {
    if?: unknown;
    strategy?: { matrix?: { shard?: number[] } };
    steps?: { run?: string; if?: unknown }[];
};

export interface CiSources {
    workflows: ReadonlyMap<string, string>;
    read: (path: string) => string | undefined;
}

const CI = ".github/workflows/ci.yml";
const RELEASE = ".github/workflows/release.yml";
const WORKFLOW_DIR = ".github/workflows";
const WORKFLOW_PATH = /^\.github\/workflows\/[\w.-]+\.ya?ml$/;
const SCRIPT_PATH = /^scripts\/ci\/[\w.-]+\.sh$/;
const HOST_SHARD_SELECTOR = "scripts/select-host-shard.ts";
const MANIFEST_SELECTOR = "scripts/validate-mode-manifest.ts";
const RUST_RUNNER = "scripts/run-rust-hermetic-e2e.sh";

export function readCiSources(root: string): CiSources {
    const read = (path: string) => {
        try {
            return readFileSync(join(root, path), "utf8");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
    };
    const workflows = new Map<string, string>();
    for (const name of readdirSync(join(root, WORKFLOW_DIR))) {
        const path = `${WORKFLOW_DIR}/${name}`;
        if (WORKFLOW_PATH.test(path)) workflows.set(path, read(path)!);
    }
    return { workflows, read };
}

function literal(source: string, value: string): boolean {
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[\\s'"(])(?:\\./)?${escaped}(?=$|[\\s'";)|&])`, "m")
        .test(source.replace(/^\s*#.*$/gm, ""));
}

function commands(job: Job | undefined): string[] {
    if (job?.if === false) return [];
    return (job?.steps ?? []).flatMap((step) =>
        typeof step.run === "string" && step.if !== false ? [step.run] : [],
    );
}

function shardSpecs(job: Job, name: string): string[] {
    const shards = job.strategy?.matrix?.shard;
    if (!Array.isArray(shards) || shards.length === 0 ||
        shards.some((shard, index) => shard !== index)) {
        throw new Error(`${name}: expected a contiguous, zero-based CI shard matrix`);
    }
    return shards.map((shard) => `${shard}/${shards.length}`);
}

export function ciModeCoverage(validation: ValidationResult, sources: CiSources): Set<string> {
    const workflows = new Map([...sources.workflows].map(([path, yaml]) => {
        const result = Bun.YAML.parse(yaml) as { jobs?: Record<string, Job> } | null;
        return [path, result?.jobs ?? {}];
    }));
    const ci = workflows.get(CI);
    const release = workflows.get(RELEASE);
    const allCommands = [...workflows.values()].flatMap((jobs) => Object.values(jobs).flatMap(commands));
    const runner = sources.read(RUST_RUNNER) ?? "";
    const covered = new Set<string>();
    const add = (files: string[]) => { for (const file of files) covered.add(file); };
    const invokes = (job: Job | undefined, path: string) => commands(job).some((run) => literal(run, path));
    const hostScripts = {
        opencode: "e2e-host-opencode-run-host-e2e-suite-opencode-tests-only.sh",
        opencode2: "e2e-host-opencode2-run-host-e2e-suite-opencode-2-tests-from-mode-manifest.sh",
        pi: "e2e-host-pi-run-host-e2e-suite-pi-tests-from-mode-manifest.sh",
        omp: "e2e-host-omp-run-host-e2e-suite-omp-tests-from-mode-manifest.sh",
    } as const;

    for (const host of Object.keys(hostScripts) as Host[]) {
        const id = `e2e-host-${host}`;
        const job = ci?.[id];
        const script = `scripts/ci/${hostScripts[host]}`;
        const wrapper = invokes(job, script) ? sources.read(script) ?? "" : "";
        if (job && (host === "opencode" || host === "opencode2") &&
            literal(wrapper, HOST_SHARD_SELECTOR) && literal(wrapper, host)) {
            const specs = shardSpecs(job, id);
            // The wrapper appends the denominator to the index from the matrix.
            // A smaller matrix alone can leave whole files in an unstarted shard.
            if (!wrapper.includes(`/${specs.length}"`)) throw new Error(`${id}: host wrapper and CI shard count disagree`);
            for (const spec of specs) add(selectHostFiles(validation, host, spec));
        }
        const selectsHost = (run: string) => literal(run, MANIFEST_SELECTOR) && literal(run, `--mode ts --harness ${host}`);
        if (selectsHost(wrapper) || commands(release?.[id]).some(selectsHost)) add(filesForMode(validation, "ts", host));
    }
    const rustJob = ci?.["e2e-rust-hermetic"];
    const rustScript = "scripts/ci/e2e-rust-hermetic-run-manifest-shard.sh";
    if (rustJob && invokes(rustJob, rustScript) && literal(sources.read(rustScript) ?? "", RUST_RUNNER) &&
        literal(runner, "$E2E_DIR/scripts/select-rust-shard.ts")) {
        for (const spec of shardSpecs(rustJob, "e2e-rust-hermetic")) {
            add(selectRustShard(filesForMode(validation, "rust"), spec));
        }
    }
    if (invokes(release?.["e2e-rust-hermetic"], RUST_RUNNER) && literal(runner, "--mode rust --harness all")) {
        add(filesForMode(validation, "rust"));
    }

    // Tests with runs_in name the CI file that invokes them. A test path in
    // an unused helper script does not demonstrate that a workflow runs it.
    for (const { path, runs_in: sourcePath } of validation.manifest.entries) {
        if (sourcePath === undefined) continue;
        const namesTest = (text: string) => literal(text, path) || literal(text, `packages/e2e-tests/${path}`);
        if (WORKFLOW_PATH.test(sourcePath)) {
            const jobs = workflows.get(sourcePath);
            if (!jobs) throw new Error(`${path}: runs_in workflow does not exist: ${sourcePath}`);
            if (!Object.values(jobs).flatMap(commands).some(namesTest)) {
                throw new Error(`${path}: runs_in workflow does not name the test: ${sourcePath}`);
            }
        } else if (SCRIPT_PATH.test(sourcePath)) {
            const script = sources.read(sourcePath);
            if (script === undefined) throw new Error(`${path}: runs_in script does not exist: ${sourcePath}`);
            if (!namesTest(script)) throw new Error(`${path}: runs_in script does not name the test: ${sourcePath}`);
            if (!allCommands.some((run) => literal(run, sourcePath)) && !literal(sources.read("scripts/gate.sh") ?? "", sourcePath)) {
                throw new Error(`${path}: runs_in script is not referenced by a workflow or scripts/gate.sh: ${sourcePath}`);
            }
        } else throw new Error(`${path}: runs_in must name a workflow or a scripts/ci/*.sh script`);
        covered.add(path);
    }
    return covered;
}
