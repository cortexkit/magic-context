/**
 * Hermetic subc stack for the Rust-mode e2e lane.
 *
 * Mirrors crates/mc-module/tests/real_daemon.rs, but driven from TypeScript so
 * the full production path (opencode → plugin → subc daemon → ck-mc module) can
 * be exercised end to end. It spawns:
 *
 *   - a real `ck-subc` daemon (from the sibling `subconscious` workspace, the
 *     same binary real_daemon.rs uses via `cargo build -p subc-core --bins`), and
 *   - the `ck-mc` module (this workspace, `cargo build --release -p mc-module`)
 *     connected to that daemon as an external tool provider.
 *
 * Wiring that makes the plugin find this daemon WITHOUT any product change: the
 * plugin's Rust module client (SubcModuleTransport, constructed in
 * packages/plugin/src/index.ts) reads the DEFAULT connection file at
 * `${XDG_DATA_HOME}/cortexkit/run/subc-connection.json`. opencode runs with
 * `XDG_DATA_HOME = <dataDir>`, so pointing the daemon's `XDG_RUNTIME_DIR` at
 * `<dataDir>/cortexkit/run` lands its connection file at exactly that path. The
 * module opens its own store at `${XDG_DATA_HOME}/cortexkit/magic-context/store.db`
 * (distinct from the plugin's context.db in the same directory), so sharing the
 * data dir is the production reality, not a test shortcut.
 *
 * Environment honesty: `detectRustModePrereqs()` returns a printable skip reason
 * when cargo is missing, the sibling subconscious workspace is absent, or the
 * platform is unsupported — the lane SKIPs rather than green-washing or hanging.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
    appendFileSync,
    copyFileSync,
    existsSync,
    linkSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
    SubcClient,
    type BindIdentity,
    type RouteHandle,
    type RouteOpenOptions,
    type RouteTarget,
} from "@cortexkit/subc-client";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const MODULE_ID = "magic-context";
const RUST_E2E_PID_FILE = "rust-e2e-pids.json";
const BROCA_ID = "broca";
const BROCA_SCRIPT = join(REPO_ROOT, "packages/e2e-tests/src/rust-runner/fake-broca.ts");
const RUST_E2E_STALE_PID_AGE_MS = 30 * 60 * 1_000;

function routeOpenWithoutAmbientConsumerIdentity(
    client: SubcClient,
    target: RouteTarget,
    identity: BindIdentity,
    options: Omit<RouteOpenOptions, "consumerIdentity"> = {},
): Promise<RouteHandle> {
    return client.routeOpen(target, identity, {
        ...options,
        // Inherited SUBC_* credentials identify a daemon-supervised module, not this independent host.
        consumerIdentity: null,
    });
}

type RustE2eProcessRole = "daemon" | "module" | "producer";

interface RustE2ePidRecord {
    pid: number;
    role: RustE2eProcessRole;
}

interface RustE2ePidFile {
    createdAtMs: number;
    pids: RustE2ePidRecord[];
}

function processStartTimeMs(pid: number): number | null {
    const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status !== 0 || typeof result.stdout !== "string") return null;
    const startedAt = Date.parse(result.stdout.trim());
    return Number.isFinite(startedAt) ? startedAt : null;
}

function isStaleRustE2ePidRecord(createdAtMs: number, nowMs = Date.now()): boolean {
    return (
        Number.isFinite(createdAtMs) &&
        createdAtMs <= nowMs &&
        nowMs - createdAtMs >= RUST_E2E_STALE_PID_AGE_MS
    );
}

/**
 * Reap only PIDs recorded by a stale Rust harness run. Fresh PID files can
 * belong to active tests in other worktrees on the shared host.
 */
