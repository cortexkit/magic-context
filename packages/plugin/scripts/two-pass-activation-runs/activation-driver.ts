import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { Readable, Writable } from "node:stream";
import { secretForms } from "./credential-protocol";
import { Database } from "../../src/shared/sqlite";
import type { TurnTwoEntry } from "../../src/features/magic-context/memory/turn-two-allowlist";
import {
    CampaignLedger,
    CostStop,
    hash,
    type Profile,
    type SendRecord,
    type UsageStep,
} from "../two-pass-live-replay/artifact-schema";
import {
    attestHost,
    disposableEnvironment,
    verifyIsolation,
    type Isolation,
} from "../two-pass-live-replay/host-drivers";

export function underRoot(root: string, path: string): string {
    const rel = relative(root, resolve(path));
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
        throw new Error("outside_disposable_root");
    // Check existing ancestors too: a not-yet-created file can escape through a symlink.
    let ancestor = resolve(path);
    for (;;) {
        try {
            const canonical = realpathSync(ancestor);
            if (canonical !== root && !canonical.startsWith(`${root}${sep}`))
                throw new Error("symlinked_disposable_path");
            break;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            ancestor = resolve(ancestor, "..");
        }
    }
    return resolve(path);
}

export function redact(value: unknown, secrets: readonly string[] = []): unknown {
    if (typeof value === "string")
        return secrets
            .flatMap(secretForms)
            .reduce((text, secret) => text.split(secret).join("[REDACTED]"), value)
            .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]");
    if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
    if (value && typeof value === "object")
        return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [
                key,
                /^(authorization|x-api-key|api[_-]?key|.*_API_KEY|credential|secret|access_token)$/i.test(
                    key,
                )
                    ? "[REDACTED]"
                    : redact(item, secrets),
            ]),
        );
    return value;
}

export type CredentialId = `apikey:${string}`;
export interface ScopedCredentials {
    /** Wrap credential.get_scoped from the credential broker; never read keys from config files. */
    getScoped(id: CredentialId): Promise<string>;
    notifyRunEnded(id: CredentialId): Promise<void>;
}

export async function withCredential<T>(
    credentials: ScopedCredentials | undefined,
    id: CredentialId | undefined,
    fake: boolean,
    run: (env: Record<string, string>, secrets: string[]) => Promise<T>,
): Promise<T> {
    if (!id) return run({}, []);
    if (!credentials) throw new Error("credential_get_scoped_required");
    if (!fake && process.platform !== "darwin") throw new Error("scoped_credentials_mac_only");
    let secret: string;
    try {
        secret = await credentials.getScoped(id);
    } catch {
        throw new Error("credential_fetch_failed");
    }
    if (!secret) throw new Error("empty_scoped_credential");
    const key = id === "apikey:cline-pass" ? "CLINE_API_KEY" : "ANTHROPIC_API_KEY";
    const env = { [key]: secret };
    let credentialStop = false;
    try {
        return await run(env, [secret]);
    } catch (error) {
        credentialStop = error instanceof Error && ["credential_no_credit", "credential_rate_limited"].includes(error.message);
        if (error instanceof PostGateBudgetStop || (error instanceof Error &&
            ["credential_no_credit", "credential_rate_limited"].includes(error.message))) throw error;
        throw new Error("scoped_run_failed");
    } finally {
        delete env[key];
        secret = "";
        try {
            await credentials.notifyRunEnded(id);
        } catch {
            if (!credentialStop) throw new Error("credential_revoke_notification_failed");
        }
    }
}

export interface CallBound {
    kind: SendRecord["kind"];
    inputTokens: number;
    outputCeiling: number;
    maxSteps: number;
    hostRetries: number;
}
export interface CallMeter {
    beforeSend(bound: CallBound): number;
    settle(id: number, steps?: UsageStep[], chargeUSD?: number): void;
}
export class PostGateBudgetStop extends CostStop {
    readonly requiresOwnerDecision = true;
}
export function callMeter(ledger: CampaignLedger, profile: Profile): CallMeter {
    const owned = new Set<number>();
    return {
        beforeSend(bound) {
            try {
                const id = ledger.reserve(
                    profile,
                    bound.kind,
                    bound.inputTokens,
                    bound.outputCeiling,
                    bound.maxSteps,
                    bound.hostRetries,
                );
                owned.add(id);
                return id;
            } catch (error) {
                if (error instanceof CostStop) throw new PostGateBudgetStop(error.message);
                throw error;
            }
        },
        settle(id, steps, chargeUSD) {
            if (!owned.has(id)) throw new Error("foreign_cost_reservation");
            ledger.settle(id, steps, chargeUSD);
        },
    };
}

