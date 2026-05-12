import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type DiagnosticReport, renderDiagnosticsMarkdown } from "./diagnostics-opencode";
import { sanitizeConfigValue, sanitizeDiagnosticText } from "./redaction";

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
    return sanitizeDiagnosticText(content);
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

/**
 * Drop log lines that reference a `ses_*` session ID OTHER than `sessionId`.
 * Lines without any `ses_*` reference are kept (they're shared-runtime logs
 * that may or may not be relevant — we don't have enough signal to drop
 * them, and keeping them is safe).
 *
 * When `sessionId` is null, no filtering happens — the full log slice is
 * returned. This is the Q2 design: filter only when the user picked a
 * specific session in the `--issue` picker.
 */
function filterLogLinesBySession(lines: string[], sessionId: string | null): string[] {
    if (!sessionId) return lines;
    // Pattern matches OpenCode session IDs (`ses_*` with hex/alnum body, up to
    // 32 chars). Anchored with a non-word boundary so we don't trip on names
    // that happen to embed `ses_`.
    const otherSessionPattern = /\bses_[A-Za-z0-9]{8,32}\b/g;
    return lines.filter((line) => {
        const matches = line.match(otherSessionPattern);
        if (!matches) return true;
        // Keep the line only if EVERY session ID it mentions matches the chosen
        // one. Mixed-session lines (rare but possible) get dropped to be safe.
        return matches.every((id) => id === sessionId);
    });
}

export async function bundleIssueReport(
    report: DiagnosticReport,
    description: string,
    _title: string,
    sessionFilter: string | null = null,
): Promise<BundledIssueReport> {
    const LOG_TAIL_LINES = 400;
    const allLogLines = report.logFile.exists
        ? readFileSync(report.logFile.path, "utf-8").split(/\r?\n/)
        : [];
    const logLines = filterLogLinesBySession(allLogLines, sessionFilter);
    const recentLog = sanitizeLogContent(logLines.slice(-LOG_TAIL_LINES).join("\n")).trim();

    // Also extract historian-failure lines from a wider window so issue reports
    // still capture failure signals even when more recent noise has pushed them
    // out of the 400-line tail. We scan the last 4000 lines for historian
    // patterns and keep up to 30 matches.
    const historianScanWindow = sanitizeLogContent(logLines.slice(-4000).join("\n"));
    const historianFailureLines = extractHistorianFailureLines(historianScanWindow, 30);

    const configBody = JSON.stringify(
        sanitizeConfigValue(report.magicContextConfig.flags),
        null,
        2,
    );
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
