import { expect, test } from "bun:test";
import type { HiddenCompletionExecutor } from "../../../hooks/magic-context/compartment-runner-types";
import { Database } from "../../../shared/sqlite";
import { insertMemory } from "../memory/storage-memory";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { runClassify } from "./classify";
import { acquireLease } from "./lease";

test("s02 review: first upgrade classification scans the full backlog in 100-row model calls", async () => {
    const db = new Database(":memory:");
    try {
        initializeDatabase(db);
        runMigrations(db);
        const project = "git:s02-upgrade";
        for (let i = 0; i < 1001; i++)
            insertMemory(db, {
                projectPath: project,
                category: "PROJECT_RULES",
                content: `Never push without approval: rule ${i}.`,
            });
        db.exec("UPDATE memories SET importance=40,classified_at=7,scope='ecosystem',shareable=0");
        db.exec(
            "ALTER TABLE memories DROP COLUMN safety_critical; DELETE FROM schema_migrations WHERE version=104",
        );
        runMigrations(db);
        const chunks: number[] = [];
        let inputChars = 0;
        let outputChars = 0;
        let text = "";
        const executor: HiddenCompletionExecutor = {
            capabilities: { tools: false, harness: "opencode2" },
            open: async () => ({ id: "s02-upgrade" }),
            attempt: async (_handle, request) => {
                const prompt = (request.body?.parts as Array<{ text?: string }>)[0].text!;
                const pool = prompt.split("### Memory pool to classify")[1];
                const ids = [...pool.matchAll(/^\[(\d+)\]/gm)].map((m) => Number(m[1]));
                chunks.push(ids.length);
                inputChars +=
                    prompt.length +
                    (typeof request.body?.system === "string" ? request.body.system.length : 0);
                text = `<classify>${ids.map((id) => `<memory id="${id}" importance="1" scope="universe" safety_critical="true"/>`).join("")}</classify>`;
                outputChars += text.length;
            },
            collect: async () => ({
                text,
                reasoning: null,
                lengthCapped: false,
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            }),
            close: async () => {},
        };
        const holderId = "s02-upgrade";
        const leaseKey = "s02-upgrade";
        expect(acquireLease(db, holderId, leaseKey)).toBe(true);
        const args = {
            db,
            projectIdentity: project,
            holderId,
            leaseKey,
            parentSessionId: "s02",
            sessionDirectory: process.cwd(),
            deadline: Date.now() + 60_000,
            hiddenCompletionExecutor: executor,
        };
        expect(await runClassify(args)).toMatchObject({
            stage: 3,
            classified: 1001,
            chunks: 11,
            remaining: 0,
            complete: true,
        });
        expect(chunks).toEqual([...Array(10).fill(100), 1]);
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) n FROM memories WHERE safety_critical=1 AND importance=80 AND scope='ecosystem' AND shareable=0 AND classified_at=7",
                )
                .get(),
        ).toEqual({ n: 1001 });
        expect(await runClassify(args)).toMatchObject({ classified: 0, chunks: 0 });
        console.log(
            `s02 upgrade: 1001 previously-classified rows, 11 calls, prompt_chars=${inputChars}, response_chars=${outputChars}; second run=0 calls (stub usage, no paid model)`,
        );
    } finally {
        db.close();
    }
}, 30_000);