function reapRecordedRustProcesses(): void {
    let candidates: string[];
    try {
        candidates = readdirSync(tmpdir(), { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && entry.name.startsWith("opencode-e2e-"))
            .map((entry) => join(tmpdir(), entry.name, "data", "cortexkit", RUST_E2E_PID_FILE));
    } catch {
        return;
    }

    for (const pidPath of candidates) {
        if (!existsSync(pidPath)) continue;
        let stale = false;
        try {
            const record = JSON.parse(readFileSync(pidPath, "utf8")) as RustE2ePidFile;
            if (!Array.isArray(record.pids)) continue;
            stale = isStaleRustE2ePidRecord(record.createdAtMs);
            if (!stale) continue;
            // `ps lstart` reports process start times only to whole seconds on
            // supported Unix hosts, so compare against the PID record's creation
            // time rounded down. Older processes predate this harness run and are
            // not killed.
            const createdAtBoundary = Math.floor(record.createdAtMs / 1_000) * 1_000;
            for (const process of record.pids) {
                if (!Number.isInteger(process?.pid) || process.pid <= 0) continue;
                const startedAt = processStartTimeMs(process.pid);
                if (startedAt === null || startedAt < createdAtBoundary) continue;
                try {
                    processKill(process.pid);
                } catch {
                    // The process may have exited between ps and kill.
                }
            }
        } catch {
            // A partial PID file is not an identity proof; leave unknown processes alone.
        } finally {
            if (stale) rmSync(pidPath, { force: true });
        }
    }
}

function processKill(pid: number): void {
    process.kill(pid, "SIGKILL");
}

/**
 * Keep Rust e2e artifacts outside either live source workspace's target directory.
 * This directory is durable across test runs so Cargo can reuse incremental artifacts,
 * while a developer build in either workspace cannot hold the harness's target lock.
 */
const RUST_E2E_CARGO_TARGET_DIR = join(
    REPO_ROOT,
    "packages/e2e-tests/.cache/rust-e2e-cargo-target",
);

/** ck-mc lives in THIS workspace; ck-subc in the sibling subconscious workspace. */
const CK_MC_RELEASE = join(RUST_E2E_CARGO_TARGET_DIR, "release/ck-mc");

/**
 * Resolve only the binary that Cargo builds from this checkout. The release
 * preflight can export a PATH fallback through `MC_E2E_CK_MC_BIN`, but consuming
 * that fallback here could replay an older tree while the e2e loads current tests.
 */
function currentTreeCkMcBinary(_configuredBinary: string | undefined): string {
    return CK_MC_RELEASE;
}

/**
 * Candidate locations for the sibling subconscious workspace. In a normal
 * checkout it sits beside the repo root; in an Alfonso worktree it is a sibling
 * symlink one level up from the worktree. Both are covered by walking up.
 */
function subconsciousCandidates(): string[] {
    return [
        join(REPO_ROOT, "..", "subconscious"),
        join(REPO_ROOT, "..", "..", "subconscious"),
    ];
}

export interface RustModePrereqs {
    ok: boolean;
    /** Human-readable reason to print when skipping the lane. Set when !ok. */
    skipReason?: string;
    /** Resolved sibling subconscious workspace root (when ok). */
    subconsciousRoot?: string;
}

/**
 * Detect whether the hermetic Rust stack can run here. Never throws; returns a
 * printable reason so the suite can SKIP cleanly on an unsupported machine.
 */
export function detectRustModePrereqs(): RustModePrereqs {
    if (process.platform === "win32") {
        return {
            ok: false,
            skipReason: `platform ${process.platform} is unsupported for the hermetic subc stack (needs a Unix socket/TCP daemon build)`,
        };
    }

    const cargo = spawnSync("cargo", ["--version"], { stdio: "ignore" });
    if (cargo.error || cargo.status !== 0) {
        return {
            ok: false,
            skipReason: "cargo is not available on PATH; cannot build ck-mc / ck-subc",
        };
    }

    const subconsciousRoot = subconsciousCandidates().find((candidate) =>
        existsSync(join(candidate, "Cargo.toml")),
    );
    if (!subconsciousRoot) {
        return {
            ok: false,
            skipReason: `sibling subconscious workspace not found (looked in: ${subconsciousCandidates().join(", ")}); cannot build the ck-subc daemon`,
        };
    }

    return { ok: true, subconsciousRoot };
}

// ── build (memoized once per process, like real_daemon's BUILD_LOCK) ──────────

interface BuiltBinaries {
    ckMcBin: string;
    ckSubcBin: string;
}

const buildPromises = new Map<string, Promise<BuiltBinaries>>();

function rustE2eCargoEnv(): NodeJS.ProcessEnv {
    return { ...process.env, CARGO_TARGET_DIR: RUST_E2E_CARGO_TARGET_DIR };
}

function runCargo(
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    return new Promise((resolveRun) => {
        const child = spawn("cargo", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk: Buffer) => {
            stdout += chunk.toString();
        });
        child.stderr?.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
        });
        child.on("error", (err) => {
            resolveRun({ ok: false, stdout, stderr: `${stderr}\nspawn error: ${String(err)}` });
        });
        child.on("exit", (code) => {
            resolveRun({ ok: code === 0, stdout, stderr });
        });
    });
}

/**
 * Resolve the sibling daemon source to build from.
 *
 * The sibling checkout on a developer box is another seat's live working tree, and
 * that tree is mid-edit whenever its owner is working: a release gate on 2026-09-18
 * failed on `E0433 cannot find type Sha256` in subconscious's ck.rs, an edit SUBC
 * had not committed yet. Building the daemon from the sibling's COMMITTED HEAD in
 * a detached scratch worktree makes the gate depend on a revision, not on whoever
 * has an editor open. The scratch worktree is keyed on the sha so a repeat build
 * reuses it, and the shared e2e target directory keeps Cargo's cache warm. In CI
 * the sibling is a fresh checkout and HEAD is the working tree, so this is a no-op
 * there beyond the extra worktree.
 */
