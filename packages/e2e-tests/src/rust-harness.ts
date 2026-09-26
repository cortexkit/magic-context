/**
 * RustTestHarness — facade for the Rust-mode (ck-mc over subc) e2e lane.
 *
 * Reuses the OpenCode e2e mock-provider, `opencode serve`, and SDK session-driving
 * machinery, then layers on the two
 * things Rust mode needs that the TS lane does not:
 *
 *   1. a hermetic subc daemon + ck-mc module (HermeticSubcStack) whose
 *      connection file is placed where the plugin's Rust client already looks
 *      (`${dataDir}/cortexkit/run/subc-connection.json`), and
 *   2. serve RESTART support that keeps the same data dir (opencode.db +
 *      context.db + module store all survive), for the cold-start-drop-seed and
 *      module-restart scenarios.
 *
 * Boot order matters: the env is allocated first so the daemon can write its
 * connection file BEFORE opencode boots and the plugin's first transform runs.
 *
 * Assertion surface: wire captures come from the fake provider's full request
 * bodies (the same source the TS lane asserts on). Rust transform decisions are
 * ALSO surfaced from the plugin diagnostic log (redirected per-suite via
 * MAGIC_CONTEXT_LOG_PATH) as a secondary signal — `readRustPasses()` parses the
 * `rust pass: decision=… served_from=… applied=…` lines the Rust transform emits.
 */

import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MockProvider, type MockResponse } from "./mock-provider/server";
import {
    createIsolatedEnv,
    type IsolatedEnv,
    type SpawnedOpencode,
    spawnOpencode,
} from "./opencode-runner/spawn";
import {
    buildHermeticBinaries,
    detectRustModePrereqs,
    type HermeticHistorianRunner,
    HermeticSubcStack,
    type RustModePrereqs,
} from "./rust-runner/hermetic-subc";

export interface RustTestHarnessOptions {
    /** magic-context USER-tier config overrides (thresholds, memory, etc.). */
    magicContextConfig?: Record<string, unknown>;
    /** Extra opencode.json config. Merged onto test defaults. */
    openCodeConfigExtra?: Record<string, unknown>;
    /** Override the mock model's context token limit. Default 200000. */
    modelContextLimit?: number;
    /** Default response used when the mock queue is empty. */
    mockDefault?: MockResponse;
    /** Mock provider id exposed to OpenCode. Defaults to "mock-anthropic". */
    providerID?: string;
    /** AI SDK provider package used by the mock. Defaults to "@ai-sdk/anthropic". */
    providerAPI?: "@ai-sdk/anthropic" | "@ai-sdk/openai";
    /** Mock model id used for prompts. Defaults to "mock-sonnet". */
    modelID?: string;
    /**
     * Start opencode in TS mode instead of Rust mode. The hermetic daemon still
     * runs (so a later `restart({ rust: true })` can flip to Rust against the
     * same data dir) but the plugin transforms in TS on this boot. Used by the
     * cold-start-drop-seed scenario to build TS-mode state, then restart in Rust.
     * Default: false (boot straight into Rust mode).
     */
    startInTsMode?: boolean;
    /**
     * Start the deterministic Broca producer. Disable it only when a scenario
     * must observe module state before any historian publication can supersede it.
     * Default: true.
     */
    startHistorianProducer?: boolean;
    /** Copy an existing module store into the isolated data directory before ck-mc starts. */
    seedModuleStorePath?: string;
    /** Build the hermetic module with the otherwise-absent drive-fault feature. */
    driveFaultBinary?: boolean;
    /** Module-only environment, for scenario-specific logging or fault controls. */
    moduleEnv?: Record<string, string>;
    /**
     * The historian/dreamer runner named in BOTH user tiers (the module's and the
     * plugin's). Default "broca", which keeps every scenario written against the
     * Broca producer on that lane now that an unconfigured OpenCode request
     * defaults to the host runner. `null` names none, so the harness default applies.
     */
    historianRunner?: HermeticHistorianRunner;
}

export interface SdkClient {
    session: {
        create: (opts: {
            query: { directory: string };
            body?: { parentID?: string; title?: string };
        }) => Promise<{ data?: { id: string } }>;
        prompt: (opts: {
            path: { id: string };
            body: {
                model: { providerID: string; modelID: string };
                parts: Array<{ type: "text"; text: string; synthetic?: boolean }>;
                agent?: string;
                messageID?: string;
                variant?: string;
            };
        }) => Promise<{ data?: unknown; error?: unknown }>;
        revert: (opts: {
            path: { id: string };
            body: { messageID: string; partID?: string };
        }) => Promise<{ data?: unknown }>;
        messages: (opts: {
            path: { id: string };
        }) => Promise<{ data?: unknown }>;
    };
}

