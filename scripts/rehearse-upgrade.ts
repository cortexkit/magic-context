import { spawnSync } from "node:child_process";
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
    firstDifference,
    hashFile,
    integrity,
    inventory,
    schemaDigest,
    snapshotRoot,
    version,
} from "./lib/upgrade-audit";
import {
    assertDoctor,
    assertFullDoctorTarget,
    assertEffects,
    assertMigrationMetrics,
    newest049,
    type MigrationMetric,
} from "./lib/upgrade-contract";
import { assertApplicationSchema } from "./lib/upgrade-schema";
import type { PayloadProof } from "./lib/upgrade-payloads";
import { isolatedEnvironment } from "./lib/upgrade-isolation";

const repo = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
if (args.includes("--help")) {
    console.log(
        "bun scripts/rehearse-upgrade.ts [--snapshot <offline-context-directory>] [--report <markdown-path>]\nRequires Linux, Bun, npm, Cargo and GNU /usr/bin/time, with network access. Synthetic mode packs the newest released 0.49.x OpenCode and Pi plugins from npm. Stores and hosts are isolated under $TMPDIR/magic-context/rehearsal-early/run-*/. Never send private snapshots to a build server.",
    );
    process.exit(0);
}
for (let i = 0; i < args.length; i += 2) {
    if (
        !["--snapshot", "--report"].includes(args[i]) ||
        !args[i + 1] ||
        args[i + 1].startsWith("--")
    )
        throw new Error(`Unknown or incomplete option: ${args[i]}`);
}
const option = (name: string) => {
    const i = args.indexOf(name);
    return i < 0 ? undefined : args[i + 1];
};
const snapshot = option("--snapshot") ? snapshotRoot(option("--snapshot")!) : undefined;
const parent = join(tmpdir(), "magic-context", "rehearsal-early");
mkdirSync(parent, { recursive: true });
const root = realpathSync(mkdtempSync(join(parent, "run-")));
const baseline = join(root, "baseline");
const release = join(root, "release");
const env = isolatedEnvironment(root, baseline);
// Dependency caches are build inputs; runtime HOME and every host path remain private.
env.CARGO_HOME = process.env.CARGO_HOME ?? join(process.env.HOME!, ".cargo");
env.RUSTUP_HOME = process.env.RUSTUP_HOME ?? join(process.env.HOME!, ".rustup");
const reportPath = resolve(
    option("--report") ??
        join(repo, ".cortexkit/internal-docs/investigations/upgrade-rehearsal.md"),
);
const steps: { name: string; seconds: number; peakKiB: number; exit: number; output: string }[] =
    [];