function committedSiblingSource(subconsciousRoot: string): { root: string; sha: string } {
    const head = spawnSync("git", ["-C", subconsciousRoot, "rev-parse", "HEAD"], {
        encoding: "utf8",
    });
    const sha = head.status === 0 ? head.stdout.trim() : "";
    if (!/^[0-9a-f]{40}$/.test(sha)) {
        // Not a git checkout (a tarball or vendored copy): build what is there.
        return { root: subconsciousRoot, sha: "working-tree" };
    }
    const scratchRoot = join(dirname(RUST_E2E_CARGO_TARGET_DIR), "subconscious-src");
    const stamp = join(scratchRoot, ".mc-e2e-sha");
    if (existsSync(stamp) && readFileSync(stamp, "utf8").trim() === sha) {
        return { root: scratchRoot, sha };
    }
    spawnSync("git", ["-C", subconsciousRoot, "worktree", "remove", "--force", scratchRoot], {
        stdio: "ignore",
    });
    rmSync(scratchRoot, { recursive: true, force: true });
    const added = spawnSync(
        "git",
        ["-C", subconsciousRoot, "worktree", "add", "--detach", scratchRoot, sha],
        { encoding: "utf8" },
    );
    if (added.status !== 0) {
        throw new Error(
            `failed to stage the sibling daemon source at ${sha} (git worktree add): ${added.stderr}`,
        );
    }
    writeFileSync(stamp, `${sha}\n`);
    return { root: scratchRoot, sha };
}

/**
 * Use an explicitly supplied CI-built module/daemon pair, or build both from
 * their current workspaces incrementally for local release runs. The fault-feature
 * variant is a separate binary; never pair only one prebuilt component with a
 * locally rebuilt counterpart. Local builds use the e2e-owned Cargo target and
 * are memoized by feature set for this test process.
 */
export async function buildHermeticBinaries(
    subconsciousRoot: string,
    options: { driveFault?: boolean } = {},
): Promise<BuiltBinaries> {
    // The fault arms live behind a non-default Cargo feature, so a scenario that
    // drives one needs a SEPARATE binary. Keying the memo (and the dev-named link)
    // on the feature set keeps a fault build and a plain build from overwriting
    // each other within one test process.
    const buildKey = options.driveFault === true ? "drive-fault" : "default";
    const existing = buildPromises.get(buildKey);
    if (existing) return existing;
    const buildPromise = (async () => {
        const prebuiltModule = options.driveFault
            ? process.env.MC_E2E_CK_MC_DRIVE_FAULT_BIN
            : process.env.MC_E2E_CK_MC_PREBUILT_BIN;
        const prebuiltDaemon = process.env.MC_E2E_CK_SUBC_BIN;
        if (prebuiltModule || prebuiltDaemon) {
            if (!prebuiltModule || !prebuiltDaemon || !existsSync(prebuiltModule) || !existsSync(prebuiltDaemon)) {
                throw new Error(`incomplete hermetic prebuilt binary pair for ${buildKey}`);
            }
            return { ckMcBin: prebuiltModule, ckSubcBin: prebuiltDaemon };
        }
        const cargoEnv = rustE2eCargoEnv();
        let ckMcBin = currentTreeCkMcBinary(process.env.MC_E2E_CK_MC_BIN);
        const moduleArgs = ["build", "--release", "-p", "mc-module"];
        if (options.driveFault === true) moduleArgs.push("--features", "drive-fault");
        const moduleBuild = await runCargo(moduleArgs, REPO_ROOT, cargoEnv);
        if (!moduleBuild.ok || !existsSync(ckMcBin)) {
            throw new Error(
                `failed to build ck-mc (cargo ${moduleArgs.join(" ")}):\n${moduleBuild.stderr.slice(-4000)}`,
            );
        }

        // Run the module under a dev-distinct process name so a test binary is
        // never mistaken for the production ck-mc in Activity Monitor / ps.
        // A hardlink shares the inode (no copy cost, always current build);
        // fall back to a copy across filesystems.
        const devNamed = join(dirname(ckMcBin), `ckdev-mc-e2e-${buildKey}`);
        try {
            rmSync(devNamed, { force: true });
            linkSync(ckMcBin, devNamed);
            ckMcBin = devNamed;
        } catch {
            try {
                copyFileSync(ckMcBin, devNamed);
                ckMcBin = devNamed;
            } catch {
                // Keep the original path; naming is cosmetic, never a test failure.
            }
        }

        const ckSubcRelease = join(RUST_E2E_CARGO_TARGET_DIR, "release/ck-subc");
        const daemonSource = committedSiblingSource(subconsciousRoot);
        const daemonBuild = await runCargo(
            ["build", "--release", "-p", "subc-core", "--bins"],
            daemonSource.root,
            cargoEnv,
        );
        if (!daemonBuild.ok || !existsSync(ckSubcRelease)) {
            throw new Error(
                `failed to build ck-subc (cargo build --release -p subc-core --bins in ${daemonSource.root} at ${daemonSource.sha}):\n${daemonBuild.stderr.slice(-4000)}`,
            );
        }

        return { ckMcBin, ckSubcBin: ckSubcRelease };
    })();
    buildPromises.set(buildKey, buildPromise);
    return buildPromise;
}

// ── daemon + module lifecycle ─────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function pollUntil(
    predicate: () => boolean | Promise<boolean>,
    opts: { timeoutMs: number; intervalMs?: number; label: string },
): Promise<void> {
    const intervalMs = opts.intervalMs ?? 100;
    const deadline = Date.now() + opts.timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) return;
        await sleep(intervalMs);
    }
    throw new Error(`hermetic subc: ${opts.label} did not happen within ${opts.timeoutMs}ms`);
}

