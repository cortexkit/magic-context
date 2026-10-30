import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

// Set both discovery roots before importing the loader: no fixture may read the operator's config.
const worker = process.argv.indexOf("--worker");
const root = process.env.MC_CONFIG_GOLDEN_ROOT ?? mkdtempSync(join(tmpdir(), "mc-config-golden-"));
if (worker < 0) process.env.HOME = join(root, "home");
if (worker < 0) process.env.XDG_CONFIG_HOME = join(root, "xdg");
process.env.XDG_DATA_HOME = join(root, "data");
process.env.XDG_CACHE_HOME = join(root, "cache");
delete process.env.MAGIC_CONTEXT_CONFIG_PATH;
const sourceDir = join(import.meta.dir, "../../../../packages/plugin/src");
const loaderDir = join(root, worker < 0 ? "loader-main" : `loader-${process.argv[worker + 1]}`, "src");
mkdirSync(join(loaderDir, "config"), { recursive: true });
for (const entry of readdirSync(sourceDir)) if (entry !== "config") symlinkSync(join(sourceDir, entry), join(loaderDir, entry));
for (const entry of readdirSync(join(sourceDir, "config"))) if (entry !== "index.ts") symlinkSync(join(sourceDir, "config", entry), join(loaderDir, "config", entry));
symlinkSync(join(import.meta.dir, "../../../../node_modules"), join(loaderDir, "../node_modules"));
// Use the integrated loader unchanged; config-path overrides are already implemented there.
symlinkSync(join(sourceDir, "config/index.ts"), join(loaderDir, "config/index.ts"));
const { loadPluginConfigDetailed } = await import(join(loaderDir, "config/index.ts"));
const { MagicContextConfigSchema, ConfigProfilesSchema } = await import("../../../../packages/plugin/src/config/schema/magic-context");
const { getMagicContextBuiltinCommands } = await import("../../../../packages/plugin/src/shared/builtin-commands");
const { isValidLanguageCode } = await import("../../../../packages/plugin/src/agents/language-directive");
const directory = import.meta.dir;
const write = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };

function describe(schema: any, path = ""): any {
    const d = schema._zod.def;
    const result: any = { type: d.type };
    if (schema.meta()?.["x-mc-user-only"]) result.userOnly = true;
    if (d.type === "pipe") {
        const inner = describe(d.in, path);
        if (path === "embedding" || path === "protected_tools" || path === "subc.connection_file" || path === "rerank.timeout_ms") return { type: "transform", rule: path, inner };
        if (!path) return inner;
        throw new Error(`Unregistered schema transform: ${path}`);
    }
    if (["optional", "default", "prefault", "nullable"].includes(d.type)) {
        result.inner = describe(d.innerType, path);
        if (d.type === "default" || d.type === "prefault") result.value = d.defaultValue;
    }
    if (d.type === "object") {
        result.shape = Object.fromEntries(Object.entries(d.shape).map(([k, v]) => [k, describe(v, path ? `${path}.${k}` : k)]));
        if (d.catchall) result.catchall = describe(d.catchall, `${path}.*`);
    }
    if (d.type === "array") result.element = describe(d.element, `${path}[]`);
    if (d.type === "record") { result.key = describe(d.keyType, `${path}#key`); result.value = describe(d.valueType, `${path}.*`); }
    if (d.type === "union") result.options = d.options.map((option: any) => describe(option, path));
    if (d.type === "enum") result.values = Object.values(d.entries);
    if (d.type === "literal") result.values = d.values;
    if (d.checks?.length) result.checks = d.checks.map((c: any) => {
        const check = c._zod.def;
        if (check.check === "overwrite") {
            const text = String(check.tx);
            if (text.includes("trim")) return { check: "trim" };
            if (text.includes("toLowerCase")) return { check: "lowercase" };
            throw new Error(`Unregistered overwrite: ${path}`);
        }
        if (check.check === "custom") return { check: "custom", rule: path };
        return Object.fromEntries(Object.entries(check).filter(([k, v]) => !["when", "fn", "error"].includes(k) && typeof v !== "function").map(([k, v]) => [k, v instanceof RegExp ? v.source : v]));
    });
    return result;
}

