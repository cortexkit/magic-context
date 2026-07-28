import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveOmpPaths } from "./paths";

const KEYS = [
    "HOME",
    "PI_CONFIG_DIR",
    "PI_CODING_AGENT_DIR",
    "OMP_PROFILE",
    "PI_PROFILE",
    "XDG_DATA_HOME",
] as const;
const original = new Map<string, string | undefined>();
let root: string;

beforeEach(() => {
    for (const key of KEYS) original.set(key, process.env[key]);
    root = mkdtempSync(join(tmpdir(), "mc-omp-paths-"));
    process.env.HOME = root;
    for (const key of KEYS.slice(1)) delete process.env[key];
});

afterEach(() => {
    for (const key of KEYS) {
        const value = original.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
});

describe("OMP path compatibility", () => {
    it("resolves the default layout", () => {
        expect(resolveOmpPaths()).toEqual({
            configRoot: join(root, ".omp"),
            agentDir: join(root, ".omp", "agent"),
            dataRoot: join(root, ".omp"),
            dataAgentRoot: join(root, ".omp", "agent"),
            pluginsDir: join(root, ".omp", "plugins"),
            sessionsRoot: join(root, ".omp", "agent", "sessions"),
        });
    });

    it("honors a custom default-profile agent dir without moving plugins", () => {
        process.env.PI_CODING_AGENT_DIR = join(root, "custom-agent");
        const paths = resolveOmpPaths();
        expect(paths.agentDir).toBe(join(root, "custom-agent"));
        expect(paths.sessionsRoot).toBe(join(root, "custom-agent", "sessions"));
        expect(paths.pluginsDir).toBe(join(root, ".omp", "plugins"));
    });

    it("lets a named profile override PI_CODING_AGENT_DIR", () => {
        process.env.OMP_PROFILE = "work";
        process.env.PI_CODING_AGENT_DIR = join(root, "stale-agent");
        const paths = resolveOmpPaths();
        expect(paths.agentDir).toBe(join(root, ".omp", "profiles", "work", "agent"));
        expect(paths.pluginsDir).toBe(join(root, ".omp", "profiles", "work", "plugins"));
    });

    it("honors PI_CONFIG_DIR for non-XDG config state", () => {
        process.env.PI_CONFIG_DIR = ".custom-omp";
        const paths = resolveOmpPaths();
        expect(paths.configRoot).toBe(join(root, ".custom-omp"));
        expect(paths.agentDir).toBe(join(root, ".custom-omp", "agent"));
    });

    it("uses an initialized XDG data root and flattens agent sessions", () => {
        const xdg = join(root, "xdg-data");
        mkdirSync(join(xdg, "omp"), { recursive: true });
        process.env.XDG_DATA_HOME = xdg;
        const paths = resolveOmpPaths();
        if (process.platform === "linux" || process.platform === "darwin") {
            expect(paths.pluginsDir).toBe(join(xdg, "omp", "plugins"));
            expect(paths.sessionsRoot).toBe(join(xdg, "omp", "sessions"));
        } else {
            expect(paths.pluginsDir).toBe(join(root, ".omp", "plugins"));
        }
    });

    it("requires the profile-specific XDG root before moving a profile", () => {
        const xdg = join(root, "xdg-data");
        mkdirSync(join(xdg, "omp"), { recursive: true });
        process.env.XDG_DATA_HOME = xdg;
        process.env.OMP_PROFILE = "work";
        expect(resolveOmpPaths().pluginsDir).toBe(
            join(root, ".omp", "profiles", "work", "plugins"),
        );

        mkdirSync(join(xdg, "omp", "profiles", "work"), { recursive: true });
        const paths = resolveOmpPaths();
        if (process.platform === "linux" || process.platform === "darwin") {
            expect(paths.pluginsDir).toBe(join(xdg, "omp", "profiles", "work", "plugins"));
            expect(paths.sessionsRoot).toBe(join(xdg, "omp", "profiles", "work", "sessions"));
        }
    });
});