export interface HermeticSubcOptions {
    /** opencode's data dir — the module store and the plugin's connection-file lookup share it. */
    dataDir: string;
    ckMcBin: string;
    ckSubcBin: string;
    /** Ceiling for daemon connection-file + module registration. Default 60s. */
    startTimeoutMs?: number;
    /** Start the deterministic Broca producer. Default true. */
    startProducer?: boolean;
    /** Environment supplied only to the hermetic module process. */
    moduleEnv?: Record<string, string>;
    /**
     * The completion runner the module's user tier names for the historian and the
     * dreamer. Default "broca": this stack registers a Broca producer, and the
     * scenarios built on it exercise the Broca lane, so they name it explicitly now
     * that an unconfigured OpenCode request defaults to the host runner. `null`
     * writes no runner, so the module decides per request from the harness.
     */
    historianRunner?: HermeticHistorianRunner;
}

export type HermeticHistorianRunner = "broca" | "host" | null;

/**
 * A running hermetic daemon + module pair. `connectionFile` is the path the
 * plugin's Rust client will read. Always call `stop()` in afterAll (even on
 * failure) so no orphaned daemon/module processes leak between suites.
 */
export class HermeticSubcStack {
    readonly connectionFile: string;
    private readonly dataDir: string;
    private readonly ckMcBin: string;
    private readonly ckSubcBin: string;
    private readonly runtimeDir: string;
    private readonly daemonConfigDir: string;
    private readonly daemonLogPath: string;
    private readonly daemonLogDir: string;
    private readonly moduleLogPath: string;
    private readonly producerLogPath: string;
    private readonly pidFilePath: string;
    private readonly startTimeoutMs: number;
    private readonly startProducer: boolean;
    private readonly historianRunner: HermeticHistorianRunner;
    /** Mutable so a restart can arm or disarm module-only settings between passes. */
    private readonly moduleEnv: Record<string, string>;
    private pidFileCreatedAtMs = 0;
    private readonly recordedPids = new Map<RustE2eProcessRole, number>();
    private daemon: ChildProcess | null = null;
    private module: ChildProcess | null = null;
    private producer: ChildProcess | null = null;
    private killedModulePid: number | null = null;
    private killedProducerPid: number | null = null;
    private producerPid: number | null = null;
    private catalogClient: SubcClient | null = null;
    private statusClient: SubcClient | null = null;

    private constructor(opts: Required<HermeticSubcOptions>) {
        this.dataDir = opts.dataDir;
        this.ckMcBin = opts.ckMcBin;
        this.ckSubcBin = opts.ckSubcBin;
        this.startTimeoutMs = opts.startTimeoutMs;
        this.startProducer = opts.startProducer;
        this.historianRunner = opts.historianRunner;
        this.moduleEnv = opts.moduleEnv;
        // The plugin's Rust client reads exactly this path (getDefaultConnectionFile
        // in module-transport.ts). The daemon derives the same run directory from its
        // hermetic XDG_DATA_HOME, so no product configuration knob is needed.
        this.runtimeDir = join(this.dataDir, "cortexkit", "run");
        this.connectionFile = join(this.runtimeDir, "subc-connection.json");
        this.daemonConfigDir = join(this.dataDir, "cortexkit", "_hermetic-daemon-config");
        this.daemonLogPath = join(this.dataDir, "cortexkit", "_hermetic-daemon.log");
        this.daemonLogDir = join(this.runtimeDir, "logs");
        this.moduleLogPath = join(this.dataDir, "cortexkit", "_hermetic-module.log");
        this.producerLogPath = join(this.dataDir, "cortexkit", "_hermetic-broca.log");
        this.pidFilePath = join(this.dataDir, "cortexkit", RUST_E2E_PID_FILE);
    }

    static async start(opts: HermeticSubcOptions): Promise<HermeticSubcStack> {
        reapRecordedRustProcesses();
        const stack = new HermeticSubcStack({
            dataDir: opts.dataDir,
            ckMcBin: opts.ckMcBin,
            ckSubcBin: opts.ckSubcBin,
            startTimeoutMs: opts.startTimeoutMs ?? 60_000,
            startProducer: opts.startProducer ?? true,
            moduleEnv: opts.moduleEnv ?? {},
            historianRunner: opts.historianRunner === undefined ? "broca" : opts.historianRunner,
        });
        try {
            await stack.boot();
            return stack;
        } catch (error) {
            await stack.stop();
            throw error;
        }
    }

