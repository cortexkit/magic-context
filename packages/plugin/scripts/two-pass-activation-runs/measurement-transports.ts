import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { attestHost, disposableEnvironment } from "../two-pass-live-replay/host-drivers";
import { underRoot } from "./activation-driver";
import type { MeasurementReply, MeasurementRequest, MeasurementSession, MeasurementTransport } from "./cache-measurement-driver";

/** A Broca opener must attest retained history and bounds before any inference send. */
export interface BrocaMeasurementRoute {
    open(input: Parameters<MeasurementTransport["openBroca"]>[0]): Promise<MeasurementSession | null>;
}

export function measurementTransport(options: {
    broca?: BrocaMeasurementRoute;
    /** An override must be HTTP on 127.0.0.1 without URL credentials; the caller must supply the mock. */
    mockAnthropicEndpoint?: string;
    onProviderAttempt?(providerHost: string): void;
} = {}): MeasurementTransport {
    if (options.mockAnthropicEndpoint) {
        const url = new URL(options.mockAnthropicEndpoint);
        if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password)
            throw new Error("mock_endpoint_not_loopback");
    }
    return {
        kind: "real-host",
        openBroca: async (input) => options.broca ? options.broca.open(input) : null,
        async openAnthropic(input) {
            let material = input.env.ANTHROPIC_API_KEY;
            delete input.env.ANTHROPIC_API_KEY;
            const env = disposableEnvironment(input.root);
            if (input.model !== "claude-sonnet-5-5" || !material)
                throw new Error("measurement_client_binding");
            for (const [key, value] of Object.entries(env))
                if (input.env[key] !== value) throw new Error("measurement_environment_binding");
            const clientRoot = underRoot(input.root, join(input.root, "anthropic-client"));
            mkdirSync(clientRoot, { recursive: true, mode: 0o700 });
            const entry = join(clientRoot, "anthropic-worker.ts");
            copyFileSync(join(import.meta.dir, "anthropic-worker.ts"), entry);
            let child: ReturnType<typeof spawn>;
            try { child = spawn(process.execPath, [entry], {
                cwd: clientRoot, stdio: ["pipe", "pipe", "ignore"],
                env: { PATH: process.env.PATH, HOME: clientRoot, ...env,
                    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
                    ANTHROPIC_API_KEY: material,
                    TWO_PASS_WITNESS: join(clientRoot, "client-witness.jsonl"),
                    ...(options.mockAnthropicEndpoint ? { TWO_PASS_MOCK_ANTHROPIC_ENDPOINT: options.mockAnthropicEndpoint } : {}),
                },
            }); } catch { material = ""; throw new Error("measurement_client_spawn_failed"); }
            material = "";
            let nextId = 0;
            let closed = false;
            let busy = false;
            const pending = new Map<number, { resolve(value: MeasurementReply): void; reject(error: Error): void }>();
            let ready!: () => void;
            let failReady!: (error: Error) => void;
            const readiness = new Promise<void>((resolve, reject) => { ready = resolve; failReady = reject; });
            const fail = () => {
                const error = new Error("measurement_client_closed");
                failReady(error);
                for (const call of pending.values()) call.reject(error);
                pending.clear();
            };
            child.once("error", fail);
            child.once("exit", fail);
            const lines = createInterface({ input: child.stdout! });
            lines.on("line", (line) => {
                try {
                    const value = JSON.parse(line);
                    if (value.ready === true) { ready(); return; }
                    if (typeof value.providerAttempt?.providerHost === "string") {
                        options.onProviderAttempt?.(value.providerAttempt.providerHost); return;
                    }
                    const call = pending.get(value.id);
                    if (!call) throw new Error("unbound_measurement_reply");
                    pending.delete(value.id);
                    if (value.error) call.reject(new Error(["credential_no_credit", "credential_rate_limited"].includes(value.error)
                        ? value.error : "measurement_dispatch_failed"));
                    else call.resolve(value.result);
                } catch { fail(); }
            });
            const close = async () => {
                if (closed) return;
                closed = true;
                lines.close();
                if (child.exitCode !== null || child.signalCode !== null) return;
                const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
                child.stdin!.end();
                const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
                try { await exited; } finally { clearTimeout(timer); }
            };
            try {
                const timer = setTimeout(() => failReady(new Error("measurement_client_start_timeout")), 10_000);
                try { await readiness; } finally { clearTimeout(timer); }
                const isolation = await attestHost(input.root, env, child.pid!);
                let first: MeasurementRequest | undefined;
                let firstText: string | undefined;
                return {
                    id: randomUUID(), isolation, maxSteps: 1, hostRetries: 2,
                    async send(request) {
                        if (closed || busy || nextId >= 2) throw new Error("measurement_session_bounds");
                        if (first && (request.system !== first.system || request.model !== first.model ||
                            request.messages.length !== 3 || request.messages[0].content !== first.messages[0].content ||
                            request.messages[0].role !== "user" || request.messages[2].role !== "user" ||
                            request.messages[1].role !== "assistant" || request.messages[1].content !== firstText))
                            throw new Error("measurement_history_not_retained");
                        if (!first && (request.messages.length !== 1 || request.messages[0].role !== "user"))
                            throw new Error("measurement_initial_history");
                        busy = true;
                        const id = ++nextId;
                        const result = new Promise<MeasurementReply>((resolve, reject) => pending.set(id, { resolve, reject }));
                        const timer = setTimeout(() => { pending.get(id)?.reject(new Error("measurement_send_timeout")); void close(); }, 425_000);
                        child.stdin!.write(`${JSON.stringify({ id, request })}\n`);
                        try {
                            const reply = await result;
                            if (!first) { first = structuredClone(request); firstText = reply.text; }
                            return reply;
                        } finally { clearTimeout(timer); busy = false; }
                    },
                    close,
                };
            } catch (error) { await close(); throw error; }
        },
    };
}
