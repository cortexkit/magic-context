/**
 * Live-provider scenario runner: real OpenCode 1.18.30, the locally built Magic Context
 * plugin, real provider endpoints, keys from CKCRED. Opt-in only.
 *
 *   MC_LIVE_PROVIDERS=1 bun packages/e2e-tests/src/live-providers/runner.ts \
 *     [--opencode /abs/opencode-1.18.30] [--out "$TMPDIR/magic-context/live-providers/<run>"] \
 *     [--only claude-oauth:trim-only] [--providers anthropic,kimi-for-coding] \
 *     [--anthropic-auth /abs/anthropic-auth/packages/opencode/dist/index.js] \
 *     [--openai-auth /abs/openai-auth/packages/opencode/dist/index.js] \
 *     [--models-catalog /abs/models.dev-api.json] [--keep-bodies]
 *
 * `--models-catalog` copies a models.dev `api.json` into the host cache, so OpenCode resolves
 * current model ids (its bundled catalogue predates some of them). `MC_LIVE_MAX_CALLS` lowers
 * the run's call cap (default 200).
 *
 * Each scenario runs in its own throwaway root (see host.ts) and drives one session:
 *   turn-1   a tool loop of `loopSteps` single bash calls, so assistant steps pile up reasoning;
 *   (drop)   a `drop` queued in pending_ops on the oldest tool tag, as `ctx_reduce` would queue it;
 *   flush    `/ctx-flush`, which makes the next pass a rebuilding pass;
 *   turn-2.. three more turns of one bash call each; the first pass of turn-2 is where the
 *            age lane (or the queued drop) takes reasoning off the wire.
 *
 * `keep_reasoning_tokens` is a nonnegative integer; an invalid value would
 * silently fall back to the default, so the runner refuses to start when the host logs a
 * config warning.
 *
 * Every provider call goes through the loopback recorder, which keeps status, error text,
 * usage and the request's reasoning map (`R` = step still carries reasoning, `-` = it does
 * not). Results land in `<out>/results.json`; secrets never do.
 */
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fetchCredential, type CredentialId } from "./ckcred";
import { assertThrowawayRoot, authPluginPath } from "./auth";
import { readIfExists, startHost, type Host } from "./host";
import { startRecorder } from "./recorder";
import { ALL_SCENARIOS, scenarioId } from "./scenarios";
import { qualifyTrimOnly } from "./trim-only";
import type { AuthPlugin, CallRecord, ScenarioResult, ScenarioSpec, ScenarioSummary } from "./types";
import { scrubError } from "./wire";

/** Upper bound on provider calls for one run, across every scenario. */
export const RUN_CALL_CAP = Number(process.env.MC_LIVE_MAX_CALLS ?? 200);
/** A single request billing more input than this is unexpected for these sessions. */
const UNEXPECTED_INPUT_TOKENS = 120_000;
const FOLLOW_UP_TURNS = 3;

export interface RunOptions {
    opencode: string;
    out: string;
    only: string[] | null;
    /** OpenCode provider ids to run (`anthropic,kimi-for-coding`); null runs all. */
    providers?: string[] | null;
    modelsCatalog?: string;
    /** Also write every request body (no headers, so no keys) under `<out>/bodies/`. */
    keepBodies?: boolean;
    authPlugins?: Partial<Record<AuthPlugin, string>>;
    /** Explicit single account selection, never an account-rotation loop. */
    claudeCredential?: CredentialId;
}

function loopPrompt(steps: number): string {
    const commands = Array.from({ length: steps }, (_, i) => `\`echo step-${i + 1}\``).join(", ");
    return [
        "This is an automated harness check. Use the bash tool exactly",
        `${steps} times, one command per tool call and one tool call per response (never in parallel):`,
        `${commands}.`,
        "Before each call, think briefly about which step comes next.",
        "Do not use any other tool. After the last result, reply with the single word DONE.",
    ].join(" ");
}

function followUpPrompt(turn: number): string {
    return `Use the bash tool once to run \`echo turn-${turn}\`, then reply with the single word DONE.`;
}

