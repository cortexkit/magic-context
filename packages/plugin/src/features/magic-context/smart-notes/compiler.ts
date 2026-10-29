import { createHash } from "node:crypto";

import { SMART_NOTE_COMPILER_AGENT } from "../../../agents/smart-note-compiler";
import { createChildSessionWithFence } from "../../../hooks/magic-context/child-session-spawn";
import type {
    HiddenCompletion,
    HiddenCompletionExecutor,
} from "../../../hooks/magic-context/compartment-runner-types";
import type { PluginContext } from "../../../plugin/types";
import * as shared from "../../../shared";
import { extractLatestAssistantText } from "../../../shared/assistant-message-extractor";
import { teardownChildSession } from "../../../shared/child-session-teardown";
import { log } from "../../../shared/logger";
import type { ModelInput } from "../../../shared/model-resolution";
import { modelBodyField } from "../../../shared/resolve-fallbacks";
import type { Database } from "../../../shared/sqlite";
import { nextOccurrence, parseCron } from "../dreamer/cron";
import { runHiddenSingleShotPrompt } from "../dreamer/hidden-single-shot";
import { recordChildInvocation } from "../subagent-token-capture";
import type { SmartNoteCapabilityFactory } from "./capabilities";
import { SMART_NOTE_COMPILER_SYSTEM_PROMPT } from "./compiler-prompt";
import { type RunCompiledSmartNoteCheckResult, runCompiledSmartNoteCheck } from "./sandbox-runner";
import { assertSmartNotePublicEndpoint } from "./ssrf-guard";
import {
    SMART_NOTE_CHECK_CEILING_MS,
    type SmartNoteCapabilityName,
    type SmartNoteCheckManifest,
    type SmartNoteCheckResult,
    SmartNoteNetworkError,
} from "./types";

interface CompileSmartNoteArgs {
    /** Child-session transport; absent on a host that only has a completion carrier. */
    client?: PluginContext["client"];
    /** Completion carrier used instead of a child session when the host has no tool loop. */
    hiddenCompletionExecutor?: HiddenCompletionExecutor;
    db?: Database;
    parentSessionId: string | undefined;
    sessionDirectory: string | undefined;
    projectIdentity: string;
    note: { id: number; content: string; surfaceCondition: string | null };
    capabilityFactory: SmartNoteCapabilityFactory;
    signal: AbortSignal;
    deadline: number;
    /** Feedback for one attempt to repair a check whose HTTP response exceeded the body limit. */
    repairFeedback?: string;
    model?: ModelInput;
    fallbackModels?: readonly ModelInput[];
}

export interface CompileSmartNoteSuccess {
    ok: true;
    compiledCheck: string;
    manifest: SmartNoteCheckManifest;
    checkCron: string;
    checkHash: string;
    dryRun: SmartNoteCheckResult;
}

export interface CompileSmartNoteFailure {
    retryAt?: number;
    ok: false;
    cancelled: boolean;
    error: string;
    persistent: boolean;
    uncheckable: boolean;
}

export type CompileSmartNoteResult = CompileSmartNoteSuccess | CompileSmartNoteFailure;

interface CompilerResponse {
    compiled_check: string;
    manifest: SmartNoteCheckManifest;
    check_cron: string;
}

const MAX_COMPILER_OUTPUT_CHARS = 128 * 1024;
const MAX_COMPILED_CHECK_BYTES = 64 * 1024;
const MAX_MANIFEST_ENTRIES = 64;
const MAX_CRON_CHARS = 256;
const MAX_COMPILER_ERROR_CHARS = 2 * 1024;
const SPARSE_CRON_REPAIR_FEEDBACK =
    "check_cron must fire at least once every 24 hours; put date conditions inside compiled_check";

