import {
    buildCompartmentAgentPrompt,
    historianSystemPrompt,
} from "../../src/hooks/magic-context/compartment-prompt";
import { buildTurnTwoPrompt } from "../../src/features/magic-context/memory/turn-two-envelope";
import { HISTORIAN_FORMAT_INSTRUCTION } from "../../src/features/magic-context/memory/turn-one-publication";
import {
    hash,
    type CampaignLedger,
    type Profile,
    type UsageStep,
} from "../two-pass-live-replay/artifact-schema";
import {
    attestHost,
    disposableEnvironment,
    verifyIsolation,
    type Isolation,
} from "../two-pass-live-replay/host-drivers";
import {
    callMeter,
    PostGateBudgetStop,
    redact,
    withCredential,
    type ScopedCredentials,
} from "./activation-driver";

export interface MeasurementRequest {
    model: "claude-sonnet-5-5";
    maxOutputTokens: number;
    system: string;
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    tools: [];
    mode: "best_effort";
}
export interface MeasurementReply {
    text: string;
    usage?: {
        input_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
    };
    steps?: UsageStep[];
    chargeUSD?: number;
    metadata?: unknown;
}
export interface MeasurementSession {
    id: string;
    isolation: Isolation;
    maxSteps: number;
    hostRetries: number;
    send(request: MeasurementRequest): Promise<MeasurementReply>;
    close(): Promise<void>;
}
export interface MeasurementTransport {
    kind: "real-host" | "fake";
    /** Return null only when this Broca runner route cannot carry both turns in one session. */
    openBroca(input: {
        root: string;
        env: Record<string, string>;
        model: string;
    }): Promise<MeasurementSession | null>;
    /** Launch the first-party client with the scoped key from env in its child environment only. */
    openAnthropic(input: {
        root: string;
        env: Record<string, string>;
        model: string;
    }): Promise<MeasurementSession>;
}
export interface PersistedMeasurementInputs {
    turnOneInput: Parameters<typeof buildCompartmentAgentPrompt>[0];
    turnTwoInput: Parameters<typeof buildTurnTwoPrompt>[0];
    turnOneRequestJson: string;
    turnTwoRequestJson: string;
}

export function measurementPrompts(inputs: PersistedMeasurementInputs) {
    const first = JSON.parse(inputs.turnOneRequestJson) as {
        system: string;
        formatInstruction: string;
        prompt: string;
    };
    const second = JSON.parse(inputs.turnTwoRequestJson) as { prompt: string };
    const system = historianSystemPrompt(true);
    const prompt = `${buildCompartmentAgentPrompt(inputs.turnOneInput)}\n\n${HISTORIAN_FORMAT_INSTRUCTION}`;
    if (
        first.system !== system ||
        first.formatInstruction !== HISTORIAN_FORMAT_INSTRUCTION ||
        first.prompt !== prompt ||
        second.prompt !== buildTurnTwoPrompt(inputs.turnTwoInput)
    )
        throw new Error("persisted_request_bytes_mismatch");
    return { system, turnOne: first.prompt, turnTwo: second.prompt };
}

export function cacheResult(first: MeasurementReply, second: MeasurementReply) {
    const read = second.usage?.cache_read_input_tokens;
    const usage = first.usage;
    const total =
        usage?.input_tokens === undefined
            ? undefined
            : usage.input_tokens +
              (usage.cache_creation_input_tokens ?? 0) +
              (usage.cache_read_input_tokens ?? 0);
    if ([read, total].some((n) => n !== undefined && (!Number.isFinite(n) || n < 0)))
        throw new Error("invalid_cache_usage");
    const ratio = read === undefined || total === undefined || total === 0 ? null : read / total;
    return {
        status:
            read === undefined
                ? "cache_not_reported"
                : read === 0
                  ? "cache_read_zero"
                  : "cache_read_positive",
        turnOneTotalInputTokens: total ?? null,
        cacheReadInputTokens: read ?? null,
        ratio,
        passes90Percent: ratio !== null && ratio >= 0.9,
    };
}