export interface ActivationHost {
    pid: number;
    lane: TurnTwoEntry["lane"];
    carrier: TurnTwoEntry["carrier"] | "unobservable";
    pluginEntrypoint: string;
    /** Null until a lazy host has actually opened the plugin store; never infer a successful binding from a filename. */
    storePath: string | null;
    /** Wait for background historian work and record host cache-rebuild events before returning. */
    runSession(prompt: string): Promise<unknown>;
    stop(): Promise<void>;
}
export interface ActivationTransport {
    kind: "real-host" | "fake";
    /** Stage host/plugin sources only under installRoot; never modify an installed live host. */
    stage(installRoot: string): Promise<void>;
    /** Build after the candidate JSON is written; return the built entrypoint loaded by the host. */
    build(installRoot: string, candidatePath: string): Promise<string>;
    /** Gate every provider dispatch (including checks/retries) with meter.beforeSend. */
    start(input: {
        installRoot: string;
        pluginEntrypoint: string;
        env: Record<string, string>;
        meter: CallMeter;
    }): Promise<ActivationHost>;
    testAttest?: typeof attestHost;
}

export interface Command {
    argv: [string, ...string[]];
    cwd: string;
}

/** Host-specific connection code supplies session RPC and a pre-dispatch provider-cost hook. */
export function processActivationTransport(plan: {
    stage(installRoot: string): Command;
    build(installRoot: string): Command;
    entrypoint(installRoot: string): string;
    launch(input: { installRoot: string; pluginEntrypoint: string; env: Record<string, string>; meter: CallMeter }): Command | Promise<Command>;
    connect(input: {
        pid: number;
        env: Record<string, string>;
        meter: CallMeter;
        installRoot: string;
        stdout: Readable;
        stderr: Readable;
        stdin: Writable;
    }): Promise<Omit<ActivationHost, "pid" | "pluginEntrypoint" | "stop">>;
    stopped?(): Promise<void>;
}): ActivationTransport {
    const buildEnvironment = (installRoot: string) => {
        const root = resolve(installRoot, "..");
        const env = { ...disposableEnvironment(root), HOME: join(root, "home"), TMPDIR: join(root, "tmp"), XDG_CACHE_HOME: join(root, "cache") };
        for (const [key, path] of Object.entries(env)) mkdirSync(key === "OPENCODE_DB" ? resolve(path, "..") : path, { recursive: true, mode: 0o700 });
        return { PATH: process.env.PATH, ...env };
    };
    return {
        kind: "real-host",
        async stage(root) {
            const command = plan.stage(root);
            await promisify(execFile)(command.argv[0], command.argv.slice(1), { cwd: command.cwd, env: buildEnvironment(root), maxBuffer: 32 * 1024 * 1024 });
        },
        async build(root) {
            const command = plan.build(root);
            await promisify(execFile)(command.argv[0], command.argv.slice(1), { cwd: command.cwd, env: buildEnvironment(root), maxBuffer: 32 * 1024 * 1024 });
            return plan.entrypoint(root);
        },
        async start(input) {
            const credentialKeys = Object.keys(input.env).filter((key) => key.endsWith("_API_KEY"));
            const secrets = credentialKeys.map((key) => input.env[key]);
            const forgetInput = () => { for (const key of credentialKeys) delete input.env[key]; };
            const cleanup = async () => {
                forgetInput();
                try { await plan.stopped?.(); } finally { secrets.fill(""); }
            };
            let command: Command;
            try {
                command = await plan.launch(input);
                if (secrets.some((secret) => !secret)) throw new Error("empty_prefetched_credential");
                if (secrets.some((secret) => command.argv.some((arg) => arg.includes(secret))))
                    throw new Error("credential_in_argv");
            } catch (error) { await cleanup(); throw error; }
            let child: ReturnType<typeof spawn>;
            try { child = spawn(command.argv[0], command.argv.slice(1), {
                cwd: command.cwd,
                env: {
                    PATH: process.env.PATH,
                    HOME: resolve(input.installRoot, ".."),
                    ...input.env,
                },
                // Connection code consumes the endpoint handoff. The mock adapter saves raw logs privately, not in returned evidence.
                stdio: ["pipe", "pipe", "pipe"],
                detached: process.platform !== "win32",
            }); } catch { await cleanup(); throw new Error("host_spawn_failed"); }
            // The child has its own environment copy; keep no material in the caller's map.
            forgetInput();
            const streamsClosed = new Promise<void>((resolve) => child.once("close", () => resolve()));
            try {
                await new Promise<void>((resolve, reject) => {
                    child.once("spawn", resolve);
                    child.once("error", reject);
                });
            } catch { await cleanup(); throw new Error("host_spawn_failed"); }
            const signal = (value: NodeJS.Signals) => {
                try {
                    if (process.platform === "win32") child.kill(value);
                    else process.kill(-child.pid!, value);
                } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
            };
            let stopped = false;
            const stop = async () => {
                if (stopped) return;
                stopped = true;
                if (child.exitCode !== null || child.signalCode !== null) { signal("SIGKILL"); await streamsClosed; await cleanup(); return; }
                const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
                signal("SIGTERM");
                const timer = setTimeout(() => signal("SIGKILL"), 5000);
                try {
                    await exited;
                } finally {
                    clearTimeout(timer);
                    signal("SIGKILL");
                    // Drain final log chunks before dropping their redaction material.
                    await streamsClosed;
                    await cleanup();
                }
            };
            try {
                const host = await plan.connect({
                    pid: child.pid!,
                    env: input.env,
                    meter: input.meter,
                    installRoot: input.installRoot,
                    stdout: child.stdout!,
                    stderr: child.stderr!,
                    stdin: child.stdin!,
                });
                return Object.assign(host, { pid: child.pid!, pluginEntrypoint: input.pluginEntrypoint, stop });
            } catch {
                await stop();
                throw new Error("host_connection_failed");
            }
        },
    };
}

