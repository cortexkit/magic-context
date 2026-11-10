import { ISSUE_LOG_IDENTIFIERS, ISSUE_LOG_TEMPLATES } from "./issue-log-templates.generated";
import { parseLogLine } from "./log-lines";
import { isSecretKey, sanitizeConfigValue, sanitizeDiagnosticText } from "./redaction";

export { ISSUE_LOG_TEMPLATES } from "./issue-log-templates.generated";

const OMITTED = "<text omitted>";
const COMPONENTS = new Set([
    "historian",
    "hist",
    "perf",
    "compaction",
    "dreamer",
    "janitor",
    "retina",
    "storage",
    "embedding",
    "transform",
    "session",
    "runtime",
    "config",
]);
const NUMERIC_FIELD =
    /^(?:duration_?ms|elapsed_?ms|latency_?ms|timeout_?ms|retry|retries|attempt|count|total|success|failed|noop|tokens|input_?tokens|output_?tokens|prompt_?tokens|prompt_?length|completion_?tokens|bytes|size_?kb|lines|turns|messages|compartments|pruned|kept)$/i;
const ENUMS = new Set([
    "true",
    "false",
    "on",
    "off",
    "auto",
    "none",
    "unknown",
    "local",
    "remote",
    "disabled",
    "enabled",
    "default",
    "debug",
    "info",
    "warn",
    "error",
    "trace",
    "validation",
    "exception",
    "cli",
    "desktop",
    "darwin",
    "linux",
    "win32",
    "arm64",
    "x64",
    "ia32",
    "json",
    "jsonc",
    "opencode1",
    "opencode2",
    "fleet-r1",
    "fleet-r2",
    "legacy",
    "mixed",
    "PATH",
    "path",
    "app",
    "openchamber",
    "environment override",
    "OPENCODE_DB",
    "stable",
    "beta",
    "latest",
    "query error",
    "path missing",
    "schema too old",
]);
const CONFIG_ENUMS = new Set([
    "ts",
    "rust",
    "broca",
    "host",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "inherit",
    "full",
    "light",
    "synapse",
    "native",
    "wasm",
    "fp32",
    "fp16",
    "q8",
    "int8",
    "uint8",
    "q4",
    "bnb4",
    "q4f16",
    "q2",
    "q2f16",
    "q1",
    "q1f16",
    "*",
    "read",
    "aft_outline",
    "aft_zoom",
    "aft_search",
    "subagent",
    "primary",
    "all",
    "ask",
    "allow",
    "deny",
]);
const PATH_KEY =
    /^(?:path|dir|directory|configDir|agentDir|opencodeConfig|magicContextConfig|tuiConfig|omoConfig|userConfig|projectConfig|loadedConfigPaths|piPath)$/;
const SESSION_KEY = /session_?ids?$/i;
const PROJECT_KEY = /^(?:project|project_?id|projectKey|rootCommit|root_commit|rootCommitHash)$/i;
const VERSION_KEY = /(?:version|cached|latest|spec)$/i;
const MODEL_KEY =
    /^(?:model|models|provider|providerID|modelID|fallback_provider|fallback_model|fallback_models|fallbackModel|fallbackModelId|model_chain)$/i;
const VERSION = /^(?:(?:opencode|pi|omp)\s+)?v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;
const KNOWN_ERROR_CLASSES = new Set([
    "Error",
    "TypeError",
    "SyntaxError",
    "RangeError",
    "ReferenceError",
    "URIError",
    "AggregateError",
    "EvalError",
    "AbortError",
]);

const INTERNAL_IDENTIFIERS = new Set(ISSUE_LOG_IDENTIFIERS);
const LOG_TEMPLATES = ISSUE_LOG_TEMPLATES.map((template) => ({
    ...template,
    sanitizedParts: template.parts.map((part) => sanitizeDiagnosticText(part)),
}));

function templateValues(value: string, parts: readonly string[]): string[] | null {
    if (!value.startsWith(parts[0])) return null;
    if (parts.length === 1) return value === parts[0] ? [] : null;
    const values: string[] = [];
    let cursor = parts[0].length;
    for (let index = 1; index < parts.length; index++) {
        const part = parts[index];
        const next =
            index === parts.length - 1
                ? value.endsWith(part)
                    ? value.length - part.length
                    : -1
                : value.indexOf(part, cursor);
        if (next < cursor) return null;
        values.push(value.slice(cursor, next));
        cursor = next + part.length;
    }
    return values;
}