    private async boot(): Promise<void> {
        mkdirSync(this.runtimeDir, { recursive: true });
        // An interrupted run can leave a stale socket and logs behind. Remove
        // those artifacts before starting the new daemon so registration proves
        // this stack, not a dead predecessor, accepted the module.
        rmSync(this.connectionFile, { force: true });
        rmSync(this.daemonLogPath, { force: true });
        rmSync(this.daemonLogDir, { recursive: true, force: true });
        rmSync(this.moduleLogPath, { force: true });
        rmSync(this.producerLogPath, { force: true });
        this.pidFileCreatedAtMs = Date.now();
        this.persistPidFile();
        mkdirSync(join(this.daemonConfigDir, "cortexkit"), { recursive: true });
        // configured_modules=0 → the daemon does NOT supervise/launch the module;
        // the module connects as an ordinary external provider. That keeps module
        // kill/restart (the park-self-heal fault) fully under this harness's control.
        writeFileSync(
            join(this.daemonConfigDir, "cortexkit", "subc.jsonc"),
            JSON.stringify({ version: 1, modules: {} }, null, 2),
        );

        this.daemon = spawn(this.ckSubcBin, [], {
            stdio: ["ignore", "pipe", "pipe"],
            env: {
                ...process.env,
                XDG_RUNTIME_DIR: this.runtimeDir,
                XDG_CONFIG_HOME: this.daemonConfigDir,
                // The daemon derives its run artifacts, subc.log, and per-module stderr
                // capture from the data home; keep all of them inside the hermetic tree.
                XDG_DATA_HOME: this.dataDir,
                SUBC_PORT: "0",
                NO_COLOR: "1",
                // The module connects as a plain client; clear any inherited
                // supervised-identity vars so it does not reuse a reserved slot.
                SUBC_MODULE_ID: "",
                SUBC_LAUNCH_NONCE: "",
            },
        });
        this.recordPid("daemon", this.daemon.pid);
        this.pipeToLog(this.daemon, this.daemonLogPath, "daemon");
        this.daemon.on("exit", () => {
            this.daemon = null;
            this.forgetPid("daemon");
        });

        await pollUntil(() => existsSync(this.connectionFile), {
            timeoutMs: this.startTimeoutMs,
            label: "daemon connection file",
        });
        // The daemon writes the connection file just before its listener enters
        // the accept loop. Let that listener become reachable before the client
        // attempts its one-shot registration handshake.
        await sleep(100);

        // Register ck-mc first so its long-lived transform route is established
        // before the independent Broca producer joins the daemon. The producer is
        // still ready before the harness returns, so no historian request can race
        // boot and the module's initial route is not starved by daemon startup.
        this.writeModuleConfig({});
        await this.spawnModule();
        await this.waitForModuleRegistration();
        if (this.startProducer) {
            await this.spawnProducer();
            await this.waitForProducerRegistration();
            process.env.MC_RUST_E2E_FOLD = "1";
        } else {
            delete process.env.MC_RUST_E2E_FOLD;
        }

        // Catalog registration is the readiness gate; this immediate assertion only
        // proves the daemon's file sink stayed inside the hermetic data home. The
        // file name is the daemon's business and has changed across versions (it
        // date-stamps its log as of ck-subc 0.18.21), so assert the directory it
        // wrote into rather than one exact name.
        const daemonLogFiles = existsSync(this.daemonLogDir)
            ? readdirSync(this.daemonLogDir).filter(
                  (name) => name.startsWith("subc") && name.endsWith(".log"),
              )
            : [];
        if (daemonLogFiles.length === 0) {
            throw new Error(
                `hermetic subc: no daemon log (subc*.log) was created under the hermetic data home: ${this.daemonLogDir}`,
            );
        }
    }

    /** The module's hermetic user-tier config file (its XDG_CONFIG_HOME). */
    get moduleConfigPath(): string {
        return join(this.dataDir, "module-config", "cortexkit", "magic-context.jsonc");
    }

    /**
     * Replace the module's user-tier config. The runner this stack was started with
     * is added unless `config.historian.runner` names one, so a scenario that writes
     * its own module settings stays on the lane it was built for. The module rereads
     * this file on each request, but the manifest's routes are fixed at boot, so a
     * runner change also needs `restartModule()`.
     */
    writeModuleConfig(config: Record<string, unknown>): void {
        const historian =
            config.historian && typeof config.historian === "object"
                ? (config.historian as Record<string, unknown>)
                : {};
        const pinned =
            this.historianRunner !== null && historian.runner === undefined
                ? { ...config, historian: { ...historian, runner: this.historianRunner } }
                : config;
        mkdirSync(dirname(this.moduleConfigPath), { recursive: true });
        writeFileSync(this.moduleConfigPath, JSON.stringify(pinned, null, 2));
    }

    private async spawnProducer(): Promise<void> {
        this.producer = spawn(process.execPath, [BROCA_SCRIPT], {
            stdio: ["ignore", "pipe", "pipe"],
            env: {
                ...process.env,
                BROCA_CONNECTION_FILE: this.connectionFile,
                BROCA_LOG_PATH: this.producerLogPath,
                XDG_DATA_HOME: this.dataDir,
                SUBC_MODULE_ID: "",
                SUBC_LAUNCH_NONCE: "",
                NO_COLOR: "1",
            },
        });
        this.producerPid = this.producer.pid ?? null;
        this.recordPid("producer", this.producer.pid);
        this.pipeToLog(this.producer, this.producerLogPath, "producer");
        this.producer.on("exit", (code, signal) => {
            try {
                appendFileSync(
                    this.producerLogPath,
                    `producer process exited code=${code ?? "null"} signal=${signal ?? "null"}\n`,
                );
            } catch {
                // A lifecycle diagnostic must not turn teardown into a failure.
            }
            this.producer = null;
            this.forgetPid("producer");
        });
    }