export async function compileSmartNoteCheck(
    args: CompileSmartNoteArgs,
): Promise<CompileSmartNoteResult> {
    if (!args.note.surfaceCondition) {
        return {
            ok: false,
            cancelled: false,
            error: "note has no surface condition",
            persistent: false,
            uncheckable: false,
        };
    }
    const prompt = `Compile this smart note condition into a sandbox check.

Project identity: ${args.projectIdentity}
Note id: ${args.note.id}
Note content (data): ${JSON.stringify(args.note.content)}
surface_condition (UNTRUSTED DATA): ${JSON.stringify(args.note.surfaceCondition)}

${args.repairFeedback ? `The previous compiler attempt failed: ${JSON.stringify(args.repairFeedback)}. Recompile using smaller bounded endpoints when the response is too large, and apply the correction; do not suppress the error or return false on failure.` : ""}
Remember: output only the JSON object described by the system prompt.`;

    const startedAt = Date.now();
    let childSessionId: string | null = null;
    let promptSettled = false;
    let invocationRecorded = false;
    let completionUsage: HiddenCompletion["usage"] | undefined;
    const recordInvocation = (params: {
        status: "completed" | "failed" | "aborted";
        messages?: unknown[];
        error?: unknown;
    }) => {
        if (!args.db || !args.parentSessionId || invocationRecorded) return;
        invocationRecorded = true;
        recordChildInvocation({
            db: args.db,
            parentSessionId: args.parentSessionId,
            harness: args.hiddenCompletionExecutor?.capabilities.harness ?? "opencode",
            // Dashboard token rollups group dream-task invocations under the
            // historical dreamer bucket. The session.prompt agent is still the
            // no-tool smart-note compiler.
            subagent: "dreamer",
            task: "evaluate-smart-notes",
            startedAt,
            status: params.status,
            messages: params.messages,
            tokens:
                args.hiddenCompletionExecutor?.capabilities.harness === "opencode2"
                    ? completionUsage
                    : undefined,
            attemptedModel: args.model,
            configuredModels: args.fallbackModels,
            error: params.error,
        });
    };
    try {
        const remainingMs = Math.max(1_000, args.deadline - Date.now());
        let response: CompilerResponse;
        let outputMessages: unknown[] | undefined;
        if (args.hiddenCompletionExecutor) {
            // The compiler is a no-tool prompt that answers with one JSON object,
            // so a completion carrier delivers it without a child-session tool loop.
            const carried = await runHiddenSingleShotPrompt({
                executor: args.hiddenCompletionExecutor,
                parentSessionId: args.parentSessionId,
                sessionDirectory: args.sessionDirectory ?? args.projectIdentity,
                agent: SMART_NOTE_COMPILER_AGENT,
                system: SMART_NOTE_COMPILER_SYSTEM_PROMPT,
                prompt,
                title: `magic-context-smart-note-compile-${args.note.id}`,
                callContext: "dreamer:smart-note-compiler",
                model: args.model,
                fallbackModels: args.fallbackModels,
                timeoutMs: remainingMs,
                signal: args.signal,
                metadata: { task: "evaluate-smart-notes" },
                onFailureOutput: (completion) => {
                    completionUsage = completion.usage;
                },
                parse: parseCompilerOutput,
            });
            promptSettled = true;
            response = carried.validated;
            outputMessages = carried.completion.messages;
            completionUsage = carried.completion.usage;
        } else {
            const client = args.client;
            if (!client) {
                throw new Error("Smart-note compilation needs a client or a completion carrier.");
            }
            const createResponse = await createChildSessionWithFence({
                client,
                db: args.db ?? null,
                parentSessionId: args.parentSessionId,
                title: `magic-context-smart-note-compile-${args.note.id}`,
                directory: args.sessionDirectory ?? args.projectIdentity,
            });
            const created = shared.normalizeSDKResponse(
                createResponse,
                null as { id?: string } | null,
                {
                    preferResponseOnMissingData: true,
                },
            );
            childSessionId = typeof created?.id === "string" ? created.id : null;
            if (!childSessionId) throw new Error("Could not create smart-note compiler session");

            const run = await shared.promptSyncWithValidatedOutputRetry(
                client,
                {
                    path: { id: childSessionId },
                    query: { directory: args.sessionDirectory ?? args.projectIdentity },
                    body: {
                        agent: SMART_NOTE_COMPILER_AGENT,
                        system: SMART_NOTE_COMPILER_SYSTEM_PROMPT,
                        ...modelBodyField(args.model),
                        parts: [{ type: "text", text: prompt, synthetic: true }],
                    },
                },
                {
                    // Send without holding a request open for the whole run, so the
                    // deadline below is the only timer (see prompt-async-transport.ts).
                    transport: shared.createPromptAsyncTransport(client, childSessionId),
                    timeoutMs: remainingMs,
                    signal: args.signal,
                    fallbackModels: args.fallbackModels,
                    callContext: "dreamer:smart-note-compiler",
                    fetchOutput: async () => {
                        const messagesResponse = await client.session.messages({
                            path: { id: childSessionId as string },
                            query: {
                                directory: args.sessionDirectory ?? args.projectIdentity,
                                limit: 20,
                            },
                        });
                        return shared.normalizeSDKResponse(messagesResponse, [] as unknown[], {
                            preferResponseOnMissingData: true,
                        });
                    },
                    validateOutput: (messages) =>
                        parseCompilerOutput(extractLatestAssistantText(messages)),
                },
            );
            promptSettled = true;
            response = run.validated;
            outputMessages = run.output;
        }
        const compiledCheck = normalizeCompiledCheck(response.compiled_check);
        const manifest = normalizeManifest(response.manifest);
        const checkCron = normalizeCron(response.check_cron);
        const dryRun = await dryRunSmartNoteCheck(
            compiledCheck,
            args.capabilityFactory,
            args.signal,
        );
        for (const warning of [
            ...manifestAdvisoryWarnings(compiledCheck, manifest),
            ...dryRun.advisories,
        ]) {
            log(`[dreamer] smart note #${args.note.id}: manifest advisory — ${warning}`);
        }
        if (!dryRun.ok) {
            const error = boundedError(`dry-run failed: ${dryRun.error}`);
            recordInvocation({
                status: dryRun.cancelled ? "aborted" : "failed",
                messages: outputMessages,
                error,
            });
            if (
                !args.repairFeedback &&
                !dryRun.cancelled &&
                dryRun.persistent &&
                dryRun.error.includes("response body too large") &&
                !args.signal.aborted &&
                Date.now() < args.deadline
            ) {
                return await compileSmartNoteCheck({ ...args, repairFeedback: error });
            }
            return {
                ok: false,
                cancelled: dryRun.cancelled,
                error,
                persistent: !dryRun.cancelled && dryRun.persistent,
                uncheckable: !dryRun.cancelled && (dryRun.uncheckable ?? false),
                ...(!dryRun.cancelled && dryRun.retryAt !== undefined
                    ? { retryAt: dryRun.retryAt }
                    : {}),
            };
        }
        recordInvocation({ status: "completed", messages: outputMessages });
        return {
            ok: true,
            compiledCheck,
            manifest,
            checkCron,
            checkHash: hashCheck(args.note.surfaceCondition, compiledCheck, manifest, checkCron),
            dryRun: dryRun.result,
        };
    } catch (error) {
        const cancelled = args.signal.aborted;
        const message = boundedError(error instanceof Error ? error.message : String(error));
        recordInvocation({ status: cancelled ? "aborted" : "failed", error: message });
        if (
            !args.repairFeedback &&
            !cancelled &&
            message === "check_cron has no occurrence within the scheduling ceiling" &&
            !args.signal.aborted &&
            Date.now() < args.deadline
        ) {
            return await compileSmartNoteCheck({
                ...args,
                repairFeedback: SPARSE_CRON_REPAIR_FEEDBACK,
            });
        }
        const networkError = error instanceof SmartNoteNetworkError ? error : undefined;
        return {
            ok: false,
            cancelled,
            error: message,
            persistent: !cancelled && (networkError?.persistent ?? false),
            uncheckable: !cancelled && (networkError?.uncheckable ?? false),
        };
    } finally {
        // The carrier branch closes its own run; only the child-session branch
        // leaves a session behind to tear down.
        if (args.client) {
            await teardownChildSession({
                client: args.client,
                sessionId: childSessionId,
                sessionDirectory: args.sessionDirectory ?? args.projectIdentity,
                promptSettled,
                privacySensitive: true,
                context: `[dreamer] smart note #${args.note.id} compiler`,
                log,
            });
        }
    }
}