export function readPluginStore(root: string, storePath: string) {
    const path = underRoot(root, storePath);
    const db = new Database(path, { readonly: true });
    try {
        return {
            stages: db
                .prepare("SELECT * FROM memory_stage_attempts ORDER BY started_at,stage_key")
                .all(),
            receipts: db
                .prepare("SELECT * FROM memory_decision_receipts ORDER BY decision_key")
                .all(),
            history: db.prepare("SELECT * FROM memory_history ORDER BY id").all(),
            pending: db.prepare("SELECT * FROM memory_pending_facts ORDER BY id").all(),
            journal: db.prepare("SELECT * FROM memory_journal ORDER BY decision_key").all(),
            appliedSnapshots: db
                .prepare("SELECT * FROM memory_applied_snapshots ORDER BY session_id")
                .all(),
            memories: db
                .prepare("SELECT id,project_path,content,status,revision FROM memories ORDER BY id")
                .all(),
        };
    } finally {
        db.close();
    }
}

/** A plausible filename is not evidence that the launched plugin opened that store. */
export function assertObservedPluginStore(isolation: Isolation, storePath: string): string {
    const path = underRoot(isolation.env.MAGIC_CONTEXT_STORAGE_DIR, storePath);
    if (!isolation.proof.paths.some((open) => open === path || open === `${path}-wal`))
        throw new Error("plugin_store_not_open_by_host");
    const db = new Database(path, { readonly: true });
    try {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
        for (const table of ["memories", "memory_stage_attempts", "memory_decision_receipts", "memory_history"])
            if (!tables.some((row) => row.name === table)) throw new Error("not_plugin_store");
    } finally {
        db.close();
    }
    return path;
}

