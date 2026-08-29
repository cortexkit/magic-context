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
import { SubcClient, type BindIdentity } from "@cortexkit/subc-client";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const MODULE_ID = "magic-context";
const RUST_E2E_PID_FILE = "rust-e2e-pids.json";
const BROCA_ID = "broca";
const BROCA_SCRIPT = join(REPO_ROOT, "packages/e2e-tests/src/rust-runner/fake-broca.ts");
const RUST_E2E_STALE_PID_AGE_MS = 30 * 60 * 1_000;

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

let buildPromise: Promise<BuiltBinaries> | null = null;

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
 * Build the module and daemon from their current workspaces, incrementally.
 *
 * `ck-mc` links protocol/client path dependencies from the sibling workspace, so
 * pairing it with any prebuilt component can exercise different source revisions.
 * Running Cargo for both workspaces keeps the hermetic pair coherent. The module
 * build always targets this checkout, even when a release preflight exported a
 * PATH fallback through `MC_E2E_CK_MC_BIN`; Cargo still reuses valid incremental
 * artifacts. Both builds use the e2e-owned target directory, avoiding either live
 * workspace's Cargo target lock. `buildPromise` serializes and memoizes the work
 * for this test process.
 */
export async function buildHermeticBinaries(subconsciousRoot: string): Promise<BuiltBinaries> {
    if (buildPromise) return buildPromise;
    buildPromise = (async () => {
        const cargoEnv = rustE2eCargoEnv();
        let ckMcBin = currentTreeCkMcBinary(process.env.MC_E2E_CK_MC_BIN);
        const moduleBuild = await runCargo(
            ["build", "--release", "-p", "mc-module"],
            REPO_ROOT,
            cargoEnv,
        );
        if (!moduleBuild.ok || !existsSync(ckMcBin)) {
            throw new Error(
                `failed to build ck-mc (cargo build --release -p mc-module):\n${moduleBuild.stderr.slice(-4000)}`,
            );
        }

        // Run the module under a dev-distinct process name so a test binary is
        // never mistaken for the production ck-mc in Activity Monitor / ps.
        // A hardlink shares the inode (no copy cost, always current build);
        // fall back to a copy across filesystems.
        const devNamed = join(dirname(ckMcBin), "ckdev-mc-e2e");
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
        const daemonBuild = await runCargo(
            ["build", "--release", "-p", "subc-core", "--bins"],
            subconsciousRoot,
            cargoEnv,
        );
        if (!daemonBuild.ok || !existsSync(ckSubcRelease)) {
            throw new Error(
                `failed to build ck-subc (cargo build --release -p subc-core --bins in ${subconsciousRoot}):\n${daemonBuild.stderr.slice(-4000)}`,
            );
        }

        return { ckMcBin, ckSubcBin: ckSubcRelease };
    })();
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
    predicate: () => boolean,
    opts: { timeoutMs: number; intervalMs?: number; label: string },
): Promise<void> {
    const intervalMs = opts.intervalMs ?? 100;
    const deadline = Date.now() + opts.timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
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
}

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
    private readonly moduleLogPath: string;
    private readonly producerLogPath: string;
    private readonly pidFilePath: string;
    private readonly startTimeoutMs: number;
    private readonly startProducer: boolean;
    private pidFileCreatedAtMs = 0;
    private readonly recordedPids = new Map<RustE2eProcessRole, number>();
    private daemon: ChildProcess | null = null;
    private module: ChildProcess | null = null;
    private producer: ChildProcess | null = null;
    private killedModulePid: number | null = null;
    private moduleRouteDropBaseline = 0;
    private killedProducerPid: number | null = null;
    private producerPid: number | null = null;
    private statusClient: SubcClient | null = null;

    private constructor(opts: Required<HermeticSubcOptions>) {
        this.dataDir = opts.dataDir;
        this.ckMcBin = opts.ckMcBin;
        this.ckSubcBin = opts.ckSubcBin;
        this.startTimeoutMs = opts.startTimeoutMs;
        this.startProducer = opts.startProducer;
        // The plugin's Rust client reads exactly this path (getDefaultConnectionFile
        // in module-transport.ts). Pointing the daemon's XDG_RUNTIME_DIR here makes it
        // write the connection file where the plugin already looks — no config knob.
        this.runtimeDir = join(this.dataDir, "cortexkit", "run");
        this.connectionFile = join(this.runtimeDir, "subc-connection.json");
        this.daemonConfigDir = join(this.dataDir, "cortexkit", "_hermetic-daemon-config");
        this.daemonLogPath = join(this.dataDir, "cortexkit", "_hermetic-daemon.log");
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
                SUBC_PORT: "0",
                // The daemon's tracing layer colorizes stdout by default, which
                // interleaves ANSI escapes THROUGH "module registered module_id=…"
                // and defeats a substring poll. NO_COLOR makes tracing emit plain
                // text (the registration check also strips ANSI as a backstop).
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
        await this.spawnModule();
        await this.waitForModuleRegistration();
        if (this.startProducer) {
            await this.spawnProducer();
            await this.waitForProducerRegistration();
            process.env.MC_RUST_E2E_FOLD = "1";
        } else {
            delete process.env.MC_RUST_E2E_FOLD;
        }
    }

    private async spawnProducer(): Promise<void> {
        this.producer = spawn(process.execPath, [BROCA_SCRIPT], {
            stdio: ["ignore", "pipe", "pipe"],
            env: {
                ...process.env,
                BROCA_CONNECTION_FILE: this.connectionFile,
                BROCA_LOG_PATH: this.producerLogPath,
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
                NO_COLOR: "1",
                SUBC_MODULE_ID: MODULE_ID,
                SUBC_LAUNCH_NONCE: "",
                // The module opens its store under this data home — the SAME dir
                // opencode uses, matching production's shared cortexkit layout.
                XDG_DATA_HOME: this.dataDir,
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

    /**
     * Registration is asynchronous relative to the daemon boot. The daemon logs
     * "module registered module_id=magic-context" once the control-plane accepts
     * it; poll that line so the first transform never races an unregistered
     * module (which the daemon rejects terminally as unknown_module).
     */
    private async waitForProducerRegistration(): Promise<void> {
        try {
            await pollUntil(() => this.registrationCount(BROCA_ID) >= 1, {
                timeoutMs: Math.min(this.startTimeoutMs, 10_000),
                label: "Broca producer registration",
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
                await pollUntil(() => this.registrationCount(MODULE_ID) >= 1, {
                    timeoutMs: Math.min(this.startTimeoutMs, 10_000),
                    label: "module registration",
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
     * Count "module registered module_id=magic-context" lines in the daemon log.
     * ANSI escapes are stripped first: the daemon's tracing layer can colorize
     * output (escapes interleave through the phrase), so a raw substring count is
     * unreliable even though NO_COLOR should suppress it. Stripping makes the poll
     * robust regardless of the daemon's color configuration.
     */
    private registrationCount(moduleId: string): number {
        if (!existsSync(this.daemonLogPath)) return 0;
        const clean = stripAnsi(readFileSync(this.daemonLogPath, "utf8"));
        const needle = `module registered module_id=${moduleId}`;
        return clean.split(needle).length - 1;
    }

    /**
     * Kill the module and bring a fresh one up against the same daemon + store.
     * Models the park-self-heal fault: a mid-session module restart whose next
     * passes must recover without permanent degradation. The 200ms settle lets
     * the OS release the single-writer store lease before the new module
     * re-acquires it (mirrors real_daemon.rs's restart step).
     */
    async restartModule(): Promise<void> {
        await this.killModuleAndWait();
        await sleep(200);
        await this.spawnModule();
        await this.waitForFreshModuleRegistration();
    }

    /** Return a killed external module without restarting the OpenCode session. */
    async restoreModule(): Promise<void> {
        await sleep(200);
        await this.spawnModule();
        await this.waitForFreshModuleRegistration();
    }

    /** Kill only the module process (leaving the daemon up), for fault injection. */
    killModule(): void {
        this.moduleRouteDropBaseline = this.routeDropCount();
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
            () => !isProcessAlive(pid) && this.routeDropLogged(),
            { timeoutMs, label: "module death and daemon route drop" },
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

    async moduleStatus(
        sessionId: string,
        projectRoot: string,
        method: "status" | "session.status" = "status",
    ): Promise<Record<string, unknown>> {
        const identity: BindIdentity = { project_root: resolve(projectRoot), harness: "opencode", session: sessionId };
        const client = this.statusClient ?? (this.statusClient = await SubcClient.connect({
            connectionFile: this.connectionFile,
            identity,
            targetKind: "tool_provider",
        }));
        let route: Awaited<ReturnType<SubcClient["routeOpen"]>> | null = null;
        try {
            route = await client.routeOpen(
                { kind: "tool_provider", module_id: MODULE_ID },
                identity,
                { consumerIdentity: null },
            );
            const response = await client.request(route, { method, v: 1, session_id: sessionId });
            return (response && typeof response === "object" ? response : {}) as Record<string, unknown>;
        } catch (error) {
            client.close();
            if (this.statusClient === client) this.statusClient = null;
            throw error;
        } finally {
            if (route) await client.closeRoute(route).catch(() => undefined);
        }
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
        const log = stripAnsi(this.daemonLog());
        if (log.includes(MODULE_ID) && /supervis/.test(log)) {
            throw new Error("Rust outage drill precondition failed: daemon reported magic-context as supervised");
        }
    }

    /**
     * After a restart the daemon log already contains the FIRST registration
     * line, so a plain presence check would return immediately. Wait until the
     * registration-line COUNT grows past what was present before the restart.
     */
    private registrationTarget = 1;
    private routeDropCount(): number {
        const clean = stripAnsi(this.daemonLog());
        return (
            clean.match(
                /route[_ ](?:gone|dropped|closed)|(?:gone|dropped|closed).*route|supervised module exited abnormally.*exit_signal=Some\(9\)/gi,
            ) ?? []
        ).length;
    }

    private routeDropLogged(): boolean {
        return this.routeDropCount() > this.moduleRouteDropBaseline;
    }

    private async waitForFreshModuleRegistration(): Promise<void> {
        this.registrationTarget += 1;
        const target = this.registrationTarget;
        await pollUntil(() => this.registrationCount(MODULE_ID) >= target, {
            timeoutMs: this.startTimeoutMs,
            label: "module re-registration after restart",
        });
    }

    private pipeToLog(child: ChildProcess, logPath: string, _tag: string): void {
        // Drain BOTH streams continuously: an undrained pipe fills the OS buffer
        // and the child blocks mid-boot on a write (the exact spurious-hang
        // real_daemon.rs documents). The ck-subc daemon logs its control-plane
        // events (including "module registered …") to STDOUT via tracing, while
        // ck-mc logs to STDERR — so capturing only one stream would miss the
        // registration line the boot poll waits on. Both are folded into one log
        // file, preserved for post-mortem when a scenario fails.
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

    /** Best-effort read of the module log (diagnostics on failure). */
    moduleLog(): string {
        try {
            return readFileSync(this.moduleLogPath, "utf8");
        } catch {
            return "";
        }
    }

    /** Hard teardown. Safe to call more than once; never throws. */
    async stop(): Promise<void> {
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

/** Remove ANSI/VT100 escape sequences so plain-text substring checks are reliable. */
function stripAnsi(input: string): string {
    // Matches CSI sequences like \x1b[32m and \x1b[0m that tracing emits for color.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are control chars by definition.
    return input.replace(/\x1b\[[0-9;]*m/g, "");
}
