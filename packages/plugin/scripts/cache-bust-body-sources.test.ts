import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../src/shared/test-temp-dir";
import { resolvePiBodiesDirectory } from "./cache-bust-body-sources";

const temporaryDirectories: string[] = [];

function fixture(): { root: string; sessionPath: string; bodies: string } {
    const root = createTestTempDirFromPath(join(tmpdir(), "pi-body-cwd-"));
    temporaryDirectories.push(root);
    const bodies = join(root, ".pi", "pi-llm-debugging", "session");
    fs.mkdirSync(bodies, { recursive: true });
    return { root, sessionPath: join(root, "session.jsonl"), bodies };
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("Pi body directory uses the first header cwd and stops before the rest of a 300 MiB session", () => {
    const { root, sessionPath, bodies } = fixture();
    fs.writeFileSync(
        sessionPath,
        `${JSON.stringify({ type: "session", cwd: root })}\n{malformed\n`,
    );
    fs.truncateSync(sessionPath, 300 * 1024 * 1024);
    const read = spyOn(fs, "readSync");
    const close = spyOn(fs, "closeSync");
    try {
        expect(resolvePiBodiesDirectory("session", sessionPath)).toBe(bodies);
        expect(read).toHaveBeenCalledTimes(1);
        expect(read.mock.results[0].value).toBe(8 * 1024 * 1024);
        expect(close).toHaveBeenCalledTimes(1);
    } finally {
        read.mockRestore();
        close.mockRestore();
    }
});

test("Pi body directory skips blank lines, tolerates CRLF, and does not replace the first header cwd", () => {
    const { root, sessionPath, bodies } = fixture();
    fs.writeFileSync(
        sessionPath,
        [
            "",
            "  ",
            JSON.stringify({ type: "title", title: "session" }),
            JSON.stringify({ type: "session", cwd: root }),
            JSON.stringify({ type: "session", cwd: join(root, "other") }),
        ].join("\r\n"),
    );
    expect(resolvePiBodiesDirectory("session", sessionPath)).toBe(bodies);
});

test("Pi body directory aborts at malformed JSON instead of accepting a later cwd", () => {
    const { root, sessionPath } = fixture();
    fs.writeFileSync(sessionPath, `{malformed\n${JSON.stringify({ type: "session", cwd: root })}`);
    expect(resolvePiBodiesDirectory("session", sessionPath)).toBeUndefined();
});

test("Pi body directory decodes a split UTF-8 cwd and an unterminated final header", () => {
    const { root, sessionPath } = fixture();
    const cwd = join(root, "東京😀");
    const bodies = join(cwd, ".pi", "pi-llm-debugging", "session");
    fs.mkdirSync(bodies, { recursive: true });
    const header = JSON.stringify({ type: "session", cwd });
    const beforeCharacter = header.slice(0, header.indexOf("東"));
    const padding = " ".repeat(8 * 1024 * 1024 - 1 - Buffer.byteLength(beforeCharacter));
    fs.writeFileSync(sessionPath, padding + header);
    expect(resolvePiBodiesDirectory("session", sessionPath)).toBe(bodies);
});
