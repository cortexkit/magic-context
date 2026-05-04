import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isOpenCodeAutoCompactionEnabled } from "./opencode-compaction-detector";
import * as configDir from "./opencode-config-dir";

describe("opencode-compaction-detector", () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = join("/tmp", `compaction-detector-test-${Date.now()}`);
        mkdirSync(join(tmpDir, ".opencode"), { recursive: true });
        delete process.env.OPENCODE_DISABLE_AUTOCOMPACT;
        spyOn(configDir, "getOpenCodeConfigPaths").mockReturnValue({
            configJson: join(tmpDir, "user-config", "opencode.json"),
            configJsonc: join(tmpDir, "user-config", "opencode.jsonc"),
        } as ReturnType<typeof configDir.getOpenCodeConfigPaths>);
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
        delete process.env.OPENCODE_DISABLE_AUTOCOMPACT;
    });

    describe("#given no config exists", () => {
        it("#then returns true (default: compaction enabled)", () => {
            const emptyDir = join("/tmp", `compaction-empty-${Date.now()}`);
            mkdirSync(emptyDir, { recursive: true });

            const result = isOpenCodeAutoCompactionEnabled(emptyDir);

            expect(result).toBe(true);
            rmSync(emptyDir, { recursive: true, force: true });
        });
    });

    describe("#given OPENCODE_DISABLE_AUTOCOMPACT env flag is set", () => {
        it("#then returns false", () => {
            process.env.OPENCODE_DISABLE_AUTOCOMPACT = "1";

            const result = isOpenCodeAutoCompactionEnabled(tmpDir);

            expect(result).toBe(false);
        });
    });

    describe("#given project config has compaction.auto = false", () => {
        it("#when opencode.json #then returns false", () => {
            writeFileSync(
                join(tmpDir, ".opencode", "opencode.json"),
                JSON.stringify({ compaction: { auto: false } }),
            );

            const result = isOpenCodeAutoCompactionEnabled(tmpDir);

            expect(result).toBe(false);
        });

        it("#when opencode.jsonc #then returns false", () => {
            writeFileSync(
                join(tmpDir, ".opencode", "opencode.jsonc"),
                `{
          // compaction disabled
          "compaction": { "auto": false }
        }`,
            );

            const result = isOpenCodeAutoCompactionEnabled(tmpDir);

            expect(result).toBe(false);
        });
    });

    describe("#given project config has compaction.auto = true", () => {
        it("#then returns true", () => {
            writeFileSync(
                join(tmpDir, ".opencode", "opencode.json"),
                JSON.stringify({ compaction: { auto: true } }),
            );

            const result = isOpenCodeAutoCompactionEnabled(tmpDir);

            expect(result).toBe(true);
        });
    });

    describe("#given project config has compaction.prune = true", () => {
        it("#then returns true (conflict enabled)", () => {
            writeFileSync(
                join(tmpDir, ".opencode", "opencode.json"),
                JSON.stringify({ compaction: { auto: false, prune: true } }),
            );

            const result = isOpenCodeAutoCompactionEnabled(tmpDir);

            expect(result).toBe(true);
        });
    });

    describe("#given project config has auto/prune both false", () => {
        it("#then returns false", () => {
            writeFileSync(
                join(tmpDir, ".opencode", "opencode.json"),
                JSON.stringify({ compaction: { auto: false, prune: false } }),
            );

            const result = isOpenCodeAutoCompactionEnabled(tmpDir);

            expect(result).toBe(false);
        });
    });

    describe("#given project config has only compaction.prune = false", () => {
        it("#then returns false", () => {
            writeFileSync(
                join(tmpDir, ".opencode", "opencode.json"),
                JSON.stringify({ compaction: { prune: false } }),
            );

            const result = isOpenCodeAutoCompactionEnabled(tmpDir);

            expect(result).toBe(false);
        });
    });

    describe("#given jsonc and json both exist", () => {
        it("#then jsonc takes precedence", () => {
            writeFileSync(
                join(tmpDir, ".opencode", "opencode.json"),
                JSON.stringify({ compaction: { auto: true } }),
            );
            writeFileSync(
                join(tmpDir, ".opencode", "opencode.jsonc"),
                `{ "compaction": { "auto": false } }`,
            );

            const result = isOpenCodeAutoCompactionEnabled(tmpDir);

            expect(result).toBe(false);
        });
    });

    describe("#given config exists but no compaction field", () => {
        it("#then returns true (default)", () => {
            writeFileSync(
                join(tmpDir, ".opencode", "opencode.json"),
                JSON.stringify({ model: "claude-opus-4-6" }),
            );

            const result = isOpenCodeAutoCompactionEnabled(tmpDir);

            expect(result).toBe(true);
        });
    });

    describe("#given env flag overrides config", () => {
        it("#then env flag wins even when config has auto: true", () => {
            process.env.OPENCODE_DISABLE_AUTOCOMPACT = "true";
            writeFileSync(
                join(tmpDir, ".opencode", "opencode.json"),
                JSON.stringify({ compaction: { auto: true } }),
            );

            const result = isOpenCodeAutoCompactionEnabled(tmpDir);

            expect(result).toBe(false);
        });
    });

    describe("#given root-level project config", () => {
        it("#when root opencode.json has compaction.auto = false #then returns false", () => {
            writeFileSync(
                join(tmpDir, "opencode.json"),
                JSON.stringify({ compaction: { auto: false } }),
            );

            const result = isOpenCodeAutoCompactionEnabled(tmpDir);

            expect(result).toBe(false);
        });

        it("#when root opencode.jsonc has compaction.auto = false #then returns false", () => {
            writeFileSync(join(tmpDir, "opencode.jsonc"), `{ "compaction": { "auto": false } }`);

            const result = isOpenCodeAutoCompactionEnabled(tmpDir);

            expect(result).toBe(false);
        });
    });

    describe("#given .opencode/ overrides root-level config", () => {
        it("#when root says false but .opencode says true #then .opencode wins", () => {
            writeFileSync(
                join(tmpDir, "opencode.json"),
                JSON.stringify({ compaction: { auto: false } }),
            );
            writeFileSync(
                join(tmpDir, ".opencode", "opencode.json"),
                JSON.stringify({ compaction: { auto: true } }),
            );

            const result = isOpenCodeAutoCompactionEnabled(tmpDir);

            expect(result).toBe(true);
        });

        it("#when root says true but .opencode says false #then .opencode wins", () => {
            writeFileSync(
                join(tmpDir, "opencode.json"),
                JSON.stringify({ compaction: { auto: true } }),
            );
            writeFileSync(
                join(tmpDir, ".opencode", "opencode.json"),
                JSON.stringify({ compaction: { auto: false } }),
            );

            const result = isOpenCodeAutoCompactionEnabled(tmpDir);

            expect(result).toBe(false);
        });
    });
});