function warningCode(message: string): string {
    if (message.includes("recovered values were applied") || message.includes("using defaults for this file")) return "file_parse";
    if (message.includes("failed to read config")) return "file_io";
    if (message.includes("config migration completes")) return "legacy_unmigrated";
    if (message.includes("reading legacy config")) return "legacy_read";
    if (message.includes("MAGIC_CONTEXT_CONFIG_PATH")) return "config_path_missing";
    if (message.includes("Project-level config no longer supports")) return "project_substitution";
    if (message.includes("Environment variable")) return "env_missing";
    if (message.includes("File not found for")) return "file_missing";
    if (message.includes("Failed to read file for")) return "file_read";
    if (message.includes("sensitive path")) return "file_sensitive";
    if (message.includes("unsafe config key")) return "unsafe_key";
    if (message.includes("Ignoring invalid profile selection")) return "profile_selection";
    if (message.includes("Ignoring profiles from user")) return "profile_invalid";
    if (message.includes("Unknown profile")) return "profile_unknown";
    if (message.includes("Ignoring invalid") && message.includes("keeping the user-level")) return "project_invalid";
    if (message.includes("command") && message.includes("project")) return "project_command";
    if (message.includes("Ignoring") && message.includes("from project config")) return "project_policy";
    if (message.includes("invalid nested") || message.includes("invalid value") || message.includes("invalid agent") || message.includes("protected_tokens") && message.includes("token count")) return "invalid_leaf";
    if (message.includes("recovery failed")) return "recovery_failed";
    if (message.includes("transform_mode") || message.includes("compaction.enabled=false") || message.includes("rust mode requires") || message.includes("rust transform mode")) return "transform_mode";
    if (message.includes("Ignoring flat") || message.includes("conflicts with")) return "flat_conflict";
    if (message.includes("deprecated") || message.includes("Deprecated") || message.includes("Migrated") || message.includes("Removed invalid") || message.includes("configuration was removed")) return "deprecated";
    if (message.includes("model") && message.includes("harness")) return "misplaced_model";
    throw new Error(`Unclassified warning: ${message}`);
}