const DEFAULT_MOCK_RESPONSE: MockResponse = {
    text: "ok",
    usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 0,
    },
};

/** One parsed `rust pass:` diagnostic line. */
export interface RustPassLine {
    decision: string;
    reason: string;
    servedFrom: string;
    inputCount: number;
    outputCount: number;
    applied: boolean;
    elapsedMs: number;
    moduleElapsedMs: number;
    adapterElapsedMs: number;
    prefixGuardMs: number;
    stateSyncMs: number;
    wireBuildMs: number;
    wireMessages: number;
    transportMs: number;
    transportPages: number;
    transportBytes: number;
    rowVersion: number;
    raw: string;
}

type TrailingBlankReplayPartRow = {
    id: string;
    time_created: number;
    data: string;
};

type TrailingBlankReplayRows = {
    sessionId: string;
    latestTime: number;
    blankPartId: string;
};

export class RustTestHarness {
    readonly mock: MockProvider;
    readonly env: IsolatedEnv;
    readonly subc: HermeticSubcStack;
    readonly logPath: string;

    private opencodeInstance: SpawnedOpencode;
    private clientInstance: SdkClient;
    private contextDbCached: Database | null = null;
    private modelContextLimit: number | undefined;
    private mockDefault: MockResponse;
    private readonly mockBaseURL: string;
    private readonly providerID: string;
    private readonly providerAPI: "@ai-sdk/anthropic" | "@ai-sdk/openai";
    private readonly modelID: string;
    private readonly historianProducerAvailable: boolean;
    private readonly historianRunner: HermeticHistorianRunner;
    private readonly trailingBlankReplayRows = new Map<string, TrailingBlankReplayRows>();

    private constructor(args: {
        mock: MockProvider;
        mockBaseURL: string;
        env: IsolatedEnv;
        subc: HermeticSubcStack;
        opencode: SpawnedOpencode;
        client: SdkClient;
        logPath: string;
        modelContextLimit: number | undefined;
        mockDefault: MockResponse;
        providerID: string;
        providerAPI: "@ai-sdk/anthropic" | "@ai-sdk/openai";
        modelID: string;
        historianProducerAvailable: boolean;
        historianRunner: HermeticHistorianRunner;
    }) {
        this.mock = args.mock;
        this.mockBaseURL = args.mockBaseURL;
        this.env = args.env;
        this.subc = args.subc;
        this.opencodeInstance = args.opencode;
        this.clientInstance = args.client;
        this.logPath = args.logPath;
        this.modelContextLimit = args.modelContextLimit;
        this.mockDefault = args.mockDefault;
        this.providerID = args.providerID;
        this.providerAPI = args.providerAPI;
        this.modelID = args.modelID;
        this.historianProducerAvailable = args.historianProducerAvailable;
        this.historianRunner = args.historianRunner;
    }

    /**
     * Preflight the lane. Cheap and never throws — call it in a describe-level
     * guard so a machine without cargo / the subconscious sibling / a supported
     * platform SKIPs with a printed reason instead of failing or hanging.
     */
    static detectPrereqs(): RustModePrereqs {
        return detectRustModePrereqs();
    }

