/**
 * Offline comparison of the OpenCode provider and whole-history Rust paths.
 * No daemon, live OpenCode host or model credentials are needed.
 *
 * The adapter runs in this Bun process. A JSON-lines test executable invokes the
 * real McHandler in-process, with isolated stores. A fake transcript reader
 * counts every attempted session.read call, which must remain zero. Generated
 * test source uses the existing Rust test helpers in a build-directory copy;
 * production sources are never patched to expose or ship a test endpoint.
 *
 * Run: bun packages/e2e-tests/scripts/provider-pipeline-differential.ts
 * Select controls: --case OpenCode1/A9.tag-prepend --case OpenCode1/A7.single-bust
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createScheduler } from "../../plugin/src/features/magic-context/scheduler";
import { runMigrations } from "../../plugin/src/features/magic-context/migrations";
import { initializeDatabase } from "../../plugin/src/features/magic-context/storage-db";
import { loadHostRunnerRecord } from "../../plugin/src/features/magic-context/storage-host-runner";
import {
    getOrCreateSessionMeta,
    updateSessionMeta,
} from "../../plugin/src/features/magic-context/storage-meta";
import { createTagger } from "../../plugin/src/features/magic-context/tagger";
import { Database } from "../../plugin/src/shared/sqlite";
import { setLogLineForwarder } from "../../plugin/src/shared/logger";
import { StoreAheadOfBinaryError } from "../../plugin/src/hooks/magic-context/store-ahead-refusal";
import {
    createOpenCodeProviderTransform,
    OPENCODE_PROVIDER_BOOTSTRAP_BUDGET_MS,
    type OpenCodeProviderOptions,
} from "../../plugin/src/hooks/magic-context/host-runner/opencode-adapter";
import type { createRustModeTransform } from "../../plugin/src/hooks/magic-context/rust-mode-transform";
import {
    createTransform,
    type TransformDeps,
} from "../../plugin/src/hooks/magic-context/transform";
import { MagicContextConfigSchema } from "../../plugin/src/config/schema/magic-context";
import { resolveTransformMode } from "../../plugin/src/config/transform-mode";
import type { MessageLike } from "../../plugin/src/hooks/magic-context/transform-operations";
import { encodeOpenCodeMessagesToCk } from "../../plugin/src/hooks/magic-context/module-wire";
import { decodeProviderAnswer } from "../../plugin/src/hooks/magic-context/host-runner/provider-client";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PREFIX = "PROVIDER_DRIVER=";
const logLines: string[] = [];
export const declaredDifferences = [
    "A3.race-tail: late user appends at the served tail, not the sorted position",
    "A3.unavailable-raw: unavailable hooks freeze raw bytes instead of LKG replay",
    "A3.switch-soft: switch equality is required only from a SOFT+ session",
] as const;

// Insert this source into a generated copy of the existing Rust tests module,
// where the isolated store and fake producer helpers are available. Provider
// files are linked to the originals, so deliberately corrupted production code
// is what the compiler sees during non-vacuity checks.
const DRIVER = String.raw`
#[test]
fn provider_pipeline_driver() {
    use std::io::{BufRead, Write};
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    rt.block_on(async {
        #[derive(Default)]
        struct ReadTrap(std::sync::atomic::AtomicUsize);
        #[async_trait]
        impl session_resolver::ProviderRunner for ReadTrap {
            async fn call(&self, _: &Path, _: &str, _: &str, _: Value, _: Duration) -> Result<Value, SessionResolveError> {
                self.0.fetch_add(1, Ordering::SeqCst);
                Err(SessionResolveError::Transport("unexpected session.read".into()))
            }
        }
        struct Rig {
            handler: McHandler,
            store: Arc<McStore>,
            sql: rusqlite::Connection,
            _dir: Option<tempfile::TempDir>,
            binding: SessionBinding,
            reads: Arc<ReadTrap>,
            namespaces: HashMap<String,u16>,
        }
        let mut rigs: HashMap<String, Rig> = HashMap::new();
        for line in std::io::stdin().lock().lines() {
            let cmd: Value = serde_json::from_str(&line.unwrap()).unwrap();
            let name = cmd["rig"].as_str().unwrap_or("default");
            let op = cmd["op"].as_str().unwrap();
            if op == "quit" { break; }
            let value = if op == "drop" {
                rigs.remove(name);
                json!({"dropped":true})
            } else if op == "fault" {
                std::env::set_var("MC_PROVIDER_FAULT_POINT", cmd["point"].as_str().unwrap());
                json!({"armed":true})
            } else if op == "create" {
                let config = McModuleConfig {
                    inject_docs: false, memory_enabled: false, temporal_awareness: false,
                    protected_tokens_user: Some(0), protected_tools: if cmd["protect_bash"] == true {BTreeMap::from([("bash".into(),2)])} else {BTreeMap::new()},
                    execute_threshold_percentage: 90.0, cache_ttl: "never".into(),
                    ..default_test_config()
                };
                let dir = if cmd["directory"].is_string() {None} else {Some(tempfile::tempdir().unwrap())};
                let root = cmd["directory"].as_str().map(PathBuf::from).unwrap_or_else(||dir.as_ref().unwrap().path().into());
                std::fs::create_dir_all(&root).unwrap();
                let project = root.join("project");
                std::fs::create_dir_all(&project).unwrap();
                let store = Arc::new(McStore::open_for_test(&crate::test_support::descriptor(&root)).unwrap());
                let mut handler = McHandler::with_producer_factory_config_resolver(
                    Arc::new(TestProducerFactory {state:Arc::new(ProducerState::default())}),
                    config.clone(), Arc::new(MissingSessionResolver));
                handler.store.set(store.clone()).ok().unwrap();
                let binding = SessionBinding {
                    project_root: project, harness: cmd["harness"].as_str().unwrap().into(),
                    session: "session".into(), model_key: None, config,
                    history_budget_tokens: 100000.0,
                };
                handler.bind_route(7, binding.clone());
                handler.set_guidance_now_ms_for_test(1);
                let reads = Arc::new(ReadTrap::default());
                handler.provider_runner = reads.clone();
                let sql = rusqlite::Connection::open(root.join("store.db")).unwrap();
                rigs.insert(name.into(), Rig {handler, store, sql, _dir: dir, binding, reads, namespaces:HashMap::new()});
                json!({"created": true})
            } else {
                let rig = rigs.get_mut(name).expect("created rig");
                if op == "event" {
                    let namespace = cmd["namespace"].as_str().unwrap_or("session");
                    match cmd["event"].as_str().unwrap() {
                        "publish" => {
                            let mut rows = rig.store.load_compartments(namespace).unwrap();
                            let start = cmd["start"].as_i64().unwrap();
                            let end = cmd["end"].as_i64().unwrap();
                            rows.push(StoredCompartment {sequence: rows.len() as i64 + 1,
                                start_message: start, end_message: end,
                                end_message_id: format!("{}#0",cmd["mid"].as_str().unwrap()),
                                title: "offline publication".into(), content: "published history".into(),
                                p1: Some("published history".into()), importance:50, ..Default::default()});
                            rig.store.replace_compartments(namespace, &rows).unwrap();
                        },
                        "delete" => { rig.store.replace_compartments(namespace, &[]).unwrap(); },
                        "flush" => { rig.store.arm_soft_refresh(namespace).unwrap(); },
                        "historian_start" | "historian_idle" => {
                            let mut loaded = rig.store.load(namespace).unwrap();
                            loaded.meta.historian.state = if cmd["event"] == "historian_start" {
                                HistorianPhase::AwaitingProducer
                            } else { HistorianPhase::Idle };
                            rig.store.commit(namespace, loaded.row_version, &loaded.core, &loaded.meta).unwrap();
                            if cmd["event"] == "historian_start" {
                                rig.handler.live_historian_sessions.lock().unwrap().insert(namespace.into(), LiveHistorianSession {token:Arc::new(()), completion:Arc::new(Notify::new())});
                            } else {
                                rig.handler.live_historian_sessions.lock().unwrap().remove(namespace);
                            }
                        },
                        other => panic!("unknown event {other}"),
                    }
                    json!({"changed":true})
                } else if op == "reads" {
                    json!(rig.reads.0.load(Ordering::SeqCst))
                } else if op == "inspect" {
                    let state = rig.store.load("session").unwrap();
                    let tags = rig.store.load_tags_for_session("session").unwrap();
                    let queued = rig.store.load_pending_agent_drops("session").unwrap().into_iter().map(|d|json!({"tag_number":tags.iter().find(|t|t.block_id==d.target_id).unwrap().tag_number,"target_id":d.target_id,"status":"queued","first_applied":d.command_first_applied_at_ms.is_some()})).collect::<Vec<_>>();
                    json!({"pending":rig.store.load_pending_agent_drops("session").unwrap().into_iter().map(|d|d.target_id).collect::<Vec<_>>(),"queue":queued,"version":state.core.version,
                        "model":state.meta.last_model_key,"floor":state.meta.protected_tokens_effective,
                        "coverage":state.meta.coverage_ordinal,"protected_tools":state.meta.protected_tool_block_ids,
                        "units":state.core.frozen_units})
                } else if op == "restart" {
                    let mut h = McHandler::with_producer_factory_config_resolver(
                        Arc::new(TestProducerFactory {state: Arc::new(ProducerState::default())}),
                        rig.binding.config.clone(), Arc::new(MissingSessionResolver));
                    h.store.set(rig.store.clone()).ok().unwrap();
                    h.bind_route(7, rig.binding.clone());
                    h.set_guidance_now_ms_for_test(1);
                    h.provider_runner = rig.reads.clone();
                    for (namespace, channel) in &rig.namespaces {
                        h.bind_route(*channel, SessionBinding {session: namespace.clone(), ..rig.binding.clone()});
                    }
                    rig.handler = h;
                    json!({"restarted": true})
                } else if op == "sql" {
                    (|| -> Result<Value, rusqlite::Error> {
                        let conn = &rig.sql;
                        if cmd["write"].as_bool() == Some(true) {
                            conn.execute_batch(cmd["sql"].as_str().unwrap()).unwrap();
                            return Ok(json!({"written":true}));
                        }
                        let mut q = conn.prepare(cmd["sql"].as_str().unwrap()).unwrap();
                        let cols = q.column_count();
                        let rows = q.query_map([], |row| {
                            Ok((0..cols).map(|i| {
                                use rusqlite::types::ValueRef;
                                match row.get_ref(i).unwrap() {
                                    ValueRef::Null => Value::Null,
                                    ValueRef::Integer(n) => json!(n),
                                    ValueRef::Real(n) => json!(n),
                                    ValueRef::Text(s) => json!(String::from_utf8_lossy(s)),
                                    ValueRef::Blob(s) => json!(String::from_utf8_lossy(s)),
                                }
                            }).collect::<Vec<_>>())
                        }).unwrap().map(Result::unwrap).collect::<Vec<_>>();
                        Ok(json!(rows))
                    })().unwrap()
                } else {
                    let mut request = cmd["body"].clone();
                    let mut channel = 7;
                    if op == "full" {
                        let raw = cmd["messages"].as_array().unwrap();
                        request = json!({"kind":"transform","v":2,
                            "serializer_profile":"opencode-aisdk","serve_native":true,
                            "session_id":cmd["namespace"].as_str().unwrap_or("session"),
                            "render_config":format!("provider:openai|model:{}",cmd["model"].as_str().unwrap()), "messages":cmd["ingress"],
                            "native_messages":raw,"tool_present":true,
                            "protected_tokens_effective":0,
                            "auto_search_enabled":false,"now_ms":cmd["now"],
                            "model_key":cmd["model"],
                            "geometry":{"usable_soft":cmd["window"].as_u64().unwrap()*9/10,"usable_hard":cmd["window"].as_u64().unwrap()*95/100,
                                "absolute_wall":cmd["window"],"derivation":"provider-differential"},
                            "historian_model_chain":[]});
                        request["usage"] = json!({"current_total_input_tokens":0,"context_limit_tokens":cmd["window"]});
                        if let Some(extra) = cmd["extra"].as_object() {
                            request.as_object_mut().unwrap().extend(extra.clone());
                        }
                        let namespace = request["session_id"].as_str().unwrap();
                        if namespace != "session" {
                            channel = if let Some(ch) = rig.namespaces.get(namespace) { *ch } else {
                                let ch = rig.namespaces.len() as u16 + 8;
                                rig.handler.bind_route(ch, SessionBinding {session:namespace.into(), ..rig.binding.clone()});
                                rig.namespaces.insert(namespace.into(),ch);
                                ch
                            };
                        }
                    }
                    match rig.handler.dispatch_value(channel, request).await {
                        HandlerOutcome::Response(bytes) => {
                            // Forward the handler's exact response, without a
                            // second parse/serialize of large bootstrap views.
                            println!("PROVIDER_DRIVER={{\"ok\":{}}}",String::from_utf8(bytes).unwrap());
                            std::io::stdout().flush().unwrap();
                            continue;
                        },
                        HandlerOutcome::Error {code,message} => json!({"error":{"code":code,"message":message}}),
                        HandlerOutcome::ErrorWithDetail {code,message,detail} => json!({"error":{"code":code,"message":message,"detail":detail}}),
                        other => panic!("unexpected outcome: {other:?}"),
                    }
                }
            };
            println!("PROVIDER_DRIVER={}", value);
            std::io::stdout().flush().unwrap();
        }
    });
}
`;

function buildDriver(directory: string): string {
    const link = (source: string, destination: string, type?: "dir") => {
        if (!existsSync(destination)) symlinkSync(source, destination, type);
    };
    const writeCurrent = (path: string, text: string) => {
        if (!existsSync(path) || readFileSync(path, "utf8") !== text) writeFileSync(path, text);
    };
    const overlay = join(directory, "workspace");
    mkdirSync(join(overlay, "crates/mc-module/src"), { recursive: true });
    for (const file of ["Cargo.toml", "Cargo.lock"])
        writeCurrent(join(overlay, file), readFileSync(join(ROOT, file), "utf8"));
    for (const name of ["packages", "tests", "docs", "assets", "scripts", "testdata"])
        link(join(ROOT, name), join(overlay, name), "dir");
    for (const name of ["mc-core", "mc-store", "mc-tokenizer"])
        link(join(ROOT, "crates", name), join(overlay, "crates", name), "dir");
    const original = join(ROOT, "crates/mc-module");
    const generated = join(overlay, "crates/mc-module");
    for (const name of readdirSync(original)) {
        if (name !== "src") link(join(original, name), join(generated, name));
    }
    // Reinstall a live link even when reusing an overlay: a Rust mutation must
    // compile the mutated source, not a cached source surrogate.
    const transformPath = join(generated, "src/transform.rs");
    if (existsSync(transformPath)) rmSync(transformPath);
    for (const name of readdirSync(join(original, "src"))) {
        if (name !== "lib.rs") link(join(original, "src", name), join(generated, "src", name));
    }
    const lib = readFileSync(join(original, "src/lib.rs"), "utf8");
    assert.equal(lib.split("mod tests {").length, 2, "unique Rust test-module insertion seam");
    const driverPath = join(generated, "src/provider_pipeline_driver.rs");
    writeCurrent(driverPath, DRIVER);
    writeCurrent(
        join(generated, "src/lib.rs"),
        lib.replace("mod tests {", `mod tests {\ninclude!(${JSON.stringify(driverPath)});`),
    );
    const target = resolve(process.env.CARGO_TARGET_DIR ?? join(ROOT, "target"));
    const built = spawnSync(
        "cargo",
        [
            "test",
            "--locked",
            "-p",
            "mc-module",
            "--lib",
            "--no-run",
            "--features",
            "drive-fault",
            "--message-format=json",
        ],
        {
            // Keep real wire deadlines enabled even for the 7.5k fixture. An
            // optimized test executable avoids measuring debug-code overhead as a
            // provider outage; this oracle does not claim production timings.
            cwd: overlay,
            env: { ...process.env, CARGO_TARGET_DIR: target, CARGO_PROFILE_TEST_OPT_LEVEL: "3" },
            encoding: "utf8",
            maxBuffer: 64 * 1024 * 1024,
        },
    );
    const artifacts = built.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    if (built.status !== 0)
        throw new Error(
            `Rust test driver build failed\n${built.stderr}\n${artifacts
                .filter((a) => a.reason === "compiler-message")
                .map((a) => a.message.rendered)
                .join("\n")}`,
        );
    const binary = artifacts.find(
        (a) => a.reason === "compiler-artifact" && a.target.name === "mc_module" && a.executable,
    )?.executable;
    assert.ok(binary, "Cargo must report the real mc-module test executable");
    return binary;
}

class Driver {
    private child;
    private lines;
    private stderr;
    private killPoint?: string;
    private killed = false;
    readonly faults: string[] = [];
    get wasKilled() {
        return this.killed;
    }
    constructor(
        readonly binary: string,
        readonly directory: string,
    ) {
        this.child = Bun.spawn(
            [
                binary,
                "--exact",
                "tests::provider_pipeline_driver",
                "--nocapture",
                "--test-threads=1",
            ],
            {
                cwd: ROOT,
                stdin: "pipe",
                stdout: "pipe",
                stderr: "pipe",
                env: {
                    ...process.env,
                    TMPDIR: directory,
                    MC_PROVIDER_FAULT_POINT: "",
                    MC_DRIVE_FAULT: "",
                },
            },
        );
        this.lines = this.readLines();
        this.stderr = this.readErrors();
    }
    private async readErrors() {
        const reader = this.child.stderr.getReader();
        const decoder = new TextDecoder();
        let pending = "";
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            pending += decoder.decode(value, { stream: true });
            let end: number;
            while ((end = pending.indexOf("\n")) >= 0) {
                const line = pending.slice(0, end);
                pending = pending.slice(end + 1);
                const point = /MC_PROVIDER_FAULT_REACHED (\w+)/.exec(line)?.[1];
                if (point) {
                    this.faults.push(point);
                    if (point === this.killPoint) {
                        this.killed = true;
                        this.child.kill("SIGKILL");
                    }
                } else process.stderr.write(`${line}\n`);
            }
        }
    }
    async arm(point: string) {
        this.killPoint = point;
        await this.send({ op: "fault", point });
    }
    private async *readLines() {
        const reader = this.child.stdout.getReader();
        const decoder = new TextDecoder();
        let pending = "";
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            pending += decoder.decode(value, { stream: true });
            let end: number;
            while ((end = pending.indexOf("\n")) >= 0) {
                const line = pending.slice(0, end);
                pending = pending.slice(end + 1);
                // libtest may put its test-name prefix on the first reply line.
                const start = line.indexOf(PREFIX);
                if (start >= 0) yield JSON.parse(line.slice(start + PREFIX.length));
            }
        }
    }
    async send(command: Record<string, unknown>): Promise<any> {
        if (this.killed) throw new Error(`Rust driver killed at ${this.killPoint}`);
        this.child.stdin.write(`${JSON.stringify(command)}\n`);
        await this.child.stdin.flush();
        const reply = await this.lines.next();
        assert.equal(reply.done, false, `Rust driver stopped (command ${command.op})`);
        return reply.value;
    }
    async close() {
        if (!this.killed) {
            this.child.stdin.write('{"op":"quit"}\n');
            this.child.stdin.end();
        }
        const code = await this.child.exited;
        await this.stderr;
        if (!this.killed) assert.equal(code, 0, "Rust driver exit");
    }
}

type Host = "OpenCode1" | "OpenCode2";
type Wire = { method: string; params: Record<string, any> };
function canonical<T>(value: T): T {
    if (Array.isArray(value)) return value.map(canonical) as T;
    if (value && typeof value === "object")
        return Object.fromEntries(
            Object.entries(value)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, v]) => [k, canonical(v)]),
        ) as T;
    return value;
}
function message(id: string, role = "user", text = `café 🦀 \"${id}\"\n`) {
    return canonical({
        info: {
            id,
            role,
            sessionID: "session",
            model: { providerID: "openai", modelID: "gpt-5.6" },
            time: { created: 1, completed: 2 },
        },
        parts: [{ id: `${id}-text`, type: "text", text }],
    }) as MessageLike;
}
function tools(id: string, repeated = false): MessageLike {
    const m = message(id, "assistant", "assistant response");
    for (const n of [1, 2])
        m.parts.push(
            canonical({
                id: `${id}-tool-${n}`,
                type: "tool",
                tool: "bash",
                callID: repeated ? "shared-call" : `${id}-call-${n}`,
                state: { status: "completed", input: {}, output: "tool output" },
            }) as any,
        );
    return canonical(m);
}
const bytes = (messages: MessageLike[]) => messages.map((m) => JSON.stringify(m));
function prefix(before: string[], after: string[]) {
    assert.deepEqual(after.slice(0, before.length), before, "served byte prefix");
}

let serial = 0;
async function fixture(driver: Driver, host: Host, directory?: string, protectBash = false) {
    const rig = `${host}-${++serial}`;
    const harness = host === "OpenCode1" ? "opencode" : "opencode2";
    await driver.send({ op: "create", rig, harness, directory, protect_bash: protectBash });
    const oracleRig = `${rig}-full`;
    await driver.send({
        op: "create",
        rig: oracleRig,
        harness,
        protect_bash: protectBash,
        directory: directory ? join(directory, "oracle") : undefined,
    });
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    getOrCreateSessionMeta(db, "session");
    const wires: Wire[] = [];
    const answers: any[] = [];
    const callTimes: { method: string; ms: number }[] = [];
    const recorded: string[][] = [];
    const fullDecisions: { rig: string; action: unknown }[] = [];
    const logStart = logLines.length;
    const fallbacks: (string | undefined)[] = [];
    let now = 1000;
    let unavailable = false;
    let intercept: ((wire: Wire, reply: any, signal?: AbortSignal) => unknown) | undefined;
    const sql = (sql: string, write = false) => driver.send({ op: "sql", rig, sql, write });
    const call = async (body: unknown) => {
        const reply = await driver.send({ op: "call", rig, body });
        if (reply.error) {
            console.error(
                `HANDLER_ERROR ${rig} ${JSON.stringify(body).slice(0, 300)} ${JSON.stringify(reply.error)}`,
            );
            throw Object.assign(new Error(reply.error.message), reply.error);
        }
        return reply.ok;
    };
    const deps: TransformDeps = {
        db,
        transformMode: "rust",
        rustPipeline: "provider",
        storeGeneration: host === "OpenCode1" ? "v1" : "v2",
        tagger: createTagger(),
        scheduler: createScheduler({ executeThresholdPercentage: 90 }),
        contextUsageMap: new Map(),
        historyRefreshSessions: new Set(),
        pendingMaterializationSessions: new Set(),
        lastHeuristicsTurnId: new Map(),
        clearReasoningAge: 50,
        directory: "/provider-differential",
        rustModeModuleClient: {
            async call(args) {
                if (unavailable) throw new Error("Injected module unavailable");
                const w = (
                    args.body instanceof Uint8Array
                        ? JSON.parse(new TextDecoder().decode(args.body))
                        : args.body
                ) as Wire;
                wires.push(w);
                const started = performance.now();
                const reply = await call(w);
                callTimes.push({ method: w.method, ms: Math.round(performance.now() - started) });
                answers.push(reply);
                return intercept ? (intercept(w, reply, args.signal) ?? reply) : reply;
            },
        },
    };
    const fullFrom = async (
        target: string,
        input: MessageLike[],
        namespace?: string,
        extra?: Record<string, unknown>,
    ) => {
        const model = String(extra?.model_key ?? "openai/gpt-5.6");
        const window = getOrCreateSessionMeta(db, "session").lastUsageContextLimit || 200000;
        const reply = await driver.send({
            op: "full",
            rig: target,
            messages: input,
            ingress: encodeOpenCodeMessagesToCk(input),
            namespace,
            now,
            model,
            window,
            extra,
        });
        assert.ok(!reply.error, `full-request handler refused: ${JSON.stringify(reply.error)}`);
        assert.equal(
            reply.ok.status,
            "ok",
            `full-request handler status: ${JSON.stringify(reply.ok)}`,
        );
        assert.ok(Array.isArray(reply.ok.native_messages), "real full-request native output");
        fullDecisions.push({ rig: target, action: reply.ok.action });
        return reply.ok.native_messages as MessageLike[];
    };
    const full = (input: MessageLike[], namespace?: string, extra?: Record<string, unknown>) =>
        fullFrom(rig, input, namespace, extra);
    const state = {
        moduleGeneration: 0,
        lastAckedSeq: 0,
        lastAckedWatermarks: null,
        idOrdinalMemoGeneration: 0,
        idOrdinalMemo: new Map(),
        ordinalMemoCheckpoints: [],
        ordinalContinuationBase: 0,
    };
    const legacy = { getState: () => state } as unknown as ReturnType<
        typeof createRustModeTransform
    >;
    const options: OpenCodeProviderOptions = {
        now: () => now,
        persisted: (_s, id) => !id.startsWith("unpersisted"),
        resolveOrdinals: async (args) => ({
            ok: true,
            annotatedInput: args.messages.map((m, i) => ({
                ...m,
                absolute_ordinal: (m.info as any).absolute_ordinal ?? i + 1,
            })),
            memoGeneration: 0,
            memoAnchor: null,
            memoStoredCount: args.messages.length,
            memoCanonicalCount: args.messages.length,
            normalizations: [],
            stats: { mode: "memo", pages: 0, rowsRead: 0, rewinds: 0 },
        }),
        sync: async (_id, _state, complete) => {
            // Fixture events already write the authoritative store. With no
            // host watermark delta, sync is no_change; only a no-hook pass needs
            // the real handler's content-free pass barrier. Sending an empty
            // authority snapshot here would erase the seeded state, not sync it.
            if (complete)
                await call({
                    kind: "state_sync",
                    session_id: "session",
                    pass_complete: true,
                    historian_model_chain: [],
                });
        },
        historian: { pump: async () => {}, stop: async () => {} },
        marker: async () => {},
        fullRequest: async (_id, input, output, _meta, namespace) => {
            fallbacks.push(namespace);
            output.messages = await full(input, namespace);
        },
    };
    let adapter = createOpenCodeProviderTransform(deps, legacy, options);
    return {
        host,
        binary: driver.binary,
        driverDirectory: driver.directory,
        get moduleDriver() {
            return driver;
        },
        db,
        deps,
        wires,
        answers,
        callTimes,
        recorded,
        fallbacks,
        fullDecisions,
        rig,
        sql,
        call,
        full,
        logs: () => logLines.slice(logStart),
        async event(event: string, details: Record<string, unknown> = {}) {
            await driver.send({ op: "event", rig, event, ...details });
            await driver.send({ op: "event", rig: oracleRig, event, ...details });
        },
        async noReads() {
            assert.equal(await driver.send({ op: "reads", rig }), 0, "zero session.read calls");
        },
        inspect: () => driver.send({ op: "inspect", rig }),
        oldInspect: () => driver.send({ op: "inspect", rig: oracleRig }),
        rustControl(name: string) {
            const run = spawnSync(driver.binary, ["--exact", name, "--nocapture"], {
                cwd: ROOT,
                encoding: "utf8",
                maxBuffer: 8 * 1024 * 1024,
            });
            assert.equal(run.status, 0, `${name}\n${run.stdout}\n${run.stderr}`);
            assert.match(
                run.stdout,
                /1 passed; 0 failed/,
                "one real Rust control, not an empty filter",
            );
        },
        old: (input: MessageLike[], extra?: Record<string, unknown>) =>
            fullFrom(oracleRig, input, undefined, extra),
        async oldCall(body: unknown) {
            const reply = await driver.send({ op: "call", rig: oracleRig, body });
            assert.ok(!reply.error, `old pipeline call refused: ${JSON.stringify(reply.error)}`);
            return reply.ok;
        },
        stored: () => loadHostRunnerRecord(db, { session_id: "session", harness }),
        get adapter() {
            return adapter;
        },
        setUnavailable(value: boolean) {
            unavailable = value;
        },
        setIntercept(value?: typeof intercept) {
            intercept = value;
        },
        advance(ms: number) {
            now += ms;
        },
        async restartHost() {
            adapter.dispose();
            adapter = createOpenCodeProviderTransform(deps, legacy, options);
        },
        restartModule: () => driver.send({ op: "restart", rig }),
        async reopenModule(next: Driver) {
            assert.ok(directory, "persistent root is required for a process restart");
            await driver.close();
            driver = next;
            await driver.send({ op: "create", rig, harness, directory, protect_bash: protectBash });
            await driver.send({
                op: "create",
                rig: oracleRig,
                harness,
                protect_bash: protectBash,
                directory: join(directory, "oracle"),
            });
        },
        async pass(input: MessageLike[]) {
            const output = { messages: [] as unknown[] };
            await adapter.run("session", input, output, getOrCreateSessionMeta(db, "session"));
            const served = output.messages as MessageLike[];
            // This is the recording fake provider's boundary, not a reconstruction
            // from the runner tables. Assertions always consume what was served.
            recorded.push(bytes(served));
            return served;
        },
        async close() {
            adapter.dispose();
            db.close();
            if (!driver.wasKilled) {
                await driver.send({ op: "drop", rig });
                await driver.send({ op: "drop", rig: oracleRig });
            }
        },
    };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Case = { name: string; run: (f: Fixture) => Promise<void> };
const faultPoints = [
    "SetupRecorded",
    "MessagesIngested",
    "AnswerRecorded",
    "HookStateRecorded",
    "WaitAnswered",
    "WaitWorkDurable",
] as const;
async function moduleCrashCase(parent: Fixture, point: (typeof faultPoints)[number]) {
    const root = join(parent.driverDirectory, `crash-${parent.host}-${point}-${++serial}`);
    const child = new Driver(parent.binary, parent.driverDirectory);
    const f = await fixture(child, parent.host, root);
    const raw = [message("base")];
    let before = bytes(await f.full(raw));
    await f.full(raw);
    try {
        const bootstrap = ["SetupRecorded", "MessagesIngested", "AnswerRecorded"].includes(point);
        if (!bootstrap) {
            await f.pass(raw);
            before = f.recorded.at(-1)!;
        }
        if (point.startsWith("Wait")) {
            f.setUnavailable(true);
            raw.push(message("tail"));
            await f.pass(raw);
            f.setUnavailable(false);
            before = f.recorded.at(-1)!;
        }
        await child.arm(point);
        if (point.startsWith("Wait")) {
            const stored = f.stored()!;
            const view = stored.views[0];
            const plan = JSON.parse(stored.state.plan_json!);
            await assert.rejects(
                f.call({
                    method: "compaction.step",
                    params: {
                        session: "session",
                        harness: parent.host === "OpenCode1" ? "opencode" : "opencode2",
                        request_id: `fault-${point}`,
                        lineage_id: stored.state.lineage_id,
                        preset: plan.preset,
                        params: plan.params,
                        model: "openai/gpt-5.6",
                        step_id: "wait-cut",
                        step_kind: "model",
                        context_window: 200000,
                        estimate: { request_tokens: 0 },
                        newest: { ordinal: 2, mid: "tail" },
                        now: 1000,
                        served_through_ordinal: 2,
                        after_ordinal: 1,
                        last_applied: { compaction_id: view.compaction_id, version: view.version },
                        messages: [{ ordinal: 2, mid: "tail", message: raw[1] }],
                        more: true,
                    },
                }),
                /Rust driver/,
            );
        } else if (point === "HookStateRecorded") {
            raw.push(message("tail"));
            await f.pass(raw);
            prefix(before, f.recorded.at(-1)!);
            before = f.recorded.at(-1)!;
        } else {
            const count = f.recorded.length;
            await assert.rejects(f.pass(raw), /safely serve|Rust driver killed/);
            assert.equal(f.recorded.length, count, "unrecorded bootstrap answer never served");
        }
        assert.deepEqual(child.faults, [point], "real durable cut reached before SIGKILL");
        await f.reopenModule(new Driver(parent.binary, parent.driverDirectory));
        f.advance(5000);
        await f.restartHost();
        if (!bootstrap) raw.push(message("confirm"));
        const restored = await f.pass(raw);
        prefix(before, bytes(restored));
        f.deps.historyRefreshSessions.add("session");
        await f.pass(raw);
        if (point === "HookStateRecorded") {
            assert.equal(
                (await f.sql("SELECT COUNT(*) FROM mc_tags WHERE tag_number=2"))[0][0],
                0,
                "answer lost at the cut was never promoted",
            );
            const refused = await f.call({ name: "ctx_reduce", arguments: { drop: "2" } });
            assert.equal(refused.isError, true, "lost answer's number remains unknown");
        }
        await f.noReads();
    } finally {
        await f.close();
        await f.moduleDriver.close();
        rmSync(root, { recursive: true, force: true });
    }
}
const cases: Case[] = [
    ...faultPoints.map((point) => ({
        name: `A6.S3-${point}`,
        run: (f: Fixture) => moduleCrashCase(f, point),
    })),
    {
        name: "A3.full-request-differential",
        async run(f) {
            const raw = [message("base")];
            for (let warm = 0; warm < 2; warm++) {
                assert.deepEqual(
                    bytes(await f.full(raw)),
                    bytes(await f.old(raw)),
                    "same starting full-request stores",
                );
            }
            assert.deepEqual(
                bytes(await f.pass(raw)),
                bytes(await f.old(raw)),
                "SOFT+ pipeline switch",
            );
            for (let pass = 0; pass < 8; pass++) {
                raw.push(message(`u${pass}`), tools(`a${pass}`));
                assert.deepEqual(
                    bytes(await f.pass(raw)),
                    bytes(await f.old(raw)),
                    `append/tool-loop differential pass ${pass}`,
                );
            }
            f.deps.historyRefreshSessions.add("session");
            assert.deepEqual(
                bytes(await f.pass(raw)),
                bytes(await f.old(raw, { flush_requested: true })),
                "flush replacement differential",
            );
        },
    },
    {
        name: "A3.race-tail",
        async run(f) {
            const raw = [message("u1"), message("a1", "assistant"), message("a2", "assistant")];
            await f.full(raw);
            await f.full(raw);
            await f.old(raw);
            await f.old(raw);
            const before = await f.pass(raw);
            const incoming = [raw[0], raw[1], message("X"), raw[2], message("a3", "assistant")];
            const served = await f.pass(incoming);
            prefix(bytes(before), bytes(served));
            assert.deepEqual(
                served.filter((m) => m.info.id).map((m) => m.info.id),
                ["u1", "a1", "a2", "X", "a3"],
            );
            const old = await f.old(incoming);
            assert.deepEqual(
                old.filter((m) => m.info.id).map((m) => m.info.id),
                ["u1", "a1", "X", "a2", "a3"],
                "old pipeline sorted-position control",
            );
            assert.equal(f.stored()!.state.ordinal_divergence, 1);
        },
    },
    {
        name: "A3.unavailable-raw",
        async run(f) {
            const raw = [message("base")];
            const before = await f.pass(raw);
            f.setUnavailable(true);
            for (const id of ["offline1", "offline2"]) {
                const m = message(id);
                raw.push(m);
                const out = await f.pass(raw);
                prefix(bytes(before), bytes(out));
                assert.equal(
                    JSON.stringify(out.at(-1)),
                    JSON.stringify(m),
                    "unavailable pass freezes new raw bytes, not an LKG",
                );
            }
            assert.ok(f.stored()!.entries.every((e) => e.ingested === 0));
            f.setUnavailable(false);
            f.deps.historyRefreshSessions.add("session");
            await f.pass(raw);
            assert.deepEqual(
                f.wires
                    .filter((w) => w.method === "compaction.step")
                    .at(-1)!
                    .params.messages.map((m: any) => m.mid),
                ["offline1", "offline2"],
            );
        },
    },
    {
        name: "A3.switch-soft",
        async run(f) {
            const raw = [message("u"), tools("a")];
            await f.full(raw);
            await f.old(raw);
            const soft = await f.full(raw);
            assert.deepEqual(bytes(soft), bytes(await f.old(raw)), "independent SOFT+ stores");
            const switched = await f.pass(raw);
            assert.deepEqual(bytes(switched), bytes(soft));
            raw.push(tools("post-switch"));
            const appended = await f.pass(raw);
            f.deps.historyRefreshSessions.add("session");
            const rebuilt = await f.pass(raw);
            for (const m of rebuilt.filter(
                (m) => m.info.id === "a" || m.info.id === "post-switch",
            )) {
                assert.equal(
                    JSON.stringify(m),
                    JSON.stringify(appended.find((p) => p.info.id === m.info.id)),
                    "replacement equals hook-served bytes",
                );
                for (const p of m.parts as any[]) {
                    const text = p.type === "tool" ? p.state.output : p.text;
                    assert.equal(
                        [...text.matchAll(/§\d+§/g)].length,
                        1,
                        "one engine/hook tag per block after switch",
                    );
                }
            }
        },
    },
    {
        name: "A3.publication-veto-opportunities",
        async run(f) {
            const raw = [message("base"), message("old1"), message("old2"), message("latest")];
            for (const [i, m] of raw.entries()) (m.info as any).absolute_ordinal = i + 1;
            await f.event("publish", { start: 1, end: 1, mid: "base" });
            await f.full(raw);
            await f.full(raw);
            await f.old(raw);
            await f.old(raw);
            const historical = [...raw];
            // The baseline summary covers ordinal 1 ("base"), which the host has
            // removed from its input window. Remaining rows retain ordinals 2-4.
            raw.shift();
            await f.pass(raw);
            await f.event("publish", { start: 2, end: 3, mid: "old2" });
            const count = f.wires.filter((w) => w.method === "compaction.step").length;
            assert.deepEqual(
                bytes(await f.pass(raw)),
                bytes(await f.old(historical)),
                "historian publish below threshold stays frozen",
            );
            assert.equal(
                f.wires.filter((w) => w.method === "compaction.step").length,
                count,
                "publication is not an opportunity",
            );
            await f.event("historian_start");
            await f.event("flush");
            f.deps.historyRefreshSessions.add("session");
            const active = await f.pass(raw);
            const oldActive = await f.old(historical, { flush_requested: true });
            assert.deepEqual(
                bytes(active),
                bytes(oldActive),
                "step while historian in-flight agrees with full path",
            );
            await f.event("historian_idle");
            await f.event("flush");
            f.deps.historyRefreshSessions.add("session");
            assert.deepEqual(
                bytes(await f.pass(raw)),
                bytes(await f.old(historical, { flush_requested: true })),
                "flush folds published history",
            );
            await f.event("delete");
            await f.event("flush");
            f.db.exec(
                "INSERT INTO m0_mutation_log (session_id,mutation_type,queued_at) VALUES ('session','compartment_delete',1)",
            );
            assert.deepEqual(
                bytes(await f.pass(raw)),
                bytes(await f.old(historical, { flush_requested: true })),
                "dashboard delete folds on next pass",
            );
        },
    },
    {
        name: "A3.drops-threshold-ttl-model",
        async run(f) {
            const raw = [
                message("base"),
                tools("a"),
                message("turn1"),
                tools("recent"),
                message("latest"),
            ];
            (raw[1].parts[1] as any).state.output = "spent output ".repeat(10000);
            (raw[1].parts[2] as any).state.output = "second spent output ".repeat(10000);
            await f.full(raw);
            await f.full(raw);
            await f.old(raw);
            await f.old(raw);
            await f.pass(raw);
            const drop = {
                name: "ctx_reduce",
                arguments: { session_id: "session", command_id: "queue-differential", drop: "3" },
            };
            const queued = await f.call(drop);
            assert.match(
                JSON.stringify(queued),
                /Queued/,
                `real provider reduction queues a tag: ${JSON.stringify(queued)}`,
            );
            assert.deepEqual(
                (await f.inspect()).pending,
                ["a#2"],
                "pre-switch tag uses the full-request durable target queue",
            );
            const oldAck = await f.oldCall(drop);
            assert.equal(
                oldAck.isError,
                false,
                `full-request control recognizes the same pre-switch tag: ${JSON.stringify(oldAck)}`,
            );
            await f.oldCall({
                kind: "agent_drops.append",
                session_id: "session",
                command_id: "queue-differential",
                drop: "3",
            });
            const count = f.wires.filter((w) => w.method === "compaction.step").length;
            assert.deepEqual(
                bytes(await f.pass(raw)),
                bytes(await f.old(raw)),
                "queued drops cannot rewrite a warm prefix",
            );
            assert.equal(f.wires.filter((w) => w.method === "compaction.step").length, count);
            f.deps.contextUsageMap.set("session", { usage: { inputTokens: 185000 } } as any);
            assert.deepEqual(
                bytes(await f.pass(raw)),
                bytes(
                    await f.old(raw, {
                        usage: { current_total_input_tokens: 185000, context_limit_tokens: 200000 },
                    }),
                ),
                "threshold crossing differential",
            );
            f.deps.contextUsageMap.delete("session");
            updateSessionMeta(f.db, "session", { cacheTtl: "5m", lastResponseTime: 2000 });
            f.advance(400000);
            const cold = await f.pass(raw);
            assert.deepEqual(
                bytes(cold),
                bytes(
                    await f.old(raw, {
                        cache_ttl: "5m",
                        prev_response_completed_at_ms: 2000,
                        request_observed_at_ms: 401000,
                    }),
                ),
                "TTL-expiry differential",
            );
            raw.push(message("switch"));
            (raw.at(-1)!.info as any).model = { providerID: "openai", modelID: "changed-model" };
            assert.deepEqual(
                bytes(await f.pass(raw)),
                bytes(
                    await f.old(raw, {
                        model_key: "openai/changed-model",
                        prefix_rebuilding: { reason: "model_switch" },
                    }),
                ),
                "model-switch differential",
            );
            assert.equal(
                (await f.inspect()).model,
                "openai/changed-model",
                "current step model is adopted",
            );
            assert.deepEqual(
                (await f.inspect()).pending,
                [],
                "queued drop applied on the independently permitted HARD",
            );
        },
    },
    {
        name: "A3.model-switch-protected-newest-tool-queue",
        async run(f) {
            const old = tools("old");
            old.parts.pop();
            (old.parts[1] as any).state.output = "spent historical output ".repeat(10000);
            const raw = [message("base"), old, message("turn"), tools("recent"), message("latest")];
            for (let i = 0; i < 2; i++) {
                await f.full(raw);
                await f.old(raw);
            }
            await f.pass(raw);
            assert.equal(
                (await f.call({ name: "ctx_reduce", arguments: { drop: "7" } })).isError,
                false,
            );
            await f.oldCall({
                kind: "agent_drops.append",
                session_id: "session",
                command_id: "model-only-drop",
                drop: "7",
            });
            const before = await f.inspect();
            assert.ok(
                before.protected_tools.includes("recent#4"),
                "keep-latest-two bash outputs protects the newest tool result",
            );
            raw.push(message("switch"));
            (raw.at(-1)!.info as any).model = { providerID: "openai", modelID: "new-model" };
            assert.deepEqual(
                bytes(await f.pass(raw)),
                bytes(await f.old(raw, { model_key: "openai/new-model" })),
                "queued pre-switch drop on current-model HARD",
            );
            const actual = await f.inspect();
            const expected = await f.oldInspect();
            assert.deepEqual(
                actual.queue,
                expected.queue,
                "same tag numbers, order, and queued/applied status on the protected newest-tool window",
            );
            assert.deepEqual(actual.pending, ["recent#4"]);
            assert.equal(actual.model, expected.model);
            assert.equal(f.fullDecisions.at(-1)!.action, "HARD");
            assert.ok(
                actual.version > before.version,
                "model eviction executed HARD even though a protected tag stays queued",
            );
        },
    },
    {
        name: "A1.append-first-serve",
        async run(f) {
            const input = [message("base")];
            await f.pass(input);
            let previous = f.recorded.at(-1)!;
            const first = new Map<string, string>();
            for (let pass = 0; pass < 12; pass++) {
                for (let i = 0; i <= pass % 3; i++)
                    input.push(message(`m-${pass}-${i}`, i === 1 ? "assistant" : "user"));
                const served = await f.pass(input);
                const current = f.recorded.at(-1)!;
                prefix(previous, current);
                for (const m of served) {
                    const id = m.info.id;
                    if (!id) continue;
                    if (first.has(id))
                        assert.equal(JSON.stringify(m), first.get(id), `first-serve ${id}`);
                    else first.set(id, JSON.stringify(m));
                }
                previous = current;
            }
            assert.equal(
                f.wires.filter((w) => w.method === "compaction.step").length,
                1,
                "only bootstrap produces a view",
            );
        },
    },
    {
        name: "A1.known-content-unread",
        async run(f) {
            const input = [message("base"), message("known")];
            await f.pass(input);
            const appended = message("tail");
            await f.pass([...input, appended]);
            const previous = f.recorded.at(-1)!;
            const poisonous = {
                info: appended.info,
                get parts(): never {
                    throw new Error("known message was read or re-serialized");
                },
            } as MessageLike;
            await f.pass([...input, poisonous, message("next")]);
            prefix(previous, f.recorded.at(-1)!);
            assert.equal(f.stored()!.entries.length, 2);
        },
    },
    {
        name: "A9.tag-prepend",
        async run(f) {
            await f.pass([message("base")]);
            const served = await f.pass([message("base"), tools("assistant")]);
            const hooks = f.wires.filter(
                (w) => w.method === "transform.hook" && w.params.subject_mid === "assistant",
            );
            assert.equal(hooks.length, 3, "text and two tool subjects");
            assert.equal(
                new Set(hooks.map((w) => JSON.stringify(w.params.message))).size,
                1,
                "byte-identical ingest on every subject",
            );
            const m = served.find((m) => m.info.id === "assistant")!;
            for (const p of m.parts as any[]) {
                const text = p.type === "tool" ? p.state.output : p.text;
                assert.match(text, /^§\d+§ /, `one tag prepend in ${p.id}`);
                assert.equal([...text.matchAll(/§\d+§/g)].length, 1, "not a doubled tag");
            }
            await f.pass([message("base"), tools("assistant"), message("confirm")]);
            const counts = await f.sql(
                "SELECT state,COUNT(*) FROM mc_provider_hook_answers_v1 GROUP BY state",
            );
            assert.ok(
                counts.some(([state, n]: any[]) => state === "live" && n >= 3),
                "all three subjects live after next call",
            );
            const ingests = await f.sql(
                "SELECT COUNT(*) FROM mc_provider_messages_v1 WHERE mid='assistant'",
            );
            assert.equal(ingests[0][0], 1, "one ingest for three subjects");
        },
    },
    {
        name: "A5.raw-tail-revert",
        async run(f) {
            const base = message("base");
            await f.pass([base]);
            const tail = [message("a"), message("b"), message("c")];
            const before = await f.pass([base, ...tail]);
            const oldLineage = f.stored()!.state.lineage_id;
            const after = await f.pass([base, tail[0], message("replacement")]);
            prefix(
                bytes(
                    before.slice(
                        0,
                        before.findIndex((m) => m.info.id === "b"),
                    ),
                ),
                bytes(after),
            );
            assert.ok(!after.some((m) => ["b", "c"].includes(m.info.id!)), "reverted ids absent");
            assert.notEqual(f.stored()!.state.lineage_id, oldLineage);
            const ingests = await f.sql(
                "SELECT mid,COUNT(*) FROM mc_provider_messages_v1 GROUP BY mid",
            );
            assert.ok(
                ingests.every(([, n]: any[]) => n === 1),
                "descent never ingests an ancestor twice",
            );
        },
    },
    {
        name: "A5.covered-revert-fails-closed",
        async run(f) {
            const raw = [message("a"), message("b"), message("c")];
            await f.pass(raw);
            assert.equal(f.stored()!.entries.length, 0, "view pruned every raw entry");
            await f.restartHost();
            f.setUnavailable(true);
            await assert.rejects(f.pass(raw.slice(0, 1)), /cannot safely serve/i);
            assert.equal(f.stored()!.views[0].state, "invalidated");
            assert.equal(f.recorded.length, 1, "invalidated output never reaches fake provider");
            f.setUnavailable(false);
            const after = await f.pass(raw.slice(0, 1));
            assert.ok(!after.some((m) => ["b", "c"].includes(m.info.id!)));
            const reverts = f.wires.filter(
                (w) =>
                    w.method === "compaction.step" &&
                    w.params.prefix_rebuilding?.reason === "revert",
            );
            assert.equal(reverts.length, 1, "exactly one answered revert rebuild");
        },
    },
    {
        name: "A6.host-and-module-restart",
        async run(f) {
            const raw = [message("base")];
            await f.pass(raw);
            raw.push(tools("a"));
            await f.pass(raw);
            const before = f.recorded.at(-1)!;
            const calls = f.wires.length;
            await f.restartHost();
            await f.pass(raw);
            assert.deepEqual(f.recorded.at(-1), before, "restart hydrates first-serve bytes");
            assert.equal(f.wires.length, calls, "no provider request on hydrated replay");
            await f.restartModule();
            raw.push(message("next"));
            await f.pass(raw);
            prefix(before, f.recorded.at(-1)!);
        },
    },
    {
        name: "A6.hook-answer-before-durable-append",
        async run(f) {
            const raw = [message("base")];
            await f.pass(raw);
            f.db.exec(
                "CREATE TEMP TRIGGER kill_append BEFORE INSERT ON host_runner_entries BEGIN SELECT RAISE(ABORT,'host stopped before durable append'); END",
            );
            raw.push(tools("uncommitted"));
            const answerStart = f.answers.length;
            await assert.rejects(f.pass(raw), /cannot safely serve/);
            assert.equal(f.stored()!.entries.length, 0, "failed append never commits or serves");
            const burned = f.answers
                .slice(answerStart)
                .flatMap((a) =>
                    (a.ops ?? []).flatMap((op: any) => /^§(\d+)§ /.exec(op.text ?? "")?.[1] ?? []),
                );
            assert.equal(burned.length, 3, "three stranded hook answers");
            assert.equal(
                (
                    await f.sql("SELECT COUNT(*) FROM mc_tags WHERE block_id LIKE 'uncommitted#%'")
                )[0][0],
                0,
            );
            f.db.exec("DROP TRIGGER kill_append");
            await f.restartHost();
            const out = await f.pass(raw);
            const text = JSON.stringify(out.find((m) => m.info.id === "uncommitted"));
            for (const number of burned)
                assert.ok(!text.includes(`§${number}§`), "retry burns the earlier answer");
            f.deps.historyRefreshSessions.add("session");
            const rebuilt = JSON.stringify(await f.pass(raw));
            for (const number of burned)
                assert.ok(
                    !rebuilt.includes(`§${number}§`),
                    "rebuild renders only committed answers",
                );
        },
    },
    {
        name: "A6.module-ahead-descent",
        async run(f) {
            const base = message("base");
            await f.pass([base]);
            const lineage = f.stored()!.state.lineage_id;
            f.db.exec(
                "CREATE TEMP TRIGGER kill_append BEFORE INSERT ON host_runner_entries BEGIN SELECT RAISE(ABORT,'host stopped before durable append'); END",
            );
            await assert.rejects(f.pass([base, message("X"), message("Y")]), /cannot safely serve/);
            f.db.exec("DROP TRIGGER kill_append");
            await f.restartHost();
            const out = await f.pass([base, message("Z"), message("X"), message("Y")]);
            assert.notEqual(
                f.stored()!.state.lineage_id,
                lineage,
                "ordinal conflict descends through committed prefix",
            );
            assert.deepEqual(
                out.filter((m) => m.info.id).map((m) => m.info.id),
                ["base", "Z", "X", "Y"],
            );
            const rehook = f.wires.filter(
                (w) => w.method === "transform.hook" && w.params.descends_from,
            );
            assert.ok(rehook.length > 0);
            assert.ok(
                rehook.every((w) => w.params.served_through_ordinal <= 1),
                "no module-ahead answer confirmed",
            );
            f.deps.historyRefreshSessions.add("session");
            await f.pass([base, message("Z"), message("X"), message("Y")]);
            const pendingAncestor = await f.sql(
                `SELECT COUNT(*) FROM mc_provider_hook_answers_v1 WHERE lineage_id='${lineage}' AND state='live'`,
            );
            assert.equal(pendingAncestor[0][0], 0, "stranded ancestor answers never live");
        },
    },
    {
        name: "A6.rebuild-commit-order",
        async run(f) {
            const raw = [message("base")];
            await f.pass(raw);
            raw.push(message("tail"));
            await f.pass(raw);
            const held = f.stored()!.views[0].replacement_json;
            await f.event("publish", { start: 1, end: 1, mid: "base" });
            f.db.exec(
                "CREATE TEMP TRIGGER kill_view BEFORE INSERT ON host_runner_views BEGIN SELECT RAISE(ABORT,'host stopped before view commit'); END",
            );
            f.deps.historyRefreshSessions.add("session");
            await assert.rejects(f.pass(raw), /cannot safely serve/);
            assert.equal(
                f.stored()!.views[0].replacement_json,
                held,
                "unrecorded answer never served",
            );
            assert.ok(f.stored()!.state.issued_request_id, "request fence already durable");
            f.db.exec("DROP TRIGGER kill_view");
            await f.restartHost();
            f.setUnavailable(true);
            const replayed = await f.pass(raw);
            assert.ok(
                replayed.some((m) => m.info.id === "tail"),
                "committed entries survive failed view commit",
            );
            f.setUnavailable(false);
            f.deps.historyRefreshSessions.add("session");
            await f.pass(raw);
        },
    },
    {
        name: "A7.single-bust",
        async run(f) {
            const raw = [message("base")];
            await f.pass(raw);
            raw.push(message("next"));
            await f.pass(raw);
            const count = f.wires.filter((w) => w.method === "compaction.step").length;
            await f.event("publish", { start: 1, end: 1, mid: "base" });
            f.deps.historyRefreshSessions.add("session");
            await f.pass(raw);
            assert.equal(
                f.wires.filter((w) => w.method === "compaction.step").length,
                count + 1,
                "one opportunity call per pass",
            );
            assert.equal(f.stored()!.views.length, 2, "only one new applied view");
            const a = f.answers.at(-1);
            assert.equal(a.answer, "compaction_message");
            await f.pass(raw);
            assert.equal(
                f.wires.filter((w) => w.method === "compaction.step").length,
                count + 1,
                "no ordinary bust",
            );
        },
    },
    {
        name: "A7.exhaustive-fast-path",
        async run(f) {
            for (const test of [
                "fast_path_exhaustive_six_input_table_never_skips_an_opportunity",
                "fast_path_never_skips_any_engine_hard_or_soft_classifier_trigger",
            ])
                f.rustControl(`providers::compaction::host_tests::${test}`);
        },
    },
    {
        name: "A9.partial-timeout-status",
        async run(f) {
            const raw = [message("base")];
            await f.pass(raw);
            f.setIntercept((w) => {
                if (w.method === "transform.hook" && w.params.hook === "post_tool")
                    throw new Error("Injected timeout after module commit");
            });
            const m = tools("partial");
            raw.push(m);
            const served = await f.pass(raw);
            assert.equal(
                JSON.stringify(served.find((m) => m.info.id === "partial")),
                JSON.stringify(m),
                "whole message freezes raw",
            );
            assert.equal(f.stored()!.entries[0].ingested, 0);
            f.setIntercept();
            raw.push(message("next"));
            await f.pass(raw);
            assert.deepEqual(
                JSON.parse(f.stored()!.state.unserved_json),
                [],
                "answered call clears burns",
            );
            const live = await f.sql(
                "SELECT COUNT(*) FROM mc_provider_hook_answers_v1 WHERE subject_mid='partial' AND state='live'",
            );
            assert.equal(live[0][0], 0, "no partially served answer becomes live");
            f.deps.historyRefreshSessions.add("session");
            await f.pass(raw);
            const status = f.wires.filter((w) => w.method === "compaction.step").at(-1)!;
            assert.deepEqual(
                status.params.messages.map((m: any) => m.mid),
                ["partial"],
                "only timed-out message in status",
            );
        },
    },
    {
        name: "A9.repeated-call-id-subjects",
        async run(f) {
            await f.pass([message("base")]);
            f.db.exec(
                "CREATE TEMP TRIGGER kill_append BEFORE INSERT ON host_runner_entries BEGIN SELECT RAISE(ABORT,'host stopped before durable append'); END",
            );
            await assert.rejects(
                f.pass([message("base"), tools("same-call", true)]),
                /cannot safely serve/,
            );
            f.db.exec("DROP TRIGGER kill_append");
            const hooks = f.wires.filter(
                (w) => w.method === "transform.hook" && w.params.hook === "post_tool",
            );
            assert.equal(hooks.length, 2);
            assert.equal(hooks[0].params.tool_call_id, hooks[1].params.tool_call_id);
            assert.notEqual(hooks[0].params.subject_part, hooks[1].params.subject_part);
            const firstTags = JSON.parse(
                (
                    await f.sql(
                        "SELECT tags_json FROM mc_provider_hook_answers_v1 WHERE subject_part='same-call-tool-1'",
                    )
                )[0][0],
            );
            const secondTags = (
                await f.sql(
                    "SELECT tags_json FROM mc_provider_hook_answers_v1 WHERE subject_part='same-call-tool-2'",
                )
            )[0][0];
            await f.call({ ...hooks[0], params: { ...hooks[0].params, request_id: "repeat-one" } });
            const afterSecond = (
                await f.sql(
                    "SELECT tags_json FROM mc_provider_hook_answers_v1 WHERE subject_part='same-call-tool-2' AND state='pending'",
                )
            )[0][0];
            assert.equal(
                afterSecond,
                secondTags,
                "retrying one part does not burn the sibling with the same callID",
            );
            const afterFirst = JSON.parse(
                (
                    await f.sql(
                        "SELECT tags_json FROM mc_provider_hook_answers_v1 WHERE subject_part='same-call-tool-1' AND state='pending'",
                    )
                )[0][0],
            );
            assert.notDeepEqual(
                afterFirst,
                firstTags,
                "retry mints a new answer for only that subject",
            );
            assert.equal(
                (
                    await f.sql(
                        "SELECT COUNT(*) FROM mc_provider_hook_answers_v1 WHERE subject_part='same-call-tool-1' AND state='burned'",
                    )
                )[0][0],
                1,
            );
        },
    },
    {
        name: "A9.identical-users-status-frontier",
        async run(f) {
            const raw = [message("base")];
            await f.pass(raw);
            raw.push(message("user1", "user", "continue"), message("user2", "user", "continue"));
            await f.pass(raw);
            const tags = await f.sql(
                "SELECT subject_mid,tags_json FROM mc_provider_hook_answers_v1 WHERE hook='pre_user' ORDER BY subject_mid",
            );
            assert.deepEqual(
                tags.map(([id]: any[]) => id),
                ["user1", "user2"],
            );
            assert.notEqual(
                tags[0][1],
                tags[1][1],
                "identical text retains distinct subject answers",
            );
            f.deps.historyRefreshSessions.add("session");
            await f.pass(raw);
            const status = f.wires.filter((w) => w.method === "compaction.step").at(-1)!.params;
            assert.deepEqual(status.messages, []);
            assert.equal(
                status.after_ordinal,
                status.newest.ordinal,
                "all answered hooks move frontier to newest",
            );
        },
    },
    {
        name: "A10.gap-resend-and-exit",
        async run(f) {
            const raw = [message("base")];
            await f.pass(raw);
            raw.push(message("a"), message("b"));
            await f.pass(raw);
            await f.sql("DELETE FROM mc_provider_messages_v1 WHERE ordinal=2", true);
            f.deps.historyRefreshSessions.add("session");
            const first = await f.pass(raw);
            assert.deepEqual(bytes(first), f.recorded.at(-2), "gap keeps last view and raw tail");
            assert.ok(
                f.stored()!.entries.every((e) => e.ingested === 0),
                "even first window ordinal is re-marked for resend",
            );
            f.setIntercept((w) =>
                w.method === "compaction.step"
                    ? {
                          answer: "refuse",
                          request_id: w.params.request_id,
                          code: "history_unreadable",
                          reason: "injected repeated gap",
                          detail: { history_gap_from: 2 },
                      }
                    : undefined,
            );
            await f.pass(raw);
            const step = f.wires.filter((w) => w.method === "compaction.step").at(-1)!;
            assert.deepEqual(
                step.params.messages.map((m: any) => m.mid),
                ["a", "b"],
                "retry carries ingest from gap, not known cursor assertion",
            );
            assert.equal(
                JSON.parse(f.stored()!.state.pipeline_exit_json!).reason,
                "provider_history_lost",
            );
            const calls = f.wires.length;
            await f.pass(raw);
            assert.equal(f.wires.length, calls, "second identical gap terminates resync");
        },
    },
    {
        name: "A10.encoded-hook-budget",
        async run(f) {
            const raw = [message("base")];
            await f.pass(raw);
            const large = message("large", "user", '漢"\\\n'.repeat(250000));
            const out = await f.pass([...raw, large]);
            assert.equal(
                f.wires.filter((w) => w.method === "transform.hook").length,
                0,
                "duplicated blocks exceed encoded 3 MiB so hook is never sent",
            );
            assert.equal(
                JSON.stringify(out.at(-1)),
                JSON.stringify(large),
                "hook-budget overflow freezes raw",
            );
            assert.equal(f.stored()!.entries[0].ingested, 0);
            f.deps.historyRefreshSessions.add("session");
            await f.pass([...raw, large]);
            const status = f.wires.filter((w) => w.method === "compaction.step").at(-1)!;
            assert.equal(status.params.messages.length, 1);
            assert.ok(
                Buffer.byteLength(JSON.stringify(status)) <= 3 * 1024 * 1024,
                "encoded status fits, including envelope and non-ASCII text",
            );
        },
    },
    {
        name: "A10.nonretryable-setup",
        async run(f) {
            f.setIntercept((w) =>
                w.method === "compaction.setup"
                    ? {
                          answer: "refuse",
                          request_id: w.params.request_id,
                          code: "misconfigured",
                          reason: "injected nonretryable Setup",
                      }
                    : undefined,
            );
            for (let i = 0; i < 10; i++) await f.pass([message("base")]);
            assert.equal(f.wires.filter((w) => w.method === "compaction.setup").length, 1);
            assert.equal(f.adapter.isProviderSession("session"), false);
            assert.equal(
                f
                    .logs()
                    .filter((line) => line.includes("bootstrap") && line.includes("misconfigured"))
                    .length,
                1,
                "nonretryable refusal logged once",
            );
        },
    },
    {
        name: "A10.bootstrap-declines-and-recovers",
        async run(f) {
            const raw = [message("a"), message("unpersisted-b"), message("c")];
            const first = await f.pass(raw);
            assert.ok(
                first.some((m) => m.info.id === "unpersisted-b"),
                "no unresolved message lost",
            );
            assert.equal(f.wires.length, 0, "no Setup or namespace change");
            assert.equal(f.adapter.bootstrapDeclines(), 1);
            raw[1] = message("b");
            await f.pass(raw);
            assert.equal(f.wires.filter((w) => w.method === "compaction.setup").length, 1);
            assert.equal(f.adapter.isProviderSession("session"), true);
        },
    },
    {
        name: "A10.paged-7500-bootstrap-restart",
        async run(f) {
            // Native metadata contributes to encoded page size without inventing a
            // multi-million-token model context. The codec must retain it verbatim.
            const raw = Array.from({ length: 7500 }, (_, i) => {
                const m = message(`bootstrap-${i}`);
                (m.info as any).fixture_opaque_payload = 'escaped " café 🦀 '.repeat(16);
                return canonical(m);
            });
            const usage = { current_total_input_tokens: 0, context_limit_tokens: 4000000 };
            const geometry = {
                usable_soft: 3600000,
                usable_hard: 3800000,
                absolute_wall: 4000000,
                derivation: "bootstrap-fixture",
            };
            updateSessionMeta(f.db, "session", { lastUsageContextLimit: 4000000 });
            for (let i = 0; i < 2; i++) {
                assert.deepEqual(
                    bytes(await f.full(raw, undefined, { usage, geometry })),
                    bytes(await f.old(raw, { usage, geometry })),
                );
            }
            let pages = 0;
            f.setIntercept((w) => {
                if (w.method === "compaction.step" && ++pages === 2)
                    throw new Error("Injected bootstrap page timeout after commit");
            });
            await f.pass(raw);
            assert.ok(f.stored()!.state.bootstrap_cursor! > 0, "answered first page checkpointed");
            assert.equal(
                f.adapter.isProviderSession("session"),
                false,
                "no unrecorded page view served",
            );
            f.setIntercept();
            f.advance(2000);
            await f.restartHost();
            const out = await f.pass(raw);
            decodeProviderAnswer("compaction.step", f.answers.at(-1));
            assert.equal(
                f.adapter.isProviderSession("session"),
                true,
                JSON.stringify({
                    times: f.callTimes,
                    logs: f.logs().slice(-6),
                    replies: f.answers.map((a) => ({
                        answer: a.answer,
                        code: a.code,
                        request_id: a.request_id,
                    })),
                    cursor: f.stored()!.state.bootstrap_cursor,
                    not_applied: f.stored()!.state.last_not_applied_json,
                }),
            );
            assert.deepEqual(
                bytes(out),
                bytes(await f.old(raw, { usage, geometry })),
                "resumed SOFT+ switch keeps engine tag numbers",
            );
            const requests = f.wires.filter((w) => w.method === "compaction.step");
            assert.ok(requests.length >= 3, "several status pages and a retry");
            assert.equal(
                new Set(requests.map((w) => w.params.request_id)).size,
                requests.length,
                "fresh request fence after restart",
            );
            assert.ok(
                requests.every((w) => Buffer.byteLength(JSON.stringify(w)) <= 3 * 1024 * 1024),
            );
            assert.equal(
                (await f.sql("SELECT COUNT(*) FROM mc_provider_messages_v1"))[0][0],
                7500,
                "ingest once across page retry",
            );
            console.log(
                `BOOTSTRAP_MEASUREMENT ${JSON.stringify({ host: f.host, messages: 7500, budget_ms: OPENCODE_PROVIDER_BOOTSTRAP_BUDGET_MS, max_page_ms: Math.max(...f.callTimes.filter((t) => t.method === "compaction.step").map((t) => t.ms)), pages: requests.length })}`,
            );
        },
    },
    {
        name: "A10.bootstrap-17000-measurement",
        async run(f) {
            const raw = Array.from({ length: 17000 }, (_, i) => {
                const m = message(`large-${i}`);
                (m.info as any).fixture_opaque_payload = 'escaped " café 🦀 '.repeat(16);
                return canonical(m);
            });
            updateSessionMeta(f.db, "session", { lastUsageContextLimit: 4000000 });
            for (let i = 0; i < 2; i++) await f.full(raw);
            const expected = await f.full(raw);
            const started = performance.now();
            const out = await f.pass(raw);
            const elapsed = Math.round(performance.now() - started);
            assert.equal(f.adapter.isProviderSession("session"), true);
            assert.deepEqual(bytes(out), bytes(expected));
            assert.equal(
                (await f.sql("SELECT COUNT(*) FROM mc_provider_messages_v1"))[0][0],
                17000,
            );
            console.log(
                `BOOTSTRAP_MEASUREMENT ${JSON.stringify({ host: f.host, messages: 17000, budget_ms: OPENCODE_PROVIDER_BOOTSTRAP_BUDGET_MS, total_ms: elapsed, max_page_ms: Math.max(...f.callTimes.filter((t) => t.method === "compaction.step").map((t) => t.ms)), pages: f.wires.filter((w) => w.method === "compaction.step").length })}`,
            );
        },
    },
    {
        name: "A10.bootstrap-timeout-full-request-late-retry",
        async run(f) {
            const raw = [message("base")];
            await f.full(raw);
            await f.full(raw);
            await f.old(raw);
            await f.old(raw);
            const expected = bytes(await f.old(raw));
            let late: Promise<unknown> | undefined;
            let delayed = false;
            f.setIntercept((w, reply) => {
                if (w.method === "compaction.step" && !delayed) {
                    delayed = true;
                    // Delay a committed real answer past the production bootstrap
                    // deadline. The original reply still arrives; it must be ignored.
                    late = new Promise((resolve) => setTimeout(() => resolve(reply), 30050));
                    return late;
                }
            });
            const out = await f.pass(raw);
            assert.deepEqual(
                bytes(out),
                expected,
                "timed-out bootstrap serves only the full-request result",
            );
            assert.equal(
                f.fallbacks.length,
                1,
                "bootstrap timeout uses the managed full-request path",
            );
            assert.equal(f.adapter.isProviderSession("session"), false);
            assert.equal(f.stored()!.views.length, 0, "no unrecorded late view served");
            await late;
            assert.deepEqual(
                f.recorded.at(-1),
                expected,
                "late receipt cannot replace already-served bytes",
            );
            assert.equal(f.stored()!.views.length, 0);
            f.setIntercept();
            f.advance(2000);
            await f.restartHost();
            assert.deepEqual(bytes(await f.pass(raw)), expected);
            assert.equal(f.adapter.isProviderSession("session"), true);
            const ids = f.wires
                .filter((w) => w.method === "compaction.step")
                .map((w) => w.params.request_id);
            assert.equal(new Set(ids).size, ids.length);
        },
    },
    {
        name: "A11.foreign-history-sticky-exit",
        async run(f) {
            await f.pass([message("base")]);
            const raw = [message("foreign")];
            await f.pass(raw);
            const state = f.stored()!.state;
            assert.equal(JSON.parse(state.pipeline_exit_json!).reason, "provider_foreign_history");
            const calls = f.wires.length;
            await f.restartHost();
            await f.pass(raw);
            assert.equal(f.wires.length, calls, "durable exit cannot rebootstrap silently");
            assert.equal(f.adapter.isProviderSession("session"), false);
            assert.equal(f.fallbacks.length, 2);
            assert.equal(
                f.logs().filter((line) => line.includes("exit provider_foreign_history")).length,
                1,
            );
        },
    },
    {
        name: "A11.process-wide-rollback",
        async run(f) {
            const raw = [message("base")];
            await f.full(raw);
            await f.full(raw);
            await f.pass(raw);
            raw.push(message("tail"));
            const before = await f.pass(raw);
            f.deps.rustPipeline = "full_request";
            assert.deepEqual(
                bytes(await f.pass(raw)),
                bytes(before),
                "zero-divergence rollback has no prefix rebuild",
            );
            assert.equal(f.fallbacks[0], undefined, "canonical namespace stays in place");
            const calls = f.wires.length;
            await f.pass(raw);
            assert.equal(f.wires.length, calls);
        },
    },
    {
        name: "A11.compaction-off-routing",
        async run(f) {
            const config = MagicContextConfigSchema.parse({
                transform_mode: "rust",
                rust_pipeline: "provider",
                compaction: { enabled: false },
            });
            assert.equal(
                resolveTransformMode({
                    configured: config.transform_mode,
                    userTierHasSubc: true,
                    compactionEnabled: false,
                }).mode,
                "ts",
            );
            const transform = createTransform({
                ...f.deps,
                compactionOff: true,
                historianRunnable: false,
            });
            try {
                await transform({}, { messages: [message("off")] });
            } finally {
                transform.disposeRust();
            }
            assert.equal(f.wires.filter((w) => w.method === "compaction.setup").length, 0);
        },
    },
    {
        name: "A11.ambiguous-revert-and-diverged-rollback",
        async run(f) {
            const raw = [message("A"), message("B"), message("C")];
            await f.pass(raw.slice(0, 1));
            await f.pass(raw);
            await f.pass([raw[0], message("X"), raw[1], raw[2]]);
            const exitPass = await f.pass([raw[0], message("X"), raw[1]]);
            assert.ok(
                !exitPass.some((m) => m.info.id === "C"),
                "exit pipeline never serves reverted C",
            );
            const exit = JSON.parse(f.stored()!.state.pipeline_exit_json!);
            assert.equal(exit.reason, "provider_revert_ambiguous");
            assert.equal(exit.reseed_full_request, true);
            assert.ok(
                f.fallbacks[0]?.includes(":full-request:"),
                "race ordinals reseed into a fresh full namespace",
            );
            const before = bytes(exitPass);
            const next = await f.pass([raw[0], message("X"), raw[1]]);
            assert.deepEqual(bytes(next), before, "reseed then stable full-request replay");
            assert.equal(new Set(f.fallbacks).size, 1, "namespace is not reseeded again");
            assert.equal(
                f.logs().filter((line) => line.includes("exit provider_revert_ambiguous")).length,
                1,
            );
        },
    },
    {
        name: "A11.record-lost",
        async run(f) {
            const raw = [message("base")];
            await f.pass(raw);
            f.deps.historyRefreshSessions.add("session");
            await f.pass(raw);
            for (const table of [
                "host_runner_entries",
                "host_runner_ids",
                "host_runner_views",
                "host_runner_state",
            ])
                f.db.exec(`DELETE FROM ${table}`);
            await f.restartHost();
            await f.pass(raw);
            assert.equal(
                JSON.parse(f.stored()!.state.pipeline_exit_json!).reason,
                "provider_record_lost",
            );
            const calls = f.wires.length;
            await f.pass(raw);
            assert.equal(f.wires.length, calls, "lost-record exit never loops bootstrap");
        },
    },
    {
        name: "A11.store-ahead-turn-refusal",
        async run(f) {
            const raw = [message("base")];
            await f.pass(raw);
            for (const method of ["transform.hook", "compaction.step"]) {
                f.setIntercept((w) => {
                    if (w.method === method)
                        throw new StoreAheadOfBinaryError({ dbVersion: 999, binaryMax: 66 });
                });
                if (method === "transform.hook") raw.push(message("next"));
                else f.deps.historyRefreshSessions.add("session");
                const served = f.recorded.length;
                await assert.rejects(f.pass(raw), /MC-C13/);
                assert.equal(f.recorded.length, served, "no model request reaches fake provider");
                assert.equal(
                    f.stored()!.state.pipeline_exit_json,
                    null,
                    "store-ahead is neither parked nor exited",
                );
                f.setIntercept();
                await f.restartHost();
                await f.pass(raw);
            }
        },
    },
    {
        name: "A11.oversize-exits-once",
        async run(f) {
            await f.pass([message("base")]);
            const raw = [message("base"), message("oversize", "user", '漢"\\\n'.repeat(550000))];
            // Full-request recovery may itself refuse the absolute wall; the provider
            // exit must already be durable either way, before any attempted serving.
            try {
                await f.pass(raw);
            } catch (error) {
                assert.match(String(error), /full-request|safely serve/);
            }
            assert.equal(
                JSON.parse(f.stored()!.state.pipeline_exit_json!).reason,
                "provider_message_too_large",
            );
            const calls = f.wires.length;
            try {
                await f.pass(raw);
            } catch (error) {
                assert.match(String(error), /full-request|safely serve/);
            }
            assert.equal(f.wires.length, calls);
            assert.equal(
                f.logs().filter((line) => line.includes("exit provider_message_too_large")).length,
                1,
            );
        },
    },
    {
        name: "A1.declared-prefix-events",
        async run(f) {
            await f.pass([message("base")]);
            const raw = [message("base"), message("tail")];
            await f.pass(raw);
            f.db.exec("UPDATE host_runner_entries SET op_version=999");
            await f.restartHost();
            await f.pass(raw);
            assert.equal(
                f
                    .logs()
                    .filter(
                        (line) =>
                            line.includes("host-side prefix event") &&
                            line.includes("unknown_op_version"),
                    ).length,
                1,
            );
            const idless = message("idless");
            delete idless.info.id;
            await f.pass([...raw, idless]);
            assert.ok(f.logs().some((line) => line.includes("host-side prefix event idless")));
            const pending = tools("pending");
            (pending.parts[1] as any).state.status = "running";
            await f.pass([...raw, pending]);
            assert.ok(
                f.logs().some((line) => line.includes("host-side prefix event non_terminal")),
            );
        },
    },
];

export async function runProviderPipelineDifferential(selected: string[] = []) {
    const work = join(ROOT, "target/provider-pipeline-driver");
    mkdirSync(join(work, "stores"), { recursive: true });
    let driver: Driver | undefined;
    let checks = 0;
    const failures: { name: string; error: string }[] = [];
    try {
        console.log(
            `Bun ${Bun.version}; ${spawnSync("cargo", ["--version"], { encoding: "utf8" }).stdout.trim()}`,
        );
        setLogLineForwarder((line) => logLines.push(line));
        driver = new Driver(buildDriver(work), join(work, "stores"));
        const names = ["OpenCode1", "OpenCode2"].flatMap((host) =>
            cases.map((c) => `${host}/${c.name}`),
        );
        for (const name of selected) assert.ok(names.includes(name), `unknown case ${name}`);
        for (const host of ["OpenCode1", "OpenCode2"] as const) {
            for (const c of cases) {
                const name = `${host}/${c.name}`;
                if (selected.length && !selected.includes(name)) continue;
                const f = await fixture(
                    driver,
                    host,
                    undefined,
                    c.name === "A3.model-switch-protected-newest-tool-queue",
                );
                try {
                    await c.run(f);
                    await f.noReads();
                    checks++;
                    console.log(`PASS ${name}`);
                } catch (error) {
                    const text = (
                        error instanceof Error ? (error.stack ?? error.message) : String(error)
                    ).slice(0, 8000);
                    failures.push({ name, error: text });
                    console.error(`FAIL ${name}\n${text}`);
                } finally {
                    await f.close();
                }
            }
        }
        assert.ok(checks + failures.length > 0, "non-empty corpus");
        console.log(
            `PROVIDER_PIPELINE_RESULT=${JSON.stringify({ checks, failures, declaredDifferences })}`,
        );
        if (failures.length)
            throw new Error(
                `${failures.length} provider pipeline checks failed: ${failures.map((f) => f.name).join(", ")}`,
            );
        return { checks, declaredDifferences };
    } finally {
        if (driver) await driver.close();
        setLogLineForwarder(null);
    }
}

if (import.meta.main) {
    const selected = Bun.argv.flatMap((arg, i) => (arg === "--case" ? [Bun.argv[i + 1]!] : []));
    await runProviderPipelineDifferential(selected);
}