type Fixture = { name: string; user?: unknown; project?: unknown; userText?: string; projectText?: string; env?: Record<string,string>; files?: Record<string,string>; override?: string; missing?: boolean; userJson?: unknown; legacyUser?: unknown; legacyProject?: unknown; bareProject?: unknown; otherUser?: unknown; otherProject?: unknown };
const fixtures: Fixture[] = [
    { name: "defaults" },
    ...[undefined, -1, 50, 1500, 15000, 99999].map((timeout_ms, i) => ({ name: `rerank-timeout-${i}`, user: { rerank: { timeout_ms } } })),
    { name: "rerank-timeout-integer-float", userText: '{"rerank":{"timeout_ms":100.0}}' },
    { name: "rerank-timeout-invalid", user: { rerank: { timeout_ms: "bad" } } },
    { name: "rerank-timeout-remote", user: { rerank: { provider: "remote", endpoint: "https://example.invalid/rerank", model: "reranker", timeout_ms: 99999 } } },
    { name: "rerank-remote-incomplete", user: { rerank: { provider: "remote", timeout_ms: 100 } } },
    { name: "historian-turn-two-default", user: { historian: {} } },
    { name: "historian-turn-two-on", user: { historian: { turn_two: "on", two_pass: true } } },
    { name: "historian-turn-two-off", user: { historian: { turn_two: "off", two_pass: false } } },
    ...[false, "Off", "none", 1].map((turn_two, index) => ({ name: `historian-turn-two-invalid-${index}`, user: { historian: { turn_two, two_pass: true, opencode: { model: "provider/historian" } } } })),
    { name: "user-only", user: { cache_ttl: "17m", language: " TR ", enabled: false, memory: { injection_budget_tokens: 7000, auto_search: { enabled: false } }, historian: { opencode: { model: { model: "provider/model", variant: "fast" }, fallback_models: ["backup/model"] }, pi: { model: { model: "pi/model", thinking_level: "high" } }, omp: { model: "omp/model", thinking_level: "xhigh" }, broca: { model: { model: "broca/model", variant: "high" }, fallback_models: [{ model: "broca/fallback", variant: "medium" }], variant: "low" } } } },
    { name: "user-project", user: { cache_ttl: "17m", memory: { auto_search: { score_threshold: 0.7 } } }, project: { cache_ttl: "31m", memory: { enabled: false }, dreamer: { pi: { model: "pi/dreamer", tasks: { verify: { model: "pi/verify", thinking_level: "low" } } } } } },
    { name: "profile-project-selection", user: { profile: "cheap", profiles: { cheap: { historian: { pi: { model: "pi/cheap" } } }, work: { historian: { opencode: { model: "oc/work", variant: "medium" }, pi: { model: "pi/work", thinking_level: "high", fallback_models: ["pi/fallback"] }, omp: { model: "omp/work", thinking_level: "max" }, broca: { model: "broca/work", variant: "high", fallback_models: ["broca/work-fallback"] } }, dreamer: { pi: { model: "pi/dream" } } } }, historian: { timeout_minutes: 15 } }, project: { profile: "work" } },
    { name: "profile-user-selection", user: { profile: "cheap", profiles: { cheap: { historian: { pi: { model: "pi/cheap" } } } } } },
    { name: "profile-unknown", user: { profile: "missing" } },
    { name: "profile-invalid", user: { profile: "bad", profiles: { bad: { historian: { prompt: "injected" } } } } },
    { name: "profile-invalid-project-falls-back", user: { profile: "ok", profiles: { ok: { historian: { pi: { model: "pi/ok" } } } } }, project: { profile: " " } },
    { name: "env-user", user: { embedding: { provider: "openai-compatible", endpoint: "https://example.invalid/v1", model: "model", api_key: "{env: GOLDEN_SECRET }" } }, env: { GOLDEN_SECRET: "quoted\"\\\nsecret" } },
    { name: "file-user", user: { embedding: { provider: "openai-compatible", endpoint: "https://example.invalid", model: "model", api_key: "{file:./key.txt}" } }, files: { "key.txt": "  quoted\"\\\nsecret  " } },
    { name: "file-home-user", user: { embedding: { provider: "synapse", fallback_provider: "off", api_key: "{file:~/key.txt}" } }, files: { "~/key.txt": "home-secret" } },
    { name: "file-absolute-user", user: { embedding: { provider: "openai-compatible", endpoint: "https://example.invalid", model: "model", api_key: "{file:$ROOT/absolute.txt}" } }, files: { "$ROOT/absolute.txt": "absolute-secret" } },
    { name: "file-sensitive-user", user: { embedding: { provider: "synapse", fallback_provider: "off", api_key: "{file:~/.ssh/key}" } }, files: { "~/.ssh/key": "fake-fixture-key" } },
    { name: "env-missing", user: { language: "{env:GOLDEN_MISSING}" } },
    { name: "file-missing", user: { models: { window_overlay_path: "{file:absent.txt}" } } },
    { name: "project-env", user: { memory: { enabled: true } }, project: { dreamer: { pi: { model: "{env:GOLDEN_SECRET}" } } }, env: { GOLDEN_SECRET: "do-not-expand" } },
    { name: "project-file-escape", project: { dreamer: { pi: { model: "{file:../../escape.txt}" } }, prompt_surface: { guidance_override_path: "../../prompt" }, models: { window_overlay_path: "../../overlay" } }, files: { "$ROOT/escape.txt": "do-not-read" } },
    { name: "project-both-tokens", project: { embedding: { api_key: "{env:GOLDEN_SECRET}" }, dreamer: { pi: { model: "{file:~/key.txt}" } } }, files: { "~/key.txt": "do-not-read" }, env: { GOLDEN_SECRET: "do-not-expand" } },
    { name: "user-signed-thinking-on", user: { signed_thinking_hold: "on" } },
    { name: "project-user-only", user: { historian: { turn_two: "off" }, language: "en", compaction: { enabled: false }, embedding: { provider: "synapse", fallback_provider: "off" } }, project: { profiles: { hostile: {} }, language: "tr", auto_update: false, fail_closed_blocking: false, debug_rpc: true, signed_thinking_hold: "on", allow_home_project: true, output_reserve: 0, rust_pipeline: "provider", sqlite: { cache_size_mb: 2048 }, storage: { enforce_private_permissions: false }, compaction: { enabled: true }, smart_notes: { enabled: false }, pi: { subagent_extensions: ["evil"] }, subc: { connection_file: "../../daemon" }, shadow_embedding: { enabled: true }, embedding: { provider: "openai-compatible", endpoint: "https://evil.invalid", query_instruction: "evil", document_prefix: "evil", input_type: "evil", query_input_type: "evil" }, prompt_surface: { tool_descriptions: { ctx_search: "evil" }, guidance_override_path: "../../evil" }, historian: { turn_two: "on", runner: "evil", host_runner: "evil", opencode: { model: "evil", fallback_models: ["evil"], variant: "max" }, pi: { model: "evil", thinking_level: "high" }, omp: { model: "evil", thinking_level: "max" }, broca: { model: "evil", variant: "max", fallback_models: ["evil/fallback"] } }, dreamer: { runner: "evil" } } },
    { name: "project-hidden-agent-injection", project: { historian: { prompt: "evil", permission: { external_directory: "allow" }, tools: { bash: true }, pi: { system_prompt: "evil", model: { model: "evil", prompt: "evil" } } }, dreamer: { prompt: "evil", opencode: { model: { model: "oc/model", permission: { bash: "allow" }, tools: { bash: true } }, fallback_models: [{ model: "oc/backup", prompt: "evil" }], tasks: { verify: { prompt: "evil", model: { model: "oc/verify", system_prompt: "evil" } } } }, tasks: { verify: { system_prompt: "evil" } } } } },
    { name: "project-lower-thresholds", user: { execute_threshold_percentage: { default: 70, "p/m": 80 }, execute_threshold_tokens: { default: 20000, "p/m": 30000 }, protected_tokens: 12000 }, project: { execute_threshold_percentage: { default: 30, "p/m": 40, "p/new": 30 }, execute_threshold_tokens: { default: 5000, "p/m": 7000 }, protected_tokens: 4000 } },
    { name: "project-raise-thresholds", user: { execute_threshold_percentage: { default: 60, "p/m": 80 }, execute_threshold_tokens: { default: 20000 }, protected_tokens: 4000 }, project: { execute_threshold_percentage: 75, execute_threshold_tokens: { default: 30000, "p/m": 40000 }, protected_tokens: 9000 } },
    { name: "project-introduce-token-threshold", project: { execute_threshold_tokens: { default: 5000, "p/m": 10000 }, execute_threshold_percentage: 40 } },
    { name: "project-invalid-restores-user", user: { cache_ttl: "19m", memory: { injection_budget_tokens: 7000 } }, project: { cache_ttl: null, memory: { injection_budget_tokens: 1 } } },
    { name: "invalid-values", user: { enabled: "yes", language: "not-language", protected_tokens: 30, execute_threshold_percentage: 99, historian: null, memory: { enabled: false, injection_budget_tokens: 1, auto_search: { score_threshold: "bad" } } } },
    { name: "unknown-keys", user: { unknown: "ignored", memory: { unknown: "ignored" }, historian: { unknown: "ignored", pi: { model: "pi/model", unknown: "strict" } } } },
    { name: "unsafe-keys", userText: '{"__proto__":{"polluted":true},"memory":{"constructor":{},"enabled":false},"prototype":{}}' },
    { name: "jsonc-comments", userText: '\uFEFF{ // {env:GOLDEN_MISSING}\n"cache_ttl":"11m", /* {file:missing} */ "memory":{"enabled":false,},}' },
    { name: "jsonc-recovery", userText: '{"cache_ttl":"12m" "memory":{"enabled":false}}' },
    { name: "jsonc-invalid", projectText: '{ broken' },
    { name: "jsonc-wins-json", user: { cache_ttl: "14m" }, userJson: { cache_ttl: "99m" } },
    { name: "legacy-user", legacyUser: { cache_ttl: "23m" } },
    { name: "legacy-project", legacyProject: { cache_ttl: "29m" } },
    { name: "flat-model-migration", user: { historian: { model: "p/model", variant: "fast", fallback_models: ["p/fallback"] }, dreamer: { model: "p/dream", thinking_level: "high" } } },
    { name: "override-absolute", override: "$ROOT/selected.settings", user: { cache_ttl: "16m" }, project: { cache_ttl: "30m", language: "tr" } },
    { name: "override-missing", override: "$ROOT/missing.settings", missing: true },
    ...["relative.jsonc", "", "   "].map((override, i) => ({ name: `override-refused-${i}`, override })),
];

