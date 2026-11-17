import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
    docsBaseHashes,
    writeDocsProposal,
} from "../../features/magic-context/dreamer/docs-proposals";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage";
import { getHarness } from "../../shared/harness";
import { createTestTempDirFromPath, getOriginalTempDirForTests } from "../../shared/test-temp-dir";
import { runValidatedHistorianPass } from "./compartment-runner-historian";
import type { HiddenCompletionExecutor } from "./compartment-runner-types";

const dirs: string[] = [];
afterEach(() => {
    closeDatabase();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

let sessionCounter = 0;
/**
 * A session id no other test run shares, with its expected dump directory
 * spelled out independently of the production helper. The test preload moves
 * os.tmpdir() to a throwaway root; the directory is still removed after each
 * test so one test's dumps never show up in another's.
 */
function uniqueSession(): { sessionId: string; dumpDir: string } {
    sessionCounter += 1;
    const sessionId = `artifact-parent-${process.pid}-${Date.now()}-${sessionCounter}`;
    const dumpDir = join(tmpdir(), getHarness(), "magic-context", "historian", sessionId);
    dirs.push(dumpDir);
    return { sessionId, dumpDir };
}

async function dump(directory: string, parentSessionId: string) {
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
        parentSessionId,
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
])("historian dumps stay out of the project and docs proposals hide artifacts but not config (old shared file: %j)", async (shared) => {
    const dir = createTestTempDirFromPath(join(tmpdir(), "mc-artifact-git-"));
    dirs.push(dir);
    const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: dir, encoding: "utf8", windowsHide: true });
    git("init", "-q");
    mkdirSync(join(dir, ".cortexkit"));
    writeFileSync(join(dir, ".cortexkit/magic-context.jsonc"), "{}\n");
    if (shared) writeFileSync(join(dir, ".cortexkit/.gitignore"), shared);

    const { sessionId, dumpDir } = uniqueSession();
    await dump(dir, sessionId);
    const dumps = readdirSync(dumpDir).filter((name) => name.endsWith(".xml"));
    expect(dumps.some((name) => /^artifacts-initial-\d+\.xml$/.test(name))).toBe(true);
    expect(readFileSync(join(dumpDir, dumps[0]!), "utf8")).toContain("invalid XML");
    // The dump creates nothing in the project and leaves the old shared ignore
    // file exactly as it was.
    expect(existsSync(join(dir, ".cortexkit/magic-context"))).toBe(false);
    if (shared) {
        expect(readFileSync(join(dir, ".cortexkit/.gitignore"))).toEqual(Buffer.from(shared));
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
    const status = () => git("status", "--porcelain", "--untracked-files=all");
    expect(status()).toBe("?? .cortexkit/magic-context.jsonc\n");
    expect(readFileSync(join(dir, ".cortexkit/magic-context/.gitignore"), "utf8")).toBe("*\n");
    if (shared.includes("cortexkit:aft")) {
        expect(readFileSync(join(dir, ".cortexkit/.gitignore"))).toEqual(Buffer.from(sibling));
    } else {
        expect(existsSync(join(dir, ".cortexkit/.gitignore"))).toBe(false);
    }
});

test("a historian dump made by a test stays out of the machine's temp directory", async () => {
    const dir = createTestTempDirFromPath(join(tmpdir(), "mc-artifact-machine-tmp-"));
    dirs.push(dir);
    const { sessionId, dumpDir } = uniqueSession();
    const machineDumpDir = join(
        getOriginalTempDirForTests(),
        getHarness(),
        "magic-context",
        "historian",
        sessionId,
    );

    const result = await dump(dir, sessionId);

    expect(result.ok).toBe(false);
    expect(readdirSync(dumpDir).some((name) => name.endsWith(".xml"))).toBe(true);
    // CLI doctor tests count dumps in the machine's temp directory, so a test
    // that leaves one there changes their warning totals.
    expect(existsSync(machineDumpDir)).toBe(false);
});

test("a dump that cannot be written leaves the pass outcome and the project unchanged", async () => {
    const dir = createTestTempDirFromPath(join(tmpdir(), "mc-artifact-failure-"));
    dirs.push(dir);

    const writable = uniqueSession();
    const baseline = await dump(dir, writable.sessionId);
    expect(readdirSync(writable.dumpDir).some((name) => name.endsWith(".xml"))).toBe(true);

    // A file where the session's dump directory belongs makes every dump
    // write fail.
    const blocked = uniqueSession();
    mkdirSync(dirname(blocked.dumpDir), { recursive: true });
    writeFileSync(blocked.dumpDir, "not a directory");
    const result = await dump(dir, blocked.sessionId);

    expect(statSync(blocked.dumpDir).isFile()).toBe(true);
    expect(baseline.ok).toBe(false);
    expect(result.ok).toBe(false);
    if (baseline.ok || result.ok) return;
    expect({ error: result.error, failureReason: result.failureReason }).toEqual({
        error: baseline.error,
        failureReason: baseline.failureReason,
    });
    expect(existsSync(join(dir, ".cortexkit"))).toBe(false);
});
