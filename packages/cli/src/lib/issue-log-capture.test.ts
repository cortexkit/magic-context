import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createTestTempDir } from "../../../plugin/src/shared/test-temp-dir";
import { ISSUE_LOG_TEMPLATES } from "./issue-log-templates.generated";
import { IssuePrivacy } from "./issue-privacy";
import { parseLogLine } from "./log-lines";

test("captured transform passes and historian success/failure retain wording without private values", async () => {
    const { dir: root, cleanup } = createTestTempDir("issue-log-capture-");
    try {
        const child = Bun.spawn(
            [
                process.execPath,
                "run",
                new URL("./issue-log-capture.fixture.ts", import.meta.url).pathname,
            ],
            {
                cwd: root,
                windowsHide: true,
                env: {
                    ...process.env,
                    NODE_ENV: "production",
                    HOME: root,
                    XDG_DATA_HOME: root,
                    XDG_CONFIG_HOME: root,
                    XDG_CACHE_HOME: root,
                    MAGIC_CONTEXT_TEST_DATA_DIR: root,
                    ISSUE_LOG_CAPTURE_ROOT: root,
                },
                stdout: "pipe",
                stderr: "pipe",
            },
        );
        const [stdout, stderr, exit] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
        ]);
        expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
        const lines = JSON.parse(stdout) as string[];
        expect(lines.length).toBeGreaterThanOrEqual(20);
        expect(lines.join("\n")).toContain("historian: prompt completed");
        expect(lines.join("\n")).toContain("historian prompt failed:");
        expect(lines.join("\n")).toContain("PRIVATE_ERROR_CANARY");
        const privacy = new IssuePrivacy({});
        const converted = lines.map((line) => privacy.logLine(line));
        const messageLines = lines.filter(
            (line) => parseLogLine(line) || /^\[\d{4}-\d\d-\d\dT[\d:.]+Z\] /.test(line),
        );
        for (const canary of [
            "PRIVATE_PROMPT_CANARY",
            "PRIVATE_FILE_CANARY",
            "PRIVATE_TOOL_CANARY",
            "PRIVATE_ERROR_CANARY",
            "PRIVATE_HOME_CANARY",
            "PRIVATE_SESSION_CANARY",
            "PRIVATE_MESSAGE_CANARY",
            "PRIVATE_HISTORIAN_CANARY",
            "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890",
        ])
            expect(converted.join("\n")).not.toContain(canary);

        // These eight prefixes are the pre-change control, not the production template inventory.
        const beforePrefixes = [
            "historian prompt failed:",
            "historian: prompt attempt ",
            "historian failure: source=",
            "historian post-publish step failed; publication stands:",
            "Historian failed while processing this session:",
            "Historian returned no assistant output.",
            "mc-module: store open failed:",
            "mc-module: historian firing failed for ",
        ];
        const before = messageLines.filter((line) =>
            beforePrefixes.some((prefix) =>
                (parseLogLine(line)?.rawMessage ?? line).startsWith(prefix),
            ),
        ).length;
        let after = 0;
        const unmatched: string[] = [];
        for (const [index, line] of lines.entries()) {
            if (!messageLines.includes(line)) continue;
            const message = parseLogLine(line)?.rawMessage ?? line.replace(/^\[[^\]]+\] /, "");
            const template = ISSUE_LOG_TEMPLATES.find(({ parts }) => {
                const pattern = parts
                    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
                    .join("[\\s\\S]*?");
                return new RegExp(`^${pattern}$`).test(message);
            });
            if (!template) {
                unmatched.push(line);
                continue;
            }
            for (const part of template.parts) expect(converted[index]).toContain(part);
            after++;
        }
        expect(unmatched).toEqual([]);
        expect(after).toBe(messageLines.length);
        expect(after).toBeGreaterThan(before);
        const metric = `Captured log wording: before ${before}/${messageLines.length} (${((100 * before) / messageLines.length).toFixed(1)}%), after ${after}/${messageLines.length} (${((100 * after) / messageLines.length).toFixed(1)}%). ${lines.length - messageLines.length} opaque stack-continuation lines are excluded from this message-line denominator and privacy-checked separately.`;
        console.log(metric);
        if (process.env.ISSUE_LOG_PROOF_OUTPUT) {
            const path = process.env.ISSUE_LOG_PROOF_OUTPUT;
            mkdirSync(dirname(path), { recursive: true });
            const sample = [...messageLines.slice(0, 10), ...messageLines.slice(-10)].map(
                (line) => converted[lines.indexOf(line)],
            );
            writeFileSync(
                path,
                `# Issue log privacy capture\n\n${metric}\n\n## Sample of 20 converted lines\n\n\`\`\`text\n${sample.join("\n")}\n\`\`\`\n`,
            );
        }
    } finally {
        cleanup();
    }
}, 30_000);
