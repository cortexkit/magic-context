import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
    type DiagnosticReport,
    describeOutdatedPluginInstall,
    renderDiagnosticsMarkdown,
} from "./diagnostics-opencode";
import { capBodyToGithubLimit, prepareIssueReport } from "./issue-body";
import { parseLogLine, readLogLines } from "./log-lines";
import { sanitizeConfigValue, sanitizeDiagnosticText } from "./redaction";

/** Credential/path-prefix redaction for diagnostic text, not a public log projection.
 * Issue attachments use prepareIssueReport so source and tool content is removed too.
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
    /** Capped markdown suitable for a GitHub issue body. */
    path: string;
    bodyMarkdown: string;
    /** Full sanitized markdown when the GitHub body had to be capped. */
    fullPath?: string;
    truncated: boolean;
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
export function extractHistorianFailureLines(sanitized: string, limit = 30): string[] {
    const matches: string[] = [];
    const lines = sanitized.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0 && matches.length < limit; i -= 1) {
        const parsed = parseLogLine(lines[i]);
        if (parsed && isHistorianLogLine(parsed.message)) {
            matches.push(lines[i]);
        }
    }
    return matches.reverse();
}

export async function bundleIssueReport(
    report: DiagnosticReport,
    description: string,
    title: string,
    sessionFilter: string | null = null,
    options: { outputPath?: string } = {},
): Promise<BundledIssueReport> {
    const LOG_TAIL_LINES = 400;
    const allLogLines = readLogLines(report.logFiles ?? [report.logFile]);
    const prepared = prepareIssueReport(report, allLogLines, sessionFilter);
    const { privacy, logLines, recentLog, recentErrorLines } = prepared;
    report = prepared.report;

    // Also extract historian-failure lines from a wider window so issue reports
    // still capture failure signals even when more recent noise has pushed them
    // out of the 400-line tail. We scan the last 4000 lines for historian
    // patterns and keep up to 30 matches.
    const historianScanWindow = logLines.slice(-4000).join("\n");
    const historianFailureLines = extractHistorianFailureLines(historianScanWindow, 30).map(
        (line) => privacy.logLine(line),
    );

    // Pull the most recent 20 ERROR-shaped lines into their own dedicated
    // section. The body-size cap (`capBodyToGithubLimit`) only shrinks the
    // main `## Log (last N lines)` block, so promoting errors here
    // guarantees the agent / human reading the issue still sees them even
    // when the body needs heavy truncation. We scan a wide window for the
    // same reason as historian: a flood of debug noise after the error
    // shouldn't push the cause out of view.

    const configBody = JSON.stringify(
        sanitizeConfigValue(report.magicContextConfig.flags),
        null,
        2,
    );
    const sanitizedConfigPath = sanitizeDiagnosticText(report.configPaths.magicContextConfig);
    const sanitizedDescription = privacy.userText(description);
    const sanitizedTitle = privacy.userText(title).trim();
    const outdatedLine = describeOutdatedPluginInstall(report.pluginCache);

    const selectedSession = sessionFilter
        ? (report.recentSessions.available ? report.recentSessions.rows : []).find(
              (session) => session.sessionId === privacy.session(sessionFilter),
          )
        : undefined;
    const sessionContext = selectedSession
        ? [
              "## Session context",
              `- Selected session: ${sanitizeDiagnosticText(selectedSession.sessionId)}`,
              `- Parent session: ${sanitizeDiagnosticText(selectedSession.parentSessionId ?? "none")}`,
              "",
          ]
        : [];

    const rawBodyMarkdown = [
        ...(sanitizedTitle ? ["## Title", sanitizedTitle, ""] : []),
        ...sessionContext,
        "## Description",
        sanitizedDescription,
        "",
        privacy.notice,
        "",
        "## Environment",
        // An outdated plugin explains many reports, so it is the first thing a reader sees.
        ...(outdatedLine ? [`- ${outdatedLine}`] : []),
        // pluginVersion is this CLI's own version, not the plugin OpenCode loads.
        `- magic-context CLI: v${report.pluginVersion}${report.pluginCache.cached ? ` (installed plugin: v${report.pluginCache.cached})` : ""}`,
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
        "## Recent errors (last 20, sanitized)",
        recentErrorLines.length === 0
            ? "_No error-shaped log lines found in recent history._"
            : ["```", recentErrorLines.join("\n"), "```"].join("\n"),
        "",
        `## Log (last ${LOG_TAIL_LINES} lines, sanitized)`,
        "```",
        recentLog || "<no log output>",
        "```",
    ].join("\n");

    // Cap the body at GitHub's ~64KB issue limit. If the rendered report
    // is already short enough this is a pass-through; otherwise the main
    // log block gets shrunk from the top (older lines first) and a
    // truncation marker inserted. The error and historian-failure sections
    // above survive intact — that's the whole point of extracting them.
    const bodyMarkdown = capBodyToGithubLimit(rawBodyMarkdown);
    const truncated = bodyMarkdown !== rawBodyMarkdown;
    const timestamp = formatTimestamp(new Date());
    const path = options.outputPath ?? join(process.cwd(), `magic-context-issue-${timestamp}.md`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${bodyMarkdown}\n`);

    // Keep the complete sanitized report beside the capped issue body. This is
    // intentionally a local attachment rather than a gist: users retain
    // control of where the diagnostic bundle is uploaded when GitHub rejects or
    // cannot create the issue.
    const fullPath = truncated
        ? options.outputPath
            ? `${options.outputPath}.full.md`
            : join(process.cwd(), `magic-context-issue-${timestamp}-full.md`)
        : undefined;
    if (fullPath) writeFileSync(fullPath, `${rawBodyMarkdown}\n`);

    return { path, bodyMarkdown, ...(fullPath ? { fullPath } : {}), truncated };
}