/** True when this request shows reasoning (or a tool pair) gone compared with the one before. */
function showsRemoval(previous: CallRecord, current: CallRecord): boolean {
    const a = previous.request;
    const b = current.request;
    if (b.reasoningItems < a.reasoningItems || b.toolCalls < a.toolCalls) return true;
    const length = Math.min(a.reasoningMap.length, b.reasoningMap.length);
    for (let i = 0; i < length; i++) if (a.reasoningMap[i] === "R" && b.reasoningMap[i] === "-") return true;
    return false;
}

export function summarize(calls: CallRecord[]): ScenarioSummary {
    const loop = calls.filter((call) => call.request.kind === "loop");
    let firstRemoval: CallRecord | null = null;
    let before: CallRecord | null = null;
    for (let i = 1; i < loop.length && !firstRemoval; i++) {
        const previous = loop[i - 1] as CallRecord;
        const current = loop[i] as CallRecord;
        if (previous.accepted && showsRemoval(previous, current)) {
            firstRemoval = current;
            before = previous;
        }
    }
    const afterCalls = firstRemoval ? loop.filter((call) => call.index >= (firstRemoval as CallRecord).index) : [];
    const pick = (call: CallRecord | null) =>
        call ? { index: call.index, usage: call.usage, request: call.request } : null;
    return {
        loopCalls: loop.length,
        rejectedCalls: calls.filter((call) => !call.accepted).length,
        firstRemovalCall: firstRemoval?.index ?? null,
        acceptedAfterRemoval: firstRemoval ? afterCalls.every((call) => call.accepted) : null,
        callsAfterRemoval: afterCalls.length,
        before: pick(before),
        after: pick(firstRemoval),
    };
}

/** Queue a drop on the session's oldest tool tag, the same row `ctx_reduce` would queue. */
function queueOldestToolDrop(host: Host, sessionId: string): number {
    const db = new Database(host.contextDb);
    try {
        const tag = db
            .query(
                "SELECT tag_number AS n FROM tags WHERE session_id = ? AND type = 'tool' ORDER BY tag_number ASC LIMIT 1",
            )
            .get(sessionId) as { n: number } | null;
        if (!tag) throw new Error("no tool tag to drop");
        db.query("INSERT INTO pending_ops (session_id, tag_id, operation, queued_at) VALUES (?, ?, 'drop', ?)").run(
            sessionId,
            tag.n,
            Date.now(),
        );
        return tag.n;
    } finally {
        db.close();
    }
}

const REMOVAL_LOG = /reasoning removal|reasoning cleanup|pending op|applyPendingOperations|ctx-flush|drop/i;