    static async create(options: RustTestHarnessOptions = {}): Promise<RustTestHarness> {
        const prereqs = detectRustModePrereqs();
        if (!prereqs.ok || !prereqs.subconsciousRoot) {
            throw new Error(
                `RustTestHarness prerequisites unmet: ${prereqs.skipReason ?? "unknown"}. ` +
                    "Guard the suite with RustTestHarness.detectPrereqs() and skip instead of creating.",
            );
        }

        const { ckMcBin, ckSubcBin } = await buildHermeticBinaries(prereqs.subconsciousRoot, {
            driveFault: options.driveFaultBinary,
        });

        const mock = new MockProvider();
        const { baseURL } = await mock.start();
        const mockDefault = options.mockDefault ?? DEFAULT_MOCK_RESPONSE;
        mock.setDefault(mockDefault);

        // Env first: the daemon must write its connection file into
        // <dataDir>/cortexkit/run/ before opencode boots and the plugin's Rust
        // client connects on the first transform.
        const env = createIsolatedEnv();
        if (options.seedModuleStorePath) {
            const moduleStoreDir = join(env.dataDir, "cortexkit", "magic-context");
            mkdirSync(moduleStoreDir, { recursive: true });
            const moduleStorePath = join(moduleStoreDir, "store.db");
            copyFileSync(options.seedModuleStorePath, moduleStorePath);
            // The copied database retains the source writer's fence epoch, while the isolated
            // lease starts at epoch one. Reset only lease metadata so ck-mc can claim the copy.
            const seededStore = new Database(moduleStorePath);
            try {
                seededStore.run("UPDATE cortexkit_fence SET epoch = 0 WHERE id = 0");
            } finally {
                seededStore.close();
            }
        }
        const subc = await HermeticSubcStack.start({
            dataDir: env.dataDir,
            ckMcBin,
            ckSubcBin,
            startProducer: options.startHistorianProducer ?? true,
            moduleEnv: options.moduleEnv ?? {},
            historianRunner: RustTestHarness.runnerOption(options),
        });
        if (options.seedModuleStorePath) {
            const deadline = Date.now() + 65_000;
            let lastError: unknown;
            while (Date.now() < deadline) {
                try {
                    await subc.moduleStatus("__seed_store_probe__", env.workdir);
                    lastError = undefined;
                    break;
                } catch (error) {
                    lastError = error;
                    await new Promise((resolve) => setTimeout(resolve, 100));
                }
            }
            if (lastError) {
                const moduleLog = subc.moduleLog();
                await subc.stop();
                throw new Error(`seeded module store did not open: ${String(lastError)}\n${moduleLog}`);
            }
        }

        const logPath = join(env.dataDir, "cortexkit", "magic-context-e2e.log");

        let opencode: SpawnedOpencode;
        try {
            opencode = await RustTestHarness.spawnServe({
                env,
                mockURL: baseURL,
                connectionFile: subc.connectionFile,
                logPath,
                options,
                rustMode: !options.startInTsMode,
            });
        } catch (error) {
            await subc.stop();
            await mock.stop();
            throw error;
        }

        const sdk = await import("@opencode-ai/sdk");
        const client = sdk.createOpencodeClient({ baseUrl: opencode.url }) as unknown as SdkClient;

        return new RustTestHarness({
            mock,
            mockBaseURL: baseURL,
            env,
            subc,
            opencode,
            client,
            logPath,
            modelContextLimit: options.modelContextLimit,
            mockDefault,
            providerID: options.providerID ?? "mock-anthropic",
            providerAPI: options.providerAPI ?? "@ai-sdk/anthropic",
            modelID: options.modelID ?? "mock-sonnet",
            historianProducerAvailable: options.startHistorianProducer ?? true,
            historianRunner: RustTestHarness.runnerOption(options),
        });
    }

    private static runnerOption(options: RustTestHarnessOptions): HermeticHistorianRunner {
        return options.historianRunner === undefined ? "broca" : options.historianRunner;
    }

    private static spawnServe(args: {
        env: IsolatedEnv;
        mockURL: string;
        connectionFile: string;
        logPath: string;
        options: RustTestHarnessOptions;
        rustMode: boolean;
    }): Promise<SpawnedOpencode> {
        const providerID = args.options.providerID ?? "mock-anthropic";
        const modelID = args.options.modelID ?? "mock-sonnet";
        return spawnOpencode({
            mockProviderURL: args.mockURL,
            mockProviderID: providerID,
            mockProviderAPI: args.options.providerAPI,
            mockModelID: modelID,
            existingEnv: args.env,
            modelContextLimit: args.options.modelContextLimit,
            openCodeConfigExtra: args.options.openCodeConfigExtra,
            magicContextConfig: RustTestHarness.pinPluginRunner(
                {
                    ...(args.options.startHistorianProducer ?? true
                        ? { historian: { opencode: { model: `${providerID}/${modelID}` } } }
                        : {}),
                    ...(args.options.magicContextConfig ?? {}),
                },
                RustTestHarness.runnerOption(args.options),
            ),
            // The connection_file value is only used to flip `userTierHasSubc`
            // true (the resolver gate). The actual transport still reads the
            // DEFAULT connection path — which this same file happens to be.
            userSubcConnectionFile: args.connectionFile,
            projectMagicContextConfig: {
                transform_mode: args.rustMode ? "rust" : "ts",
            },
            extraEnv: { MAGIC_CONTEXT_LOG_PATH: args.logPath },
        });
    }

    /**
     * Name the runner in the plugin's user tier too, so the plugin's pull loop and
     * the module agree on the lane. A scenario that names its own runner keeps it.
     */
    private static pinPluginRunner(
        config: Record<string, unknown>,
        runner: HermeticHistorianRunner,
    ): Record<string, unknown> {
        if (runner === null) return config;
        const historian =
            config.historian && typeof config.historian === "object"
                ? (config.historian as Record<string, unknown>)
                : {};
        if (historian.runner !== undefined) return config;
        return { ...config, historian: { ...historian, runner } };
    }

    get opencode(): SpawnedOpencode {
        return this.opencodeInstance;
    }

    get client(): SdkClient {
        return this.clientInstance;
    }

