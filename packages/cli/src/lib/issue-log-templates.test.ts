import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createTestTempDir } from "../../../plugin/src/shared/test-temp-dir";
import { generateIssueLogTemplates, OUTPUT } from "../../scripts/generate-issue-log-templates";
import { ISSUE_LOG_SITES, ISSUE_LOG_TEMPLATES } from "./issue-log-templates.generated";
import { IssuePrivacy } from "./issue-privacy";
import { parseLogLine } from "./log-lines";

test("every shipped logging call is represented by the regenerated template module", () => {
    expect(generateIssueLogTemplates()).toBe(
        readFileSync(new URL(`../../../../${OUTPUT}`, import.meta.url), "utf8"),
    );
    for (const directory of [
        "packages/plugin/src/plugin/",
        "packages/plugin/src/v2/",
        "packages/plugin/src/hooks/",
        "packages/pi-plugin/src/",
    ]) {
        expect(ISSUE_LOG_SITES.some((site) => site.startsWith(directory))).toBe(true);
    }
}, 30_000);

test("extraction follows aliases, forwarding wrappers, concatenations and Rust field-first messages", () => {
    const { dir: root, cleanup } = createTestTempDir("issue-log-source-");
    const put = (path: string, text: string) => {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text);
    };
    try {
        put(
            "packages/plugin/src/logger.ts",
            "export function log(message: string) {}\nexport function sessionLog(sessionId: string, message: string) {}\n",
        );
        put(
            "packages/plugin/src/example.ts",
            [
                'import { log as renamed, sessionLog } from "./logger";',
                'function warning(message: string) { renamed("wrapper: " + message); }',
                'const reason: "cache_hit" | "hard_fold" = "cache_hit";',
                'sessionLog("ses_fixture", `elapsed ${duration}ms reason=${reason}`);',
                'warning("provider failed: " + error);',
                'renamed("a new fixed message");',
            ].join("\n"),
        );
        put(
            "packages/pi-plugin/src/example.ts",
            "function log(message: string) {}\nlog(`Pi pass: ${count} messages`);",
        );
        put(
            "crates/mc-module/src/example.rs",
            'tracing::warn!(session = %session_id, reason = "private", "Rust failed: {error}");',
        );
        const generated = generateIssueLogTemplates(root);
        for (const wording of [
            '"a new fixed message"',
            '"wrapper: provider failed: "',
            '"elapsed "',
            '"ms reason=cache_hit"',
            '"Pi pass: "',
            '"Rust failed: "',
        ])
            expect(generated).toContain(wording);
        expect(generated).not.toContain('"parts":["private"]');
    } finally {
        cleanup();
    }
});

test("all generated templates retain their static parts and omit canaries in every slot", () => {
    const privacy = new IssuePrivacy({});
    const canary =
        " PRIVATE_PROMPT_CANARY PRIVATE_FILE_CANARY PRIVATE_TOOL_CANARY error /home/PRIVATE_HOME_CANARY/private.env API_KEY=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890 ";
    for (const template of ISSUE_LOG_TEMPLATES) {
        expect(template.parts.length).toBe(template.slots.length + 1);
        const message = template.parts.join(canary);
        const output = privacy.logLine(
            `[2026-09-05T10:41:07.130Z] [magic-context][ses_private700] ${message}`,
        );
        for (const part of template.parts) expect(output, JSON.stringify(template)).toContain(part);
        for (const token of [
            "PRIVATE_PROMPT_CANARY",
            "PRIVATE_FILE_CANARY",
            "PRIVATE_TOOL_CANARY",
            "PRIVATE_HOME_CANARY",
            "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890",
        ])
            expect(output).not.toContain(token);
    }
});

test("template slots keep individual measurements, enums, models, versions and identity aliases", () => {
    const privacy = new IssuePrivacy({});
    const line = (text: string) =>
        privacy.logLine(`[2026-09-05T10:41:07.130Z] [magic-context][ses_private700] ${text}`);
    expect(line("transform completed in 29.5ms (10 messages, 2 targets, watermark: 8)")).toContain(
        "transform completed in 29.5ms (10 messages, 2 targets, watermark: 8)",
    );
    expect(
        line(
            'historian failure: source=validation reason="private-tool-output" chunkRange=12-18 fallbackModel=opencode/deepseek-v4.1-flash-free twoPass=true',
        ),
    ).toContain(
        'historian failure: source=validation reason="<text omitted>" chunkRange=12-18 fallbackModel=opencode/deepseek-v4.1-flash-free twoPass=true',
    );
    expect(
        line(
            "historian: prompt attempt 2 failed: TypeError: /home/private-canary sk-ant-api03-PRIVATE_CANARY",
        ),
    ).toContain("historian: prompt attempt 2 failed: <text omitted>");
    expect(line("unknown upstream wording TypeError: private-canary")).toContain(
        "TypeError: <text omitted>",
    );
    expect(line("unknown upstream wording TypeError: private-canary")).not.toContain(
        "unknown upstream wording",
    );
});

test("raw message preserves quoted and duplicate fields without changing existing parsed values", () => {
    const message =
        'historian failure: source=validation reason="tool output with spaces" chunkRange=12-18 fallbackModel=opencode/model twoPass=true count=1 count=2';
    for (const envelope of [
        `[2026-09-05T10:41:07.130Z] [magic-context][ses_private] `,
        "2026-09-05T10:41:07.130Z INFO  magic-context session=opencode:ses_private tag=historian ",
        "2026-09-05T10:41:07.130Z INFO  magic-context.historian: [session=opencode:ses_private] ",
    ]) {
        const parsed = parseLogLine(envelope + message)!;
        const { rawMessage, ...existing } = parsed;
        expect(rawMessage).toBe(message);
        expect(existing).toMatchObject({
            session: "ses_private",
            message: "historian failure:",
            kv: {
                source: "validation",
                reason: "tool output with spaces",
                chunkRange: "12-18",
                fallbackModel: "opencode/model",
                twoPass: "true",
                count: "2",
            },
        });
    }
});

test("inserted path and identity values are aliased in place, not only in the fallback fields", () => {
    for (const [hint, value, alias] of [
        ["session", "ses_PRIVATE_ALIAS_CANARY", "session-2"],
        ["message", "msg_PRIVATE_ALIAS_CANARY", "session-2"],
        ["value", "pj-PRIVATE_ALIAS_CANARY", "project-1"],
        ["path", "/home/PRIVATE_ALIAS_CANARY/file.txt", "~/path-1"],
    ]) {
        const template = ISSUE_LOG_TEMPLATES.find(
            ({ slots }) => slots.length === 1 && slots[0] === hint,
        );
        if (!template) throw new Error(`No single-slot template for ${hint}`);
        const message = template.parts.join(value);
        const output = new IssuePrivacy({}).logLine(
            `[2026-09-05T10:41:07.130Z] [magic-context][ses_envelope] ${message}`,
        );
        expect(output).toContain(template.parts.join(alias));
        expect(output).not.toContain("PRIVATE_ALIAS_CANARY");
    }
    expect(
        new IssuePrivacy({}).logLine(
            "[2026-09-05T10:41:07.130Z] [magic-context][ses_envelope] historian: prompt attempt 1 failed: 1.2.3",
        ),
    ).toContain("historian: prompt attempt 1 failed: 1.2.3");
});