const LOG_PATH = /(?:[A-Za-z]:[\\/]|~\/|\/)[^\s,;) '\x22]+/g;
const LOG_ID =
    /\b(?:ses_[A-Za-z0-9_-]+|msg_[A-Za-z0-9_-]+|git:[a-f0-9]{16,64}|pj-[A-Za-z0-9_-]+|dir:[^\s,;) '\x22]+)/gi;

/** Each IssuePrivacy instance assigns aliases for one public report and its full-size copy. */
export class IssuePrivacy {
    readonly notice =
        "_Paths and IDs in diagnostic data use per-report aliases. Session titles, private package names, free-text log values, and source/tool content are omitted; fixed Magic Context diagnostic wording and safe diagnostic fields remain. Your issue title and description are shown unchanged._";
    private readonly projects = new Map<string, string>();
    private readonly sessions = new Map<string, string>();
    private readonly paths = new Map<string, string>();

    constructor(report: unknown, projectDirectories: string[] = []) {
        this.discover(report);
        for (const directory of projectDirectories) {
            this.alias(this.projects, this.normalize(directory), "project");
        }
    }

    private normalize(value: string): string {
        let path = value.replaceAll("\\", "/");
        const home = (process.env.HOME || process.env.USERPROFILE || "").replaceAll("\\", "/");
        if (home && (path === home || path.startsWith(`${home}/`)))
            path = `~${path.slice(home.length)}`;
        return path
            .replace(/^(?:\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\/Users\/[^/]+)(?=\/|$)/, "~")
            .replace(/\/$/, "");
    }

    private alias(map: Map<string, string>, value: string, prefix: string): string {
        let alias = map.get(value);
        if (!alias) {
            alias = `${prefix}-${new Set(map.values()).size + 1}`;
            map.set(value, alias);
        }
        return alias;
    }

    private discover(value: unknown): void {
        if (Array.isArray(value)) {
            for (const item of value) this.discover(item);
        } else if (value && typeof value === "object") {
            const record = value as Record<string, unknown>;
            const directory =
                typeof record.directory === "string" ? this.normalize(record.directory) : null;
            if (directory) {
                const alias = this.alias(this.projects, directory, "project");
                for (const [key, item] of Object.entries(record)) {
                    if (PROJECT_KEY.test(key) && typeof item === "string")
                        this.projects.set(this.normalize(item), alias);
                }
            }
            for (const [key, item] of Object.entries(record)) {
                if (key !== "flags") this.discover(item);
            }
        }
    }

    path(value: string): string {
        const normalized = this.normalize(value);
        if (!normalized || normalized === "~") return normalized;
        // Longest roots first so a nested checkout is not assigned its parent's alias.
        for (const [root, alias] of [...this.projects].sort(([a], [b]) => b.length - a.length)) {
            if (normalized === root || normalized.startsWith(`${root}/`)) {
                return `${normalized.startsWith("~/") ? "~/" : ""}${alias}${normalized === root ? "" : "/<path>"}`;
            }
        }
        return `${normalized.startsWith("~/") ? "~/" : ""}${this.alias(this.paths, normalized, "path")}`;
    }

    session(value: string): string {
        return value === "none" || !value ? value : this.alias(this.sessions, value, "session");
    }

    private project(value: string): string {
        if (value.startsWith("dir:")) return this.path(value.slice(4));
        return this.alias(this.projects, this.normalize(value), "project");
    }

    /** Prose and stack frames may contain source or tool output, not just paths. */
    summary(value: string): string {
        const safe = sanitizeDiagnosticText(value);
        const errors = [
            ...new Set(
                (
                    safe.match(
                        /\b(?:[A-Z][A-Za-z]*Error|SQLITE_[A-Z_]+|EACCES|EPERM|ENOENT|ENOSPC|ECONNRESET|ETIMEDOUT|MC-H[A-Z0-9-]+)\b/g,
                    ) ?? []
                ).filter(
                    (token) =>
                        KNOWN_ERROR_CLASSES.has(token) ||
                        /^(?:SQLITE_[A-Z_]+|EACCES|EPERM|ENOENT|ENOSPC|ECONNRESET|ETIMEDOUT|MC-H[A-Z0-9-]+)$/.test(
                            token,
                        ),
                ),
            ),
        ];
        if (/generation mismatch/i.test(safe)) errors.push("store generation mismatch");
        if (/no such table/i.test(safe)) errors.push("SQLITE_ERROR");
        if (/could not safely prepare this turn|refused\s*\(/i.test(safe)) errors.push("refused");
        if (/\bfailed:|\bexception\b|\bEMERGENCY\b/i.test(safe)) errors.push("failed");
        return errors.length ? `${errors.join(" ")}: ${OMITTED}` : OMITTED;
    }

    userText(value: string): string {
        return value;
    }

    logLine(line: string): string {
        const parsed = parseLogLine(line);
        const globalLine = /^\[(\d{4}-\d\d-\d\dT[\d:.]+Z)\] (.*)$/.exec(line);
        const safe = sanitizeDiagnosticText(line);
        const component =
            parsed?.tags.find((tag) => COMPONENTS.has(tag)) ??
            [...COMPONENTS].find((name) => new RegExp(`\\b${name}\\b`).test(parsed?.message ?? ""));
        const logger = component ? `magic-context.${component}` : "magic-context";
        const session = parsed?.session ? ` [${this.session(parsed.session)}]` : "";
        const fields = Object.entries(parsed?.kv ?? {}).flatMap(([key, raw]) => {
            const value = sanitizeDiagnosticText(raw);
            if (NUMERIC_FIELD.test(key) && /^\d+(?:\.\d+)?$/.test(value))
                return [`${key}=${value}`];
            if (SESSION_KEY.test(key)) return [`${key}=${this.session(value)}`];
            if (PROJECT_KEY.test(key)) return [`${key}=${this.project(value)}`];
            if (PATH_KEY.test(key)) return [`${key}=${this.path(value)}`];
            if (VERSION_KEY.test(key) && VERSION.test(value)) return [`${key}=${value}`];
            if (
                MODEL_KEY.test(key) &&
                /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) &&
                !value.includes("..") &&
                !/^(?:git:|dir:|pj-)/.test(value)
            )
                return [`${key}=${value}`];
            if (key === "chunkRange" && /^\d+-\d+$/.test(value)) return [`${key}=${value}`];
            if (key === "source" && ENUMS.has(value)) return [`${key}=${value}`];
            if (/^(?:enabled|disabled|twoPass)$/i.test(key) && ENUMS.has(value))
                return [`${key}=${value}`];
            return [];
        });
        // Legacy telemetry often writes timings in prose rather than structured fields.
        const timings = safe.match(/\b\d+(?:\.\d+)?(?:ms|µs|us|s)\b/g) ?? [];
        // Match before splitting event fields: quotes, duplicate keys and order are source text.
        const message = parsed?.rawMessage ?? globalLine?.[2] ?? line;
        const identities = [...message.matchAll(LOG_ID)].map(([id]) => {
            if (id.startsWith("ses_") || id.startsWith("msg_")) return this.session(id);
            if (id.startsWith("dir:")) return this.path(id.slice(4));
            return this.project(id);
        });
        const paths = [...message.matchAll(LOG_PATH)].map(([path]) =>
            this.path(path.replace(/:$/, "")),
        );
        return [
            parsed?.ts && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(parsed.ts)
                ? parsed.ts
                : (globalLine?.[1] ?? ""),
            parsed?.level ?? line.match(/^(TRACE|DEBUG|INFO|WARN|ERROR)\b/)?.[1] ?? "LOG",
            `${logger}${session}`,
            this.logMessage(message),
            ...fields,
            ...timings,
            ...identities,
            ...paths,
        ]
            .filter(Boolean)
            .join(" ");
    }

    private logMessage(value: string): string {
        const safe = sanitizeDiagnosticText(value);
        // Generated templates are sorted by static character count, most specific first.
        for (const template of LOG_TEMPLATES) {
            // The shared plugin logger sanitizes credentials before writing. That can redact a source literal
            // such as context_limit_tokens=unknown; restore only the proven static text.
            const values =
                templateValues(value, template.parts) ??
                templateValues(safe, template.sanitizedParts);
            if (!values) continue;
            return template.parts.reduce(
                (result, part, index) =>
                    result +
                    (index === 0
                        ? ""
                        : this.logValue(
                              values[index - 1],
                              template.slots[index - 1],
                              template.parts[index - 1],
                          )) +
                    part,
                "",
            );
        }
        return this.summary(value);
    }

    private logValue(value: string, hint: string, before: string): string {
        const safe = sanitizeDiagnosticText(value).trim();
        if (!safe) return "";
        if (
            /^-?\d+(?:\.\d+)?(?:\s?(?:ms|µs|us|s|%|tokens))?$/.test(safe) ||
            ENUMS.has(safe) ||
            CONFIG_ENUMS.has(safe) ||
            INTERNAL_IDENTIFIERS.has(safe) ||
            VERSION.test(safe)
        )
            return safe;
        if (/^(?:ses_|msg_)[A-Za-z0-9_-]+$/.test(safe) || hint === "session" || hint === "message")
            return this.session(safe);
        if (
            /^(?:git:[a-f0-9]{16,64}|pj-[A-Za-z0-9_-]+|dir:[^\s]+)$/.test(safe) ||
            hint === "project"
        )
            return this.project(safe);
        const model = hint === "model" || /(?:model|provider)[A-Za-z_]*[=:] ?$/i.test(before);
        if (
            model &&
            /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(safe) &&
            !safe.includes("..") &&
            safe === value.trim() &&
            !/REDACTED/.test(safe)
        )
            return safe;
        if (/^(?:~\/|\/|[A-Za-z]:[\\/])[^\s]+$/.test(safe) || hint === "path")
            return this.path(safe);
        return OMITTED;
    }

    healthMessage(value: string): string {
        const labels = [
            "compaction.enabled",
            "memory.backend",
            "@cortexkit/pi-magic-context",
            "native compaction",
            "memory backend",
            "agent directory",
            "config",
            "plugin",
            "manifest",
            "Shared storage",
            "Magic Context storage",
            "context DB",
            "SQLite integrity_check",
            "Background maintenance",
            "runtime log",
            "sessions",
            "package override",
        ];
        const label =
            labels.find((entry) => value.toLowerCase().includes(entry.toLowerCase())) ??
            "host detection";
        const staticMessages = [
            "OMP native compaction is disabled",
            "OMP automatic memory backend is disabled",
            "SQLite integrity_check: ok",
            "Background maintenance completed its last pass",
            "Magic Context runtime config loads successfully",
            "Plugin exposes an OMP/Pi extension manifest",
            "Installed plugin has no OMP/Pi extension manifest",
        ];
        if (staticMessages.includes(value)) return value;
        const paths = [...value.matchAll(/(?:[A-Za-z]:[\\/]|~\/|\/)[^\s,;)]+/g)].map(([path]) =>
            this.path(path),
        );
        const versions = value.match(/\b\d+\.\d+\.\d+\b/g) ?? [];
        const fields = [
            ...value.matchAll(/\b(grammar|lines|source)[=:]\s*(environment override|[\w-]+)/g),
        ].map(
            ([, key, item]) => `${key}=${/^\d+$/.test(item) || ENUMS.has(item) ? item : OMITTED}`,
        );
        const measurements = value.match(/\b\d+(?:\.\d+)?\s?(?:KB|MB|GB|ms|s)\b/g) ?? [];
        return [label, ...versions, ...paths, ...fields, ...measurements, this.summary(value)].join(
            " ",
        );
    }

    /** Publish typed diagnostics and approved string values; omit unrecognized prose. */
    report<T>(value: T, key = "", config = false): T {
        if (value === null || typeof value === "number" || typeof value === "boolean") return value;
        if (isSecretKey(key)) return sanitizeConfigValue(value, [key]) as T;
        if (Array.isArray(value)) return value.map((item) => this.report(item, key, config)) as T;
        if (value && typeof value === "object") {
            return Object.fromEntries(
                Object.entries(value).map(([childKey, item]) => [
                    key === "factCountByCategory"
                        ? `category-${Object.keys(value).indexOf(childKey) + 1}`
                        : /[\s/@\\:]|[a-f0-9]{24,}/i.test(childKey)
                          ? "<key omitted>"
                          : childKey,
                    this.report(item, childKey, config || key === "flags"),
                ]),
            ) as T;
        }
        if (typeof value !== "string") return value;
        const safe = sanitizeDiagnosticText(value);
        if (/^<[^<>]*REDACTED[^<>]*>$/.test(safe)) return safe as T;
        if (/^title$/i.test(key)) return OMITTED as T;
        if (SESSION_KEY.test(key)) return this.session(value) as T;
        if (PROJECT_KEY.test(key) || /^(?:git:[a-f0-9]{16,64}|pj-)/.test(value))
            return this.project(value) as T;
        if (PATH_KEY.test(key) || /^(?:~\/|\/|[A-Za-z]:[\\/]|file:)/.test(value))
            return this.path(value) as T;
        if (key === "$schema" && /^https?:\/\/[^\s]+$/i.test(value)) return safe as T;
        if (VERSION_KEY.test(key) && VERSION.test(value)) return value as T;
        if (
            /^(?:timestamp|lastActiveAt|lastFailureAt|lastRunAt|lastUpdatedAt)$/.test(key) &&
            /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value)
        )
            return value as T;
        if (
            MODEL_KEY.test(key) &&
            /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(safe) &&
            !safe.includes("..") &&
            !/^(?:git:|dir:|pj-)/.test(safe)
        )
            return safe as T;
        if (ENUMS.has(value) || value === "") return value;
        if (config && (CONFIG_ENUMS.has(value) || (key === "language" && /^[a-z]{2}$/.test(value))))
            return value;
        if (config) return OMITTED as T;
        return this.summary(value) as T;
    }
}