    /**
     * Restart `opencode serve` against the SAME data dir (opencode.db, context.db,
     * module store, and the running daemon all persist). Optionally flip the
     * project transform_mode (ts↔rust) — the cold-start-drop-seed scenario builds
     * TS-mode state then restarts in Rust to prove drop-tag state seeds correctly.
     */
    async restart(opts: { rust?: boolean; magicContextConfig?: Record<string, unknown> } = {}): Promise<void> {
        if (this.contextDbCached) {
            try {
                this.contextDbCached.close();
            } catch {
                // ignore
            }
            this.contextDbCached = null;
        }
        await this.opencodeInstance.kill();
        this.opencodeInstance = await RustTestHarness.spawnServe({
            env: this.env,
            mockURL: this.mockBaseURL,
            connectionFile: this.subc.connectionFile,
            logPath: this.logPath,
            options: {
                modelContextLimit: this.modelContextLimit,
                magicContextConfig: opts.magicContextConfig,
                startHistorianProducer: this.historianProducerAvailable,
                historianRunner: this.historianRunner,
                providerID: this.providerID,
                providerAPI: this.providerAPI,
                modelID: this.modelID,
            },
            rustMode: opts.rust ?? true,
        });
        const sdk = await import("@opencode-ai/sdk");
        this.clientInstance = sdk.createOpencodeClient({
            baseUrl: this.opencodeInstance.url,
        }) as unknown as SdkClient;
    }

    /** Create a session bound to the isolated workdir. Throws on failure. */
    async createSession(): Promise<string> {
        const maxAttempts = 5;
        for (let i = 1; i <= maxAttempts; i++) {
            const res = await this.clientInstance.session.create({
                query: { directory: this.env.workdir },
            });
            if (res.data) return res.data.id;
            if (i < maxAttempts) {
                await Bun.sleep(200 * i);
                continue;
            }
            throw new Error(
                `session.create failed after ${maxAttempts} attempts. stderr:\n${this.opencodeInstance.stderr()}`,
            );
        }
        throw new Error("session.create failed");
    }

    /**
     * Create a child session the way OpenCode's `task` tool does: POST /session with a
     * `parentID`. The plugin reads that field from the `session.created` event and marks
     * the row a subagent, which is the only way to drive subagent behaviour end to end.
     */
    async createChildSession(parentId: string, title?: string): Promise<string> {
        const maxAttempts = 5;
        for (let i = 1; i <= maxAttempts; i++) {
            const res = await this.clientInstance.session.create({
                query: { directory: this.env.workdir },
                body: { parentID: parentId, ...(title ? { title } : {}) },
            });
            if (res.data) return res.data.id;
            if (i < maxAttempts) {
                await Bun.sleep(200 * i);
                continue;
            }
            throw new Error(
                `child session.create failed after ${maxAttempts} attempts. stderr:\n${this.opencodeInstance.stderr()}`,
            );
        }
        throw new Error("child session.create failed");
    }

    /** Read the plugin's persisted subagent flag, or null before the row exists. */
    isSubagent(sessionId: string): boolean | null {
        try {
            const row = this.contextDb()
                .prepare("SELECT is_subagent FROM session_meta WHERE session_id = ?")
                .get(sessionId) as { is_subagent?: unknown } | null;
            if (!row) return null;
            return row.is_subagent === 1 || row.is_subagent === true;
        } catch {
            return null;
        }
    }

    /**
     * Generate ~`tokens` tokens of varied prose ballast. Copied from the TS
     * harness: the protected-tail boundary measures true-raw content, so pressure
     * turns must carry real mass, and varied prose tokenizes at a stable rate.
     */
    ballast(tokens: number): string {
        const words = [
            "boundary", "historian", "compartment", "schedule", "pressure",
            "tokens", "window", "publish", "transform", "session", "marker",
            "budget", "eligible", "protected", "ordinal", "snapshot", "replay",
            "decision", "threshold", "baseline", "measure", "archive", "deliver",
        ];
        const target = Math.max(0, Math.round(tokens * 4));
        const parts: string[] = [];
        let length = 0;
        let i = 0;
        while (length < target) {
            const w = words[i % words.length]!;
            parts.push(`${w}${i % 17 === 0 ? "." : ""}`);
            length += w.length + 1;
            i += 1;
        }
        return parts.join(" ");
    }