export async function runScenario(spec: ScenarioSpec, options: RunOptions, callsLeft: number, material?: string): Promise<ScenarioResult> {
    const id = scenarioId(spec);
    const startedAt = new Date().toISOString();
    const root = join(options.out, "roots", id.replace(/[^\w.-]/g, "_"));
    const key = material ?? await fetchCredential(spec.route.credentialId);
    const secrets = () => [key];
    const recorder = startRecorder(
        spec.route,
        Math.min(spec.callBudget, callsLeft),
        secrets,
        options.keepBodies ? join(options.out, "bodies", id.replace(/[^\w.-]/g, "_")) : undefined,
    );
    let host: Host | null = null;
    let abortReason: string | null = null;
    let dbFiles: string[] = [];
    let mcLog = "";
    let hostLog = "";
    try {
        host = await startHost({
            binary: options.opencode,
            root,
            route: spec.route,
            apiKey: key,
            recorderBaseURL: recorder.baseURL,
            modelsCatalog: options.modelsCatalog,
            authPlugins: options.authPlugins,
            magicContext: {
                keep_reasoning_tokens: spec.keepReasoningTokens,
                execute_threshold_percentage: 80,
            },
        });
        const activeHost = host;
        const session = (await activeHost.api("/session", { title: `live ${id}` })).value as { id: string };
        dbFiles = activeHost.checkIsolation();
        const warnings = activeHost.configWarnings();
        if (warnings.length > 0) throw new Error(`Magic Context rejected the scenario config: ${warnings.join(" | ")}`);
        const stopReason = (): string | null => {
            if (recorder.budgetExhausted()) return "call budget spent";
            const last = recorder.calls.at(-1);
            if (!last) return "no provider call reached the recorder (see the host log)";
            if (last.status === 429) return `rate limited: ${last.error ?? ""}`;
            if ((last.usage?.input ?? 0) > UNEXPECTED_INPUT_TOKENS) return `unexpected input size ${last.usage?.input}`;
            if (!last.accepted) return `provider rejected call ${last.index}`;
            return null;
        };
        const prompt = async (phase: string, text: string) => {
            recorder.setPhase(phase);
            await activeHost.api(
                `/session/${session.id}/message`,
                {
                    model: { providerID: spec.route.providerId, modelID: spec.route.model },
                    agent: "build",
                    parts: [{ type: "text", text }],
                },
                600_000,
            );
            await recorder.settled();
            abortReason = stopReason();
        };
        await prompt("turn-1", loopPrompt(spec.loopSteps));
        if (!abortReason) {
            if (spec.kind === "drop") {
                const tag = queueOldestToolDrop(activeHost, session.id);
                recorder.setPhase(`flush (drop queued on tag ${tag})`);
            } else {
                recorder.setPhase("flush");
            }
            await activeHost.api(`/session/${session.id}/command`, { command: "ctx-flush", arguments: "" }, 120_000);
            await recorder.settled();
            abortReason = stopReason();
        }
        if (spec.kind === "trim-only") {
            if (!abortReason) await prompt("trim-only", "Think briefly: what is 7 times 8? Reply only with the number. Do not use tools.");
            if (!abortReason) await prompt("cache-follow-up", "Think briefly: what is 8 times 9? Reply only with the number. Do not use tools.");
            if (!abortReason) {
                queueOldestToolDrop(activeHost, session.id);
                recorder.setPhase("mixed-flush");
                await activeHost.api(`/session/${session.id}/command`, { command: "ctx-flush", arguments: "" });
                await recorder.settled();
                abortReason = stopReason();
            }
            if (!abortReason) await prompt("tool-edit", "Think briefly: what is 9 times 10? Reply only with the number. Do not use tools.");
        } else {
            for (let turn = 2; turn <= 1 + FOLLOW_UP_TURNS && !abortReason; turn++) {
                await prompt(`turn-${turn}`, followUpPrompt(turn));
            }
        }
        dbFiles = activeHost.checkIsolation();
    } catch (error) {
        abortReason = abortReason ?? scrubError(`harness: ${String(error)}`, secrets());
    } finally {
        await recorder.settled();
        recorder.stop();
        if (host) {
            mcLog = readIfExists(host.mcLogPath);
            hostLog = host.hostLog();
            await host.dispose();
        }
    }
    // Logs are copied out of the root before it is deleted, with the key scrubbed.
    const scrub = (text: string) => text.replaceAll(key, "[REDACTED]");
    writeFileSync(join(options.out, `${id.replace(/[^\w.-]/g, "_")}.mc.log`), scrub(mcLog));
    writeFileSync(join(options.out, `${id.replace(/[^\w.-]/g, "_")}.host.log`), scrub(hostLog));
    const calls = recorder.calls;
    const trimOnly = spec.kind === "trim-only" ? qualifyTrimOnly(calls) : undefined;
    if (trimOnly && !trimOnly.qualified) abortReason ??= trimOnly.failures.join("; ");
    return {
        scenario: id,
        route: spec.route.id,
        model: spec.route.model,
        hostVersion: "1.18.30",
        pluginCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: import.meta.dir, windowsHide: true })
            .toString()
            .trim(),
        startedAt,
        finishedAt: new Date().toISOString(),
        outcome: abortReason ? "aborted" : "completed",
        abortReason,
        locallyRefusedCalls: recorder.locallyRefused(),
        calls,
        removalLog: scrub(mcLog)
            .split("\n")
            .filter((line) => REMOVAL_LOG.test(line))
            .slice(0, 60),
        isolation: { hostPid: host?.pid ?? null, dbFiles, rootRemoved: !existsSync(root) },
        summary: summarize(calls),
        ...(trimOnly ? { trimOnly } : {}),
    };
}