const findings: string[] = [];
const evidence: Record<string, unknown> = {
    input: snapshot ?? "synthetic npm release writers",
    root,
    releases: {},
    checks: {},
    tables: {},
    integrity: {},
    schema: {},
};
function run(
    name: string,
    command: string[],
    cwd = repo,
    extra: NodeJS.ProcessEnv = {},
): string {
    const usage = join(root, `${steps.length}-usage`);
    const result = spawnSync("/usr/bin/time", ["-f", "%e %M", "-o", usage, ...command], {
        cwd,
        env: { ...env, ...extra },
        encoding: "utf8",
        timeout: 900_000,
        maxBuffer: 32 * 1024 * 1024,
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? `\n${result.error}` : ""}`;
    const metrics = existsSync(usage)
        ? readFileSync(usage, "utf8").trim().split("\n").at(-1)!.split(" ").map(Number)
        : [NaN, NaN];
    const step = {
        name,
        seconds: metrics[0],
        peakKiB: metrics[1],
        exit: result.status ?? -1,
        output,
    };
    steps.push(step);
    console.log(`${name}: ${step.seconds}s, peak ${step.peakKiB} KiB, exit ${step.exit}`);
    if (step.exit !== 0)
        throw new Error(`${name}: exit ${step.exit}\n${output.slice(-8000)}`);
    return result.stdout ?? "";
}
function copyContext(source: string, name: string): string {
    const dest = join(root, name);
    mkdirSync(dest, { recursive: true, mode: 0o700 });
    copyFileSync(join(source, "context.db"), join(dest, "context.db"));
    return dest;
}
function audit(label: string, directory: string): void {
    const path = join(directory, "context.db");
    (evidence.tables as Record<string, unknown>)[label] = inventory(path);
    (evidence.integrity as Record<string, unknown>)[label] = integrity(path);
    (evidence.schema as Record<string, unknown>)[label] = {
        version: version(path),
        digest: schemaDigest(path),
    };
}
function check(label: string, body: () => void): void {
    body();
    (evidence.checks as Record<string, string>)[label] = "passed";
    console.log(`${label}: passed`);
}
try {
    if (process.platform !== "linux")
        throw new Error("Rehearsal requires Linux and GNU /usr/bin/time");
    mkdirSync(baseline, { recursive: true });
    mkdirSync(release, { recursive: true });
    evidence.toolchain = Object.fromEntries(
        ["bun", "cargo", "rustc", "npm"].map((tool) => [
            tool,
            run(`${tool}-version`, [tool, "--version"]).trim(),
        ]),
    );
    run("build-plugin-pi-cli-bundles", [process.execPath, "run", "build"], repo, {
        NODE_ENV: "production",
        MAGIC_CONTEXT_TEST_DATA_DIR: "",
    });
    for (const [pkg, folder] of [
        ["@cortexkit/opencode-magic-context", "plugin"],
        ["@cortexkit/pi-magic-context", "pi-plugin"],
    ]) {
        const versions = JSON.parse(
            run(`npm-versions-${folder}`, ["npm", "view", pkg, "versions", "--json"]),
        );
        const selected = newest049(versions);
        const packed = JSON.parse(
            run(`npm-pack-${folder}`, [
                "npm",
                "pack",
                `${pkg}@${selected}`,
                "--json",
                "--pack-destination",
                root,
            ]),
        );
        const archive = join(root, packed[0].filename);
        const dest = join(release, "packages", folder);
        mkdirSync(dest, { recursive: true });
        run(`extract-${folder}`, ["tar", "-xf", archive, "--strip-components=1", "-C", dest]);
        const manifest = JSON.parse(readFileSync(join(dest, "package.json"), "utf8"));
        if (manifest.name !== pkg || manifest.version !== selected)
            throw new Error(`Wrong release archive: ${pkg}`);
        (evidence.releases as Record<string, unknown>)[pkg] = {
            version: selected,
            sha256: hashFile(archive),
            integrity: packed[0].integrity,
        };
        symlinkSync(
            join(repo, "packages", folder, "node_modules"),
            join(dest, "node_modules"),
            "dir",
        );
    }
    symlinkSync(join(repo, "node_modules"), join(release, "node_modules"), "dir");
    const host = join(repo, "scripts/lib/upgrade-host.ts");
    if (snapshot) copyFileSync(join(snapshot, "context.db"), join(baseline, "context.db"));
    else run("seed-release-context", [process.execPath, host, "seed", release, baseline]);
    if (version(join(baseline, "context.db")) !== 95)
        throw new Error("Released plugin must write context.db schema 95");
    audit("before", baseline);
    const upgraded = copyContext(baseline, "upgraded");
    const measurement = run("migrate-context-95-to-105", [
        process.execPath,
        host,
        "measure-context",
        repo,
        upgraded,
    ]);
    evidence.migrations = [...measurement.matchAll(/REHEARSAL_METRIC (\{[^\n]+\})/g)].map((match) =>
        JSON.parse(match[1]),
    );
    assertMigrationMetrics(evidence.migrations as MigrationMetric[]);
    assertEffects(version(join(upgraded, "context.db")));
    audit("after", upgraded);
    check("migration-only row and payload preservation", () => {
        const proof = {
            payloads: [] as PayloadProof[],
            tables: [] as { name: string; rows: number; sha256: string }[],
        };
        const difference = firstDifference(
            join(baseline, "context.db"),
            join(upgraded, "context.db"),
            undefined,
            proof,
        );
        evidence.preservation = proof;
        if (difference) throw new Error(difference);
    });
    const fresh = join(root, "fresh");
    mkdirSync(fresh);
    run("fresh-typescript-context", [process.execPath, host, "migrate", repo, fresh]);
    evidence.schemaCompatibility = assertApplicationSchema(
        join(fresh, "context.db"),
        join(upgraded, "context.db"),
    );
    evidence.freshSchemaDigest = schemaDigest(join(fresh, "context.db"));
    const doctor = run("upgraded-database-doctor", [
        process.execPath,
        join(repo, "scripts/lib/upgrade-doctor.ts"),
        upgraded,
    ]);
    assertDoctor(doctor);
    evidence.doctor = JSON.parse(doctor);
    const toolchain = join(root, "host-toolchain");
    run("install-opencode1", [
        "npm",
        "install",
        "--prefix",
        toolchain,
        "--no-audit",
        "--no-fund",
        "opencode-ai@1.18.31",
    ]);
    run(
        "prepare-opencode2",
        ["node", "postinstall.mjs"],
        join(repo, "packages/plugin/node_modules/@opencode/cli"),
    );
    env.MC_E2E_OPENCODE1_CLI = join(toolchain, "node_modules/.bin/opencode");
    env.MC_E2E_OPENCODE2_CLI = join(
        repo,
        "packages/plugin/node_modules/@opencode/cli/bin/opencode.exe",
    );
    env.PATH = `${join(toolchain, "node_modules/.bin")}:${join(repo, "packages/pi-plugin/node_modules/.bin")}:${env.PATH}`;
    evidence.fullDoctor = [];
    for (const adapter of ["opencode", "pi"]) {
        const directory = copyContext(upgraded, `doctor-${adapter}`);
        run(
            `full-doctor-${adapter}`,
            [
                process.execPath,
                join(repo, "packages/cli/dist/index.js"),
                "doctor",
                "--harness",
                adapter,
            ],
            directory,
            { MAGIC_CONTEXT_STORAGE_DIR: directory },
        );
        const result = steps.at(-1)!;
        assertFullDoctorTarget(result.output, directory, adapter);
        (evidence.fullDoctor as unknown[]).push({
            host: adapter,
            exit: result.exit,
            output: result.output,
        });
    }
    const hostsReport = join(root, "hosts.json");
    run("host-first-passes", [
        process.execPath,
        join(repo, "scripts/lib/upgrade-live-hosts.ts"),
        release,
        join(root, "hosts"),
        hostsReport,
        upgraded,
    ]);
    evidence.hosts = JSON.parse(readFileSync(hostsReport, "utf8"));
    run(
        "build-candidate-ck-mc",
        ["cargo", "build", "--release", "--locked", "-p", "mc-module", "-j", "8"],
        repo,
        { RUSTC_WRAPPER: "", CARGO_BUILD_RUSTC_WRAPPER: "" },
    );
    const binary = join(repo, "target/release/ck-mc");
    const moduleDir = copyContext(upgraded, "module-startup");
    const fences = run("candidate-ck-mc-fences", [binary, "--print-fences"]).trim();
    if (fences !== "context.db=105 mode3.db=5")
        throw new Error(`Unexpected ck-mc fences: ${fences}`);
    const startup = run("ck-mc-private-startup", [
        process.execPath,
        join(repo, "scripts/lib/upgrade-module.ts"),
        binary,
        moduleDir,
    ]);
    evidence.module = JSON.parse(startup);
    console.log(`ROW_COUNTS ${JSON.stringify(evidence.tables)}`);
    console.log(`SCHEMA ${JSON.stringify(evidence.schema)}`);
    console.log(`HOSTS ${JSON.stringify(evidence.hosts)}`);
    console.log(`CK_MC ${startup.trim()}`);
} catch (error) {
    findings.push(String(error));
} finally {
    const lines = [
        "# Upgrade rehearsal",
        "",
        `Date: ${new Date().toISOString()}`,
        `Input: ${evidence.input}`,
        `Findings: ${findings.length}`,
        "",
        "## Summary",
        "",
        ...findings.map((f) => `- ${f}`),
        "",
        "## Measurements",
        "",
        "| Step | Seconds | Peak RSS KiB | Exit |",
        "| --- | ---: | ---: | ---: |",
        ...steps.map((s) => `| ${s.name} | ${s.seconds} | ${s.peakKiB} | ${s.exit} |`),
        "",
        "## Detailed evidence",
        "",
        "```json",
        JSON.stringify({ ...evidence, findings, steps }, null, 2),
        "```",
        "",
        "## Tool issues",
        "",
        "The retired store.db builders, Rust context migration/parity/crash routes, old transform drill, old-binary refusal matrix, legacy tag importer and old prebuilt artifact format were removed. ck-mc no longer consumes that database or implements those paths. Context migration auditing still compares every retained original column and row identity, validates all thirteen relocated payloads through production readers, and records FTS shadow counts without treating SQLite's physical index layout as content. Fresh/upgraded schema digests are diagnostic; reviewed legacy DDL differences are checked structurally. Hosts use a local mock provider, not paid model calls. The startup probe reaches the daemon connection boundary after opening both private databases; it does not claim a live daemon handshake.",
        "",
    ];
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, lines.join("\n"));
    console.log(`Report: ${reportPath}`);
    rmSync(root, { recursive: true, force: true });
}
process.exitCode = findings.length ? 1 : 0;
console.log(
    findings.length
        ? `REHEARSAL_FAIL findings=${findings.length}\n${findings.join("\n")}`
        : "REHEARSAL_PASS context=105 mode3=5 first_pass_hosts=3 database_doctor=clean",
);