export async function dryRunSmartNoteCheck(
    compiledCheck: string,
    capabilityFactory: SmartNoteCapabilityFactory,
    signal?: AbortSignal,
): Promise<RunCompiledSmartNoteCheckResult & { advisories: string[] }> {
    const responses: Array<{ url: string; status: number }> = [];
    const dryRun = await runCompiledSmartNoteCheck({
        compiledCheck,
        capabilityFactory: (runSignal) => {
            const capabilities = capabilityFactory(runSignal);
            return {
                ...capabilities,
                httpGet: async (url) => {
                    const response = await capabilities.httpGet(url);
                    responses.push({ url, status: response.status });
                    return response;
                },
            };
        },
        signal,
    });
    // A note can wait for a release artifact that does not exist yet, so
    // inaccessible HTTP sources are advisory rather than compilation errors.
    const advisories =
        dryRun.ok &&
        responses.length > 0 &&
        responses.every(({ status }) => status === 401 || status === 403 || status === 404)
            ? [
                  `all HTTP sources currently return 401/403/404: ${responses.map(({ url, status }) => `${url} (HTTP ${status})`).join(", ")}`,
              ]
            : [];
    return { ...dryRun, advisories };
}

export function parseCompilerOutput(output: string | null): CompilerResponse {
    if (!output) throw new Error("smart-note compiler returned no output");
    if (output.length > MAX_COMPILER_OUTPUT_CHARS) {
        throw new Error("smart-note compiler output exceeds 128 KiB");
    }
    const json = extractJsonObject(output);
    const parsed = JSON.parse(json) as Partial<CompilerResponse>;
    if (typeof parsed.compiled_check !== "string") throw new Error("compiled_check missing");
    if (!parsed.manifest || typeof parsed.manifest !== "object")
        throw new Error("manifest missing");
    if (typeof parsed.check_cron !== "string") throw new Error("check_cron missing");
    return parsed as CompilerResponse;
}

