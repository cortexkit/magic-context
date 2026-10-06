// The SINGLEFILE variant embeds the WASM as binary INSIDE the JS module, so it
// survives bundling into dist/index.js. The default wasmfile variant loads a
// sibling `emscripten-module.wasm` via `new URL(..., import.meta.url)`, which
// resolves to `dist/emscripten-module.wasm` in the bundle — a file the build
// never emits, so every sandbox run fails with ENOENT. (Documented fix:
// emscriptenInclusion=singlefile is "for missing .wasm files when bundling".)
// We use the ASYNCIFY variant because the capability API (readFile/httpGet/git)
// is async and the sandbox installs async host functions.
//
// These two modules are imported LAZILY inside getAsyncModule() (below), not at
// the top of this file. The singlefile variant inlines ~2.6MB of base64 WASM into
// the bundle; a top-level import forced the JS engine to parse that blob on every
// plugin load — and on every subagent child spawn — adding hundreds of ms (issue
// #242). Deferring the import to the first smart-note evaluation splits the variant
// into its own chunk that stays out of the cold-start parse. The type-only import
// below is erased at build time and pulls in no runtime code.
import type {
    QuickJSAsyncContext,
    QuickJSAsyncWASMModule,
    QuickJSHandle,
} from "quickjs-emscripten";
import { classifyStalePluginBuild, importPluginModule } from "../../../shared/stale-plugin-build";
import type { SmartNoteCapabilityApi, SmartNoteCapabilityFactory } from "./capabilities";
import { SMART_NOTE_HTTP_TIMEOUT_MS } from "./ssrf-guard";
import {
    isSmartNoteNetworkError,
    type SmartNoteCheckResult,
    SmartNoteNetworkError,
    smartNoteNetworkTimeout,
} from "./types";

/**
 * The WASM module is expensive to instantiate (~1MB compile) but reusable across
 * checks — each check gets its own disposable CONTEXT off the shared module. Cache
 * the module promise process-wide so we compile once, not per check.
 *
 * The QuickJS variant + runtime are loaded here on first use via dynamic import so
 * their (large) modules are parsed only when a smart-note check actually runs,
 * never at plugin import time. See the file-header note for the cold-start reason.
 */
let asyncModulePromise: Promise<QuickJSAsyncWASMModule> | null = null;
let asyncModuleLoaded = false;
let asyncModuleLoadAttempted = false;
let beforeModuleAcquisition: (() => Promise<void>) | undefined;
let beforeModuleLoad: (() => Promise<void>) | undefined;
let moduleLoadTimeoutOverride: number | undefined;
let afterContextDisposal: ((context: QuickJSAsyncContext) => void) | undefined;

/** Delay module availability in tests without slowing production checks. */
export const __sandboxRunnerTest = {
    setAfterContextDisposal(hook: ((context: QuickJSAsyncContext) => void) | undefined): void {
        afterContextDisposal = hook;
    },
    setBeforeModuleAcquisition(hook: () => Promise<void>): void {
        beforeModuleAcquisition = hook;
    },
    /** Force a fresh infrastructure load, before any context has been created. */
    setBeforeModuleLoad(hook: () => Promise<void>, timeoutMs: number): void {
        beforeModuleLoad = hook;
        moduleLoadTimeoutOverride = timeoutMs;
        asyncModulePromise = null;
        asyncModuleLoaded = false;
    },
    reset(): void {
        beforeModuleAcquisition = undefined;
        beforeModuleLoad = undefined;
        moduleLoadTimeoutOverride = undefined;
        afterContextDisposal = undefined;
    },
};

export function getQuickJsNativeMemoryStats(): { loadAttempted: boolean; loaded: boolean } {
    return { loadAttempted: asyncModuleLoadAttempted, loaded: asyncModuleLoaded };
}

