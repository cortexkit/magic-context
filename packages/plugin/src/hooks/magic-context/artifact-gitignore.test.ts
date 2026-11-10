import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    docsBaseHashes,
    writeDocsProposal,
} from "../../features/magic-context/dreamer/docs-proposals";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { runValidatedHistorianPass } from "./compartment-runner-historian";
import type { HiddenCompletionExecutor } from "./compartment-runner-types";

const dirs: string[] = [];
afterEach(() => {
    closeDatabase();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function dump(directory: string) {
    const executor: HiddenCompletionExecutor = {
        capabilities: { tools: false, harness: "opencode" },
        open: async () => ({ id: "artifact-child" }),
        attempt: async () => {},
        collect: async () => ({
            text: "invalid XML kept for diagnosis",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            lengthCapped: false,
        }),
        close: async () => {},
    };
    return runValidatedHistorianPass({
        client: undefined,
        hiddenCompletionExecutor: executor,
        db: openDatabase(),
        parentSessionId: "artifact-parent",
        sessionDirectory: directory,
        prompt: "Messages 1-1:\n1: U: preserve this",
        chunk: { startIndex: 1, endIndex: 1, lines: [{ ordinal: 1, messageId: "message-1" }] },
        priorCompartments: [],
        sequenceOffset: 0,
        dumpLabelBase: "artifacts",
    });
}

const legacy = "# >>> cortexkit:magic-context\nmagic-context/\n# <<< cortexkit:magic-context\n";
const sibling = "# >>> cortexkit:aft\r\n/.gitignore\r\naft/\r\n# <<< cortexkit:aft\r\n";

test.each([
    "",
    legacy,
    sibling + legacy,
])("historian dumps and docs proposals hide artifacts but not config in a real repo (old shared file: %j)", async (shared) => {
    const dir = createTestTempDirFromPath(join(tmpdir(), "mc-artifact-git-"));
    dirs.push(dir);
    const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: dir, encoding: "utf8", windowsHide: true });
    git("init", "-q");
    mkdirSync(join(dir, ".cortexkit"));
    writeFileSync(join(dir, ".cortexkit/magic-context.jsonc"), "{}\n");
    if (shared) writeFileSync(join(dir, ".cortexkit/.gitignore"), shared);

    await dump(dir);
    const historianDir = join(dir, ".cortexkit/magic-context/historian");
    const dumps = readdirSync(historianDir).filter((name) => name.endsWith(".xml"));
    expect(dumps.length).toBeGreaterThan(0);
    expect(readFileSync(join(historianDir, dumps[0]!), "utf8")).toContain("invalid XML");
    const status = () => git("status", "--porcelain", "--untracked-files=all");
    expect(status()).toBe("?? .cortexkit/magic-context.jsonc\n");
    expect(readFileSync(join(dir, ".cortexkit/magic-context/.gitignore"), "utf8")).toBe("*\n");
    if (shared.includes("cortexkit:aft")) {
        expect(readFileSync(join(dir, ".cortexkit/.gitignore"))).toEqual(Buffer.from(sibling));
    } else {
        expect(existsSync(join(dir, ".cortexkit/.gitignore"))).toBe(false);
    }

    const changes = JSON.stringify([
        {
            file: "ARCHITECTURE.md",
            action: "add",
            heading: "## Core",
            text: "## Core\nNew docs.",
            reason: "Describe the core",
        },
    ]);
    const proposal = writeDocsProposal(dir, changes, 12000, docsBaseHashes(dir), "head");
    expect(readFileSync(proposal, "utf8")).toContain("# Docs update proposal");
    expect(status()).toBe("?? .cortexkit/magic-context.jsonc\n");
});

test("a gitignore failure still preserves the historian diagnostic dump", async () => {
    const dir = createTestTempDirFromPath(join(tmpdir(), "mc-artifact-failure-"));
    dirs.push(dir);
    mkdirSync(join(dir, ".cortexkit/magic-context/.gitignore"), { recursive: true });
    await dump(dir);
    const historianDir = join(dir, ".cortexkit/magic-context/historian");
    expect(readdirSync(historianDir).some((name) => name.endsWith(".xml"))).toBe(true);
});