fixtures.push(
    { name: "env-property-not-flat-migrated", user: { historian: { "{env:GOLDEN_FIELD}": "p/model" } }, env: { GOLDEN_FIELD: "model" } },
    { name: "flat-model-env", user: { historian: { model: "{env:GOLDEN_MODEL}" } }, env: { GOLDEN_MODEL: "p/model" } },
    { name: "flat-model-discards-token-payload", user: { historian: { model: { model: "p/model", prompt: "{file:absent.txt}" } } } },
    { name: "flat-model-preserves-alias-order", userText: '{"historian":{"model":"p/model"},"protected_tools":{"bash":1,"MCP_BASH":9}}' },
    { name: "protected-tools-integer-order", userText: '{"protected_tools":{"MCP_2":7,"2":0}}' },
    { name: "override-file-origin", override: "$ROOT/selected/config.settings", user: { embedding: { provider: "synapse", fallback_provider: "off", api_key: "{file:key.txt}" } }, files: { "$ROOT/selected/key.txt": "override-origin-secret" } },
    { name: "invalid-numbers", userText: '{"execute_threshold_percentage":65e,"memory":{"injection_budget_tokens":4000.},"protected_tags":9007199254740993}' },
    { name: "unknown-token-recovery", projectText: '{garbage "cache_ttl": foo "9m","memory":{"enabled":false}}' },
    { name: "nested-missing-value", projectText: '{"memory":{"enabled":},"cache_ttl":"17m"}' },
    { name: "project-cr-comment", projectText: '{//comment\r"cache_ttl":"18m"}' },
    { name: "project-comment-token-boundary", projectText: '{"execute_threshold_percentage":6/*comment*/5}' },
    { name: "legacy-priority", legacyProject: { cache_ttl: "90m" }, bareProject: { cache_ttl: "24m" } },
    { name: "other-harness-legacy-user", otherUser: { cache_ttl: "90m" } },
    { name: "other-harness-legacy-project", otherProject: { cache_ttl: "90m" } },
    { name: "empty-config", userText: "" },
    { name: "unterminated-string", userText: '{"cache_ttl":"9m' },
    { name: "invalid-escape", userText: '{"cache_ttl":"9\\qm"}' },
    { name: "invalid-unicode-escape", userText: '{"cache_ttl":"9\\uQQQQm"}' },
    { name: "missing-value", projectText: '{"cache_ttl":,"memory":{"enabled":false}}' },
    { name: "missing-colon", projectText: '{"cache_ttl" "8m","memory":{"enabled":false}}' },
    { name: "project-unterminated-comment", projectText: '{"cache_ttl":"8m"} /*unterminated' },
    { name: "protected-tools-alias-order", userText: '{"protected_tools":{"bash":1,"MCP_BASH":9,"ctx_reduce":0}}' },
    { name: "protected-tools-invalid-alias", userText: '{"protected_tools":{"bash":1,"MCP_BASH":"invalid"}}' },
    { name: "invalid-dotted-model-key", user: { prompt_surface: { default: "light", models: { "p/gpt-5.6": "wrong", "p/valid": "light" } } } },
    { name: "decimal-integers", userText: '{"protected_tokens":8000.0,"protected_tools":{"bash":2.0},"execute_threshold_tokens":{"default":9000.0}}' },
    { name: "relative-xdg-ignored", user: { cache_ttl: "99m" }, env: { XDG_CONFIG_HOME: "relative-fixture-only" } },
    { name: "bridge-and-core-nondefaults", user: { auto_update: false, toast_duration_ms: 1234, pi: { subagent_extensions: [" ./fixture.ts "] }, todowrite: { enabled: true, overlay: false }, keep_subagents: true, disabled_hooks: ["event", 4], command: { mine: { template: "trusted command" } }, compaction: { enabled: false }, debug_rpc: true, fail_closed_blocking: false, allow_home_project: true, sqlite: { cache_size_mb: 128, mmap_size_mb: 32 }, storage: { enforce_private_permissions: false }, system_prompt_injection: { enabled: false, skip_signatures: ["own marker"] }, smart_notes: { retina_handoff: true }, commit_cluster_trigger: { enabled: false, min_clusters: 8 }, history_budget_percentage: 0.25, historian_timeout_ms: 900000, keep_reasoning_tokens: { default: 2500, "p/gpt-5.6": 1500 }, output_reserve: 12000, protected_tools: { MCP_BASH: 0 }, shadow_embedding: { enabled: true }, temporal_awareness: false } },
    { name: "transform-rust-with-user-subc", user: { transform_mode: "rust", rust_pipeline: "provider", subc: { connection_file: "~/daemon/connection.json" } } },
    { name: "transform-rust-without-subc", project: { transform_mode: "rust" } },
    { name: "transform-compaction-off", user: { transform_mode: "rust", compaction: { enabled: false }, subc: { connection_file: "$ROOT/connection.json" } } },
    { name: "embedding-off", user: { embedding: { provider: "off", model: "ignored", api_key: "ignored" } } },
    { name: "embedding-local", user: { embedding: { provider: "local", model: " custom ", local_dtype: "q4", local_runtime: "wasm", max_input_tokens: 1200 } } },
    { name: "embedding-missing-required", user: { embedding: { provider: "openai-compatible" }, memory: { enabled: false } } },
    { name: "template-valid", user: { historian: { expand_tools: { read: '${input.paths[*].path.join("\\n").truncate(200)}', edit: '${input.ops.each("${op}")}', bash: false }, disallowed_tools: ["read"], two_pass: true } } },
    { name: "template-invalid", user: { historian: { expand_tools: { bad: "${environment.secret}", okay: "${output}" } } } },
    { name: "cron-invalid", user: { dreamer: { tasks: { verify: { schedule: "@daily" }, curate: { schedule: "0 */6 * * 0-7", token_budget: 12000 } } } } },
    { name: "array-invalid", user: { cache_ttl: "21m", system_prompt_injection: { enabled: false, skip_signatures: ["safe", 5] } } },
    { name: "commands-project", user: { command: { mine: { template: "trusted" } }, disabled_hooks: ["a"] }, project: { disabled_hooks: ["a", "b"], command: { mine: { template: "hostile" }, "ctx-status": { template: "hostile" }, empty: { template: " " }, added: { template: "project", unknown: "ignored" } } } },
    { name: "commands-project-invalid-block", user: { command: { mine: { template: "trusted" } } }, project: { command: false } },
    { name: "project-primitive-user-only-block", user: { compaction: { enabled: false }, embedding: { provider: "off" }, storage: { enforce_private_permissions: false } }, project: { compaction: false, embedding: null, storage: false } },
    { name: "protected-tools-merge", user: { protected_tools: { MCP_BASH: 2, todowrite: 4 } }, project: { protected_tools: { bash: 0, MCP_CTX_REDUCE: 8 } } },
    { name: "prompt-key-invalid", user: { prompt_surface: { models: { "bad*": "light", "p/model/path": "light" }, tool_descriptions: { ctx_search: "custom description" } } } },
    { name: "unknown-agent-entry", user: { historian: { pi: { model: { model: "pi/model", unknown: true }, fallback_models: ["pi/fallback"] } } } },
    { name: "flat-conflict", user: { historian: { model: "p/old", opencode: { model: "p/new" } }, dreamer: { tasks: { verify: { model: "p/verify", timeout_minutes: 21 } } } } },
    { name: "project-token-comment", projectText: '{// {env:GOLDEN_SECRET}\n"cache_ttl":"22m"}' },
);
const deprecatedFixtures: Record<string, unknown>[] = [
    { protected_tags: 20 }, { clear_reasoning_age: 3 }, { smart_drops: false }, { mural: { model: "ignored" } }, { sidekick: { model: "ignored" } },
    { experimental: { temporal_awareness: false } }, { experimental: { caveman_text_compression: { enabled: true } } }, { experimental: { auto_search: { enabled: false } } }, { experimental: { git_commit_indexing: { enabled: true } } }, { experimental: { mural: true } }, { experimental: { user_memories: false } }, { experimental: { pin_key_files: true } },
    { dreamer: { enabled: false } }, { dreamer: { enabled: true } }, { historian: { enabled: false } },
    { dreamer: { schedule: "03:17-06:00" } }, { dreamer: { tasks: ["verify", "improve"] } }, { dreamer: { user_memories: { enabled: false, promotion_threshold: 7 } } }, { dreamer: { pin_key_files: { enabled: true } } }, { dreamer: { task_timeout_minutes: 25 } }, { dreamer: { max_runtime_minutes: 90 } },
    ...["maintain-memory", "consolidate", "archive-stale", "improve"].map(task => ({ dreamer: { tasks: { [task]: { schedule: "0 3 * * *" } } } })),
    { dreamer: { tasks: { verify: { schedule: "", broad_interval_days: 14 }, "key-files": {} } } },
];
fixtures.push(...deprecatedFixtures.map((user, i) => ({ name: `deprecated-${i}`, user })));

