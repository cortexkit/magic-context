import { readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { type DiagnosticReport, renderDiagnosticsMarkdown } from "./diagnostics-opencode";

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Secret-token redaction patterns. Council finding #9 (8/9 members):
 * the original sanitizer only stripped paths and usernames, so any log line
 * carrying an API token, AWS key, GitHub PAT, or other credential would
 * land verbatim in the user-shareable issue report.
 *
 * Each entry maps a regex to the replacement string. Patterns are
 * intentionally narrow — overzealous matching would mangle log content
 * and false-redact legitimate identifiers (e.g. session IDs, model
 * names). When in doubt we prefer to under-redact and let the user
 * notice rather than over-redact and make logs incomprehensible.
 *
 * Order matters: check the more specific token shapes first so a generic
 * fallback doesn't swallow a credential we recognize.
 */
const SECRET_PATTERNS: Array<{
    name: string;
    pattern: RegExp;
    /** Replacement; if it's a function, the matched groups are passed in. */
    replacement: string | ((match: string, ...groups: string[]) => string);
}> = [
    // Anthropic API keys: sk-ant-api03-... or sk-ant-...
    {
        name: "anthropic_api_key",
        pattern: /\bsk-ant-(?:api03-)?[A-Za-z0-9_-]{32,}/g,
        replacement: "<ANTHROPIC_API_KEY_REDACTED>",
    },
    // OpenAI API keys: sk-... (legacy) and sk-proj-... (project)
    {
        name: "openai_api_key",
        pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g,
        replacement: "<OPENAI_API_KEY_REDACTED>",
    },
    // GitHub fine-grained PATs (github_pat_...) and classic tokens
    {
        name: "github_pat_fine_grained",
        pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
        replacement: "<GITHUB_PAT_REDACTED>",
    },
    {
        name: "github_token_classic",
        pattern: /\b(?:gh[opsu]|ghr)_[A-Za-z0-9]{30,}/g,
        replacement: "<GITHUB_TOKEN_REDACTED>",
    },
    // HuggingFace tokens: hf_... (typically 30+ char alphanumeric)
    {
        name: "huggingface_token",
        pattern: /\bhf_[A-Za-z0-9]{30,}/g,
        replacement: "<HUGGINGFACE_TOKEN_REDACTED>",
    },
    // AWS access keys: AKIA... (20 chars total) or ASIA... (temp creds)
    {
        name: "aws_access_key_id",
        pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
        replacement: "<AWS_ACCESS_KEY_ID_REDACTED>",
    },
    // AWS secret access keys: 40-char base64-ish, only redact when in
    // an obvious assignment context to avoid false positives on hashes.
    {
        name: "aws_secret_access_key",
        pattern: /\b(aws[_-]?secret[_-]?access[_-]?key\s*[=:]\s*)([A-Za-z0-9/+=]{40})\b/gi,
        replacement: (_full: string, prefix: string) => `${prefix}<AWS_SECRET_REDACTED>`,
    },
    // Slack tokens: xox[abprs]-... (bot, user, etc.)
    {
        name: "slack_token",
        pattern: /\bxox[abprsuvc]-[A-Za-z0-9-]{10,}/g,
        replacement: "<SLACK_TOKEN_REDACTED>",
    },
    // Google API keys: AIza... (39 chars)
    {
        name: "google_api_key",
        pattern: /\bAIza[A-Za-z0-9_-]{35}\b/g,
        replacement: "<GOOGLE_API_KEY_REDACTED>",
    },
    // Generic env-var assignments where the key name suggests a secret.
    // Matches `FOO_API_KEY=value`, `BAR_TOKEN=value`, `BAZ_SECRET=value`,
    // `QUX_PASSWORD=value` in shell-export form. Keeps the variable name
    // visible (useful for debugging) but redacts the value.
    {
        name: "secret_env_assignment",
        pattern:
            /\b([A-Z][A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE[_-]?KEY))\s*=\s*([^\s'"]+)/g,
        replacement: (_full: string, key: string) => `${key}=<REDACTED>`,
    },
    // JSON-style secret assignments: "api_key": "value", "token": "value", etc.
    // Matches the JSON spelling in config files / structured logs. Redacts
    // the value but keeps the key visible.
    {
        name: "secret_json_assignment",
        pattern:
            /("(?:api[_-]?key|access[_-]?token|auth[_-]?token|bearer[_-]?token|client[_-]?secret|password|private[_-]?key|secret[_-]?key)"\s*:\s*)"([^"]+)"/gi,
        replacement: (_full: string, prefix: string) => `${prefix}"<REDACTED>"`,
    },
    // Bearer tokens in HTTP headers: `Authorization: Bearer eyJ...`
    {
        name: "bearer_token",
        pattern: /\b(Authorization\s*:\s*Bearer\s+)([A-Za-z0-9._~+/=-]{16,})/gi,
        replacement: (_full: string, prefix: string) => `${prefix}<BEARER_TOKEN_REDACTED>`,
    },
    // JWT tokens (common in API responses): three base64url segments
    // separated by dots. Conservative match: requires the standard JWT
    // header prefix `eyJ` to avoid false positives on arbitrary base64.
    {
        name: "jwt_token",
        pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
        replacement: "<JWT_REDACTED>",
    },
];

/**
 * Replace absolute home paths, usernames, and known secret-token shapes in
 * captured log lines so users can share reports publicly without leaking
 * local paths or credentials.
 *
 * Order of operations matters:
 *   1. Path/user redaction first — paths are deterministic and the
 *      easiest to match, doing them before token redaction means
 *      tokens never appear inside a path-resolved replacement.
 *   2. Secret-token redaction in `SECRET_PATTERNS` order — more
 *      specific shapes (provider-prefixed keys) before generic
 *      assignment patterns, so a known shape doesn't get caught
 *      twice.
 */
export function sanitizeLogContent(content: string): string {
    const home = homedir();
    const username = userInfo().username;

    let sanitized = content;

    // Phase 1: paths and usernames.
    if (home) {
        sanitized = sanitized.replace(new RegExp(escapeRegex(home), "g"), "~");
    }
    sanitized = sanitized.replace(/\/Users\/[^/]+\//g, "/Users/<USER>/");
    sanitized = sanitized.replace(/\/home\/[^/]+\//g, "/home/<USER>/");
    sanitized = sanitized.replace(/C:\\Users\\[^\\]+\\/g, "C:\\Users\\<USER>\\");
    if (username) {
        sanitized = sanitized.replace(new RegExp(escapeRegex(username), "g"), "<USER>");
    }

    // Phase 2: secret tokens.
    for (const { pattern, replacement } of SECRET_PATTERNS) {
        if (typeof replacement === "string") {
            sanitized = sanitized.replace(pattern, replacement);
        } else {
            // Function form needs the explicit cast because TS's
            // String.prototype.replace overloads don't unify cleanly with
            // (match, ...groups) => string in all tsc versions.
            sanitized = sanitized.replace(
                pattern,
                replacement as (match: string, ...groups: string[]) => string,
            );
        }
    }

    return sanitized;
}

function formatTimestamp(date: Date): string {
    const pad = (value: number) => String(value).padStart(2, "0");
    return [
        String(date.getFullYear()),
        pad(date.getMonth() + 1),
        pad(date.getDate()),
        "-",
        pad(date.getHours()),
        pad(date.getMinutes()),
        pad(date.getSeconds()),
    ].join("");
}

export interface BundledIssueReport {
    path: string;
    bodyMarkdown: string;
}

/**
 * Pattern tokens recognized as historian-failure signals in raw log output.
 * These are stable log strings emitted by the runtime:
 *   - `historian failure:`            — structured failure log from runners
 *   - `historian failure recorded:`   — storage-layer log when failureCount increments
 *   - `historian prompt failed:`      — SDK call failure with describeError output
 *   - `## Historian alert`            — notification payload heading
 *   - `historian alert suppressed`    — alert suppressed due to cooldown
 *   - `EMERGENCY: aborting session`   — 95% abort path
 *   - `historian: prompt attempt N failed:` — per-retry transient errors
 */
const HISTORIAN_LOG_PATTERNS = [
    /historian failure:/,
    /historian failure recorded:/,
    /historian prompt failed:/,
    /## Historian alert/,
    /historian alert suppressed/,
    /EMERGENCY: aborting session/,
    /historian: prompt attempt \d+ failed:/,
];

function isHistorianLogLine(line: string): boolean {
    return HISTORIAN_LOG_PATTERNS.some((rx) => rx.test(line));
}

/**
 * Extract historian-failure log lines from the sanitized log content.
 * Returns the most recent occurrences (up to `limit`), newest first.
 */
function extractHistorianFailureLines(sanitized: string, limit = 30): string[] {
    const matches: string[] = [];
    const lines = sanitized.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0 && matches.length < limit; i -= 1) {
        if (isHistorianLogLine(lines[i])) {
            matches.push(lines[i]);
        }
    }
    return matches.reverse();
}

export async function bundleIssueReport(
    report: DiagnosticReport,
    description: string,
    _title: string,
): Promise<BundledIssueReport> {
    const LOG_TAIL_LINES = 400;
    const logLines = report.logFile.exists
        ? readFileSync(report.logFile.path, "utf-8").split(/\r?\n/)
        : [];
    const recentLog = sanitizeLogContent(logLines.slice(-LOG_TAIL_LINES).join("\n")).trim();

    // Also extract historian-failure lines from a wider window so issue reports
    // still capture failure signals even when more recent noise has pushed them
    // out of the 400-line tail. We scan the last 4000 lines for historian
    // patterns and keep up to 30 matches.
    const historianScanWindow = sanitizeLogContent(logLines.slice(-4000).join("\n"));
    const historianFailureLines = extractHistorianFailureLines(historianScanWindow, 30);

    const configBody = JSON.stringify(report.magicContextConfig.flags, null, 2);
    const sanitizedConfigPath = report.configPaths.magicContextConfig.replace(homedir(), "~");

    const bodyMarkdown = [
        "## Description",
        description,
        "",
        "## Environment",
        `- Plugin: v${report.pluginVersion}`,
        `- OS: ${report.platform} ${report.arch}`,
        `- Node: ${report.nodeVersion}`,
        `- OpenCode: ${report.opencodeVersion ?? "not installed"}`,
        "",
        "## Configuration",
        `Config from \`${sanitizedConfigPath}\`:`,
        "```jsonc",
        configBody,
        "```",
        "",
        "## Diagnostics",
        renderDiagnosticsMarkdown(report),
        "",
        "## Historian failure signals (log, sanitized)",
        historianFailureLines.length === 0
            ? "_No historian failure log lines found in recent history._"
            : ["```", historianFailureLines.join("\n"), "```"].join("\n"),
        "",
        `## Log (last ${LOG_TAIL_LINES} lines, sanitized)`,
        "```",
        recentLog || "<no log output>",
        "```",
    ].join("\n");

    const path = join(process.cwd(), `magic-context-issue-${formatTimestamp(new Date())}.md`);
    writeFileSync(path, `${bodyMarkdown}\n`);
    return { path, bodyMarkdown };
}