    /**
     * Append persisted messages through OpenCode's production database shape. This keeps
     * large-session transport tests fast while the next prompt still traverses the real
     * OpenCode → plugin → subc → module path.
     */
    appendSyntheticHistory(
        sessionId: string,
        options: { count: number; textBytes: number },
    ): void {
        const dbPath = join(this.env.dataDir, "opencode", "opencode.db");
        const db = new Database(dbPath);
        try {
            db.exec("PRAGMA busy_timeout = 30000");
            const row = db
                .prepare(
                    "SELECT COALESCE(MIN(time_created), 0) AS earliest FROM message WHERE session_id = ?",
                )
                .get(sessionId) as { earliest: number };
            const templateRow = db
                .prepare(
                    "SELECT m.data AS message_data, p.data AS part_data FROM message m JOIN part p ON p.message_id = m.id WHERE m.session_id = ? AND json_extract(m.data, '$.role') = 'user' AND json_extract(p.data, '$.type') = 'text' ORDER BY m.time_created DESC LIMIT 1",
                )
                .get(sessionId) as { message_data: string; part_data: string } | undefined;
            if (!templateRow) {
                throw new Error("synthetic history requires an existing user text message");
            }
            const messageTemplate = JSON.parse(templateRow.message_data) as Record<
                string,
                unknown
            >;
            const partTemplate = JSON.parse(templateRow.part_data) as Record<string, unknown>;
            const insertMessage = db.prepare(
                "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
            );
            const insertPart = db.prepare(
                "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
            );
            // OpenCode orders message IDs generated from descending timestamps. Place the
            // fixture immediately before the live seed messages so a later prompt remains
            // newest while both OpenCode and the raw ordinal reader agree on history order.
            // Provider latency must not interleave history with the seeded user/assistant pair.
            const firstTimestamp = Math.max(1, row.earliest - options.count - 1);
            const descendingId = (
                prefix: "msg" | "prt",
                timestamp: number,
                counter: number,
            ): string => {
                const encoded = ~(BigInt(timestamp) * 0x1000n + BigInt(counter));
                const timeBytes = Buffer.alloc(6);
                for (let byte = 0; byte < timeBytes.length; byte += 1) {
                    timeBytes[byte] = Number((encoded >> BigInt(40 - 8 * byte)) & 0xffn);
                }
                return `${prefix}_${timeBytes.toString("hex")}${counter.toString(36).padStart(14, "0")}`;
            };
            const append = db.transaction(() => {
                for (let index = 0; index < options.count; index += 1) {
                    const suffix = index.toString().padStart(4, "0");
                    const timestamp = firstTimestamp + index;
                    const messageId = descendingId("msg", timestamp, 1);
                    const partId = descendingId("prt", timestamp, 2);
                    const prefix = `synthetic history message ${suffix}: `;
                    const text = `${prefix}${"x".repeat(Math.max(0, options.textBytes - prefix.length))}`;
                    insertMessage.run(
                        messageId,
                        sessionId,
                        timestamp,
                        timestamp,
                        JSON.stringify({
                            ...messageTemplate,
                            id: messageId,
                            sessionID: sessionId,
                            time: {
                                ...((messageTemplate.time as Record<string, unknown> | undefined) ??
                                    {}),
                                created: timestamp,
                            },
                        }),
                    );
                    insertPart.run(
                        partId,
                        messageId,
                        sessionId,
                        timestamp,
                        timestamp,
                        JSON.stringify({
                            ...partTemplate,
                            id: partId,
                            messageID: messageId,
                            sessionID: sessionId,
                            text,
                        }),
                    );
                }
            });
            append();
        } finally {
            db.close();
        }
    }

    /**
     * Capture the persisted tool-use assistant that a replay will expose through several
     * ingress shapes. The original rows are retained so every shape starts from identical data.
     */
    prepareTrailingBlankReplay(sessionId: string): string {
        const dbPath = join(this.env.dataDir, "opencode", "opencode.db");
        const db = new Database(dbPath);
        try {
            db.exec("PRAGMA busy_timeout = 30000");
            const message = db
                .prepare(
                    "SELECT m.id FROM message m WHERE m.session_id = ? AND json_extract(m.data, '$.role') = 'assistant' AND EXISTS (SELECT 1 FROM part p WHERE p.message_id = m.id AND json_extract(p.data, '$.type') = 'tool') ORDER BY m.time_created DESC LIMIT 1",
                )
                .get(sessionId) as { id: string } | undefined;
            if (!message) throw new Error("trailing-blank replay did not persist a tool assistant");
            const rawRows = db
                .prepare(
                    "SELECT id, time_created, data FROM part WHERE message_id = ? ORDER BY time_created, id",
                )
                .all(message.id) as TrailingBlankReplayPartRow[];
            const finishPartId = rawRows.find(
                (row) => (JSON.parse(row.data) as Record<string, unknown>).type === "step-finish",
            )?.id;
            if (!finishPartId) {
                throw new Error("trailing-blank replay requires a completed tool step");
            }
            const blankPartId = `prt_zzzzzzzzzzzz${message.id.slice(-12)}`;
            this.trailingBlankReplayRows.set(message.id, {
                sessionId,
                latestTime: Math.max(...rawRows.map((row) => row.time_created)),
                blankPartId,
            });
            return message.id;
        } finally {
            db.close();
        }
    }

