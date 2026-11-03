import { openTestDb } from "../src/test-db";
/// <reference types="bun-types" />

/**
 * A real Pi host started in its home directory.
 *
 * The home directory is not a project: the identity resolver refuses it, so
 * nothing may be registered or keyed under an empty project name (dreamer,
 * embeddings, memory, search, session attribution). A Pi process also never
 * opens OpenCode's session store, even when one exists on the machine and the
 * shared context.db could name its sessions. The whole run lives under a
 * throwaway root; `lsof` on the host process shows which databases it holds.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeOpenCodeV1FixtureStore } from "../../plugin/src/hooks/magic-context/opencode-v1-store-fixture";
import { PiTestHarness } from "../src/pi-harness";
import { prepareContextDatabase } from "../src/prepare-context-db";

let pi: PiTestHarness | null = null;
const originalLogPath = process.env.MAGIC_CONTEXT_LOG_PATH;

afterAll(async () => {
    await pi?.dispose();
    if (originalLogPath === undefined) delete process.env.MAGIC_CONTEXT_LOG_PATH;
    else process.env.MAGIC_CONTEXT_LOG_PATH = originalLogPath;
});

/** Database files the process holds open, from `lsof -p <pid>`. */
function openDatabasePaths(pid: number): string[] {
    const output = execFileSync("lsof", ["-n", "-P", "-p", String(pid), "-F", "n"], {
        encoding: "utf8",
    });
    return output
        .split("\n")
        .filter((line) => line.startsWith("n"))
        .map((line) => line.slice(1))
        .filter((path) => /\.db(-wal|-shm)?$/.test(path));
}

describe("pi started in the home directory", () => {
    it.skipIf(process.platform === "win32")(
        "registers no project and never opens OpenCode's store",
        async () => {
            const root = realpathSync(mkdtempSync(join(tmpdir(), "mc-pi-home-")));
            const dataDir = join(root, "data");
            mkdirSync(dataDir, { recursive: true });
            // An OpenCode store with a large session from another project sits
            // exactly where a Pi process would look for it.
            const openCodeDbPath = join(dataDir, "opencode", "opencode.db");
            writeOpenCodeV1FixtureStore(openCodeDbPath, [
                {
                    sessionId: "ses_other_project",
                    turns: 400,
                    toolOutputChars: 8_000,
                    diagnosticsPerTool: 20,
                },
            ]);
            // The shared context.db names that session: message-index rows still
            // waiting for their timestamps, which the boot backfill fills from
            // OpenCode's store. Only an OpenCode process may do that.
            prepareContextDatabase(dataDir);
            const seed = openTestDb(join(dataDir, "cortexkit", "magic-context", "context.db"));
            try {
                const insertFts = seed.prepare(
                    "INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content) VALUES (?, ?, ?, 'user', ?)",
                );
                const insertMap = seed.prepare(
                    "INSERT INTO message_fts_rowid_map (session_id, message_ordinal, fts_rowid, message_time_ms) VALUES (?, ?, ?, NULL)",
                );
                for (let turn = 1; turn <= 20; turn += 1) {
                    const ordinal = turn * 2 - 1;
                    const messageId = `ses_other_project-u${String(turn).padStart(6, "0")}`;
                    const row = insertFts.run("ses_other_project", ordinal, messageId, `question ${turn}`);
                    insertMap.run("ses_other_project", ordinal, Number(row.lastInsertRowid));
                }
                // A fresh store marks the backfill done; reopen it for these rows.
                seed.prepare(
                    "UPDATE message_time_backfill_state SET cursor_session_id = '', cursor_ordinal = 0, completed = 0",
                ).run();
            } finally {
                seed.close();
            }
            const logPath = join(root, "magic-context.log");
            process.env.MAGIC_CONTEXT_LOG_PATH = logPath;

            pi = await PiTestHarness.create({
                sharedDataDir: dataDir,
                workdirIsHome: true,
                magicContextConfig: {
                    dreamer: { disable: false },
                    memory: {
                        enabled: true,
                        auto_promote: false,
                        auto_search: { enabled: true, min_prompt_chars: 5 },
                        git_commit_indexing: { enabled: true },
                    },
                },
            });
            const home = pi.env.baseDir;
            expect(pi.workdir).toBe(home);
            const pid = pi.hostPid;
            if (pid === undefined) throw new Error("Pi host pid unavailable");

            const seenDatabases = new Set<string>();
            const sample = () => {
                for (const path of openDatabasePaths(pid)) seenDatabases.add(path);
            };
            sample();
            const turn = await pi.sendPrompt("please summarise what you can see here", {
                timeoutMs: 120_000,
            });
            expect(turn.exitCode === null || turn.exitCode === 0).toBe(true);
            sample();
            // Background maintenance (the boot backfills, the dreamer startup
            // tick) waits out a fixed 120-second boot-quiet period; sample
            // until well past it so that work has run.
            const quietEndsAt = Date.now() + 130_000;
            while (Date.now() < quietEndsAt) {
                await Bun.sleep(5_000);
                sample();
            }

            const databases = [...seenDatabases].sort();
            console.log(`[lsof] Pi host ${pid} database files:\n  ${databases.join("\n  ")}`);
            // lsof works and sees the host's own store.
            expect(databases.some((path) => path.endsWith("context.db"))).toBe(true);
            // Every database the host touched is under the throwaway root.
            for (const path of databases) expect(path.startsWith(root)).toBe(true);
            // OpenCode's store was never opened.
            expect(databases.filter((path) => path.startsWith(openCodeDbPath))).toEqual([]);

            expect(existsSync(logPath)).toBe(true);
            const log = readFileSync(logPath, "utf8");
            expect(log).toContain("project=(none)");
            // The logger writes the home directory as "~".
            expect(log).toContain("no project identity for ~:");
            expect(log).toContain("dir=~");
            expect(log).not.toContain("registered embedding config for project");
            expect(log).not.toContain("[dreamer] registered project");

            const contextDb = openTestDb(pi.contextDbPath(), { readonly: true });
            try {
                const blank = contextDb
                    .prepare("SELECT COUNT(*) AS count FROM session_projects WHERE TRIM(project_path) = ''")
                    .get() as { count: number };
                expect(blank.count).toBe(0);
            } finally {
                contextDb.close();
            }
        },
        300_000,
    );
});
