import { afterEach, describe, expect, test } from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDatabase } from "../../src/features/magic-context/storage-db";
import { insertMemory } from "../../src/features/magic-context/memory/storage-memory";
import { buildTurnOneAuthorizationRequest } from "../../src/features/magic-context/memory/turn-two";
import { HISTORIAN_FORMAT_INSTRUCTION } from "../../src/features/magic-context/memory/turn-one-publication";
import { buildTurnTwoPrompt } from "../../src/features/magic-context/memory/turn-two-envelope";
import {
    buildCompartmentAgentPrompt,
    historianSystemPrompt,
} from "../../src/hooks/magic-context/compartment-prompt";
import { Database } from "../../src/shared/sqlite";
import { CampaignLedger, type Profile } from "../two-pass-live-replay/artifact-schema";
import { disposableEnvironment, type Isolation } from "../two-pass-live-replay/host-drivers";
import {
    redact,
    runActivation,
    type ActivationTransport,
    type ScopedCredentials,
} from "./activation-driver";
import {
    measurementPrompts,
    runCacheMeasurement,
    type MeasurementReply,
    type MeasurementRequest,
    type MeasurementTransport,
    type PersistedMeasurementInputs,
} from "./cache-measurement-driver";

const roots: string[] = [];
function root() {
    const parent = join(realpathSync(tmpdir()), "magic-context");
    mkdirSync(parent, { recursive: true });
    const path = mkdtempSync(join(parent, "v5-test-"));
    roots.push(path);
    return path;
}
afterEach(() => {
    for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
function isolation(path: string): Isolation {
    return {
        root: path,
        env: disposableEnvironment(path),
        proof: { pid: 42, tool: "fake-handles", output: path, paths: [join(path, "host.db")] },
    };
}
function profile(lane: "opencode-1" | "opencode-2" | "omp" = "opencode-2"): Profile {
    const entry = buildTurnOneAuthorizationRequest(
        {
            lane,
            carrier: lane === "omp" ? "pi-historian-rpc" : "hidden-completion",
            provider: "anthropic",
            modelId: "claude-sonnet-5-5",
            variant: null,
            temperature: null,
            thinkingLevel: null,
        },
        {
            system: historianSystemPrompt(true),
            formatInstruction: HISTORIAN_FORMAT_INSTRUCTION,
            toolSurface: [],
            checkToolSurface: [],
        },
    ).requestedIdentity;
    return {
        id: "sonnet-measurement",
        family: "claude",
        entry,
        modelRoute: "anthropic/claude-sonnet-5-5",
        priceClass: "paid",
        tariff: { inputUSDPerMillion: 1, outputUSDPerMillion: 2, source: "fake tariff" },
        configurationSource: "fixture",
        variantSource: "fixture",
    };
}
function inputs(): PersistedMeasurementInputs {
    const turnOneInput = {
        inputSource: "[1] user: Use 64 KiB chunks, not 32 KiB.",
        anchoredFacts: true,
        seedExamples: "",
        sessionReferences: "",
        projectMemory: "",
    };
    const turnTwoInput = { facts: [], items: [], lexicalOnly: true };
    return {
        turnOneInput,
        turnTwoInput,
        turnOneRequestJson: JSON.stringify({
            system: historianSystemPrompt(true),
            formatInstruction: HISTORIAN_FORMAT_INSTRUCTION,
            prompt: `${buildCompartmentAgentPrompt(turnOneInput)}\n\n${HISTORIAN_FORMAT_INSTRUCTION}`,
        }),
        turnTwoRequestJson: JSON.stringify({ prompt: buildTurnTwoPrompt(turnTwoInput) }),
    };
}
const secret = "fake-ckcred-key-not-a-real-key";
function credentials(events: string[]): ScopedCredentials {
    return {
        async getScoped(id) {
            events.push(`get:${id}`);
            return secret;
        },
        async notifyRunEnded(id) {
            events.push(`end:${id}`);
        },
    };
}
function measurement(path: string, read: number | undefined = 95, fallback = false) {
    const requests: MeasurementRequest[] = [];
    const events: string[] = [];
    const replies: MeasurementReply[] = [
        {
            text: `not JSON; raw reply ${secret}`,
            usage: { input_tokens: 10, cache_creation_input_tokens: 90 },
            chargeUSD: 0,
        },
        {
            text: "not a lifecycle decision",
            usage: read === undefined ? {} : { cache_read_input_tokens: read },
            metadata: { Authorization: "Bearer something", nested: { echoed: secret } },
            chargeUSD: 0,
        },
    ];
    const session = {
        id: "same-child",
        isolation: isolation(path),
        maxSteps: 1,
        hostRetries: 0,
        async send(request: MeasurementRequest) {
            requests.push(request);
            events.push("send");
            return replies[requests.length - 1];
        },
        async close() {
            events.push("close");
        },
    };
    const transport: MeasurementTransport = {
        kind: "fake",
        async openBroca() {
            events.push("broca");
            return fallback ? null : session;
        },
        async openAnthropic(input) {
            expect(input.env.ANTHROPIC_API_KEY).toBe(secret);
            expect(input.model).toBe("claude-sonnet-5-5");
            events.push("anthropic");
            return session;
        },
    };
    const options = {
        root: path,
        profile: profile(),
        ledger: new CampaignLedger(),
        transport,
        inputs: inputs(),
        outputCeiling: 100,
        credentials: credentials(events),
        anthropicGrant: "apikey:anthropic:ufukaltinokgmail" as const,
    };
    return { options, requests, replies, events };
}
function files(path: string): Record<string, string> {
    const entries: Record<string, string> = {};
    const walk = (folder: string) => {
        for (const entry of readdirSync(folder, { withFileTypes: true })) {
            const file = join(folder, entry.name);
            if (entry.isDirectory()) walk(file);
            else entries[file] = readFileSync(file).toString("hex");
        }
    };
    walk(path);
    return entries;
}

describe("cache measurement", () => {
    test("production persisted bytes extend raw history but measurement writes nothing", async () => {
        const path = root();
        writeFileSync(join(path, "store-sentinel"), "unchanged store");
        const before = files(path);
        const fake = measurement(path);
        const result = JSON.parse(JSON.stringify(await runCacheMeasurement(fake.options)));
        expect(files(path)).toEqual(before);
        expect(fake.requests).toHaveLength(2);
        expect(fake.requests[0].system).toBe(historianSystemPrompt(true));
        expect(fake.requests[0].messages[0].content).toBe(
            JSON.parse(fake.options.inputs.turnOneRequestJson).prompt,
        );
        expect(fake.requests[1].messages[2].content).toBe(
            JSON.parse(fake.options.inputs.turnTwoRequestJson).prompt,
        );
        expect(fake.requests[1].messages.slice(0, 1)).toEqual(fake.requests[0].messages);
        expect(fake.requests[1].messages[1].content).toBe(fake.replies[0].text);
        expect(result.prefixExtended).toBe(true);
        expect(result.records.map((r: { sessionId: string }) => r.sessionId)).toEqual([
            "same-child",
            "same-child",
        ]);
        expect(fake.options.ledger.rows).toHaveLength(2);
        expect(fake.events).toEqual(["broca", "send", "send", "close"]);
    });
    for (const [read, status, passed] of [
        [undefined, "cache_not_reported", false],
        [0, "cache_read_zero", false],
        [89, "cache_read_positive", false],
        [90, "cache_read_positive", true],
    ] as const)
        test(`cache usage ${status} at ${read}`, async () => {
            const fake = measurement(root(), read);
            // Pass undefined explicitly; the fixture's ordinary default is a positive cache read.
            if (read === undefined) fake.replies[1].usage = {};
            const result = JSON.parse(JSON.stringify(await runCacheMeasurement(fake.options)));
            expect(result.cache.status).toBe(status);
            expect(result.cache.passes90Percent).toBe(passed);
            expect(result.cache.turnOneTotalInputTokens).toBe(100);
            expect(result.prefixExtended).toBe(true);
        });
    test("scoped fallback redacts secrets and notifies revocation after the session", async () => {
        const fake = measurement(root(), 95, true);
        const result = await runCacheMeasurement(fake.options);
        expect(JSON.stringify(result)).not.toContain(secret);
        expect(JSON.stringify(result)).not.toContain("Bearer something");
        expect(JSON.parse(JSON.stringify(result)).route).toBe("ckcred-anthropic");
        expect(fake.events).toEqual([
            "broca",
            "get:apikey:anthropic:ufukaltinokgmail",
            "anthropic",
            "send",
            "send",
            "close",
            "end:apikey:anthropic:ufukaltinokgmail",
        ]);
        expect(
            redact({ env: { CLINE_API_KEY: secret }, headers: { "x-api-key": secret } }, [secret]),
        ).toEqual({ env: { CLINE_API_KEY: "[REDACTED]" }, headers: { "x-api-key": "[REDACTED]" } });
    });
    test("refuses a non-disposable root before opening a transport", async () => {
        const fake = measurement(root());
        fake.options.root = realpathSync(tmpdir());
        await expect(runCacheMeasurement(fake.options)).rejects.toThrow("non_disposable_root");
        expect(fake.events).toEqual([]);
    });
    test("matrix spending refuses measurement before the next paid dispatch", async () => {
        const fake = measurement(root());
        fake.options.ledger = new CampaignLedger();
        // Preload a $15 reservation so this profile's cap is reached before measurement sends.
        fake.options.ledger.reserve(fake.options.profile, "turn_one", 15_000_000, 0, 1);
        await expect(runCacheMeasurement(fake.options)).rejects.toMatchObject({
            requiresOwnerDecision: true,
            message: "cost_cap",
        });
        expect(fake.requests).toHaveLength(0);
        expect(fake.events).toEqual(["broca", "close"]);
        expect(fake.options.ledger.rows).toHaveLength(1);
    });
    test("refuses request drift instead of measuring a rewritten prompt", () => {
        const data = inputs();
        data.turnTwoRequestJson = JSON.stringify({ prompt: "abbreviated reconciliation" });
        expect(() => measurementPrompts(data)).toThrow("persisted_request_bytes_mismatch");
    });
    test("fallback failures still close and notify without echoing credentials", async () => {
        const fake = measurement(root(), 95, true);
        fake.options.transport.openAnthropic = async () => {
            throw new Error(secret);
        };
        await expect(runCacheMeasurement(fake.options)).rejects.toThrow("scoped_run_failed");
        expect(fake.events).toEqual(["broca", "get:apikey:anthropic:ufukaltinokgmail", "end:apikey:anthropic:ufukaltinokgmail"]);
    });
});

function activation(path: string, p = profile()) {
    const events: string[] = [];
    let candidate: unknown;
    const transport: ActivationTransport = {
        kind: "fake",
        async stage() {
            events.push("stage");
        },
        async build(installRoot, candidatePath) {
            events.push("build");
            candidate = JSON.parse(readFileSync(candidatePath, "utf8"));
            const entrypoint = join(installRoot, "plugin.js");
            writeFileSync(entrypoint, `export default ${JSON.stringify(candidate)}`);
            return entrypoint;
        },
        async start(input) {
            events.push("start");
            expect(Object.keys(input).sort()).toEqual([
                "env",
                "installRoot",
                "meter",
                "pluginEntrypoint",
            ]);
            const storePath = join(input.env.MAGIC_CONTEXT_STORAGE_DIR, "context.db");
            mkdirSync(input.env.MAGIC_CONTEXT_STORAGE_DIR, { recursive: true });
            const db = new Database(storePath);
            initializeDatabase(db);
            insertMemory(db, {
                projectPath: path,
                category: "CONSTRAINTS",
                content: "plugin-owned result",
                sourceType: "historian",
            });
            db.close();
            return {
                pid: 42,
                lane: p.entry.lane,
                carrier: p.entry.carrier,
                pluginEntrypoint: input.pluginEntrypoint,
                storePath,
                async runSession() {
                    const id = input.meter.beforeSend({
                        kind: "turn_two",
                        inputTokens: 100,
                        outputCeiling: 100,
                        maxSteps: 4,
                        hostRetries: 0,
                    });
                    events.push("session");
                    input.meter.settle(id, [{ inputTokens: 100, outputTokens: 10 }]);
                    return { carrier: p.entry.carrier, cacheRebuilds: [], echoed: secret };
                },
                async stop() {
                    events.push("stop");
                },
            };
        },
        async testAttest() {
            return isolation(path);
        },
    };
    const options = {
        root: path,
        profile: p,
        ledger: new CampaignLedger(),
        transport,
        sessions: ["The old rule is wrong; use the replacement."],
        credentials: credentials(events),
    };
    return { options, events, candidate: () => candidate };
}

describe("normal built-plugin activation", () => {
    for (const lane of ["opencode-1", "opencode-2", "omp"] as const)
        test(`starts ${lane} with compiled candidate and reads plugin store`, async () => {
            const fake = activation(root(), profile(lane));
            const result = JSON.parse(JSON.stringify(await runActivation(fake.options)));
            expect(fake.candidate()).toEqual({ version: 1, entries: [fake.options.profile.entry] });
            expect(result.store.memories[0].content).toBe("plugin-owned result");
            expect(result.store.stages).toEqual([]);
            expect(result.carrier).toBe(fake.options.profile.entry.carrier);
            expect(fake.events).toEqual(["stage", "build", "start", "session", "stop"]);
            expect(fake.options.ledger.rows[0].charged).toBeCloseTo(0.00012, 10);
        });
    test("OpenCode 1 preserves an explicitly pinned session carrier", async () => {
        const p = profile("opencode-1");
        p.entry.carrier = "opencode-session";
        const fake = activation(root(), p);
        const result = JSON.parse(JSON.stringify(await runActivation(fake.options)));
        expect(result.carrier).toBe("opencode-session");
        expect(result.candidate.entries[0].carrier).toBe("opencode-session");
    });
    test("activation refuses a non-disposable root before staging", async () => {
        const fake = activation(root());
        fake.options.root = realpathSync(tmpdir());
        await expect(runActivation(fake.options)).rejects.toThrow("non_disposable_root");
        expect(fake.events).toEqual([]);
    });
    test("activation uses scoped Cline environment and redacts artifacts", async () => {
        const p = profile("omp");
        p.entry.provider = "cline-pass";
        const fake = activation(root(), p);
        const result = await runActivation(fake.options);
        expect(JSON.stringify(result)).not.toContain(secret);
        expect(fake.events).toContain("get:apikey:cline-pass");
        expect(fake.events.at(-1)).toBe("end:apikey:cline-pass");
    });
    test("matrix spending refuses activation dispatch and still stops the host", async () => {
        const fake = activation(root());
        fake.options.ledger.reserve(fake.options.profile, "grader", 15_000_000, 0, 1);
        await expect(runActivation(fake.options)).rejects.toMatchObject({
            requiresOwnerDecision: true,
        });
        expect(fake.events).toEqual(["stage", "build", "start", "stop"]);
    });
});