    /** Append the late empty text part without rewriting the assistant's accepted prefix. */
    appendTrailingBlankReplayPart(messageId: string): void {
        const captured = this.trailingBlankReplayRows.get(messageId);
        if (!captured) throw new Error(`trailing-blank replay assistant ${messageId} was not prepared`);
        const latestTime = captured.latestTime + 1;
        const dbPath = join(this.env.dataDir, "opencode", "opencode.db");
        const db = new Database(dbPath);
        try {
            db.exec("PRAGMA busy_timeout = 30000");
            db.prepare(
                "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
            ).run(
                captured.blankPartId,
                messageId,
                captured.sessionId,
                latestTime,
                latestTime,
                JSON.stringify({ type: "text", text: "" }),
            );
        } finally {
            db.close();
        }
    }

    /** Seed the latest isolated tool result for a sanitized provider-wire replay fixture. */
    seedLatestToolOutputForReplay(sessionId: string, output: string): void {
        const dbPath = join(this.env.dataDir, "opencode", "opencode.db");
        const db = new Database(dbPath);
        try {
            db.exec("PRAGMA busy_timeout = 30000");
            const row = db
                .prepare(
                    "SELECT id, data FROM part WHERE session_id = ? AND json_extract(data, '$.type') = 'tool' ORDER BY time_created DESC LIMIT 1",
                )
                .get(sessionId) as { id: string; data: string } | undefined;
            if (!row) throw new Error("paired replay setup did not persist a tool result");
            const data = JSON.parse(row.data) as Record<string, unknown>;
            const state =
                data.state && typeof data.state === "object"
                    ? (data.state as Record<string, unknown>)
                    : null;
            data.output = output;
            if (state) {
                state.output = output;
                if (state.metadata && typeof state.metadata === "object") {
                    (state.metadata as Record<string, unknown>).output = output;
                }
            }
            db.prepare("UPDATE part SET data = ? WHERE id = ?").run(JSON.stringify(data), row.id);
        } finally {
            db.close();
        }
    }

    async sendPrompt(
        sessionId: string,
        text: string,
        options: {
            agent?: string;
            timeoutMs?: number;
            providerID?: string;
            modelID?: string;
            messageID?: string;
            /**
             * OpenCode reasoning variant for this turn. OpenCode hands it to the
             * plugin's chat.message hook, and the adapter folds it into the render
             * identity it sends the module.
             */
            variant?: string;
            /**
             * Send the prompt the way OpenCode's own notice deliveries do: a text part
             * flagged `synthetic`. The flag keeps the message out of the terminal's
             * human-turn rendering; OpenCode still persists it as an ordinary user row
             * and still serializes it to the model on every later pass.
             */
            synthetic?: boolean;
        } = {},
    ): Promise<unknown> {
        const timeoutMs = options.timeoutMs ?? 180_000;
        const promptPromise = this.clientInstance.session.prompt({
            path: { id: sessionId },
            body: {
                model: {
                    providerID: options.providerID ?? this.providerID,
                    modelID: options.modelID ?? this.modelID,
                },
                parts: [{ type: "text", text, ...(options.synthetic ? { synthetic: true } : {}) }],
                ...(options.agent ? { agent: options.agent } : {}),
                ...(options.messageID ? { messageID: options.messageID } : {}),
                ...(options.variant ? { variant: options.variant } : {}),
            },
        });
        const timeout = new Promise<null>((r) => setTimeout(() => r(null), timeoutMs));
        const result = await Promise.race([promptPromise, timeout]);
        if (result === null) {
            throw new Error(
                `sendPrompt did not complete within ${timeoutMs}ms. stderr:\n${this.opencodeInstance
                    .stderr()
                    .slice(-2000)}\nmodule log:\n${this.subc.moduleLog().slice(-2000)}`,
            );
        }
        if (result.data === undefined) {
            throw new Error(
                `sendPrompt returned without session data: ${JSON.stringify(result.error ?? null)}\n` +
                    `stdout:\n${this.opencodeInstance.stdout().slice(-2000)}\n` +
                    `stderr:\n${this.opencodeInstance.stderr().slice(-2000)}\n` +
                    `module log:\n${this.subc.moduleLog().slice(-2000)}`,
            );
        }
        return result;
    }