    private async spawnModule(): Promise<void> {
        const module = spawn(this.ckMcBin, ["--subc", this.connectionFile], {
            stdio: ["ignore", "pipe", "pipe"],
            env: {
                ...process.env,
                // Module-only settings, applied before the fixed hermetic wiring below
                // so a scenario can arm a module behaviour without touching the daemon,
                // the producer, or this test process.
                ...this.moduleEnv,
                NO_COLOR: "1",
                SUBC_MODULE_ID: MODULE_ID,
                SUBC_LAUNCH_NONCE: "",
                // Keep module config hermetic too. ConfigCache reloads this path on
                // each transform, so tests can write explicit Rust-only settings.
                XDG_CONFIG_HOME: join(this.dataDir, "module-config"),
                // The module opens its store under this data home — the SAME dir
                // opencode uses, matching production's shared cortexkit layout.
                XDG_DATA_HOME: this.dataDir,
                MAGIC_CONTEXT_STORAGE_DIR: join(this.dataDir, "cortexkit", "magic-context"),
            },
        });
        this.module = module;
        this.recordPid("module", module.pid);
        this.pipeToLog(module, this.moduleLogPath, "module");
        module.on("exit", (code, signal) => {
            try {
                appendFileSync(
                    this.moduleLogPath,
                    `module process exited code=${code ?? "null"} signal=${signal ?? "null"}\n`,
                );
            } catch {
                // A lifecycle diagnostic must not turn teardown into a failure.
            }
            // A late event from an old process must not clear a replacement module.
            if (this.module === module) {
                this.module = null;
                this.forgetPid("module");
            }
        });
    }

    private recordPid(role: RustE2eProcessRole, pid: number | undefined): void {
        if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return;
        this.recordedPids.set(role, pid);
        this.persistPidFile();
    }

    private forgetPid(role: RustE2eProcessRole): void {
        this.recordedPids.delete(role);
        this.persistPidFile();
    }

    private persistPidFile(): void {
        if (!this.pidFileCreatedAtMs) return;
        try {
            writeFileSync(
                this.pidFilePath,
                JSON.stringify({
                    createdAtMs: this.pidFileCreatedAtMs,
                    pids: [...this.recordedPids.entries()].map(([role, pid]) => ({ role, pid })),
                } satisfies RustE2ePidFile),
            );
        } catch {
            // The reaper is a safety net; a write failure must not break the harness.
        }
    }

    /** Wait until the registry catalog exposes the independently spawned producer. */
    private async waitForProducerRegistration(): Promise<void> {
        try {
            await pollUntil(async () => (await this.registrationCount(BROCA_ID)) >= 1, {
                timeoutMs: Math.min(this.startTimeoutMs, 10_000),
                label: "Broca producer registration in catalog",
            });
        } catch (error) {
            throw new Error(
                `${String(error)}\\ndaemon log:\\n${this.daemonLog().slice(-4000)}\\nproducer log:\\n${this.producerLog().slice(-4000)}`,
            );
        }
    }