function normalize(value: any, caseRoot: string): any {
    if (typeof value === "string") return value.replaceAll(caseRoot, "$ROOT");
    if (Array.isArray(value)) return value.map(v => normalize(v, caseRoot));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, normalize(v, caseRoot)]));
    return value;
}
function emit(file: string, value: unknown) {
    const text = `${JSON.stringify(value, null, 2)}\n`;
    if (process.argv.includes("--check")) {
        if (readFileSync(join(directory, file), "utf8") !== text) throw new Error(`${file} is stale; regenerate the config golden`);
    } else writeFileSync(join(directory, file), text);
}
try {
    const runFixture = (fixture: Fixture) => {
        const caseRoot = join(root, fixture.name);
        process.env.HOME = join(caseRoot, "home");
        process.env.XDG_CONFIG_HOME = join(caseRoot, "xdg");
        delete process.env.GOLDEN_SECRET;
        delete process.env.GOLDEN_MISSING;
        for (const [k, v] of Object.entries(fixture.env ?? {})) process.env[k] = v;
        const expand = (text: string) => text.replaceAll("$ROOT", caseRoot);
        const userPath = join(caseRoot, "xdg/cortexkit/magic-context.jsonc");
        const projectRoot = join(caseRoot, "project");
        mkdirSync(projectRoot, { recursive: true });
        if (fixture.user !== undefined || fixture.userText !== undefined) write(userPath, expand(fixture.userText ?? JSON.stringify(fixture.user)));
        if (fixture.project !== undefined || fixture.projectText !== undefined) write(join(projectRoot, ".cortexkit/magic-context.jsonc"), expand(fixture.projectText ?? JSON.stringify(fixture.project)));
        if (fixture.userJson !== undefined) write(join(caseRoot, "xdg/cortexkit/magic-context.json"), JSON.stringify(fixture.userJson));
        if (fixture.legacyUser !== undefined) write(join(caseRoot, "xdg/opencode/magic-context.jsonc"), JSON.stringify(fixture.legacyUser));
        if (fixture.legacyProject !== undefined) write(join(projectRoot, ".opencode/magic-context.jsonc"), JSON.stringify(fixture.legacyProject));
        if (fixture.bareProject !== undefined) write(join(projectRoot, "magic-context.jsonc"), JSON.stringify(fixture.bareProject));
        if (fixture.otherUser !== undefined) write(join(process.env.HOME!, ".pi/agent/magic-context.jsonc"), JSON.stringify(fixture.otherUser));
        if (fixture.otherProject !== undefined) write(join(projectRoot, ".pi/magic-context.jsonc"), JSON.stringify(fixture.otherProject));
        for (const [path, text] of Object.entries(fixture.files ?? {})) write(path.startsWith("~/") ? join(process.env.HOME!, path.slice(2)) : path.startsWith("$ROOT") ? expand(path) : join(dirname(userPath), path), text);
        if (fixture.override !== undefined) {
            const selected = expand(fixture.override).trim();
            process.env.MAGIC_CONTEXT_CONFIG_PATH = expand(fixture.override);
            if (selected && isAbsolute(selected) && !fixture.missing && existsSync(userPath)) write(selected, readFileSync(userPath, "utf8"));
            write(userPath, '{"cache_ttl":"99m"}');
        }
        let result;
        try { result = loadPluginConfigDetailed(projectRoot, false); }
        catch (error) {
            if (String(error).includes("MAGIC_CONTEXT_CONFIG_PATH must be an absolute path")) return { ...fixture, error: "config_path_absolute" };
            throw error;
        }
        const { configWarnings = [], configParseFailures: _parse, configWarningDetails: _details, cacheTtlConfigured: _ttl, ...effective } = result.config;
        const warnings = configWarnings.map(warningCode);
        return { ...fixture, effective: normalize(effective, caseRoot), warnings: [...new Set(warnings)].sort(), warningMessages: normalize(configWarnings, caseRoot), trust: { user: result.sources.userConfig, project: result.sources.projectConfig, outcome: result.loadOutcome, trusted: result.loadOutcome === "ok", cacheTtlConfigured: result.cacheTtlConfigured } };
    };
    if (worker >= 0) {
        console.log(JSON.stringify(runFixture(fixtures[Number(process.argv[worker + 1])])));
    } else {
    const rows = fixtures.map((fixture, index) => {
        const caseRoot = join(root, fixture.name);
        // Bun caches os.homedir at startup, so each fixture gets a fresh runtime
        // whose HOME is private before any loader module is imported.
        const result = Bun.spawnSync([process.execPath, import.meta.path, "--worker", String(index)], {
            env: { ...process.env, HOME: join(caseRoot, "home"), XDG_CONFIG_HOME: join(caseRoot, "xdg"), MC_CONFIG_GOLDEN_ROOT: root },
            stdout: "pipe", stderr: "pipe",
        });
        if (result.exitCode !== 0) throw new Error(result.stderr.toString());
        return JSON.parse(result.stdout.toString());
    });
    emit("golden.json", rows);
    const languages = Array.from({ length: 26*26 }, (_, i) => String.fromCharCode(97 + Math.floor(i/26), 97+i%26)).filter(isValidLanguageCode);
    emit("schema.json", { config: describe(MagicContextConfigSchema), profiles: describe(ConfigProfilesSchema), languages, commands: Object.keys(getMagicContextBuiltinCommands()) });
    console.log(`Config golden ${process.argv.includes("--check") ? "checked" : "generated"}: ${rows.length} real-loader cases, 2 schema descriptors`);
    }
} finally { if (worker < 0) rmSync(root, { recursive: true, force: true }); }