export function normalizeCompiledCheck(source: string): string {
    if (Buffer.byteLength(source, "utf8") > MAX_COMPILED_CHECK_BYTES) {
        throw new Error("compiled_check exceeds 64 KiB");
    }
    let code = source.trim();
    const fence = code.match(/^```(?:javascript|js)?\s*([\s\S]*?)```$/i);
    if (fence) code = fence[1].trim();
    code = code.replace(/export\s+function\s+check\s*\(/, "function check(");
    if (/\basync\s+function\s+check\s*\(/.test(code)) {
        throw new Error("compiled_check must be synchronous");
    }
    if (!/\bfunction\s+check\s*\(/.test(code) && !/module\.exports\.check\s*=/.test(code)) {
        throw new Error("compiled_check must define check(cap)");
    }
    if (/\b(?:import|require)\b/.test(code)) {
        throw new Error("compiled_check must not import modules");
    }
    if (Buffer.byteLength(code, "utf8") > MAX_COMPILED_CHECK_BYTES) {
        throw new Error("compiled_check exceeds 64 KiB");
    }
    // Validate literal endpoints even when the dry run would short-circuit before
    // reaching them. Manifest entries alone are advisory, not the source of truth.
    for (const url of literalCalls(code, "httpGet")) {
        assertSmartNotePublicEndpoint(new URL(url));
    }
    return code;
}

export function normalizeManifest(manifest: SmartNoteCheckManifest): SmartNoteCheckManifest {
    const capabilities = Array.isArray(manifest.capabilities)
        ? unique(
              manifest.capabilities
                  .slice(0, MAX_MANIFEST_ENTRIES)
                  .filter((cap): cap is SmartNoteCapabilityName =>
                      ["readFile", "gitHeadSha", "gitTag", "gitLog", "httpGet"].includes(
                          String(cap),
                      ),
                  ),
          )
        : [];
    return {
        capabilities,
        readFiles: uniqueStrings(manifest.readFiles),
        hosts: uniqueStrings(manifest.hosts, (host) => host.toLowerCase()),
        urls: uniqueStrings(manifest.urls),
        signals: uniqueStrings(manifest.signals),
        summary: typeof manifest.summary === "string" ? manifest.summary.slice(0, 160) : undefined,
    };
}

/**
 * Best-effort manifest drift notes for audit visibility only. Runtime guards in
 * the capability implementations are the security boundary; this check must not
 * accept or reject code.
 */
export function manifestAdvisoryWarnings(code: string, manifest: SmartNoteCheckManifest): string[] {
    const warnings: string[] = [];
    const declared = new Set(manifest.capabilities);
    const used = capabilityUses(code);
    for (const cap of used) {
        if (!declared.has(cap)) warnings.push(`manifest omits capability ${cap}`);
    }

    const readFiles = literalCalls(code, "readFile");
    for (const file of readFiles) {
        if (!manifest.readFiles?.includes(file))
            warnings.push(`manifest omits readFile path ${file}`);
    }

    const urls = literalCalls(code, "httpGet");
    for (const url of urls) {
        try {
            const parsed = new URL(url);
            if (parsed.protocol !== "https:") {
                warnings.push(`manifest records non-https URL ${url}`);
                continue;
            }
            if (!manifest.urls?.includes(url)) warnings.push(`manifest omits URL ${url}`);
            if (!manifest.hosts?.includes(parsed.hostname.toLowerCase())) {
                warnings.push(`manifest omits host ${parsed.hostname}`);
            }
        } catch {
            warnings.push(`manifest records invalid URL ${url}`);
        }
    }
    return warnings;
}

export function hashCheck(
    surfaceCondition: string | null,
    compiledCheck: string,
    manifest: SmartNoteCheckManifest,
    checkCron: string,
): string {
    return createHash("sha256")
        .update(surfaceCondition ?? "")
        .update("\0")
        .update(compiledCheck)
        .update("\0")
        .update(JSON.stringify(manifest))
        .update("\0")
        .update(checkCron)
        .digest("hex");
}

function extractJsonObject(output: string): string {
    const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const text = fenced ? fenced[1] : output;
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("smart-note compiler returned no JSON object");
    return text.slice(start, end + 1);
}

function capabilityUses(code: string): Set<SmartNoteCapabilityName> {
    const uses = new Set<SmartNoteCapabilityName>();
    const regex = /\bcap\s*\.\s*(readFile|gitHeadSha|gitTag|gitLog|httpGet)\s*\(/g;
    for (const match of code.matchAll(regex)) uses.add(match[1] as SmartNoteCapabilityName);
    return uses;
}

function literalCalls(code: string, method: "readFile" | "httpGet"): string[] {
    const regex = new RegExp(
        `\\bcap\\s*\\.\\s*${method}\\s*\\(\\s*(["'])((?:\\\\.|(?!\\1)[^\\\\])*)\\1`,
        "g",
    );
    const values: string[] = [];
    for (const match of code.matchAll(regex)) {
        values.push(match[2].replace(/\\([\\"'])/g, "$1"));
    }
    return values;
}

export function normalizeCron(cron: string): string {
    if (cron.length > MAX_CRON_CHARS) throw new Error("check_cron exceeds 256 characters");
    const normalized = cron.trim() || "0 * * * *";
    const parsed = parseCron(normalized);
    if (!parsed.ok) throw new Error(`invalid check_cron: ${parsed.error}`);
    const next = nextOccurrence(parsed.cron, new Date(), undefined, SMART_NOTE_CHECK_CEILING_MS);
    if (!next) throw new Error("check_cron has no occurrence within the scheduling ceiling");
    return normalized;
}

function unique<T>(items: T[]): T[] {
    return [...new Set(items)];
}

function uniqueStrings(
    items: unknown,
    normalize: (value: string) => string = (value) => value,
): string[] | undefined {
    if (!Array.isArray(items)) return undefined;
    const values = unique(
        items
            .slice(0, MAX_MANIFEST_ENTRIES)
            .filter((item): item is string => typeof item === "string" && item.length > 0)
            .map(normalize),
    );
    return values.length > 0 ? values : undefined;
}

function boundedError(error: string): string {
    return error.slice(0, MAX_COMPILER_ERROR_CHARS);
}