export async function runAll(options: RunOptions): Promise<ScenarioResult[]> {
    assertThrowawayRoot(options.out);
    mkdirSync(options.out, { recursive: true, mode: 0o700 });
    if (options.claudeCredential && !/^oauth:anthropic(?::[\w.-]+)?$/.test(options.claudeCredential)) {
        throw new Error("--claude-credential must name a single enrolled oauth:anthropic account");
    }
    const selected = ALL_SCENARIOS.filter(
        (spec) =>
            (!options.only || options.only.includes(scenarioId(spec))) &&
            (!options.providers || options.providers.includes(spec.route.providerId)),
    ).map((spec) => spec.route.authPlugin === "anthropic-auth" && options.claudeCredential
        ? { ...spec, route: { ...spec.route, credentialId: options.claudeCredential } } : spec);
    if (!selected.length) throw new Error("No live scenarios selected");
    for (const spec of selected) authPluginPath(spec.route, options.authPlugins);
    const results: ScenarioResult[] = [];
    // One vault read/account per route per run. Never enumerate the subscription roster.
    const credentials = new Map<string, string>();
    const stoppedRoutes = new Set<string>();
    const skipped: Array<{ scenario: string; reason: string }> = [];
    let used = 0;
    const write = () =>
        writeFileSync(
            join(options.out, "results.json"),
            JSON.stringify({ runAt: new Date().toISOString(), callCap: RUN_CALL_CAP, used, results, skipped }, null, 2),
        );
    for (const spec of selected) {
        if (stoppedRoutes.has(spec.route.credentialId)) {
            skipped.push({ scenario: scenarioId(spec), reason: `an earlier scenario on ${spec.route.credentialId} was refused` });
            continue;
        }
        if (used >= RUN_CALL_CAP) break;
        console.error(`[live] ${scenarioId(spec)} starting (${used}/${RUN_CALL_CAP} calls used)`);
        let material = credentials.get(spec.route.credentialId);
        if (!material) {
            material = await fetchCredential(spec.route.credentialId);
            credentials.set(spec.route.credentialId, material);
        }
        const result = await runScenario(spec, options, RUN_CALL_CAP - used, material);
        used += result.calls.length;
        results.push(result);
        write();
        console.error(
            `[live] ${result.scenario} ${result.outcome}${result.abortReason ? ` (${result.abortReason})` : ""}: ` +
                `${result.calls.length} calls, removal at ${result.summary.firstRemovalCall}, ` +
                `accepted after removal ${result.summary.acceptedAfterRemoval}`,
        );
        // Rate limits, quota or key refusals and runaway billing would repeat on every later
        // scenario that uses the same key, so those scenarios are skipped.
        const statuses = result.calls.map((call) => call.status);
        if (
            (result.abortReason && /rate limited|unexpected input|budget/.test(result.abortReason)) ||
            statuses.some((status) => status === 401 || status === 403 || status === 429)
        ) {
            stoppedRoutes.add(spec.route.credentialId);
        }
    }
    write();
    return results;
}

function arg(name: string): string | undefined {
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

if (import.meta.main) {
    if (process.env.MC_LIVE_PROVIDERS !== "1") {
        console.error("Live provider scenarios make billed calls; set MC_LIVE_PROVIDERS=1 to run them.");
        process.exit(2);
    }
    const out = resolve(
        arg("out") ??
            join(process.env.TMPDIR ?? "/tmp", "magic-context", "live-providers", `run-${Date.now().toString(36)}`),
    );
    assertThrowawayRoot(out);
    if (existsSync(join(out, "results.json"))) throw new Error("Use a new output root");
    const opencode =
        arg("opencode") ??
        process.env.MC_LIVE_OPENCODE ??
        execFileSync("which", ["opencode"], { windowsHide: true }).toString().trim();
    const results = await runAll({
        opencode: resolve(opencode),
        out,
        only: arg("only")?.split(",") ?? null,
        providers: arg("providers")?.split(",") ?? null,
        modelsCatalog: arg("models-catalog"),
        keepBodies: process.argv.includes("--keep-bodies"),
        authPlugins: {
            "anthropic-auth": arg("anthropic-auth") ?? process.env.MC_LIVE_ANTHROPIC_AUTH_PLUGIN,
            "openai-auth": arg("openai-auth") ?? process.env.MC_LIVE_OPENAI_AUTH_PLUGIN,
        },
        claudeCredential: arg("claude-credential") as CredentialId | undefined,
    });
    console.log(JSON.stringify({ out, scenarios: results.map((r) => ({ id: r.scenario, ...r.summary, outcome: r.outcome, abortReason: r.abortReason })) }, null, 2));
    if (results.some((r) => r.outcome !== "completed")) process.exitCode = 1;
}