function getAsyncModule(): Promise<QuickJSAsyncWASMModule> {
    if (asyncModulePromise) return asyncModulePromise;
    asyncModuleLoadAttempted = true;
    const timeoutMs = moduleLoadTimeoutOverride ?? SMART_NOTE_MODULE_LOAD_TIMEOUT_MS;
    const startedAt = performance.now();
    const load = (async () => {
        if (beforeModuleLoad) await beforeModuleLoad();
        const [{ default: singlefileAsyncifyVariant }, { newQuickJSAsyncWASMModuleFromVariant }] =
            await importPluginModule(() =>
                Promise.all([
                    import("@jitl/quickjs-singlefile-cjs-release-asyncify"),
                    import("quickjs-emscripten"),
                ]),
            );
        const module = await newQuickJSAsyncWASMModuleFromVariant(singlefileAsyncifyVariant);
        return module;
    })();
    const bounded = new Promise<QuickJSAsyncWASMModule>((resolve, reject) => {
        const timeout = () => reject(new SandboxModuleLoadTimeoutError());
        const timer = setTimeout(timeout, timeoutMs);
        // Keep both handlers attached after timeout. A late native load can finish
        // safely, but must neither execute guest code nor publish over a retry.
        void load.then(
            (module) => {
                clearTimeout(timer);
                // Synchronous loading can keep an eligible timer from running.
                if (performance.now() - startedAt >= timeoutMs) timeout();
                else resolve(module);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
    const cached = bounded.then(
        (module) => {
            if (asyncModulePromise === cached) asyncModuleLoaded = true;
            return module;
        },
        (error) => {
            if (asyncModulePromise === cached) {
                asyncModulePromise = null;
                asyncModuleLoaded = false;
            }
            throw error;
        },
    );
    asyncModulePromise = cached;
    return cached;
}

class SandboxModuleLoadTimeoutError extends Error {
    constructor() {
        super("smart-note sandbox module load timed out; check was not run");
        this.name = "SandboxModuleLoadTimeoutError";
    }
}

/**
 * Await the shared module, giving up promptly if the caller is cancelled first.
 *
 * Instantiation is one-time process infrastructure, not an asyncify-suspended
 * eval, so it must not hold the serialization chain (below): unrelated queued
 * runs would otherwise wait behind a compile that has nothing to do with them,
 * and a cancelled sweep would burn its entire budget waiting for the compile
 * instead of reporting cancellation. Acquisition therefore happens OUTSIDE
 * withSandboxLock, and a caller with an aborted signal returns immediately.
 */
function acquireSandboxModule(signal?: AbortSignal): Promise<QuickJSAsyncWASMModule> {
    const modulePromise = beforeModuleAcquisition
        ? beforeModuleAcquisition().then(getAsyncModule)
        : getAsyncModule();
    if (!signal) return modulePromise;
    if (signal.aborted) {
        return Promise.reject(signal.reason ?? new Error("smart-note check aborted"));
    }
    return new Promise((resolve, reject) => {
        const cleanup = () => signal.removeEventListener("abort", onAbort);
        const onAbort = () => {
            cleanup();
            reject(signal.reason ?? new Error("smart-note check aborted"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        void modulePromise.then(
            (module) => {
                cleanup();
                resolve(module);
            },
            (error) => {
                cleanup();
                reject(error);
            },
        );
    });
}

/**
 * Process-wide serialization for sandbox runs.
 *
 * The asyncify variant has ONE suspension stack per WASM module instance, and we
 * share a single cached module across every check (above). When a check awaits a
 * host capability (httpGet/git/readFile) the WASM stack is unwound and parked;
 * if a SECOND check's `evalCodeAsync` suspends on the same module before the
 * first resumes, the two share/clobber that single asyncify stack and a
 * continuation later resumes against a context that has since been disposed,
 * surfacing as `QuickJSUseAfterFree: Lifetime not alive`. This is reachable in
 * normal operation: the dream timer fires per-project smart-note sweeps
 * un-awaited during multi-project startup, so two projects' sweeps overlap.
 *
 * Serializing every run through one promise chain makes "one suspended eval at a
 * time" an invariant. These are background sweeps with no user-facing latency, so
 * the serialization cost is irrelevant. A failed/rejected run must not break the
 * chain for the next caller, so we continue the chain on both settle paths.
 */
let sandboxRunChain: Promise<unknown> = Promise.resolve();
function withSandboxLock<T>(
    fn: () => Promise<T>,
    signal?: AbortSignal,
    cancelled?: () => T,
): Promise<T> {
    let started = false;
    const start = () => {
        started = true;
        return signal?.aborted && cancelled ? cancelled() : fn();
    };
    const run = sandboxRunChain.then(start, start);
    sandboxRunChain = run.then(
        () => undefined,
        () => undefined,
    );
    // Once running, the VM must classify its own interruption. A promise race
    // returning cancellation here would hide an already-exhausted CPU budget.
    return resolveBeforeAbort(run, signal, cancelled, () => !started);
}

/**
 * A sweep's deadline includes waiting for an earlier sandbox run. Only queued
 * callers may give up without waiting for that unrelated suspended check; an
 * active run owns abort cleanup and classification before releasing the lock.
 */
function resolveBeforeAbort<T>(
    run: Promise<T>,
    signal: AbortSignal | undefined,
    cancelled: (() => T) | undefined,
    canCancel: () => boolean,
): Promise<T> {
    if (!signal || !cancelled) return run;
    if (signal.aborted) return Promise.resolve(cancelled());

    return new Promise((resolve, reject) => {
        const cleanup = () => signal.removeEventListener("abort", abort);
        const abort = () => {
            if (!canCancel()) return;
            cleanup();
            resolve(cancelled());
        };
        signal.addEventListener("abort", abort, { once: true });
        void run.then(
            (result) => {
                cleanup();
                resolve(result);
            },
            (error) => {
                cleanup();
                reject(error);
            },
        );
    });
}

export interface RunCompiledSmartNoteCheckOptions {
    compiledCheck: string;
    capabilities?: SmartNoteCapabilityApi;
    capabilityFactory?: SmartNoteCapabilityFactory;
    signal?: AbortSignal;
    timeoutMs?: number;
    /** Called with the execution deadline armed, after loading and VM queuing. */
    onExecutionStart?: () => void;
    heapLimitBytes?: number;
    stackLimitBytes?: number;
}

export interface RunCompiledSmartNoteCheckSuccess {
    ok: true;
    result: SmartNoteCheckResult;
}

export interface RunCompiledSmartNoteCheckFailure {
    ok: false;
    cancelled: false;
    error: string;
    network: boolean;
    persistent: boolean;
    uncheckable?: boolean;
    retryAt?: number;
}

export interface RunCompiledSmartNoteCheckCancelled {
    ok: false;
    cancelled: true;
    error: string;
    network: false;
}

export type RunCompiledSmartNoteCheckResult =
    | RunCompiledSmartNoteCheckSuccess
    | RunCompiledSmartNoteCheckFailure
    | RunCompiledSmartNoteCheckCancelled;

// Give one guarded request its full deadline, plus time to enter/resume the VM.
export const SMART_NOTE_CHECK_TIMEOUT_MS = SMART_NOTE_HTTP_TIMEOUT_MS + 1_000;
// Loading is host infrastructure, not guest execution. Bound it independently
// so a stalled cold start cannot pin every future check to one pending promise.
const SMART_NOTE_MODULE_LOAD_TIMEOUT_MS = 10_000;
const CPU_BUDGET_MS = 2_000;
const DEFAULT_HEAP_LIMIT_BYTES = 8 * 1024 * 1024;
const DEFAULT_STACK_LIMIT_BYTES = 512 * 1024;
const MAX_COMPILED_CHECK_BYTES = 64 * 1024;
const MAX_SANDBOX_ERROR_CHARS = 2 * 1024;

// Interrupt handlers cannot run while asyncify is suspended in a host promise.
// Bound every capability at the VM boundary, even if its transport ignores abort.
// Rejecting this await lets QuickJS resume, interrupt and dispose normally before
// releasing the shared suspension stack; racing the whole eval and disposing a
// still-suspended context would instead risk use-after-free on a late response.
function resolveCapabilitiesForRun(
    options: RunCompiledSmartNoteCheckOptions,
    signal: AbortSignal,
): SmartNoteCapabilityApi {
    const capabilities = options.capabilityFactory?.(signal) ?? options.capabilities;
    if (!capabilities) throw new Error("smart-note check requires capabilities");
    return {
        readFile: (path) => awaitCapability(() => capabilities.readFile(path), signal),
        httpGet: (url) => awaitCapability(() => capabilities.httpGet(url), signal),
        gitHeadSha: () => awaitCapability(() => capabilities.gitHeadSha(), signal),
        gitTag: () => awaitCapability(() => capabilities.gitTag(), signal),
        gitLog: (opts) => awaitCapability(() => capabilities.gitLog(opts), signal),
    };
}

function awaitCapability<T>(call: () => Promise<T>, signal: AbortSignal): Promise<T> {
    throwIfRunAborted(signal);
    return new Promise<T>((resolve, reject) => {
        const cleanup = () => signal.removeEventListener("abort", abort);
        const abort = () => {
            cleanup();
            reject(signal.reason ?? new Error("smart-note check aborted"));
        };
        signal.addEventListener("abort", abort, { once: true });
        try {
            // Both handlers remain attached to the transport after abort. Late
            // fulfillment/rejection is consumed without touching any VM handles.
            void call().then(
                (value) => {
                    cleanup();
                    resolve(value);
                },
                (error) => {
                    cleanup();
                    reject(error);
                },
            );
        } catch (error) {
            cleanup();
            reject(error);
        }
    });
}

function throwIfRunAborted(signal: AbortSignal): void {
    if (signal.aborted) {
        throw signal.reason ?? new Error("smart-note check aborted");
    }
}

export async function runCompiledSmartNoteCheck(
    options: RunCompiledSmartNoteCheckOptions,
): Promise<RunCompiledSmartNoteCheckResult> {
    if (options.signal?.aborted) return cancelledResult(options.signal.reason);
    if (Buffer.byteLength(options.compiledCheck, "utf8") > MAX_COMPILED_CHECK_BYTES) {
        return failureResult("compiled check exceeds 64 KiB", false);
    }
    // Acquire the shared module BEFORE taking the serialization slot (see
    // acquireSandboxModule): the one-time compile must not wedge the chain for
    // unrelated runs, and a cancelled caller must be able to give up while the
    // compile is still in flight.
    let quickjs: QuickJSAsyncWASMModule;
    try {
        quickjs = await acquireSandboxModule(options.signal);
    } catch (error) {
        if (options.signal?.aborted) return cancelledResult(options.signal.reason);
        if (error instanceof SandboxModuleLoadTimeoutError) return cancelledResult(error);
        const stale = classifyStalePluginBuild(error);
        // Infrastructure disappeared, not a note's condition. Cancellation leaves
        // the note pending without failure counters, fallback or rewrite notices.
        if (stale) return cancelledResult(stale.guidance);
        return failureResult(formatSandboxError(error), false);
    }
    // Serialize the actual sandbox work (see withSandboxLock): only one
    // asyncify-suspended eval may exist at a time on the shared module. The
    // per-check timeout and host-capability controller start INSIDE the lock so
    // a check queued behind another doesn't burn its own budget waiting.
    return withSandboxLock(
        () => runCompiledSmartNoteCheckLocked(options, quickjs),
        options.signal,
        () => cancelledResult(options.signal?.reason),
    );
}

async function runCompiledSmartNoteCheckLocked(
    options: RunCompiledSmartNoteCheckOptions,
    quickjs: QuickJSAsyncWASMModule,
): Promise<RunCompiledSmartNoteCheckResult> {
    if (options.signal?.aborted) return cancelledResult(options.signal.reason);
    const timeoutMs = options.timeoutMs ?? SMART_NOTE_CHECK_TIMEOUT_MS;
    const cpuBudgetMs = Math.min(CPU_BUDGET_MS, timeoutMs);
    const controller = new AbortController();
    let externallyCancelled = false;
    let executionTimedOut = false;
    let cpuTimedOut = false;
    let persistentNetworkFailure = false;
    let uncheckableNetworkFailure = false;
    let missingResource = false;
    let httpFailure: SmartNoteNetworkError | undefined;
    let httpRetryAt: number | undefined;
    let waitingOnHttp = false;
    let httpWaitMs = 0;
    let startedAt: number | undefined;
    const cpuBudgetExceeded = (now: number) =>
        startedAt !== undefined && !waitingOnHttp && now - startedAt - httpWaitMs >= cpuBudgetMs;
    const externalAbort = () => {
        // Lease/sweep cancellation is not a pardon for JavaScript that has
        // already spent its CPU budget. Suspended HTTP never spends that budget.
        if (cpuBudgetExceeded(performance.now())) {
            cpuTimedOut = true;
            executionTimedOut = true;
        }
        externallyCancelled = true;
        controller.abort(options.signal?.reason);
    };
    options.signal?.addEventListener("abort", externalAbort, { once: true });
    const timer = setTimeout(() => {
        executionTimedOut = true;
        if (waitingOnHttp) {
            httpFailure = smartNoteNetworkTimeout(
                "SMART_NOTE_NETWORK: check timed out waiting on HTTP",
            );
            httpRetryAt = Math.max(httpRetryAt ?? 0, httpFailure.retryAt ?? 0);
        }
        controller.abort(new Error("smart-note check timed out"));
    }, timeoutMs);
    try {
        throwIfRunAborted(controller.signal);
        const capabilities = resolveCapabilitiesForRun(options, controller.signal);
        startedAt = performance.now();
        const deadline = startedAt + timeoutMs;
        options.onExecutionStart?.();
        throwIfRunAborted(controller.signal);
        // Own both lifetimes explicitly: the async module's implicit newContext
        // helper does not transfer runtime ownership to its context in 0.32.
        const runtime = quickjs.newRuntime();
        let context: QuickJSAsyncContext | undefined;
        let releaseCapabilities: (() => void) | undefined;
        const disposalHook = afterContextDisposal;
        try {
            context = runtime.newContext();
            runtime.setMemoryLimit(options.heapLimitBytes ?? DEFAULT_HEAP_LIMIT_BYTES);
            runtime.setMaxStackSize(options.stackLimitBytes ?? DEFAULT_STACK_LIMIT_BYTES);
            runtime.setInterruptHandler(() => {
                const now = performance.now();
                if (cpuBudgetExceeded(now)) {
                    cpuTimedOut = true;
                    executionTimedOut = true;
                    return true;
                }
                if (now >= deadline) {
                    executionTimedOut = true;
                    return true;
                }
                return controller.signal.aborted;
            });
            releaseCapabilities = installCapabilityObject(context, {
                ...capabilities,
                httpGet: async (url) => {
                    const waitStartedAt = performance.now();
                    waitingOnHttp = true;
                    try {
                        const response = await capabilities.httpGet(url);
                        if (response.status === 404 || response.status === 410)
                            missingResource = true;
                        return response;
                    } catch (error) {
                        // QuickJS turns host exceptions into guest errors, losing
                        // the typed failure metadata before the outer catch.
                        if (error instanceof SmartNoteNetworkError) {
                            if (!httpFailure?.persistent || error.uncheckable) httpFailure = error;
                            persistentNetworkFailure ||= error.persistent;
                            uncheckableNetworkFailure ||= error.uncheckable;
                            if (error.retryAt !== undefined) {
                                httpRetryAt = Math.max(httpRetryAt ?? 0, error.retryAt);
                            }
                        }
                        throw error;
                    } finally {
                        httpWaitMs += performance.now() - waitStartedAt;
                        waitingOnHttp = false;
                    }
                },
            });
            disableAmbientDynamicCode(context);
            const result = await evalCheck(context, options.compiledCheck);
            throwIfRunAborted(controller.signal);
            // Accept a returned {met} verdict: HTTP 404/410 can prove deletion.
            // Fetch failures (access, rate limit, size or timeout) still fail the
            // check, even if its JavaScript caught the error and returned a verdict.
            if (httpFailure) throw httpFailure;
            const checkResult = result as { met?: unknown } | null;
            if (!checkResult || typeof checkResult.met !== "boolean") {
                return failureResult("check() must return { met: boolean }", false);
            }
            return { ok: true, result: { met: checkResult.met } };
        } finally {
            try {
                try {
                    releaseCapabilities?.();
                } finally {
                    context?.dispose();
                }
            } finally {
                runtime.dispose();
            }
            if (context) disposalHook?.(context);
        }
    } catch (error) {
        // A previously caught network error must not relabel a subsequent busy
        // loop as transient. CPU exhaustion is independently a logic failure.
        if (cpuTimedOut) return failureResult("smart-note check exceeded CPU budget", false);
        // Queue deadlines and lease loss are control flow, not evidence that a
        // healthy compiled check is failing. Only this run's own timeout counts.
        if (externallyCancelled && !executionTimedOut) return cancelledResult(error);
        if (!executionTimedOut && !httpFailure && missingResource)
            return { ok: true, result: { met: false } };
        return failureResult(
            formatSandboxError(httpFailure ?? error),
            isSmartNoteNetworkError(httpFailure ?? error),
            persistentNetworkFailure,
            httpRetryAt,
            uncheckableNetworkFailure,
        );
    } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", externalAbort);
    }
}

function failureResult(
    error: string,
    network: boolean,
    persistent = false,
    retryAt?: number,
    uncheckable = false,
): RunCompiledSmartNoteCheckFailure {
    return {
        ok: false,
        cancelled: false,
        error: truncate(error),
        network,
        persistent,
        ...(uncheckable ? { uncheckable: true } : {}),
        ...(retryAt === undefined ? {} : { retryAt }),
    };
}

function cancelledResult(reason: unknown): RunCompiledSmartNoteCheckCancelled {
    return {
        ok: false,
        cancelled: true,
        error: truncate(reason instanceof Error ? reason.message : String(reason ?? "cancelled")),
        network: false,
    };
}

function formatSandboxError(error: unknown): string {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function truncate(value: string): string {
    return value.slice(0, MAX_SANDBOX_ERROR_CHARS);
}

function installCapabilityObject(
    context: QuickJSAsyncContext,
    cap: SmartNoteCapabilityApi,
): () => void {
    const capObject = context.newObject();
    const release = () => {
        try {
            // Evaluation has settled. Cleanup must still be able to allocate
            // property keys after an OOM or a CPU/abort interruption.
            context.runtime.setMemoryLimit(-1);
            context.runtime.removeInterruptHandler();
            // Guest wrappers can outlive check() through globals or prototypes.
            // Detach their private native functions while the runtime's HostRef
            // callbacks are still registered, then release our final handle.
            for (const name of [
                "__readFile",
                "__httpGet",
                "__gitHeadSha",
                "__gitTag",
                "__gitLog",
            ]) {
                context.setProp(capObject, name, context.undefined);
            }
        } finally {
            capObject.dispose();
        }
    };
    try {
        installAsyncStringFunction(context, capObject, "__readFile", async (arg) => {
            const value = await cap.readFile(arg);
            return value === null ? null : value;
        });
        installAsyncStringFunction(context, capObject, "__httpGet", async (arg) =>
            JSON.stringify(await cap.httpGet(arg)),
        );
        installAsyncNoArgFunction(context, capObject, "__gitHeadSha", async () => cap.gitHeadSha());
        installAsyncNoArgFunction(context, capObject, "__gitTag", async () => cap.gitTag());
        installAsyncStringFunction(context, capObject, "__gitLog", async (arg) => {
            const opts = arg
                ? (JSON.parse(arg) as { maxCount?: number; path?: string; since?: string })
                : undefined;
            return JSON.stringify(await cap.gitLog(opts));
        });
        context.setProp(context.global, "__mcHostCap", capObject);
        return release;
    } catch (error) {
        release();
        throw error;
    }
}

function installAsyncStringFunction(
    context: QuickJSAsyncContext,
    target: QuickJSHandle,
    name: string,
    fn: (arg: string) => Promise<string | null>,
): void {
    const handle = context.newAsyncifiedFunction(name, async (argHandle) => {
        const arg = context.getString(argHandle);
        const value = await fn(arg);
        return value === null ? context.null : context.newString(value);
    });
    handle.consume((fnHandle) => context.setProp(target, name, fnHandle));
}

function installAsyncNoArgFunction(
    context: QuickJSAsyncContext,
    target: QuickJSHandle,
    name: string,
    fn: () => Promise<string | null>,
): void {
    const handle = context.newAsyncifiedFunction(name, async () => {
        const value = await fn();
        return value === null ? context.null : context.newString(value);
    });
    handle.consume((fnHandle) => context.setProp(target, name, fnHandle));
}

function disableAmbientDynamicCode(context: QuickJSAsyncContext): void {
    context.setProp(context.global, "eval", context.undefined);
    context.setProp(context.global, "Function", context.undefined);
}

async function evalCheck(context: QuickJSAsyncContext, compiledCheck: string): Promise<unknown> {
    // Local bindings must die with evaluation rather than become global roots
    // for capability closures when the context and runtime are freed.
    const wrapped = `
(() => {
"use strict";
const module = { exports: {} };
const exports = module.exports;
const __mcCap = (() => {
  const hostCap = __mcHostCap;
  delete globalThis.__mcHostCap;
  if (Object.prototype.hasOwnProperty.call(globalThis, "__mcHostCap")) {
    globalThis.__mcHostCap = undefined;
  }
  return Object.freeze({
    readFile(path) { return hostCap.__readFile(String(path)); },
    httpGet(url) { return JSON.parse(hostCap.__httpGet(String(url))); },
    gitHeadSha() { return hostCap.__gitHeadSha(); },
    gitTag() { return hostCap.__gitTag(); },
    gitLog(opts) { return JSON.parse(hostCap.__gitLog(JSON.stringify(opts || {}))); },
  });
})();
${compiledCheck}
const __check = typeof check === "function" ? check : module.exports.check;
if (typeof __check !== "function") throw new Error("compiled check must define check(cap)");
const __result = __check(__mcCap);
if (!__result || typeof __result.met !== "boolean") throw new Error("check() must return { met: boolean }");
return JSON.stringify({ met: __result.met });
})();`;
    const evalResult = await context.evalCodeAsync(wrapped, "smart-note-check.js", {
        type: "global",
    });
    const resultHandle = context.unwrapResult(evalResult);
    try {
        return JSON.parse(context.getString(resultHandle));
    } finally {
        resultHandle.dispose();
    }
}