    private async waitForModuleRegistration(): Promise<void> {
        let lastError: unknown;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            if (attempt > 0) {
                await sleep(500 * attempt);
                await this.spawnModule();
            }
            try {
                await pollUntil(async () => (await this.registrationCount(MODULE_ID)) >= 1, {
                    timeoutMs: Math.min(this.startTimeoutMs, 10_000),
                    label: "module registration in catalog",
                });
                return;
            } catch (error) {
                lastError = error;
                // A fresh daemon can publish its connection file before the listener
                // is ready. Recreate the external client for the next attempt rather
                // than treating that startup race as a failed hermetic prerequisite.
                this.killModule();
            }
        }
        throw new Error(
            `${String(lastError)}\ndaemon log:\n${this.daemonLog().slice(-4000)}\nmodule log:\n${this.moduleLog().slice(-4000)}`,
        );
    }

    /**
     * Query the versioned registry contract. Daemon stdout is not a logging contract,
     * and `ck module list` reports only the supervisor roster, not external modules.
     */
    private async registrationCount(moduleId: string): Promise<number> {
        let client = this.catalogClient;
        try {
            if (!client) {
                client = await SubcClient.connect({
                    connectionFile: this.connectionFile,
                    handshakeTimeoutMs: 1_000,
                });
                this.catalogClient = client;
            }
            const entries = await client.catalogList();
            return entries.filter((entry) => entry.module_id === moduleId).length;
        } catch {
            client?.close();
            if (this.catalogClient === client) this.catalogClient = null;
            // A daemon that is not accepting catalog RPCs is not ready yet; the next
            // poll reconnects rather than turning startup into a terminal error.
            return 0;
        }
    }

    /**
     * Kill the module and bring a fresh one up against the same daemon + store.
     * Models the park-self-heal fault: a mid-session module restart whose next
     * passes must recover without permanent degradation. The 200ms settle lets
     * the OS release the single-writer store lease before the new module
     * re-acquires it (mirrors real_daemon.rs's restart step).
     */
    async restartModule(moduleEnv: Record<string, string | undefined> = {}): Promise<void> {
        this.applyModuleEnv(moduleEnv);
        await this.killModuleAndWait();
        await sleep(200);
        await this.waitForFreshModuleRegistration();
    }

    /** Return a killed external module without restarting the OpenCode session. */
    async restoreModule(moduleEnv: Record<string, string | undefined> = {}): Promise<void> {
        this.applyModuleEnv(moduleEnv);
        await sleep(200);
        await this.waitForFreshModuleRegistration();
    }

    /**
     * Change the environment the NEXT module process starts with. An explicit
     * `undefined` removes a setting, so a scenario can arm a fault for one restart
     * and disarm it on the next without rebuilding the stack.
     */
    private applyModuleEnv(moduleEnv: Record<string, string | undefined>): void {
        for (const [key, value] of Object.entries(moduleEnv)) {
            if (value === undefined) delete this.moduleEnv[key];
            else this.moduleEnv[key] = value;
        }
    }

    /** Kill only the module process (leaving the daemon up), for fault injection. */
    killModule(): void {
        const pid = this.module?.pid;
        if (pid && Number.isInteger(pid) && pid > 0) this.killedModulePid = pid;
        if (this.module && this.module.exitCode === null) {
            this.module.kill("SIGKILL");
        }
        this.module = null;
        this.forgetPid("module");
    }

    /** Wait until SIGKILL has reaped the module and the daemon has dropped its route. */
    async waitForModuleDeath(timeoutMs = 15_000): Promise<void> {
        const pid = this.killedModulePid;
        if (!pid) throw new Error("waitForModuleDeath called before killModule");
        await pollUntil(
            async () => !isProcessAlive(pid) && (await this.registrationCount(MODULE_ID)) === 0,
            { timeoutMs, label: "module death and catalog route removal" },
        );
    }

    /** Kill the fake Broca process for the producer-outage drill. */
    killProducer(): void {
        const pid = this.producer?.pid ?? this.producerPid;
        if (pid && Number.isInteger(pid) && pid > 0) this.killedProducerPid = pid;
        if (this.producer && this.producer.exitCode === null) this.producer.kill("SIGKILL");
        this.producer = null;
        this.forgetPid("producer");
    }

    async waitForProducerDeath(timeoutMs = 15_000): Promise<void> {
        const pid = this.killedProducerPid ?? this.producerPid;
        if (!pid) throw new Error("waitForProducerDeath called before killProducer");
        await pollUntil(() => !isProcessAlive(pid), {
            timeoutMs,
            label: "Broca producer death",
        });
    }

    producerLog(): string {
        try {
            return readFileSync(this.producerLogPath, "utf8");
        } catch {
            return "";
        }
    }

    producerRequestCount(): number {
        return (this.producerLog().match(/session\.send /g) ?? []).length;
    }

    async moduleRequest(
        sessionId: string,
        projectRoot: string,
        request: Record<string, unknown>,
        /** Harness name the route binds with; the module's runner default follows it. */
        harness = "opencode",
    ): Promise<Record<string, unknown>> {
        const identity: BindIdentity = {
            project_root: resolve(projectRoot),
            harness,
            session: sessionId,
        };
        let client = this.statusClient;
        if (!client) {
            client = await SubcClient.connect({
                connectionFile: this.connectionFile,
                identity,
                targetKind: "tool_provider",
            });
            this.statusClient = client;
        }
        let route: Awaited<ReturnType<SubcClient["routeOpen"]>> | null = null;
        try {
            route = await routeOpenWithoutAmbientConsumerIdentity(
                client,
                { kind: "tool_provider", module_id: MODULE_ID },
                identity,
            );
            const response = await client.request(route, {
                v: 1,
                session_id: sessionId,
                ...request,
            });
            return (response && typeof response === "object" ? response : {}) as Record<string, unknown>;
        } catch (error) {
            client.close();
            if (this.statusClient === client) this.statusClient = null;
            throw error;
        } finally {
            if (route) await client.closeRoute(route).catch(() => undefined);
        }
    }

    async moduleSeriesRequest(
        sessionId: string,
        projectRoot: string,
        requests: readonly Record<string, unknown>[],
        timeoutMs = 120_000,
    ): Promise<Record<string, unknown>[]> {
        const identity: BindIdentity = {
            project_root: resolve(projectRoot),
            harness: "opencode",
            session: sessionId,
        };
        const client = await SubcClient.connect({
            connectionFile: this.connectionFile,
            identity,
            targetKind: "tool_provider",
        });
        let route: Awaited<ReturnType<SubcClient["routeOpen"]>> | null = null;
        try {
            route = await routeOpenWithoutAmbientConsumerIdentity(
                client,
                { kind: "tool_provider", module_id: MODULE_ID },
                identity,
            );
            const responses: Record<string, unknown>[] = [];
            for (const request of requests) {
                const response = await client.request(route, request, { timeoutMs });
                responses.push(
                    (response && typeof response === "object" ? response : {}) as Record<
                        string,
                        unknown
                    >,
                );
            }
            return responses;
        } finally {
            if (route) await client.closeRoute(route).catch(() => undefined);
            client.close();
        }
    }

    async moduleStatus(
        sessionId: string,
        projectRoot: string,
        method: "status" | "session.status" = "status",
    ): Promise<Record<string, unknown>> {
        return this.moduleRequest(sessionId, projectRoot, { method });
    }

    /** Wait until SIGKILL is observed before driving an outage or spawning a replacement. */
    async killModuleAndWait(): Promise<void> {
        const module = this.module;
        this.killModule();
        if (!module || module.exitCode !== null || module.signalCode !== null) return;
        await pollUntil(() => module.exitCode !== null || module.signalCode !== null, {
            timeoutMs: 5_000,
            label: "module process exit after SIGKILL",
        });
    }

    /** Stop the live module without killing it, so daemon timeout handling can be tested. */
    stopModule(): void {
        if (this.module && this.module.exitCode === null) this.module.kill("SIGSTOP");
    }

    /** Continue a module paused by stopModule(). */
    continueModule(): void {
        if (this.module && this.module.exitCode === null) this.module.kill("SIGCONT");
    }

    /**
     * Prove the hermetic daemon is using the external-provider path. A configured
     * supervised module would restart after a long outage and invalidate the drill.
     */
    assertModuleNotSupervised(): void {
        const configPath = join(this.daemonConfigDir, "cortexkit", "subc.jsonc");
        const config = JSON.parse(readFileSync(configPath, "utf8")) as { modules?: unknown };
        if (
            config.modules === null ||
            typeof config.modules !== "object" ||
            Array.isArray(config.modules) ||
            Object.keys(config.modules as Record<string, unknown>).length !== 0
        ) {
            throw new Error("Rust outage drill precondition failed: magic-context is configured for supervision");
        }
        // The empty modules map is the supervision source of truth. Daemon stdout is
        // not a contract, and `ck module list` would only repeat this supervisor roster.
    }

    /**
     * Prove the old route left the registry before spawning its replacement. Waiting
     * only for presence could accept the dead module's stale catalog entry.
     */
    private async waitForFreshModuleRegistration(): Promise<void> {
        await pollUntil(async () => (await this.registrationCount(MODULE_ID)) === 0, {
            timeoutMs: this.startTimeoutMs,
            label: "catalog absence before module re-registration",
        });
        await this.spawnModule();
        await pollUntil(async () => (await this.registrationCount(MODULE_ID)) >= 1, {
            timeoutMs: this.startTimeoutMs,
            label: "module re-registration in catalog after restart",
        });
    }

    private pipeToLog(child: ChildProcess, logPath: string, _tag: string): void {
        // Drain BOTH streams continuously so a child cannot block on a full pipe.
        // The daemon's normal logs go to subc.log; this capture remains only for
        // pre-subscriber eprintln failures and other post-mortem diagnostics.
        const append = (chunk: Buffer) => {
            try {
                appendFileSync(logPath, chunk.toString());
            } catch {
                // Logging must never throw and take down a test.
            }
        };
        child.stdout?.on("data", append);
        child.stderr?.on("data", append);
    }

    /** Best-effort read of the daemon log (diagnostics on failure). */
    daemonLog(): string {
        try {
            return readFileSync(this.daemonLogPath, "utf8");
        } catch {
            return "";
        }
    }

    /** Read the module's dated file sink and its separately captured stderr. */
    moduleLog(): string {
        const logDir = join(this.dataDir, "cortexkit", "magic-context", "logs");
        const segments = existsSync(logDir)
            ? readdirSync(logDir)
                  .filter((name) => name.startsWith("magic-context.") && name.endsWith(".log"))
                  .sort()
                  .map((name) => join(logDir, name))
            : [];
        let output = "";
        for (const path of [...segments, this.moduleLogPath]) {
            try {
                output += readFileSync(path, "utf8");
            } catch {
                // A module that died before creating its sink can still have stderr.
            }
        }
        return output;
    }

    /** Hard teardown. Safe to call more than once; never throws. */
    async stop(): Promise<void> {
        this.catalogClient?.close();
        this.catalogClient = null;
        this.statusClient?.close();
        this.statusClient = null;
        try {
            await this.killModuleAndWait();
        } catch {
            // SIGKILL was sent; a delayed exit notification must not make teardown fail.
        }
        if (this.producer && this.producer.exitCode === null) this.producer.kill("SIGKILL");
        this.producer = null;
        this.forgetPid("producer");
        const daemon = this.daemon;
        if (daemon && daemon.exitCode === null) daemon.kill("SIGKILL");
        if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
            try {
                await pollUntil(() => daemon.exitCode !== null || daemon.signalCode !== null, {
                    timeoutMs: 5_000,
                    label: "daemon process exit after SIGKILL",
                });
            } catch {
                // SIGKILL was sent; a delayed exit notification must not make teardown fail.
            }
        }
        if (this.daemon === daemon) this.daemon = null;
        this.forgetPid("daemon");
        delete process.env.MC_RUST_E2E_FOLD;
        rmSync(this.pidFilePath, { force: true });
    }
}

export const __hermeticSubcTest = {
    currentTreeCkMcBinary,
    isStaleRustE2ePidRecord,
    rustE2eCargoEnv,
    rustE2eCargoTargetDir: RUST_E2E_CARGO_TARGET_DIR,
    stalePidAgeMs: RUST_E2E_STALE_PID_AGE_MS,
};
