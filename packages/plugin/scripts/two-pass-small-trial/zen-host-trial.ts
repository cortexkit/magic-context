import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { memoryHistorySnapshot } from "../../src/features/magic-context/memory/history-applier";
import { resolveProjectIdentityForSession } from "../../src/features/magic-context/memory/project-identity";
import { insertMemory } from "../../src/features/magic-context/memory/storage-memory";
import { HISTORIAN_FORMAT_INSTRUCTION } from "../../src/features/magic-context/memory/turn-one-publication";
import { buildTurnOneAuthorizationRequest } from "../../src/features/magic-context/memory/turn-two";
import { initializeDatabase } from "../../src/features/magic-context/storage-db";
import { historianSystemPrompt } from "../../src/hooks/magic-context/compartment-prompt";
import { Database } from "../../src/shared/sqlite";
import { callMeter, readPluginStore } from "../two-pass-activation-runs/activation-driver";
import { hostAdapter } from "../two-pass-activation-runs/host-adapters";
import { sumProviderSteps } from "../two-pass-activation-runs/provider-meter";
import { CampaignLedger } from "../two-pass-live-replay/artifact-schema";
import { attestHost, disposableEnvironment } from "../two-pass-live-replay/host-drivers";
import { turnOne } from "./prompts";
import { loadCases } from "./run";

const ZEN_PROVIDER_ID = "opencode";
const ZEN_MODEL_ID = "deepseek-v4.1-flash-free";
const ZEN_PROVIDER_URL = "https://opencode.ai/inference/openai";
const OUTPUT_CEILING = 32000;

