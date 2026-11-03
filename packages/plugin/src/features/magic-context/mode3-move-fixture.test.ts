/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTestTempDir, createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { buildMode3MoveFixture } from "./__tests__/mode3-move-fixture";

const FIXTURE_PATH = join(
    import.meta.dir,
    "../../../test-fixtures/runtime/mode3_move_fixture.json",
);
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const dirs: string[] = [];

afterEach(() => {
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of dirs.splice(0)) cleanupTestTempDir(dir);
});

describe("mode 3 offline-move fixture", () => {
    it("is what the standalone plugin writes today", async () => {
        const dir = createTestTempDirFromPath(join(tmpdir(), "mode3-move-fixture-"));
        dirs.push(dir);
        process.env.XDG_DATA_HOME = dir;
        mkdirSync(join(dir, "opencode"), { recursive: true });
        const fixture = await buildMode3MoveFixture(dir);
        // Twenty counted parts get a tag: every text, completed tool and file part.
        expect(fixture.expected.tag_checkpoint).toBe(20);
        expect(fixture.context.tags).toHaveLength(20);
        expect(fixture.expected.cut).toBe("msg_m005");
        const rendered = `${JSON.stringify(fixture, null, 2)}\n`;
        if (process.env.UPDATE_MODE3_MOVE_FIXTURE === "1") writeFileSync(FIXTURE_PATH, rendered);
        // Regenerate with UPDATE_MODE3_MOVE_FIXTURE=1 when standalone's writers change.
        expect(readFileSync(FIXTURE_PATH, "utf8")).toBe(rendered);
    });
});