    /**
     * Remove a message from the session the way session.revert does — the
     * message.removed event path the ordinal resolver must self-heal from. Reverts
     * TO the given message (dropping it and everything after), then unshares so the
     * revert is applied as a real removal opencode persists to its DB.
     */
    async revertMessage(sessionId: string, messageId: string): Promise<void> {
        await this.clientInstance.session.revert({
            path: { id: sessionId },
            body: { messageID: messageId },
        });
    }

    /** Fetch the session row via the SDK (revert marker, timestamps). */
    async getSession(
        sessionId: string,
    ): Promise<{ revert?: { messageID?: string }; time?: { updated?: number } } | undefined> {
        const response = await this.clientInstance.session.get({ path: { id: sessionId } });
        return (response as { data?: { revert?: { messageID?: string } } }).data ?? undefined;
    }

    /** Fetch the session's messages via the SDK (for choosing a mid-session id to remove). */
    async listMessages(
        sessionId: string,
    ): Promise<
        Array<{
            info?: { id?: string; role?: string; parentID?: string };
            parts?: Array<{
                type?: string;
                text?: string;
                synthetic?: boolean;
                ignored?: boolean;
            }>;
        }>
    > {
        const res = await this.clientInstance.session.messages({ path: { id: sessionId } });
        const data = (res as { data?: unknown }).data;
        return Array.isArray(data)
            ? (data as Array<{
                  info?: { id?: string; role?: string; parentID?: string };
                  parts?: Array<{
                type?: string;
                text?: string;
                synthetic?: boolean;
                ignored?: boolean;
            }>;
              }>)
            : [];
    }

    // ── wire captures (from the fake provider) ────────────────────────────────

    /** Full captured provider request bodies for the main agent (Magic Context system prompt present). */
    mainRequests() {
        return this.mock
            .requests()
            .filter((request) => JSON.stringify(request.body).includes("## Magic Context"));
    }

    /** The messages array of the most recent main-agent request. */
    lastMainMessages(): Array<{ role?: string; content?: unknown }> {
        const req = this.mainRequests().at(-1);
        const messages = req?.body.messages;
        return Array.isArray(messages) ? (messages as Array<{ role?: string; content?: unknown }>) : [];
    }

    /**
     * Byte size of the full serialized messages array of the most recent
     * main-agent request, with `cache_control` stripped (it is provider cache
     * bookkeeping that varies pass to pass and is not part of the logical wire).
     */
    lastMainWireBytes(): number {
        const req = this.mainRequests().at(-1);
        if (!req) return 0;
        return Buffer.byteLength(stableSerialize(req.body.messages ?? []));
    }

    /** Deterministically serialize messages or input from the latest main-provider request. */
    lastMainWireSerialized(requestField: "messages" | "input" = "messages"): string {
        const req = this.mainRequests().at(-1);
        return stableSerialize(req?.body[requestField] ?? []);
    }

    // ── plugin-log rust-pass decisions (secondary signal) ─────────────────────

    /**
     * Wait until at least `minCount` rust-pass lines are visible, then return
     * them. The plugin logger buffers and flushes every ~500ms, so a read
     * immediately after a prompt returns can miss the just-emitted pass. Polling
     * removes that race without a fixed sleep (the no-sleeps-as-sync rule).
     */
    async waitForRustPasses(minCount: number, timeoutMs = 15_000): Promise<RustPassLine[]> {
        return this.waitFor(
            () => {
                const passes = this.readRustPasses();
                return passes.length >= minCount ? passes : null;
            },
            { timeoutMs, label: `>= ${minCount} rust passes` },
        );
    }

    /** Read the subprocess diagnostic log for assertions about the active lineage. */
    diagnosticLog(): string {
        if (!existsSync(this.logPath)) return "";
        return readFileSync(this.logPath, "utf8");
    }

    /** Parse every `rust pass:` diagnostic line the Rust transform emitted so far. */
    readRustPasses(): RustPassLine[] {
        if (!existsSync(this.logPath)) return [];
        const lines = readFileSync(this.logPath, "utf8").split("\n");
        const parsed: RustPassLine[] = [];
        for (const line of lines) {
            const idx = line.indexOf("rust pass: ");
            if (idx < 0) continue;
            const body = line.slice(idx + "rust pass: ".length);
            const elapsedMs = Number(field(body, "elapsed") || "0");
            const moduleElapsedMs = Number(field(body, "module") || "0");
            parsed.push({
                decision: field(body, "decision"),
                reason: field(body, "reason"),
                servedFrom: field(body, "served_from"),
                inputCount: Number(field(body, "in") || "0"),
                outputCount: Number(field(body, "out") || "0"),
                applied: field(body, "applied") === "true",
                elapsedMs,
                moduleElapsedMs,
                adapterElapsedMs: Math.max(0, elapsedMs - moduleElapsedMs),
                prefixGuardMs: Number(stageField(body, "prefix_guard") || "0"),
                stateSyncMs: Number(stageField(body, "state_sync") || "0"),
                wireBuildMs: Number(stageField(body, "wire_build") || "0"),
                wireMessages: Number(stageField(body, "wire_messages") || "0"),
                transportMs: Number(stageField(body, "transport") || "0"),
                transportPages: Number(stageField(body, "transport_pages") || "0"),
                transportBytes: Number(stageField(body, "transport_bytes") || "0"),
                rowVersion: Number(field(body, "row_version") || "0"),
                raw: line,
            });
        }
        return parsed;
    }

