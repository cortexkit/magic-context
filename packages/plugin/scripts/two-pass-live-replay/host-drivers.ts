import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { ReportedProfile } from "../../src/features/magic-context/memory/lifecycle-gates";
import { lifecycleTextHash } from "../../src/features/magic-context/memory/lifecycle-text";
import { hasHistorianToolActivity } from "../../src/features/magic-context/memory/historian-wire";
import {
    lifecycleToolHash,
    type TurnTwoEntry,
} from "../../src/features/magic-context/memory/turn-two-allowlist";
import type {
    HiddenCompletionExecutor,
    HiddenRunHandle,
} from "../../src/hooks/magic-context/compartment-runner-types";
import {
    openCodeTurnTwoToolSurface,
    reportedProfile,
} from "../../src/hooks/magic-context/historian-turn-two-carrier";
import { modelBodyField } from "../../src/shared/resolve-fallbacks";
import type { SubagentRunOptions, SubagentRunResult } from "../../src/shared/subagent-runner";
import type { SendRecord, UsageStep } from "./artifact-schema";

export interface HandleProof {
    pid: number;
    tool: string;
    output: string;
    paths: string[];
}
export interface Isolation {
    root: string;
    env: Record<string, string>;
    proof: HandleProof;
}
const variables = [
    "XDG_DATA_HOME",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "XDG_RUNTIME_DIR",
    "OPENCODE_DB",
    "MAGIC_CONTEXT_STORAGE_DIR",
] as const;
function within(root: string, path: string): boolean {
    const rel = relative(root, path);
    return !!rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
export function disposableEnvironment(root: string): Record<string, string> {
    if (
        resolve(root) !== root ||
        realpathSync(root) !== root ||
        !within(join(realpathSync(tmpdir()), "magic-context"), root)
    )
        throw new Error("non_disposable_root");
    return Object.fromEntries(
        variables.map((key, i) => [
            key,
            join(root, i === 4 ? "host/opencode.db" : key.toLowerCase()),
        ]),
    );
}
export function verifyIsolation(isolation: Isolation): void {
    disposableEnvironment(isolation.root);
    if (
        variables.some(
            (key) => !isolation.env[key] || !within(isolation.root, resolve(isolation.env[key])),
        )
    )
        throw new Error("isolation_environment");
    for (const key of variables) {
        let ancestor = resolve(isolation.env[key]);
        while (!existsSync(ancestor)) ancestor = dirname(ancestor);
        const canonical = realpathSync(ancestor);
        if (canonical !== isolation.root && !within(isolation.root, canonical))
            throw new Error("symlinked_environment");
    }
    const { proof } = isolation;
    if (
        !Number.isInteger(proof.pid) ||
        proof.pid <= 0 ||
        !proof.tool ||
        !proof.output ||
        !proof.paths.some((path) => within(isolation.root, path))
    )
        throw new Error("open_handle_proof");
    if (
        proof.paths.some((path) =>
            /[/\\]\.local[/\\]share[/\\]opencode[/\\]|[/\\]\.local[/\\]share[/\\]cortexkit[/\\]magic-context[/\\](context|store)\.db|[/\\]\.config[/\\](opencode|cortexkit)[/\\]/.test(
                path,
            ),
        )
    )
        throw new Error("live_store_handle");
    if (proof.paths.some((path) => /\.db(?:-(?:wal|shm|journal))?(?: \(deleted\))?$/.test(path) && !within(isolation.root, path)))
        throw new Error("database_outside_disposable_root");
}
/** Inspect the host, not the runner: provider traffic must originate in the isolated host. */
export async function attestHost(
    root: string,
    env: Record<string, string>,
    pid: number,
): Promise<Isolation> {
    let proof: HandleProof;
    try {
        const { stdout } = await promisify(execFile)("lsof", ["-Fpn", "-p", String(pid)]);
        proof = {
            pid,
            tool: "lsof -Fpn",
            output: stdout,
            paths: stdout
                .split("\n")
                .filter((line) => line.startsWith("n/"))
                .map((line) => line.slice(1)),
        };
    } catch (error) {
        if (process.platform !== "linux" || (error as NodeJS.ErrnoException).code !== "ENOENT")
            throw error;
        const paths = readdirSync(`/proc/${pid}/fd`).flatMap((fd) => {
            try {
                return [readlinkSync(`/proc/${pid}/fd/${fd}`)];
            } catch {
                return [];
            }
        });
        proof = { pid, tool: "/proc/pid/fd", output: paths.join("\n"), paths };
    }
    const isolation = { root, env, proof };
    verifyIsolation(isolation);
    return isolation;
}

/** Inspect live Linux descendants while a provider request keeps its originating child alive. */
export async function attestProcessTree(root: string, env: Record<string, string>, pid: number): Promise<Isolation[]> {
    const pending = [pid];
    const seen = new Set<number>();
    const proofs: Isolation[] = [];
    while (pending.length) {
        const current = pending.shift()!;
        if (seen.has(current)) continue;
        seen.add(current);
        try { proofs.push(await attestHost(root, env, current)); }
        catch (error) { if (current === pid || existsSync(`/proc/${current}`)) throw error; else continue; }
        if (process.platform !== "linux") continue;
        let tids: string[];
        try { tids = readdirSync(`/proc/${current}/task`); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && current !== pid) continue; throw error; }
        for (const tid of tids) {
            try {
                pending.push(...readFileSync(`/proc/${current}/task/${tid}/children`, "utf8").trim().split(/\s+/)
                    .filter(Boolean).map(Number).filter((child) => Number.isSafeInteger(child) && child > 0));
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
    }
    return proofs;
}
export interface HostReply {
    text: string;
    profile: ReportedProfile | null;
    lengthCapped: boolean;
    toolActivity?: boolean;
    steps?: UsageStep[];
    chargeUSD?: number;
    rateLimitedOrRefused?: boolean;
}
export interface HostChild {
    id: string;
    readonly lastRequest?: unknown;
    send(prompt: string, continuation: boolean, key: string): Promise<HostReply>;
    close(retainForRecovery?: boolean): Promise<void>;
}
export interface HostDriver {
    lane: TurnTwoEntry["lane"];
    carrier: TurnTwoEntry["carrier"];
    isolation: Isolation;
    transport: "real-host" | "fake";
    attest(): Promise<Isolation>;
    historianTools: unknown;
    checkTools: unknown;
    maxSteps: number;
    hostRetryLimit: number;
    open(system: string, format: string, kind: SendRecord["kind"]): Promise<HostChild>;
}

/** The executor must belong to the real host launched with the supplied isolated environment. */
export function openCodeDriver(args: {
    executor: HiddenCompletionExecutor;
    host: {
        pid: number;
        harness: "opencode" | "opencode2";
        carrier: "hidden-completion" | "opencode-session";
    };
    testHandleListing?: typeof attestHost;
    isolation: Isolation;
    entry: TurnTwoEntry;
    parentSessionId: string;
    agent: string;
    timeoutMs: number;
    outputCeiling: number;
    hostRetryLimit: number;
    observedToolSurface?: readonly string[];
    /** Use host counters for every provider step; Magic Context's OpenCode 2 collector retains only the final step. */
    observeUsage(
        childId: string,
        sendKey: string,
    ): Promise<{ steps?: UsageStep[]; chargeUSD?: number }>;
}): HostDriver {
    verifyIsolation(args.isolation);
    const { entry, executor } = args;
    const { harness, carrier } = args.host;
    const lane = harness === "opencode" ? "opencode-1" : "opencode-2";
    if (
        executor.capabilities.harness !== harness ||
        args.host.pid !== args.isolation.proof.pid ||
        lane !== entry.lane ||
        carrier !== entry.carrier ||
        (lane === "opencode-2" && carrier !== "hidden-completion")
    )
        throw new Error("host_lane");
    const tools = openCodeTurnTwoToolSurface({
        harness,
        carrier,
        agent: args.agent,
        provider: entry.provider,
        observedToolSurface: args.observedToolSurface,
    });
    if (tools === undefined) throw new Error("unobserved_tool_surface");
    return {
        lane,
        carrier,
        isolation: args.isolation,
        transport: args.testHandleListing ? "fake" : "real-host",
        attest: () =>
            (args.testHandleListing ?? attestHost)(
                args.isolation.root,
                args.isolation.env,
                args.host.pid,
            ),
        historianTools: tools,
        checkTools: tools,
        maxSteps: 4,
        hostRetryLimit: args.hostRetryLimit,
        async open(system, format, kind) {
            const model = {
                model: `${entry.provider}/${entry.modelId}`,
                ...(entry.variant ? { qualifier: entry.variant } : {}),
            };
            const opening: Parameters<HiddenCompletionExecutor["open"]>[0] = {
                parentSessionId: args.parentSessionId,
                agent: args.agent,
                kind: "historian",
                system,
                model,
                configuredModels: [model],
                timeoutMs: args.timeoutMs,
                maxOutputTokens: args.outputCeiling,
                title: `magic-context-replay-${kind}`,
                directory: args.isolation.root,
                ...(kind === "check" ? { metadata: { memoryCheck: true } } : {}),
            };
            const handle: HiddenRunHandle = await executor.open(opening);
            let lastRequest: unknown;
            return {
                id: handle.childSessionId ?? handle.id,
                get lastRequest() {
                    return lastRequest;
                },
                async send(prompt, continuation, key) {
                    const request: Parameters<HiddenCompletionExecutor["attempt"]>[1] = {
                        path: { id: handle.id },
                        query: { directory: args.isolation.root },
                        ...(continuation ? { continueConversation: true } : {}),
                        body: {
                            agent: args.agent,
                            ...modelBodyField(model),
                            ...(!continuation ? { system } : {}),
                            parts: [{ type: "text", text: prompt, synthetic: true }],
                        },
                    };
                    lastRequest = { open: opening, attempt: request, sendKey: key };
                    await executor.attempt(handle, request);
                    const completion = await executor.collect(handle, 50);
                    return {
                        text: completion.text ?? "",
                        lengthCapped: completion.lengthCapped,
                        toolActivity: hasHistorianToolActivity(completion),
                        profile: reportedProfile(
                            completion,
                            model,
                            lifecycleTextHash(system),
                            { harness, carrier, agent: args.agent },
                            format,
                        ),
                        ...(await args.observeUsage(handle.childSessionId ?? handle.id, key)),
                    };
                },
                async close(retainForRecovery) {
                    await executor.close(handle, {
                        promptSettled: true,
                        retainForRecovery,
                        privacySensitive: false,
                        context: "live-replay",
                        log: () => {},
                    });
                },
            };
        },
    };
}

/** A minimal interface for PiRpcHistorianRunner's retained-child method. */
export interface RetainedRpcRunner {
    runRetainedHistorian(
        options: SubagentRunOptions,
        key?: string,
    ): Promise<{
        child: {
            id: string;
            send(prompt: string, key: string): Promise<SubagentRunResult>;
            close(): Promise<void>;
        } | null;
        result: SubagentRunResult;
    }>;
}
export function piRpcDriver(args: {
    runner: RetainedRpcRunner;
    hostPid: number;
    testHandleListing?: typeof attestHost;
    harness: "pi" | "omp";
    isolation: Isolation;
    entry: TurnTwoEntry;
    timeoutMs: number;
    outputCeiling: number;
    configuredTemperature?: number;
    configuredThinkingLevel?: string;
    observeUsage(
        childId: string,
        sendKey: string,
    ): Promise<{ steps?: UsageStep[]; chargeUSD?: number }>;
}): HostDriver {
    verifyIsolation(args.isolation);
    const { entry } = args;
    if (
        args.hostPid !== args.isolation.proof.pid ||
        args.harness !== entry.lane ||
        entry.carrier !== "pi-historian-rpc" ||
        entry.variant !== null
    )
        throw new Error("host_lane");
    return {
        lane: entry.lane,
        carrier: entry.carrier,
        isolation: args.isolation,
        transport: args.testHandleListing ? "fake" : "real-host",
        attest: () =>
            (args.testHandleListing ?? attestHost)(
                args.isolation.root,
                args.isolation.env,
                args.hostPid,
            ),
        historianTools: [],
        checkTools: [],
        maxSteps: 4,
        hostRetryLimit: 0,
        async open(system, format) {
            let child: Awaited<ReturnType<RetainedRpcRunner["runRetainedHistorian"]>>["child"];
            let lastRequest: unknown;
            let opening: SubagentRunOptions | undefined;
            return {
                get lastRequest() {
                    return lastRequest;
                },
                get id() {
                    return child?.id ?? "rpc-not-started";
                },
                async send(prompt, continuation, key) {
                    let result: SubagentRunResult;
                    if (continuation) {
                        if (!child) throw new Error("rpc_child_missing");
                        lastRequest = { open: opening, childId: child.id, prompt, sendKey: key };
                        result = await child.send(prompt, key);
                    } else {
                        opening = {
                            agent: "historian",
                            systemPrompt: system,
                            userMessage: prompt,
                            model: `${entry.provider}/${entry.modelId}`,
                            fallbackModels: undefined,
                            cwd: args.isolation.root,
                            timeoutMs: args.timeoutMs,
                            maxOutputTokens: args.outputCeiling,
                            temperature: args.configuredTemperature,
                            thinkingLevel: args.configuredThinkingLevel,
                        };
                        lastRequest = { open: opening, sendKey: key };
                        const opened = await args.runner.runRetainedHistorian(opening, key);
                        child = opened.child;
                        result = opened.result;
                    }
                    if (!result.ok) throw new Error("rpc_send_failed");
                    return {
                        text: result.assistantText,
                        lengthCapped: result.meta?.lengthCapped === true,
                        toolActivity: hasHistorianToolActivity(result.meta),
                        profile:
                            typeof result.meta?.reportedProvider === "string" &&
                            typeof result.meta.reportedModel === "string"
                                ? {
                                      lane: args.harness,
                                      carrier: "pi-historian-rpc",
                                      provider: result.meta.reportedProvider,
                                      modelId: result.meta.reportedModel,
                                      variant: entry.variant,
                                      temperature: null,
                                      thinkingLevel: null,
                                      systemHash: lifecycleTextHash(system),
                                      schemaHash: lifecycleTextHash(format),
                                      toolHash: lifecycleToolHash([]),
                                  }
                                : null,
                        ...(await args.observeUsage(child?.id ?? "", key)),
                    };
                },
                async close(retainForRecovery) {
                    if (!retainForRecovery) await child?.close();
                },
            };
        },
    };
}