/** No store, selector, reply parser or authorization object is available on this inference-only path. */
export async function runCacheMeasurement(options: {
    root: string;
    profile: Profile;
    ledger: CampaignLedger;
    transport: MeasurementTransport;
    inputs: PersistedMeasurementInputs;
    outputCeiling: number;
    credentials?: ScopedCredentials;
    anthropicGrant?: import("./activation-driver").CredentialId;
}) {
    const env = disposableEnvironment(options.root);
    if (
        options.profile.entry.modelId !== "claude-sonnet-5-5" ||
        options.profile.priceClass !== "paid"
    )
        throw new Error("measurement_model");
    const prompts = measurementPrompts(options.inputs);
    const meter = callMeter(options.ledger, options.profile);
    const model = "claude-sonnet-5-5";
    const broca = await options.transport.openBroca({ root: options.root, env, model });
    if (!broca && !options.anthropicGrant) throw new Error("anthropic_grant_required");
    return withCredential(
        options.credentials,
        broca ? undefined : options.anthropicGrant,
        options.transport.kind === "fake",
        async (credentialEnv, secrets) => {
            const session =
                broca ??
                (await options.transport.openAnthropic({
                    root: options.root,
                    env: { ...env, ...credentialEnv },
                    model,
                }));
            let credentialStop = false;
            try {
                if (options.transport.kind === "real-host")
                    session.isolation = await attestHost(
                        options.root,
                        env,
                        session.isolation.proof.pid,
                    );
                verifyIsolation(session.isolation);
                if (session.isolation.root !== options.root || !session.id)
                    throw new Error("measurement_session_binding");
                const records: Array<{
                    sessionId: string;
                    ledgerId: number;
                    request: MeasurementRequest;
                    requestHash: string;
                    reply: MeasurementReply;
                }> = [];
                const send = async (request: MeasurementRequest, kind: "turn_one" | "turn_two") => {
                    const id = meter.beforeSend({
                        kind,
                        inputTokens: Buffer.byteLength(JSON.stringify(request), "utf8"),
                        outputCeiling: options.outputCeiling,
                        maxSteps: session.maxSteps,
                        hostRetries: session.hostRetries,
                    });
                    const reply = await session.send(request);
                    meter.settle(id, reply.steps, reply.chargeUSD);
                    records.push({
                        sessionId: session.id,
                        ledgerId: id,
                        request,
                        requestHash: hash(request),
                        reply,
                    });
                    return reply;
                };
                const firstRequest: MeasurementRequest = {
                    model,
                    maxOutputTokens: options.outputCeiling,
                    system: prompts.system,
                    messages: [{ role: "user", content: prompts.turnOne }],
                    tools: [],
                    mode: "best_effort",
                };
                const first = await send(firstRequest, "turn_one");
                const secondRequest: MeasurementRequest = {
                    ...firstRequest,
                    messages: [
                        ...firstRequest.messages,
                        { role: "assistant", content: first.text },
                        { role: "user", content: prompts.turnTwo },
                    ],
                };
                const second = await send(secondRequest, "turn_two");
                const prefixExtended =
                    secondRequest.system === firstRequest.system &&
                    secondRequest.messages[0].content === firstRequest.messages[0].content &&
                    secondRequest.messages[1].content === first.text;
                return redact(
                    {
                        purpose: "cache_measurement",
                        route: broca ? "broca-runner" : "ckcred-anthropic",
                        model,
                        records,
                        isolation: session.isolation,
                        prefixExtended,
                        cache: cacheResult(first, second),
                    },
                    secrets,
                );
            } catch (error) {
                credentialStop = error instanceof Error && ["credential_no_credit", "credential_rate_limited"].includes(error.message);
                if (error instanceof PostGateBudgetStop || (error instanceof Error &&
                    ["credential_no_credit", "credential_rate_limited"].includes(error.message))) throw error;
                throw new Error("cache_measurement_failed");
            } finally {
                try {
                    await session.close();
                } catch {
                    if (!credentialStop) throw new Error("measurement_close_failed");
                }
            }
        },
    );
}