    /** Poll until `predicate` returns truthy or `timeoutMs` elapses. */
    async waitFor<T>(
        predicate: () => T | null | undefined | false | Promise<T | null | undefined | false>,
        opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
    ): Promise<T> {
        const timeoutMs = opts.timeoutMs ?? 60_000;
        const intervalMs = opts.intervalMs ?? 100;
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const value = await predicate();
            if (value) return value as T;
            await Bun.sleep(intervalMs);
        }
        throw new Error(
            `waitFor timed out after ${timeoutMs}ms${opts.label ? ` (${opts.label})` : ""}`,
        );
    }

    // ── context.db access (plugin state) ──────────────────────────────────────

    private contextDbPath(): string {
        return join(this.env.dataDir, "cortexkit", "magic-context", "context.db");
    }

    contextDb(): Database {
        if (this.contextDbCached) return this.contextDbCached;
        const dbPath = this.contextDbPath();
        if (!existsSync(dbPath)) {
            throw new Error(`context.db not found at ${dbPath} — plugin may not have initialized yet.`);
        }
        this.contextDbCached = new Database(dbPath, { readonly: true });
        return this.contextDbCached;
    }

    hasContextDb(): boolean {
        return existsSync(this.contextDbPath());
    }

    countTagsByStatus(sessionId: string, status: string): number {
        try {
            const row = this.contextDb()
                .prepare("SELECT COUNT(*) AS n FROM tags WHERE session_id = ? AND status = ?")
                .get(sessionId, status) as { n: number } | null;
            return row?.n ?? 0;
        } catch {
            return 0;
        }
    }

    /**
     * Override one session's cache TTL for a deterministic cache-busting probe.
     * The regular config path only refreshes this value on a new session; tests
     * that preserve a warm module session need to change it without recreating
     * the queued module-side drop.
     */
    setSessionCacheTtl(sessionId: string, cacheTtl: string): void {
        if (this.contextDbCached) {
            try {
                this.contextDbCached.close();
            } catch {
                // Best-effort close: a failure must not prevent reopening the database below.
            }
            this.contextDbCached = null;
        }
        const dbPath = this.contextDbPath();
        const db = new Database(dbPath);
        try {
            const result = db
                .prepare("UPDATE session_meta SET cache_ttl = ? WHERE session_id = ?")
                .run(cacheTtl, sessionId) as { changes?: number };
            if (result.changes !== 1) {
                throw new Error(`session cache TTL update affected ${result.changes ?? 0} rows`);
            }
        } finally {
            db.close();
        }
    }

    /** All mock requests received in this suite. */
    requests() {
        return this.mock.requests();
    }

    async dispose(): Promise<void> {
        if (this.contextDbCached) {
            try {
                this.contextDbCached.close();
            } catch {
                // ignore
            }
            this.contextDbCached = null;
        }
        // Kill order: opencode (holds the plugin's subc client) → module → daemon.
        try {
            await this.opencodeInstance.kill();
        } catch {
            // ignore
        }
        try {
            await this.subc.stop();
        } catch {
            // ignore
        }
        try {
            await this.mock.stop();
        } catch {
            // ignore
        }
        // Reclaim the per-suite temp tree (best-effort).
        try {
            rmSync(join(this.env.dataDir, ".."), { recursive: true, force: true });
        } catch {
            // ignore
        }
    }
}

/** Extract `key=value` (value = up to the next space) from a rust-pass log body. */
function field(body: string, key: string): string {
    const match = body.match(new RegExp(`(?:^|\\s)${key}=([^\\s]+)`));
    return match ? match[1]! : "";
}

function stageField(body: string, key: string): string {
    const match = body.match(new RegExp(`(?:^|\\s)${key}:([^\\s]+)`));
    return match ? match[1]! : "";
}

/** Serialize a value with every `cache_control` key stripped, for byte-identity checks. */
export function stableSerialize(value: unknown): string {
    return JSON.stringify(stripCacheControl(value));
}

function stripCacheControl(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stripCacheControl);
    if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(value)) {
            if (key === "cache_control") continue;
            out[key] = stripCacheControl(child);
        }
        return out;
    }
    return value;
}
