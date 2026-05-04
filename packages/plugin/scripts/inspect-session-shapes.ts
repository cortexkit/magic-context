#!/usr/bin/env bun
import { Database } from "../src/shared/sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const opencodeDbPath = join(homedir(), ".local", "share", "opencode", "opencode.db");
const piSessionsDir = join(homedir(), ".pi", "agent", "sessions");

function inspectOpenCode(): void {
    if (!existsSync(opencodeDbPath)) {
        console.log(`OpenCode DB not found: ${opencodeDbPath}`);
        return;
    }

    const db = new Database(opencodeDbPath, { readonly: true });
    const sessions = db
        .prepare(`
            SELECT id, title, directory,
                   (SELECT COUNT(*) FROM message WHERE session_id = s.id) AS message_count
            FROM session s
            ORDER BY message_count DESC
            LIMIT 5
        `)
        .all();
    console.log("Largest OpenCode sessions:");
    console.table(sessions);

    const sessionId = (sessions[0] as { id?: string } | undefined)?.id;
    if (!sessionId) return;

    const rows = db
        .prepare("SELECT data FROM part WHERE session_id = ? ORDER BY time_created, id LIMIT 10000")
        .all(sessionId) as Array<{ data: string }>;
    const counts = new Map<string, number>();
    const samples = new Map<string, unknown>();
    for (const row of rows) {
        const parsed = JSON.parse(row.data) as { type?: string };
        const type = parsed.type ?? "<missing>";
        counts.set(type, (counts.get(type) ?? 0) + 1);
        if (!samples.has(type)) samples.set(type, parsed);
    }
    console.log(`Part type counts for ${sessionId}:`);
    console.table([...counts.entries()].map(([type, count]) => ({ type, count })));
    console.log("Part samples:");
    for (const [type, sample] of samples) {
        console.log(`\n[${type}] ${JSON.stringify(sample).slice(0, 1000)}`);
    }
}

function walkJsonlFiles(dir: string, out: string[] = []): string[] {
    if (!existsSync(dir)) return out;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walkJsonlFiles(path, out);
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(path);
    }
    return out;
}

function inspectPi(): void {
    const files = walkJsonlFiles(piSessionsDir).slice(0, 20);
    console.log("Pi JSONL files:");
    console.table(files.map((path) => ({ path })));
    for (const file of files) {
        const lines = readFileSync(file, "utf-8").trim().split("\n").filter(Boolean);
        const types = new Set<string>();
        for (const line of lines) {
            const parsed = JSON.parse(line) as { type?: string };
            types.add(parsed.type ?? "<missing>");
        }
        console.log(`\n${file}`);
        console.log(`Entry types: ${[...types].join(", ")}`);
        for (const line of lines.slice(0, 5)) console.log(line.slice(0, 1000));
    }
}

inspectOpenCode();
inspectPi();