/** The turn-two authorization entry comes from the candidate JSON compiled into this isolated build. */
export async function runActivation(options: {
    root: string;
    profile: Profile;
    ledger: CampaignLedger;
    transport: ActivationTransport;
    sessions: readonly string[];
    credentials?: ScopedCredentials;
}) {
    const { root, profile, transport } = options;
    const env = disposableEnvironment(root);
    if (profile.entry.lane === "pi" || options.sessions.length < 1 || options.sessions.length > 3)
        throw new Error("activation_sessions_or_lane");
    if (transport.kind === "real-host" && transport.testAttest) throw new Error("fake_attestation");
    const installRoot = underRoot(root, join(root, "install"));
    mkdirSync(installRoot, { recursive: true });
    await transport.stage(installRoot);
    const candidatePath = underRoot(
        root,
        join(
            installRoot,
            "packages/plugin/src/features/magic-context/memory/turn-two-allowlist.json",
        ),
    );
    const candidate = { version: 1, entries: [profile.entry] };
    mkdirSync(resolve(candidatePath, ".."), { recursive: true });
    writeFileSync(candidatePath, JSON.stringify(candidate, null, 2));
    const pluginEntrypoint = underRoot(
        installRoot,
        await transport.build(installRoot, candidatePath),
    );
    if (hash(JSON.parse(readFileSync(candidatePath, "utf8"))) !== hash(candidate))
        throw new Error("candidate_changed_during_build");
    const builtHash = hash(readFileSync(pluginEntrypoint, "utf8"));
    const id = profile.entry.provider === "cline-pass" ? "apikey:cline-pass" : undefined;
    return withCredential(
        options.credentials,
        id,
        transport.kind === "fake",
        async (credentialEnv, secrets) => {
            let host: ActivationHost | undefined;
            try {
                host = await transport.start({
                    installRoot,
                    pluginEntrypoint,
                    env: { ...env, ...credentialEnv },
                    meter: callMeter(options.ledger, profile),
                });
                if (
                    host.lane !== profile.entry.lane ||
                    (host.carrier !== "unobservable" && host.carrier !== profile.entry.carrier) ||
                    host.pluginEntrypoint !== pluginEntrypoint
                )
                    throw new Error("activation_host_binding");
                const attest = transport.testAttest ?? attestHost;
                const isolation: Isolation = await attest(root, env, host.pid);
                if (isolation.root !== root || isolation.proof.pid !== host.pid)
                    throw new Error("host_attestation_binding");
                verifyIsolation(isolation);
                if (host.storePath !== null) {
                    underRoot(env.MAGIC_CONTEXT_STORAGE_DIR, host.storePath);
                    if (transport.kind === "real-host") assertObservedPluginStore(isolation, host.storePath);
                }
                const sessions = [];
                const proofs = [isolation.proof];
                for (const prompt of options.sessions) {
                    sessions.push(await host.runSession(prompt));
                    if (host.carrier !== profile.entry.carrier) throw new Error("activation_carrier_unobserved_or_mismatched");
                    const after = await attest(root, env, host.pid);
                    if (after.root !== root || after.proof.pid !== host.pid)
                        throw new Error("host_attestation_binding");
                    verifyIsolation(after);
                    if (host.storePath === null) throw new Error("plugin_store_unobservable");
                    if (transport.kind === "real-host") assertObservedPluginStore(after, host.storePath);
                    proofs.push(after.proof);
                }
                if (host.storePath === null) throw new Error("plugin_store_unobservable");
                const store = readPluginStore(root, host.storePath);
                return redact(
                    {
                        purpose: "activation",
                        lane: host.lane,
                        carrier: host.carrier,
                        candidate,
                        candidateHash: hash(candidate),
                        builtHash,
                        pluginEntrypoint,
                        isolation,
                        proofs,
                        storePath: host.storePath,
                        sessions,
                        store,
                    },
                    secrets,
                );
            } catch (error) {
                if (error instanceof PostGateBudgetStop) throw error;
                // Host errors can contain echoed environment values; never propagate them into artifacts.
                throw new Error("activation_failed");
            } finally {
                if (host) {
                    try {
                        await host.stop();
                    } catch {
                        throw new Error("activation_stop_failed");
                    }
                }
            }
        },
    );
}
