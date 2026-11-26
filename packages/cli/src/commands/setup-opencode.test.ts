import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openCodeHostGenerationFromVersion } from "@magic-context/core/shared/opencode-db-path";
import { parse as parseJsonc } from "comment-json";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import {
    addPluginToOpenCodeConfig,
    addPluginToTuiConfig,
    applyOpenCodeSetupConfigs,
    findDcpPluginEntries,
    findDcpPluginIndexes,
    writeMagicContextConfig,
} from "./setup-opencode";

const tempDirs: string[] = [];

function tempDir(): string {
    const path = createTestTempDirFromPath(join(tmpdir(), "mc-opencode-setup-"));
    tempDirs.push(path);
    return path;
}

afterEach(() => {
    for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("setup-opencode config safety", () => {
    it("leaves malformed existing config unchanged", () => {
        const path = join(tempDir(), "magic-context.jsonc");
        const malformed = `{\n  "historian": {\n`;
        writeFileSync(path, malformed);

        expect(() =>
            writeMagicContextConfig(path, {
                historianModel: "anthropic/claude-sonnet-4-6",
                dreamerEnabled: false,
                dreamerModel: null,
                claudeMax: false,
            }),
        ).toThrow(`Refusing to overwrite unparseable config ${path}`);
        expect(readFileSync(path, "utf-8")).toBe(malformed);
    });

    it("re-detects targets created after discovery and merges them", () => {
        const root = tempDir();
        const opencodePath = join(root, "opencode.jsonc");
        const tuiPath = join(root, "tui.jsonc");
        writeFileSync(opencodePath, `{"theme":"dark","plugin":["other"]}`);
        writeFileSync(tuiPath, `{"layout":"wide","plugin":["other-tui"]}`);

        // "none" is the stale pre-prompt detection result.
        addPluginToOpenCodeConfig(opencodePath, "none");
        addPluginToTuiConfig(tuiPath, "none");

        expect(parseJsonc(readFileSync(opencodePath, "utf-8"))).toMatchObject({
            theme: "dark",
            plugin: ["other", "@cortexkit/opencode-magic-context@latest"],
        });
        expect(parseJsonc(readFileSync(tuiPath, "utf-8"))).toMatchObject({
            layout: "wide",
            plugin: ["other-tui", "@cortexkit/opencode-magic-context@latest"],
        });
    });

    it("creates a missing config and merges a valid config", () => {
        const root = tempDir();
        const missingPath = join(root, "opencode.json");
        addPluginToOpenCodeConfig(missingPath, "none");
        expect(parseJsonc(readFileSync(missingPath, "utf-8"))).toMatchObject({
            compaction: { auto: false, prune: false },
        });

        const validPath = join(root, "existing.jsonc");
        writeFileSync(
            validPath,
            `{"theme":"dark","plugin":["other","@tarquinen/opencode-dcp@latest"]}`,
        );
        addPluginToOpenCodeConfig(validPath, "jsonc", true);
        const merged = parseJsonc(readFileSync(validPath, "utf-8")) as {
            theme?: string;
            plugin?: string[];
            compaction?: { auto?: boolean; prune?: boolean };
        };
        expect(merged).toMatchObject({
            theme: "dark",
            compaction: { auto: false, prune: false },
        });
        expect(merged.plugin).toContain("other");
        expect(merged.plugin).not.toContain("@tarquinen/opencode-dcp@latest");
    });
});

describe("setup-opencode per-harness config", () => {
    it("writes fresh OpenCode choices only inside OpenCode harness blocks", () => {
        const path = join(tempDir(), "magic-context.jsonc");

        writeMagicContextConfig(path, {
            historianModel: "fresh/historian",
            dreamerEnabled: true,
            dreamerModel: "fresh/dreamer",
            claudeMax: false,
        });

        const config = parseJsonc(readFileSync(path, "utf-8")) as {
            historian?: { model?: string; opencode?: { model?: string } };
            dreamer?: { model?: string; opencode?: { model?: string } };
        };
        expect(config.historian?.opencode?.model).toBe("fresh/historian");
        expect(config.historian).not.toHaveProperty("model");
        expect(config.dreamer?.opencode?.model).toBe("fresh/dreamer");
        expect(config.dreamer).not.toHaveProperty("model");
    });

    it("migrates flat fields through the shared raw loader before writing OpenCode choices", () => {
        const path = join(tempDir(), "magic-context.jsonc");
        writeFileSync(
            path,
            JSON.stringify({
                historian: { model: "legacy/historian" },
                dreamer: {
                    model: "legacy/dreamer",
                    tasks: { curate: { schedule: "0 3 * * *" } },
                },
            }),
        );

        writeMagicContextConfig(path, {
            historianModel: "new/historian",
            dreamerEnabled: true,
            dreamerModel: "new/dreamer",
            claudeMax: false,
        });

        const config = parseJsonc(readFileSync(path, "utf-8")) as {
            historian?: {
                model?: string;
                opencode?: { model?: string };
                pi?: { model?: string };
            };
            dreamer?: {
                model?: string;
                opencode?: { model?: string };
                pi?: { model?: string };
                tasks?: { curate?: { schedule?: string } };
            };
        };
        expect(config.historian?.opencode?.model).toBe("new/historian");
        expect(config.historian?.pi?.model).toBe("legacy/historian");
        expect(config.historian).not.toHaveProperty("model");
        expect(config.dreamer?.opencode?.model).toBe("new/dreamer");
        expect(config.dreamer?.pi?.model).toBe("legacy/dreamer");
        expect(config.dreamer?.tasks?.curate?.schedule).toBe("0 3 * * *");
        expect(config.dreamer).not.toHaveProperty("model");
    });
});

/** The retired agent's config key, spelled the way the source fence test requires. */
const RETIRED_AGENT_KEY = ["side", "kick"].join("");

describe("setup-opencode keeps magic-context.jsonc comments", () => {
    it("retains top-level, nested and trailing comments when rewriting choices", () => {
        const path = join(tempDir(), "magic-context.jsonc");
        writeFileSync(
            path,
            `{
  // why this historian
  "historian": {
    // pinned for cost
    "opencode": { "model": "old/historian" } // trailing note
  },
  /* keep the dreamer */
  "dreamer": { "opencode": { "model": "old/dreamer" } },
  "${RETIRED_AGENT_KEY}": { "enabled": true }
}
`,
        );

        writeMagicContextConfig(path, {
            historianModel: "new/historian",
            dreamerEnabled: true,
            dreamerModel: "new/dreamer",
            claudeMax: false,
        });

        const text = readFileSync(path, "utf-8");
        for (const comment of [
            "// why this historian",
            "// pinned for cost",
            "// trailing note",
            "/* keep the dreamer */",
        ]) {
            expect(text).toContain(comment);
        }
        const config = parseJsonc(text) as Record<string, unknown> & {
            historian?: { opencode?: { model?: string } };
            dreamer?: { opencode?: { model?: string } };
        };
        expect(config.historian?.opencode?.model).toBe("new/historian");
        expect(config.dreamer?.opencode?.model).toBe("new/dreamer");
        // The retired agent block is still removed.
        expect(config).not.toHaveProperty(RETIRED_AGENT_KEY);
    });

    it("still refuses a prototype-pollution key", () => {
        const path = join(tempDir(), "magic-context.jsonc");
        const original = `{ "__proto__": { "polluted": true } }\n`;
        writeFileSync(path, original);
        expect(() =>
            writeMagicContextConfig(path, {
                historianModel: "new/historian",
                dreamerEnabled: false,
                dreamerModel: null,
                claudeMax: false,
            }),
        ).toThrow(/prototype-pollution/);
        expect(readFileSync(path, "utf-8")).toBe(original);
    });
});

describe("setup-opencode DCP preflight", () => {
    it("is tuple-safe and only matches canonical opencode-dcp entries", () => {
        const plugins: unknown[] = [
            ["@plannotator/opencode@latest", { workflow: "plan-agent" }],
            "@some-fork/opencode-dcp-fork",
            ["@tarquinen/opencode-dcp@latest", { enabled: true }],
            "file:///tmp/opencode-dcp-dev",
        ];

        expect(() => findDcpPluginIndexes(plugins)).not.toThrow();
        expect(findDcpPluginIndexes(plugins)).toEqual([2]);
    });
});

// --- Compaction-off mode writer (issue #266 S2) ---
// In compaction-off mode the setup writer MUST NOT write
// compaction.auto=false / compaction.prune=false into opencode.jsonc —
// native compaction (or nothing) is the user's chosen window manager, so
// pre-existing native compaction fields are left byte-for-byte as found.
describe("setup-opencode compaction-off writer (issue #266)", () => {
    it("skips the compaction.auto=false write when compactionEnabled=false", () => {
        const root = tempDir();
        const configPath = join(root, "opencode.jsonc");
        writeFileSync(configPath, JSON.stringify({ compaction: { auto: true, prune: true } }));

        addPluginToOpenCodeConfig(configPath, "jsonc", false, false);

        const merged = parseJsonc(readFileSync(configPath, "utf-8")) as {
            compaction?: { auto?: boolean; prune?: boolean };
        };
        // Pre-existing native compaction values preserved byte-for-byte.
        expect(merged.compaction).toEqual({ auto: true, prune: true });
    });

    it("writes compaction.auto=false when compactionEnabled=true (default mode-on)", () => {
        const root = tempDir();
        const configPath = join(root, "opencode.jsonc");
        writeFileSync(configPath, JSON.stringify({ compaction: { auto: true, prune: true } }));

        addPluginToOpenCodeConfig(configPath, "jsonc", false, true);

        const merged = parseJsonc(readFileSync(configPath, "utf-8")) as {
            compaction?: { auto?: boolean; prune?: boolean };
        };
        expect(merged.compaction).toEqual({ auto: false, prune: false });
    });

    it("does not create a compaction block when compactionEnabled=false and none exists", () => {
        const root = tempDir();
        const configPath = join(root, "opencode.jsonc");
        addPluginToOpenCodeConfig(configPath, "jsonc", false, false);

        const merged = parseJsonc(readFileSync(configPath, "utf-8")) as {
            compaction?: unknown;
        };
        expect(merged.compaction).toBeUndefined();
    });

    // Mutation direction: with mode ON, the write DOES happen. Proves the
    // off-gate isn't just always-skip.
    it("mutation direction: same config gets auto=false when mode forced on", () => {
        const root = tempDir();
        const configPath = join(root, "opencode.jsonc");
        writeFileSync(configPath, JSON.stringify({ compaction: { auto: true } }));

        addPluginToOpenCodeConfig(configPath, "jsonc", false, false);
        const afterOff = parseJsonc(readFileSync(configPath, "utf-8")) as {
            compaction?: { auto?: boolean };
        };
        expect(afterOff.compaction?.auto).toBe(true);

        addPluginToOpenCodeConfig(configPath, "jsonc", false, true);
        const afterOn = parseJsonc(readFileSync(configPath, "utf-8")) as {
            compaction?: { auto?: boolean };
        };
        expect(afterOn.compaction?.auto).toBe(false);
    });
});

describe("setup-opencode JSONC byte preservation", () => {
    it("removes DCP and updates compaction without reformatting the existing config", () => {
        const configPath = join(tempDir(), "opencode.jsonc");
        const original =
            "// leading comment\r\n" +
            "{\r\n" +
            '\t"plugin": [\r\n' +
            "\t\t// first plugin\r\n" +
            '\t\t"@keep/first",\r\n' +
            "\t\t// removed DCP plugin\r\n" +
            '\t\t"@tarquinen/opencode-dcp@latest",\r\n' +
            "\t\t// Magic Context stays\r\n" +
            '\t\t"@cortexkit/opencode-magic-context@latest",\r\n' +
            "\t], // array comment\r\n" +
            '\t"compaction": {\r\n' +
            "\t\t// preserve nested comment\r\n" +
            '\t\t"auto": true,\r\n' +
            '\t\t"prune": true,\r\n' +
            "\t},\r\n" +
            '\t"theme": "dark",\r\n' +
            "}\r\n";
        const expected =
            "// leading comment\r\n" +
            "{\r\n" +
            '\t"plugin": [\r\n' +
            "\t\t// first plugin\r\n" +
            '\t\t"@keep/first",\r\n' +
            "\t\t// Magic Context stays\r\n" +
            '\t\t"@cortexkit/opencode-magic-context@latest",\r\n' +
            "\t], // array comment\r\n" +
            '\t"compaction": {\r\n' +
            "\t\t// preserve nested comment\r\n" +
            '\t\t"auto": false,\r\n' +
            '\t\t"prune": false,\r\n' +
            "\t},\r\n" +
            '\t"theme": "dark",\r\n' +
            "}\r\n";
        writeFileSync(configPath, original);

        addPluginToOpenCodeConfig(configPath, "jsonc", true);

        expect(readFileSync(configPath, "utf-8")).toBe(expected);
        expect(readFileSync(configPath, "utf-8")).not.toContain("removed DCP plugin");
    });
});

// OpenCode 2 loads both the legacy `plugin` and the native `plugins` array, so
// setup must recognise a registration under either and write new entries under
// the running generation's own key; otherwise the plugin loads twice.
describe("setup-opencode plugin key across host generations", () => {
    it("writes a fresh v2 registration under `plugins`, never `plugin`", () => {
        const path = join(tempDir(), "opencode.json");
        writeFileSync(path, `{"model":"openai/x"}`);
        addPluginToOpenCodeConfig(path, "json", false, true, "v2");
        const config = parseJsonc(readFileSync(path, "utf-8")) as Record<string, unknown>;
        expect(config.plugin).toBeUndefined();
        expect(config.plugins).toEqual(["@cortexkit/opencode-magic-context@latest"]);
        expect(config.compaction).toEqual({ auto: false, prune: false, background: false });
    });

    it("leaves a checkout registered under `plugins` alone on a v2 host", () => {
        const path = join(tempDir(), "opencode.json");
        const checkout = resolve(import.meta.dir, "../../../plugin");
        writeFileSync(path, JSON.stringify({ plugins: [checkout] }));
        addPluginToOpenCodeConfig(path, "json", false, true, "v2");
        const config = parseJsonc(readFileSync(path, "utf-8")) as Record<string, unknown>;
        expect(config.plugins).toEqual([checkout]);
        expect(config.plugin).toBeUndefined();
    });

    it("creates a v2 config with the `plugins` key", () => {
        const path = join(tempDir(), "opencode.json");
        addPluginToOpenCodeConfig(path, "none", false, true, "v2");
        const config = parseJsonc(readFileSync(path, "utf-8")) as Record<string, unknown>;
        expect(config.plugins).toEqual(["@cortexkit/opencode-magic-context@latest"]);
        expect(config.plugin).toBeUndefined();
        expect(config.compaction).toEqual({ auto: false, prune: false, background: false });
    });

    it("keeps the singular `plugin` key on a v1 host", () => {
        const path = join(tempDir(), "opencode.json");
        writeFileSync(path, `{"model":"openai/x"}`);
        addPluginToOpenCodeConfig(path, "json", false, true, "v1");
        const config = parseJsonc(readFileSync(path, "utf-8")) as Record<string, unknown>;
        expect(config.plugin).toEqual(["@cortexkit/opencode-magic-context@latest"]);
        expect(config.plugins).toBeUndefined();
        expect(config.compaction).toEqual({ auto: false, prune: false });
    });
});

describe("setup-opencode background compaction", () => {
    const configWith = (fields: string) =>
        `{\n  "plugins": ["@cortexkit/opencode-magic-context@latest"],\n  "compaction": { ${fields} }\n}\n`;

    it.each([
        "2.0.22",
        "2.1.0",
        "2.3.1",
        "2.4.2",
    ])("adds background: false on OpenCode %s even if auto is already off", (version) => {
        const path = join(tempDir(), "opencode.jsonc");
        writeFileSync(path, configWith('"auto": false, "prune": false'));

        addPluginToOpenCodeConfig(
            path,
            "jsonc",
            false,
            true,
            openCodeHostGenerationFromVersion(version),
        );

        expect(parseJsonc(readFileSync(path, "utf-8"))).toMatchObject({
            compaction: { auto: false, prune: false, background: false },
        });
    });

    it("switches an explicit background setting off without changing comments or other keys", () => {
        const path = join(tempDir(), "opencode.jsonc");
        const original = `\uFEFF{\n  "plugins": ["@cortexkit/opencode-magic-context@latest"],\n  "compaction": {\n    // keep the custom buffer\n    "buffer": 934,\n    "auto": false,\n    "prune": false,\n    "background": true // host setting\n  },\n  "model": "provider/model"\n}\n`;
        writeFileSync(path, original);

        addPluginToOpenCodeConfig(path, "jsonc", false, true, "v2");

        expect(readFileSync(path, "utf-8")).toBe(
            original.replace('"background": true', '"background": false'),
        );
    });

    it.each([
        [true, '"auto": false, "prune": false, "background": false'],
        [false, '"auto": true, "prune": true, "background": true'],
        [false, '"auto": true, "prune": true'],
    ] as const)("leaves the existing file unchanged when Magic Context compaction is %s and nothing needs repair", (enabled, fields) => {
        const path = join(tempDir(), "opencode.jsonc");
        const original = configWith(fields);
        writeFileSync(path, original);

        addPluginToOpenCodeConfig(path, "jsonc", false, enabled, "v2");

        expect(readFileSync(path, "utf-8")).toBe(original);
    });

    it("does not add a compaction block in compaction-off mode", () => {
        const path = join(tempDir(), "opencode.jsonc");
        addPluginToOpenCodeConfig(path, "none", false, false, "v2");
        expect(parseJsonc(readFileSync(path, "utf-8"))).not.toHaveProperty("compaction");
    });
});

describe("setup-opencode Claude Max cache TTL", () => {
    it("keeps a string cache_ttl as the default when adding the Claude Max overrides", () => {
        const path = join(tempDir(), "magic-context.jsonc");
        writeFileSync(path, `{ "cache_ttl": "1h" }\n`);

        writeMagicContextConfig(path, {
            historianModel: null,
            dreamerEnabled: false,
            dreamerModel: null,
            claudeMax: true,
        });

        const config = parseJsonc(readFileSync(path, "utf-8")) as { cache_ttl?: unknown };
        expect(config.cache_ttl).toEqual({
            default: "1h",
            "anthropic/claude-sonnet-4-6": "59m",
            "anthropic/claude-opus-4-6": "59m",
        });
    });
});

describe("setup-opencode byte-order mark", () => {
    const BOM = "\uFEFF";

    it("adds the plugin to an opencode.jsonc that starts with a BOM", () => {
        const path = join(tempDir(), "opencode.jsonc");
        writeFileSync(path, `${BOM}{\n  // mine\n  "plugin": ["other"]\n}\n`);

        addPluginToOpenCodeConfig(path, "jsonc", false, false, "v1");

        const text = readFileSync(path, "utf-8");
        expect(text.startsWith(BOM)).toBe(true);
        expect(text).toContain("// mine");
        expect((parseJsonc(text) as { plugin?: unknown[] }).plugin).toEqual([
            "other",
            "@cortexkit/opencode-magic-context@latest",
        ]);
    });

    it("adds the plugin to a tui.jsonc that starts with a BOM", () => {
        const path = join(tempDir(), "tui.jsonc");
        writeFileSync(path, `${BOM}{\n  "theme": "dark"\n}\n`);

        addPluginToTuiConfig(path, "jsonc");

        const text = readFileSync(path, "utf-8");
        expect(text.startsWith(BOM)).toBe(true);
        expect((parseJsonc(text) as { plugin?: unknown[] }).plugin).toEqual([
            "@cortexkit/opencode-magic-context@latest",
        ]);
    });
});

describe("applyOpenCodeSetupConfigs", () => {
    function targets() {
        const dir = tempDir();
        const paths = {
            opencodeConfig: join(dir, "opencode.jsonc"),
            magicContextConfig: join(dir, "magic-context.jsonc"),
            tuiConfig: join(dir, "tui.jsonc"),
        };
        writeFileSync(paths.opencodeConfig, `{\n  "plugin": []\n}\n`);
        writeFileSync(paths.tuiConfig, `\uFEFF{\n  "theme": "dark"\n}\n`);
        return paths;
    }
    const choices = {
        removeDcp: false,
        compactionEnabled: true,
        hostGeneration: "v1" as const,
        magicContext: {
            historianModel: "a/historian",
            dreamerEnabled: false,
            dreamerModel: null,
            claudeMax: true,
        },
    };

    it("writes all three configs, including a BOM-prefixed tui.jsonc", () => {
        const paths = targets();
        applyOpenCodeSetupConfigs(paths, choices);

        expect(readFileSync(paths.opencodeConfig, "utf-8")).toContain(
            "@cortexkit/opencode-magic-context@latest",
        );
        expect(readFileSync(paths.tuiConfig, "utf-8")).toContain(
            "@cortexkit/opencode-magic-context@latest",
        );
        expect(
            (
                parseJsonc(readFileSync(paths.magicContextConfig, "utf-8")) as {
                    historian?: { opencode?: { model?: string } };
                }
            ).historian?.opencode?.model,
        ).toBe("a/historian");
    });

    it("writes nothing when one config cannot be updated", () => {
        const paths = targets();
        // An array cache_ttl cannot take per-model overrides; setup must stop
        // before opencode.jsonc is changed, not after.
        const magicContext = `{ "cache_ttl": ["5m"] }\n`;
        writeFileSync(paths.magicContextConfig, magicContext);
        const before = [paths.opencodeConfig, paths.tuiConfig].map((path) =>
            readFileSync(path, "utf-8"),
        );

        expect(() => applyOpenCodeSetupConfigs(paths, choices)).toThrow(/cache_ttl/);

        expect(
            [paths.opencodeConfig, paths.tuiConfig].map((path) => readFileSync(path, "utf-8")),
        ).toEqual(before);
        expect(readFileSync(paths.magicContextConfig, "utf-8")).toBe(magicContext);
    });
});

describe("setup-opencode relative development checkout", () => {
    it("does not add the npm entry next to a checkout registered relative to the config", () => {
        const configDir = tempDir();
        const elsewhere = tempDir();
        mkdirSync(join(configDir, "mc", "plugin"), { recursive: true });
        writeFileSync(
            join(configDir, "mc", "plugin", "package.json"),
            JSON.stringify({ name: "@cortexkit/opencode-magic-context" }),
        );
        const path = join(configDir, "opencode.jsonc");
        const original = `{\n  "plugin": ["./mc/plugin"],\n  "compaction": { "auto": false, "prune": false }\n}\n`;
        writeFileSync(path, original);
        const originalCwd = process.cwd();
        process.chdir(elsewhere);
        try {
            addPluginToOpenCodeConfig(path, "jsonc", false, true, "v1");
        } finally {
            process.chdir(originalCwd);
        }
        expect(readFileSync(path, "utf-8")).toBe(original);
    });
});

describe("setup-opencode DCP detection across plugin keys", () => {
    it("finds opencode-dcp registered under the OpenCode 2 `plugins` key", () => {
        expect(
            findDcpPluginEntries({
                plugin: ["@cortexkit/opencode-magic-context@latest"],
                plugins: [{ package: "@tarquinen/opencode-dcp@latest" }],
            }),
        ).toEqual([{ package: "@tarquinen/opencode-dcp@latest" }]);
        expect(findDcpPluginEntries({ plugin: ["@tarquinen/opencode-dcp"] })).toEqual([
            "@tarquinen/opencode-dcp",
        ]);
        expect(findDcpPluginEntries({ plugins: ["other"] })).toEqual([]);
    });
});

describe("setup-opencode inserts follow the file's layout", () => {
    it("writes new keys on their own indented lines with the file's CRLF endings", () => {
        const path = join(tempDir(), "opencode.jsonc");
        writeFileSync(path, '{\r\n    "model": "a/b"\r\n}\r\n');

        addPluginToOpenCodeConfig(path, "jsonc", false, true, "v1");

        const text = readFileSync(path, "utf-8");
        // Every line break stays CRLF and nothing is crammed onto the model line.
        expect(text.replace(/\r\n/g, "")).not.toContain("\n");
        expect(text.split("\r\n")[1]).toBe('    "model": "a/b",');
        expect(text).toContain('\r\n    "plugin": [');
        expect(text).toContain('\r\n    "compaction": {');
        expect(parseJsonc(text)).toEqual({
            model: "a/b",
            plugin: ["@cortexkit/opencode-magic-context@latest"],
            compaction: { auto: false, prune: false },
        });
    });
});