if (import.meta.main) {
    const [root, install, variantArg, outArg] = process.argv.slice(2);
    const variant = variantArg === "high" ? "high" : variantArg === "max" ? "max" : null;
    if (!root || !install)
        throw new Error("usage: zen-host-trial.ts <root> <install> [high|max] [outDir]");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const outDir = outArg ?? join(root, "zen-host-001");
    mkdirSync(outDir, { recursive: true, mode: 0o700 });
    if (process.platform !== "linux") throw new Error("zen_child_linux_required");
    const { selected } = loadCases({
        version: 1,
        corpusRoot: join(install, "corpus-readonly"),
        manifestPath: "manifest.json",
        manifestSHA256: "cec9878c9514691005ce7b9b637ec0a56b902ea0269a46019637a9bcc565b7c2",
        caseIds: [0, 8, 10, 12, 35],
        repeats: 1,
        grant: { name: "apikey:deepseek", kind: "api_key" },
        endpoint: "https://api.deepseek.com/chat/completions",
        maxSpendUSD: 2,
        peakUSDPerMillion: { hit: 0.006, miss: 0.3, output: 1.2 },
        outputDir: ".cortexkit/internal-docs/investigations/two-pass-small-trial/paid-run-001",
    });
    const targets = selected.filter((c) => {
        // Default order stays 0,8,10,12,35. CASES=0 (comma-separated) runs a subset,
        // e.g. case 0 only to validate turn_one published + turn_two resolved before spending quota on all five.
        const only = (process.env.CASES ?? "")
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean);
        return only.length ? only.includes(String(c.id)) : [0, 8, 10, 12, 35].includes(c.id);
    });
    if (!process.env.CASES && targets.length !== 5) throw new Error("zen_five_cases_required");
    if (!targets.length) throw new Error("zen_no_cases_selected");
    const interfaces = networkInterfaces();
    const networkIsolation = { interfaces, routes: readFileSync("/proc/net/route", "utf8") };
    const ledger = new CampaignLedger();
    const profile = {
        id: `zen-opencode-1-${variant ?? "novariant"}`,
        family: "deepseek",
        entry: buildTurnOneAuthorizationRequest(
            {
                lane: "opencode-1",
                carrier: "opencode-session",
                provider: ZEN_PROVIDER_ID,
                modelId: ZEN_MODEL_ID,
                variant,
                temperature: null,
                thinkingLevel: null,
            },
            {
                system: historianSystemPrompt(true),
                formatInstruction: HISTORIAN_FORMAT_INSTRUCTION,
                toolSurface: [],
                checkToolSurface: [],
            },
        ).requestedIdentity,
        modelRoute: `${ZEN_PROVIDER_ID}/${ZEN_MODEL_ID}`,
        priceClass: "free" as const,
        tariff: {
            inputUSDPerMillion: 0,
            outputUSDPerMillion: 0,
            source: "https://opencode.ai/docs/zen/#pricing + https://opencode.ai/inference/v1/models",
        },
        configurationSource: "explicit zen-host trial job",
        variantSource: variant ? "explicit variant high for thinking" : "explicit unset variant",
    };
    const adapter = hostAdapter("opencode-1", {
        sourceRoot: install,
        mockProviderURL: ZEN_PROVIDER_URL,
        modelId: ZEN_MODEL_ID,
        providerId: ZEN_PROVIDER_ID,
        providerPackage: "@ai-sdk/openai-compatible",
        outputCeiling: OUTPUT_CEILING,
        timeoutMs: 1_800_000,
        startupTimeoutMs: 300_000,
        forceWrapup: true,
        grantFree: true,
        paidProvider: true,
        magicContext: {
            historian: {
                opencode: variant
                    ? { model: { model: `${ZEN_PROVIDER_ID}/${ZEN_MODEL_ID}`, variant } }
                    : { model: `${ZEN_PROVIDER_ID}/${ZEN_MODEL_ID}` },
                turn_two: "on",
                two_pass: false,
                maxTokens: OUTPUT_CEILING,
            },
            memory: {
                enabled: true,
                auto_promote: true,
                auto_search: { enabled: false },
                git_commit_indexing: { enabled: false },
            },
            embedding: { provider: "off" },
        },
    });
    const pluginEntrypoint = join(install, "packages/plugin/dist/index.js");
    const summary: Array<Record<string, unknown>> = [];
    for (const c of targets) {
        const caseRoot = join(root, `case-${c.id}`);
        mkdirSync(caseRoot, { recursive: true, mode: 0o700 });
        const caseEnv = disposableEnvironment(caseRoot);
        mkdirSync(caseEnv.MAGIC_CONTEXT_STORAGE_DIR, { recursive: true, mode: 0o700 });
        mkdirSync(join(caseRoot, "work"), { recursive: true, mode: 0o700 });
        const project = resolveProjectIdentityForSession(join(caseRoot, "work"), false);
        if (!project) throw new Error("fixture_project_identity_unobservable");
        const db = new Database(join(caseEnv.MAGIC_CONTEXT_STORAGE_DIR, "context.db"));
        try {
            initializeDatabase(db);
            for (const m of c.memories) {
                const stored = insertMemory(db, {
                    projectPath: project,
                    category: m.category,
                    content: m.content,
                    sourceType: "historian",
                });
                db.prepare("UPDATE memories SET id=?,revision=? WHERE id=?").run(
                    m.id,
                    m.revision,
                    stored.id,
                );
            }
            const seed = db.prepare("SELECT id FROM memories LIMIT 1").get();
            if (c.memories.length && !seed) throw new Error("seed_insert_failed");
            if (seed && !memoryHistorySnapshot(db, (seed as { id: number }).id))
                throw new Error("fixture_seed_not_history_compatible");
        } finally {
            db.close();
        }
        const firstRequest = turnOne(c, "enabled");
        writeFileSync(
            join(outDir, `case-${c.id}-trial-first-request.json`),
            JSON.stringify(firstRequest, null, 2),
            { mode: 0o600 },
        );
        // For activation, send only the transcript (new_messages body), not the prebuilt historian prompt.
        // The plugin builds its own historian prompt (examples + references + transcript + format)
        // from session history; sending the prebuilt prompt would double-wrap examples/format
        // and fail validation (as observed: "no usable compartments").
        const newMessagesMatch = c.userPrompt.match(/<new_messages>[\s\S]*?<\/new_messages>/);
        const transcriptOnly = newMessagesMatch
            ? newMessagesMatch[0].slice(0, 150_000)
            : (firstRequest.messages[1].content as string).slice(0, 150_000);
        let host: Awaited<ReturnType<typeof adapter.start>> | undefined;
        try {
            host = await adapter.start({
                installRoot: install,
                pluginEntrypoint,
                env: caseEnv,
                meter: callMeter(ledger, profile as never),
            });
            const before = await attestHost(caseRoot, caseEnv, host.pid);
            if (before.proof.tool !== "lsof -Fpn")
                throw new Error("proof_requires_lsof_not_proc_fallback");
            writeFileSync(
                join(outDir, `case-${c.id}-lsof-before.json`),
                JSON.stringify(before, null, 2),
                { mode: 0o600 },
            );
            const promptText = transcriptOnly;
            const session = (await host.runSession(promptText)) as {
                requests: Array<{
                    request: { path: string; body: string; providerHost?: string };
                    response: {
                        status: number;
                        body: string;
                        contentType: string;
                        responseHeaders?: Record<string, string>;
                    };
                    steps?: Array<{ inputTokens: number; outputTokens: number }>;
                }>;
                carrier?: string;
                sessionId?: string;
            };
            if (host.carrier !== "opencode-session")
                throw new Error(`observed_carrier_mismatch:${host.carrier}`);
            const after = await attestHost(caseRoot, caseEnv, host.pid);
            if (after.proof.tool !== "lsof -Fpn")
                throw new Error("proof_requires_lsof_not_proc_fallback");
            writeFileSync(
                join(outDir, `case-${c.id}-lsof-after.json`),
                JSON.stringify(after, null, 2),
                { mode: 0o600 },
            );
            if (host.storePath === null) throw new Error("plugin_store_unobservable");
            const store = readPluginStore(caseRoot, host.storePath);
            const stages = (store.stages as Array<Record<string, unknown>>).filter(
                (r) => r.stage === "turn_one" || r.stage === "turn_two",
            );
            const turnOneStage = (
                store.stages as Array<{
                    stage: string;
                    state: string;
                    reply_json: string | null;
                    child_session_id: string | null;
                }>
            ).find((r) => r.stage === "turn_one" && r.state === "published");
            const turnTwoStage = (
                store.stages as Array<{
                    stage: string;
                    state: string;
                    reply_json: string | null;
                    child_session_id: string | null;
                }>
            ).find((r) => r.stage === "turn_two" && r.state === "resolved");
            const firstReply = turnOneStage?.reply_json
                ? ((JSON.parse(turnOneStage.reply_json) as { text?: string }).text ??
                  turnOneStage.reply_json)
                : null;
            const secondReply = turnTwoStage?.reply_json
                ? ((JSON.parse(turnTwoStage.reply_json) as { text?: string }).text ??
                  turnTwoStage.reply_json)
                : null;
            if (firstReply)
                writeFileSync(join(outDir, `case-${c.id}-turn-one-reply.txt`), firstReply, {
                    mode: 0o600,
                });
            if (secondReply)
                writeFileSync(join(outDir, `case-${c.id}-turn-two-reply.txt`), secondReply, {
                    mode: 0o600,
                });
            writeFileSync(
                join(outDir, `case-${c.id}-provider-receipts.json`),
                JSON.stringify(session.requests, null, 2),
                { mode: 0o600 },
            );
            for (const receipt of session.requests) {
                // Container stdout carries status + every response header per request so the
                // free tier's rate-limit/reset window is readable even if later stages time out.
                console.log(
                    JSON.stringify({
                        caseId: c.id,
                        path: receipt.request.path,
                        status: receipt.response.status,
                        contentType: receipt.response.contentType,
                        responseHeaders: receipt.response.responseHeaders ?? null,
                        rawBytes: receipt.response.body.length,
                        rawPreview: receipt.response.body.slice(0, 500),
                    }),
                );
            }
            writeFileSync(
                join(outDir, `case-${c.id}-stages.json`),
                JSON.stringify(stages, null, 2),
                { mode: 0o600 },
            );
            const historianRequests = session.requests.filter((r) => {
                try {
                    const body = JSON.parse(r.request.body) as {
                        messages?: Array<{ role: string; content: unknown }>;
                        system?: unknown;
                    };
                    const text = (v: unknown): string =>
                        typeof v === "string"
                            ? v
                            : Array.isArray(v)
                              ? v.map(text).join("\n")
                              : typeof (v as { text?: unknown })?.text === "string"
                                ? (v as { text: string }).text
                                : "";
                    const sys =
                        body.system ??
                        body.messages?.filter((m) => m.role === "system").map((m) => m.content);
                    return text(sys).includes(historianSystemPrompt(true).slice(0, 128));
                } catch {
                    return false;
                }
            });
            summary.push({
                caseId: c.id,
                carrier: host.carrier,
                sessionId: session.sessionId,
                historianRequestCount: historianRequests.length,
                providerRequestCount: session.requests.length,
                turnOnePublished: !!turnOneStage,
                turnTwoResolved: !!turnTwoStage,
                sameChild:
                    !!turnOneStage &&
                    !!turnTwoStage &&
                    turnOneStage.child_session_id === turnTwoStage.child_session_id,
                firstReplyChars: firstReply?.length ?? 0,
                secondReplyChars: secondReply?.length ?? 0,
                usage: sumProviderSteps(session.requests.flatMap((r) => r.steps ?? [])),
                maxTokensObserved: [
                    ...new Set(
                        historianRequests.map((r) => {
                            try {
                                return (JSON.parse(r.request.body) as { max_tokens?: number })
                                    .max_tokens;
                            } catch {
                                return undefined;
                            }
                        }),
                    ),
                ],
                reasoningFields: [
                    ...new Set(
                        historianRequests.map((r) => {
                            try {
                                const b = JSON.parse(r.request.body) as Record<string, unknown>;
                                return JSON.stringify({
                                    reasoning: b.reasoning ?? null,
                                    thinking: b.thinking ?? null,
                                });
                            } catch {
                                return "unparseable";
                            }
                        }),
                    ),
                ],
            });
            writeFileSync(
                join(outDir, `transcript-case-${c.id}.md`),
                `# Case ${c.id} — Zen host trial (opencode-session, ${ZEN_PROVIDER_ID}/${ZEN_MODEL_ID}${variant ? ` variant=${variant}` : ""})\n\n## Turn 1 reply — historian via host\n\n\`\`\`\n${(firstReply ?? "TURN_ONE_UNRESOLVED").slice(0, 200_000)}\n\`\`\`\n\n## Turn 2 reply — historian via host\n\n\`\`\`\n${(secondReply ?? "TURN_TWO_UNRESOLVED").slice(0, 200_000)}\n\`\`\`\n`,
                { mode: 0o600 },
            );
        } finally {
            if (host) await host.stop();
        }
    }
    writeFileSync(
        join(outDir, "zen-host-summary.json"),
        JSON.stringify(
            {
                lane: "opencode-1",
                carrier: "opencode-session",
                provider: ZEN_PROVIDER_ID,
                modelId: ZEN_MODEL_ID,
                variant,
                outputCeiling: OUTPUT_CEILING,
                network: "bridge-for-zen-provider-call",
                networkIsolation,
                ledger: ledger.rows,
                summary,
                actualUSDSpent: 0,
                credentials: "none (Zen free tier)",
            },
            null,
            2,
        ),
        { mode: 0o600 },
    );
    console.log(
        JSON.stringify({
            lane: "opencode-1",
            carrier: "opencode-session",
            cases: summary.length,
            outDir,
        }),
    );
}
