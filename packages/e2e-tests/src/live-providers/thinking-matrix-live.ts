/**
 * Opt-in, billed native Messages experiment. The installed subscription plugin shapes
 * auth against a loopback-only bootstrap; subsequent requests go directly to Anthropic.
 * Unlike the MC trim scenario, this deliberately edits independent copies of wire history.
 * No response branch is appended to the seed, no retries or account rotation occur, and
 * bearer headers remain in memory only. Recorded specimens are read only from the
 * private specimen directory; no raw request/response bodies enter the results.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { assertThrowawayRoot, authPluginPath } from "./auth";
import { fetchCredential, type CredentialId } from "./ckcred";
import { startHost } from "./host";
import { claudeOAuth } from "./scenarios/anthropic";
import {
    buildSeedRequest,
    isSigned,
    isQuotaError,
    MAX_SEED_TURNS,
    MIN_COMPLETED_TURNS,
    MIN_SIGNED_BLOCKS,
    prepareRecordedSeed,
    replaceLastUserText,
    restoreFirstSignedBlock,
    runRecordedCells,
    seedPrompt,
    seedThinkingConfig,
    shouldRetryRefusal,
    shouldSeedTurn,
    signedBlockCount,
    thinkingVariants,
    type Block,
    type ThinkingRequest,
} from "./thinking-matrix";
import { readResponse, requestShape, scrubError } from "./wire";

const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i < 0 ? undefined : process.argv[i + 1];
};

export async function runThinkingMatrix(options: {
    out: string; opencode: string; authPlugin: string; seedFiles?: Partial<Record<string, string>>;
}): Promise<boolean> {
    if (process.env.MC_LIVE_PROVIDERS !== "1") throw new Error("Set MC_LIVE_PROVIDERS=1 to authorize billed calls");
    assertThrowawayRoot(options.out);
    const recorded = options.seedFiles !== undefined;
    const maxCalls = recorded ? 18 : 92;
    const cap = Number(process.env.MC_LIVE_MAX_CALLS ?? maxCalls);
    if (!Number.isInteger(cap) || cap < 1 || cap > maxCalls) throw new Error(`Call cap must be an integer in 1..${maxCalls}`);
    const seeds = new Map<string, { request: ThinkingRequest; summary: {
        file: string; bytes: number; model: string; signedBlocks: number; signedAssistantTurns: number; tokenEstimate: number;
    } }>();
    for (const [model, file] of Object.entries(options.seedFiles ?? {})) {
        if (!file || !["claude-opus-5-5", "claude-sonnet-5-5"].includes(model)) throw new Error("Unexpected recorded seed selection");
        const directory = resolve(homedir(), ".local/share/cortexkit/magic-context/specimens/thinking-matrix");
        const path = resolve(file);
        if (!path.startsWith(`${directory}${sep}`) || realpathSync(path) !== path) {
            throw new Error("Use a non-symlink seed under the private thinking-matrix specimen directory");
        }
        const stat = lstatSync(path);
        if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error("Recorded seed must be a mode-0600 regular file");
        const raw = readFileSync(path, "utf8");
        const request = prepareRecordedSeed(JSON.parse(raw) as ThinkingRequest, model);
        seeds.set(model, { request, summary: { file: basename(path), bytes: stat.size, model,
            signedBlocks: signedBlockCount(request),
            signedAssistantTurns: request.messages.filter((message) => message.role === "assistant" && message.content.some(isSigned)).length,
            tokenEstimate: Math.ceil(Buffer.byteLength(raw) / 4) } });
    }
    if (recorded && !seeds.size) throw new Error("Supply at least one recorded seed");
    const credentialId: CredentialId = "oauth:anthropic";
    authPluginPath(claudeOAuth, { "anthropic-auth": options.authPlugin });
    mkdirSync(options.out, { recursive: true, mode: 0o700 });
    if (existsSync(join(options.out, "results.json"))) throw new Error("Use a fresh output directory");
    const material = await fetchCredential(credentialId);
    const secrets = [material];
    const rememberStrings = (value: unknown): void => {
        if (typeof value === "string" && value.length >= 16) secrets.push(value, JSON.stringify(value).slice(1, -1));
        else if (value && typeof value === "object") for (const item of Object.values(value)) rememberStrings(item);
    };
    for (const seed of seeds.values()) rememberStrings(seed.request);
    // Preserve complete error bodies, unlike the shared recorder's 800-character summary.
    const redactError = (text: string) => {
        for (const secret of secrets) if (secret) text = text.replaceAll(secret, "[REDACTED]");
        return text.replace(/Bearer\s+[\w.~+/=-]{20,}|sk-[\w-]{8,}|bedrock-api-key-\S+/gi, "[REDACTED]");
    };
    let captured: { headers: Headers; body: Record<string, unknown> } | undefined;
    const loopback = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
        captured = { headers: new Headers(req.headers), body: await req.json() as Record<string, unknown> };
        return Response.json({ type: "error", error: { type: "invalid_request_error", message: "loopback auth bootstrap complete; no model call" } }, { status: 400 });
    } });
    const root = join(options.out, "bootstrap-root");
    const isolation: { pid: number | null; dbFiles: string[]; rootRemoved: boolean } = { pid: null, dbFiles: [], rootRemoved: false };
    try {
        const host = await startHost({ binary: options.opencode, root, route: claudeOAuth, apiKey: material,
            recorderBaseURL: `http://127.0.0.1:${loopback.port}/v1`, magicContext: {},
            authPlugins: { "anthropic-auth": options.authPlugin } });
        try {
            isolation.pid = host.pid;
            const session = (await host.api("/session", { title: "native thinking matrix auth bootstrap" })).value as { id: string };
            isolation.dbFiles = host.checkIsolation();
            await host.api(`/session/${session.id}/message`, {
                model: { providerID: "anthropic", modelID: claudeOAuth.model },
                parts: [{ type: "text", text: "Reply OK. Do not use tools." }],
            }, 60_000);
            isolation.dbFiles = host.checkIsolation();
        } finally { await host.dispose(); }
    } finally { loopback.stop(true); isolation.rootRemoved = !existsSync(root); }
    if (!captured) throw new Error("Installed auth plugin did not reach the loopback bootstrap");
    const { headers, body } = captured;
    for (const name of ["host", "content-length", "connection", "accept-encoding"]) headers.delete(name);
    if (!headers.get("authorization")?.startsWith("Bearer ")) throw new Error("Bootstrap did not provide bearer auth");
    const beta = new Set((headers.get("anthropic-beta") ?? "").split(",").filter(Boolean));
    beta.add("thinking-binding-controls-2026-08-01");
    headers.set("anthropic-beta", [...beta].join(","));
    const firstSystem = (body.system as Array<{ type: string; text: string }> | undefined)?.[0];
    if (!firstSystem || typeof firstSystem.text !== "string") throw new Error("Missing subscription system prefix");
    const results: Array<{
        model: string; outcome: string; reason: string | null; signedBlocks: number; completedTurns: number;
        seedRounds: Array<{ turn: number; signedBlocks: number; cumulativeSignedBlocks: number; toolRequestId: string | null; finalRequestId: string | null }>;
        seed?: unknown;
        calls: unknown[]; variants: Array<{ variant: string; expected: string; status: number | null; requestId: string | null; accepted: boolean | null; note?: string }>;
    }> = [];
    let callsUsed = 0;
    let authRejected = false;
    let stopRun = false;
    const startedAt = new Date().toISOString();
    const write = () => writeFileSync(join(options.out, "results.json"), `${JSON.stringify({
        schema: 3, startedAt, updatedAt: new Date().toISOString(), source: recorded ? "recorded" : "synthetic",
        baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: import.meta.dir, windowsHide: true }).toString().trim(),
        credentialId, authBootstrap: { hostVersion: "1.18.30", upstreamCalls: 0, isolation },
        endpoint: "https://api.anthropic.com/v1/messages", bindingBeta: true,
        thinking: recorded ? "preserved adaptive configuration with strict block binding" : seedThinkingConfig(),
        outputConfig: recorded ? "preserved recorded output_config.effort" : { effort: "high" }, maxTokens: recorded ? 64 : 1152,
        minimumSignedBlocks: recorded ? 6 : MIN_SIGNED_BLOCKS, minimumCompletedTurns: MIN_COMPLETED_TURNS, maxSeedTurns: recorded ? 0 : MAX_SEED_TURNS,
        callCap: cap, callsUsed, results,
    }, null, 2)}\n`, { mode: 0o600 });
    const send = async (model: string, phase: string, request: ThinkingRequest, calls: unknown[]) => {
        if (callsUsed >= cap) throw new Error(`Call cap ${cap} spent`);
        callsUsed++;
        const at = new Date().toISOString();
        const text = JSON.stringify(request);
        const response = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers, body: text,
            signal: AbortSignal.timeout(120_000) });
        const raw = await response.text();
        const reading = readResponse("anthropic-messages", raw);
        const value = response.ok ? JSON.parse(raw) as { content: Block[]; stop_reason: string } : null;
        const record = { index: callsUsed, at, model, phase, status: response.status,
            accepted: response.ok && !reading.streamError, requestId: response.headers.get("request-id"),
            stopReason: value?.stop_reason ?? null,
            error: response.ok ? (reading.streamError ? redactError(reading.streamError) : null) : redactError(raw),
            usage: reading.usage, diagnostics: reading.diagnostics, request: requestShape("anthropic-messages", text) };
        calls.push(record);
        write();
        console.error(`[thinking-matrix] ${model} ${phase}: HTTP ${record.status}; usage=${JSON.stringify(record.usage?.raw ?? null)}`);
        if (isQuotaError(response.status, record.error)) stopRun = true;
        return { record, value };
    };
    const seedValue = (sent: Awaited<ReturnType<typeof send>>, phase: string) => {
        if ([401, 403].includes(sent.record.status)) {
            authRejected = true;
            throw new Error(`${phase} authentication rejected: HTTP ${sent.record.status}`);
        }
        if (sent.record.status === 429) throw new Error(`${phase} rate-limited: HTTP 429`);
        if (!sent.record.accepted || !sent.value) throw new Error(`${phase} rejected: HTTP ${sent.record.status}`);
        return sent.value;
    };
    const interruptOnProviderFailure = (status: number, phase: string) => {
        if ([401, 403].includes(status)) {
            authRejected = true;
            throw new Error(`${phase} authentication rejected: HTTP ${status}`);
        }
        if (status === 429) throw new Error(`${phase} rate-limited: HTTP 429`);
        if (status >= 500) throw new Error(`${phase} interrupted by HTTP ${status}`);
    };
    const rememberThinkingSecrets = (blocks: Block[]) => {
        for (const block of blocks) {
            if (typeof block.signature === "string") secrets.push(block.signature);
            if (typeof block.data === "string") secrets.push(block.data);
        }
    };
    for (const model of ["claude-opus-5-5", "claude-sonnet-5-5"]) {
        if (authRejected || stopRun) break;
        const result = {
            model, outcome: "aborted", reason: null as string | null, signedBlocks: 0, completedTurns: 0,
            seedRounds: [] as Array<{ turn: number; signedBlocks: number; cumulativeSignedBlocks: number; toolRequestId: string | null; finalRequestId: string | null }>,
            calls: [] as unknown[], variants: [] as Array<{ variant: string; expected: string; status: number | null; requestId: string | null; accepted: boolean | null; note?: string }>,
        };
        results.push(result);
        if (recorded) {
            const seed = seeds.get(model);
            if (!seed) {
                result.outcome = "skipped";
                result.reason = "No qualifying recorded seed supplied; no synthetic seeding or live call attempted";
                write();
                continue;
            }
            result.signedBlocks = seed.summary.signedBlocks;
            Object.assign(result, { seed: seed.summary });
            try {
                const requestIds = new Map<string, string | null>();
                const matrix = await runRecordedCells(seed.request, async (variant, request) => {
                    const sent = await send(model, variant, request, result.calls);
                    requestIds.set(variant, sent.record.requestId);
                    if (sent.value) rememberStrings(sent.value.content);
                    if ([401, 403].includes(sent.record.status)) authRejected = true;
                    if (variant === "control" && !sent.record.accepted) stopRun = true;
                    return { status: sent.record.status, accepted: sent.record.accepted,
                        content: sent.value?.content ?? null, error: sent.record.error };
                });
                result.variants.push(...matrix.cells.map((cell) => ({ ...cell, requestId: requestIds.get(cell.variant) ?? null })));
                result.outcome = matrix.completed ? "completed" : "aborted";
                result.reason = matrix.reason ?? (matrix.completed ? null : "Restore check not reached: no new signed block in prefix-trim response");
            } catch (error) { result.reason = scrubError(String(error), secrets); }
            write();
            continue;
        }
        const request = buildSeedRequest(model, firstSystem.text);
        try {
            // Complete every note-tool round so each next seed call has a valid tool result.
            for (let turn = 1; shouldSeedTurn(result.signedBlocks, result.completedTurns, turn); turn++) {
                const signedBefore = result.signedBlocks;
                request.messages.push({ role: "user", content: [{ type: "text", text: seedPrompt(turn, "tool") }] });
                let toolSent = await send(model, `seed-${turn}-tool`, request, result.calls);
                let toolValue = seedValue(toolSent, `seed-${turn}-tool`);
                if (shouldRetryRefusal(toolValue.stop_reason, false)) {
                    replaceLastUserText(request, seedPrompt(turn, "tool-retry"));
                    toolSent = await send(model, `seed-${turn}-tool-retry`, request, result.calls);
                    toolValue = seedValue(toolSent, `seed-${turn}-tool-retry`);
                }
                if (toolValue.stop_reason !== "tool_use") {
                    throw new Error(`Seed did not produce one record_note tool call (${toolValue.stop_reason})`);
                }
                const uses = toolValue.content.filter((block) => block.type === "tool_use");
                if (uses.length !== 1 || uses[0]!.name !== "record_note") {
                    throw new Error(`Seed did not produce exactly one record_note tool call (${uses.length})`);
                }
                const input = uses[0]!.input as { note?: unknown };
                if (typeof input.note !== "string") throw new Error("record_note input did not contain a string note");
                request.messages.push({ role: "assistant", content: toolValue.content });
                request.messages.push({ role: "user", content: [
                    { type: "tool_result", tool_use_id: String(uses[0]!.id), content: input.note },
                    { type: "text", text: seedPrompt(turn, "final") },
                ] });

                let finalSent = await send(model, `seed-${turn}-final`, request, result.calls);
                let finalValue = seedValue(finalSent, `seed-${turn}-final`);
                if (shouldRetryRefusal(finalValue.stop_reason, false)) {
                    replaceLastUserText(request, seedPrompt(turn, "final-retry"));
                    finalSent = await send(model, `seed-${turn}-final-retry`, request, result.calls);
                    finalValue = seedValue(finalSent, `seed-${turn}-final-retry`);
                }
                if (finalValue.stop_reason !== "end_turn") throw new Error(`Incomplete note-tool round (${finalValue.stop_reason})`);
                request.messages.push({ role: "assistant", content: finalValue.content });
                result.completedTurns++;
                result.signedBlocks = signedBlockCount(request);
                result.seedRounds.push({ turn, signedBlocks: result.signedBlocks - signedBefore,
                    cumulativeSignedBlocks: result.signedBlocks, toolRequestId: toolSent.record.requestId,
                    finalRequestId: finalSent.record.requestId });
                rememberThinkingSecrets(toolValue.content);
                rememberThinkingSecrets(finalValue.content);
            }
            if (result.signedBlocks < MIN_SIGNED_BLOCKS || result.completedTurns < MIN_COMPLETED_TURNS) {
                throw new Error(`Need ${MIN_SIGNED_BLOCKS} signed blocks across ${MIN_COMPLETED_TURNS} completed turns; got ${result.signedBlocks} across ${result.completedTurns}`);
            }
            request.messages.push({ role: "user", content: [{ type: "text", text: "Think briefly: what is 7 times 8? Reply only with the number. Do not use tools." }] });
            const variants = thinkingVariants(request);
            let oldestPrefix: { request: ThinkingRequest; content: Block[]; stopReason: string } | undefined;
            for (const variant of variants) {
                const sent = await send(model, variant.variant, variant.request, result.calls);
                result.variants.push({ variant: variant.variant, expected: variant.expected, status: sent.record.status,
                    requestId: sent.record.requestId, accepted: sent.record.accepted });
                interruptOnProviderFailure(sent.record.status, variant.variant);
                if (variant.variant === "control" && !sent.record.accepted) {
                    throw new Error("Unchanged control rejected; variants would be inconclusive");
                }
                if (variant.variant === "oldest-1" && sent.record.accepted && sent.value?.stop_reason === "end_turn") {
                    oldestPrefix = { request: variant.request, content: sent.value.content, stopReason: sent.value.stop_reason };
                    rememberThinkingSecrets(sent.value.content);
                }
            }
            let restorationReached = false;
            if (oldestPrefix && oldestPrefix.content.some(isSigned)) {
                const whileAbsent = structuredClone(oldestPrefix.request);
                whileAbsent.messages.push({ role: "assistant", content: oldestPrefix.content });
                whileAbsent.messages.push({ role: "user", content: [{ type: "text", text: seedPrompt(0, "final") }] });
                const restored = restoreFirstSignedBlock(request, whileAbsent);
                const sent = await send(model, "restore-removed-prefix", restored, result.calls);
                restorationReached = true;
                result.variants.push({ variant: "restore-removed-prefix",
                    expected: "400/signature error after restoring a removed prefix", status: sent.record.status,
                    requestId: sent.record.requestId, accepted: sent.record.accepted });
                interruptOnProviderFailure(sent.record.status, "restore-removed-prefix");
            } else {
                result.variants.push({ variant: "restore-removed-prefix",
                    expected: "400/signature error after restoring a removed prefix", status: null,
                    requestId: null, accepted: null,
                    note: "Not reached: oldest-prefix response did not include a signed block generated while the prefix was absent" });
            }
            if (restorationReached) result.outcome = "completed";
            else result.reason = "Restore check was not reached because no signed response was generated while the prefix was absent";
        } catch (error) { result.reason = scrubError(String(error), secrets); }
        write();
    }
    return results.length === 2 && results.every((result) => result.outcome === "completed" || (recorded && result.outcome === "skipped"));
}

if (import.meta.main) {
    try {
        const out = arg("out");
        const authPlugin = arg("anthropic-auth") ?? process.env.MC_LIVE_ANTHROPIC_AUTH_PLUGIN;
        const opencode = arg("opencode") ?? process.env.MC_LIVE_OPENCODE;
        if (!out || !authPlugin || !opencode) throw new Error("Supply --out, --opencode and --anthropic-auth");
        const opusSeed = arg("opus-seed");
        const sonnetSeed = arg("sonnet-seed");
        const seedFiles = opusSeed || sonnetSeed ? {
            ...(opusSeed ? { "claude-opus-5-5": opusSeed } : {}),
            ...(sonnetSeed ? { "claude-sonnet-5-5": sonnetSeed } : {}),
        } : undefined;
        process.exitCode = await runThinkingMatrix({ out, opencode, authPlugin, seedFiles }) ? 0 : 1;
    } catch {
        // Unexpected library exceptions may contain request headers. Do not log them.
        console.error("Thinking matrix setup/network failure; no credential diagnostics are printed.");
        process.exitCode = 1;
    }
}
