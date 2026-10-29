import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmbeddingConfig } from "../config/schema/magic-context";
import {
    _resetProjectEmbeddingRegistryForTests,
    _setTestProviderFactoryForProject,
    getProjectEmbeddingSnapshot,
    getShadowEmbeddingMeasurementCohort,
    registerProjectShadowEmbedding,
} from "../features/magic-context/memory/embedding";
import { resolveProjectIdentity } from "../features/magic-context/memory/project-identity";
import { insertMemory } from "../features/magic-context/memory/storage-memory";
import { sweepStaleEmbeddingIdentitiesForProject } from "../features/magic-context/project-embedding-registry";
import { closeDatabase, openDatabase } from "../features/magic-context/storage";
import { createTestTempDirFromPath } from "../shared/test-temp-dir";
import { ensureProjectRegisteredFromOpenCodeDirectory } from "./embedding-bootstrap";

const tempDirs: string[] = [];
const originalHome = process.env.HOME;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalXdgDataHome = process.env.XDG_DATA_HOME;

function tempDir(prefix: string): string {
    const dir = createTestTempDirFromPath(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

function writeUserConfig(configHome: string, config: Record<string, unknown>): void {
    mkdirSync(join(configHome, "cortexkit"), { recursive: true });
    writeFileSync(join(configHome, "cortexkit", "magic-context.json"), JSON.stringify(config));
}

function installShadowProvider(onDispose: () => void): void {
    _setTestProviderFactoryForProject(() => ({
        modelId: "shadow",
        initialize: async () => true,
        embed: async () => new Float32Array([1, 0]),
        embedBatch: async (texts: string[]) => texts.map(() => new Float32Array([1, 0])),
        // Non-async: record the flag at call time. disposeProvider is
        // fire-and-forget, so an async body would make the assertion depend on
        // that body running before its first await rather than on retirement.
        dispose: () => {
            onDispose();
            return Promise.resolve();
        },
        isLoaded: () => true,
    }));
}

function seedShadowCohort(
    db: ReturnType<typeof openDatabase>,
    identity: string,
    directory: string,
): void {
    registerProjectShadowEmbedding(
        db,
        identity,
        {
            provider: "synapse",
            model: "shadow",
            synapse_fingerprint: "fixture",
        } as unknown as EmbeddingConfig,
        directory,
    );
}

afterEach(() => {
    _resetProjectEmbeddingRegistryForTests();
    closeDatabase();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

describe("ensureProjectRegisteredFromOpenCodeDirectory", () => {
    it("keeps memory on at first startup after recovering an out-of-range injection budget", async () => {
        const projectDir = tempDir("mc-budget-boot-");
        process.env.HOME = tempDir("mc-budget-home-");
        const configHome = tempDir("mc-budget-config-");
        process.env.XDG_CONFIG_HOME = configHome;
        process.env.XDG_DATA_HOME = tempDir("mc-budget-data-");
        writeUserConfig(configHome, {
            embedding: {
                provider: "openai-compatible",
                model: "fixture",
                endpoint: "http://127.0.0.1:9/v1",
            },
            memory: { injection_budget_tokens: 20001 },
        });
        await ensureProjectRegisteredFromOpenCodeDirectory(projectDir, openDatabase());
        const snapshot = getProjectEmbeddingSnapshot(resolveProjectIdentity(projectDir));
        expect(snapshot?.features.memoryEnabled).toBe(true);
        expect(snapshot?.enabled).toBe(true);
        expect(snapshot?.runtimeFingerprint).not.toStartWith("observation:");
    });

    it("preserves stored embeddings and last-known-good registration after an invalid model recovery", async () => {
        const projectDir = tempDir("mc-invalid-model-boot-");
        process.env.HOME = tempDir("mc-invalid-model-home-");
        const configHome = tempDir("mc-invalid-model-config-");
        process.env.XDG_CONFIG_HOME = configHome;
        process.env.XDG_DATA_HOME = tempDir("mc-invalid-model-data-");
        const embedding = {
            provider: "openai-compatible",
            model: "fixture",
            endpoint: "http://127.0.0.1:9/v1",
        };
        writeUserConfig(configHome, { embedding });
        const db = openDatabase();
        const identity = resolveProjectIdentity(projectDir);
        await ensureProjectRegisteredFromOpenCodeDirectory(projectDir, db);
        const prior = getProjectEmbeddingSnapshot(identity);
        const memory = insertMemory(db, {
            projectPath: identity,
            category: "CONSTRAINTS",
            content: "Preserve this vector.",
        });
        db.prepare(
            "INSERT INTO memory_embeddings(memory_id, model_id, embedding) VALUES (?, 'expired-model', ?)",
        ).run(memory.id, new Uint8Array(4));
        db.prepare(
            "INSERT INTO embedding_identity_active VALUES (?, 'memory', 'expired-model', 0)",
        ).run(identity);

        writeUserConfig(configHome, { embedding: { ...embedding, model: 123 } });
        await ensureProjectRegisteredFromOpenCodeDirectory(projectDir, db);
        expect(getProjectEmbeddingSnapshot(identity)?.runtimeFingerprint).toBe(
            prior?.runtimeFingerprint,
        );
        expect(sweepStaleEmbeddingIdentitiesForProject(db, identity).memoryRowsDeleted).toBe(0);
        expect(
            db
                .prepare("SELECT COUNT(*) AS n FROM memory_embeddings WHERE memory_id = ?")
                .get(memory.id),
        ).toEqual({ n: 1 });

        writeUserConfig(configHome, { embedding });
        await ensureProjectRegisteredFromOpenCodeDirectory(projectDir, db);
        expect(sweepStaleEmbeddingIdentitiesForProject(db, identity).memoryRowsDeleted).toBe(1);
    });

    it("reads the legacy config and registers the real identity (not observation) when only legacy config exists", async () => {
        const projectDir = tempDir("mc-legacy-boot-");
        process.env.HOME = tempDir("mc-legacy-home-");
        process.env.XDG_CONFIG_HOME = tempDir("mc-legacy-config-");
        process.env.XDG_DATA_HOME = tempDir("mc-legacy-data-");
        // Read-legacy-on-conflict: the CortexKit base is absent but THIS harness's
        // legacy project config exists, so it is read and trusted — NOT treated as
        // an untrusted/observation load that would suppress registration. The real
        // embedding identity is registered so the project is fully functional
        // before the user consolidates.
        writeFileSync(
            join(projectDir, "magic-context.jsonc"),
            '{"embedding":{"provider":"openai-compatible","model":"qwen3","endpoint":"http://localhost:1234/v1"}}',
        );
        const db = openDatabase();
        const projectIdentity = resolveProjectIdentity(projectDir);

        await ensureProjectRegisteredFromOpenCodeDirectory(projectDir, db);

        const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
        expect(snapshot?.enabled).toBe(true);
        expect(snapshot?.runtimeFingerprint).not.toStartWith("observation:");
    });

    it("keeps repeated registration read-only and observes a changed config file", async () => {
        const projectDir = tempDir("mc-registration-read-");
        process.env.HOME = tempDir("mc-registration-home-");
        const configHome = tempDir("mc-registration-config-");
        process.env.XDG_CONFIG_HOME = configHome;
        process.env.XDG_DATA_HOME = tempDir("mc-registration-data-");
        writeUserConfig(configHome, {
            embedding: {
                provider: "openai-compatible",
                model: "first",
                endpoint: "http://127.0.0.1:9/v1",
            },
        });
        const db = openDatabase();
        const identity = resolveProjectIdentity(projectDir);
        await ensureProjectRegisteredFromOpenCodeDirectory(projectDir, db);
        const first = getProjectEmbeddingSnapshot(identity);
        const changes = (db.prepare("SELECT total_changes() AS count").get() as { count: number })
            .count;
        for (let i = 0; i < 4; i++)
            await ensureProjectRegisteredFromOpenCodeDirectory(projectDir, db);
        expect(
            (db.prepare("SELECT total_changes() AS count").get() as { count: number }).count,
        ).toBe(changes);
        expect(getProjectEmbeddingSnapshot(identity)?.runtimeFingerprint).toBe(
            first?.runtimeFingerprint,
        );
        writeUserConfig(configHome, {
            embedding: {
                provider: "openai-compatible",
                model: "second-longer",
                endpoint: "http://127.0.0.1:9/v1",
            },
        });
        await ensureProjectRegisteredFromOpenCodeDirectory(projectDir, db);
        expect(getProjectEmbeddingSnapshot(identity)?.runtimeFingerprint).not.toBe(
            first?.runtimeFingerprint,
        );
    });

    it("retires a disabled shadow without removing the primary lane", async () => {
        const projectDir = tempDir("mc-shadow-disable-");
        process.env.HOME = tempDir("mc-shadow-disable-home-");
        const configHome = tempDir("mc-shadow-disable-config-");
        process.env.XDG_CONFIG_HOME = configHome;
        process.env.XDG_DATA_HOME = tempDir("mc-shadow-disable-data-");
        let disposed = false;
        installShadowProvider(() => {
            disposed = true;
        });
        writeUserConfig(configHome, {
            embedding: { provider: "off" },
            shadow_embedding: { enabled: false },
        });
        const db = openDatabase();
        const identity = resolveProjectIdentity(projectDir);
        seedShadowCohort(db, identity, projectDir);
        expect(getShadowEmbeddingMeasurementCohort(identity)?.fingerprint).toBe("fixture");

        await ensureProjectRegisteredFromOpenCodeDirectory(projectDir, db);

        expect(getShadowEmbeddingMeasurementCohort(identity)).toBeNull();
        expect(getProjectEmbeddingSnapshot(identity)?.provider).toBe("off");
        expect(disposed).toBe(true);
    });

    it("retires a shadow lane that becomes unavailable without removing the primary lane", async () => {
        const projectDir = tempDir("mc-shadow-unavailable-");
        process.env.HOME = tempDir("mc-shadow-unavailable-home-");
        const configHome = tempDir("mc-shadow-unavailable-config-");
        process.env.XDG_CONFIG_HOME = configHome;
        process.env.XDG_DATA_HOME = tempDir("mc-shadow-unavailable-data-");
        let disposed = false;
        installShadowProvider(() => {
            disposed = true;
        });
        writeUserConfig(configHome, {
            embedding: {
                provider: "openai-compatible",
                model: "qwen3",
                endpoint: "http://127.0.0.1:9/v1",
            },
            shadow_embedding: { enabled: true },
            subc: { connection_file: join(configHome, "absent-subc.json") },
        });
        const db = openDatabase();
        const identity = resolveProjectIdentity(projectDir);
        seedShadowCohort(db, identity, projectDir);
        expect(getShadowEmbeddingMeasurementCohort(identity)?.fingerprint).toBe("fixture");

        await ensureProjectRegisteredFromOpenCodeDirectory(projectDir, db);

        expect(getShadowEmbeddingMeasurementCohort(identity)).toBeNull();
        expect(getProjectEmbeddingSnapshot(identity)?.provider).toBe("openai-compatible");
        expect(disposed).toBe(true);
    });
});
