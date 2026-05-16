import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EmbeddingConfig } from "../../config/schema/magic-context";
import type { EmbeddingProvider } from "./memory/embedding-provider";
import {
    _resetProjectEmbeddingRegistryForTests,
    _setTestProviderFactoryForProject,
    embedTextForProject,
    getProjectEmbeddingSnapshot,
    registerProjectEmbeddingAndMaybeWipe,
    registerProjectInObservationMode,
} from "./project-embedding-registry";
import { closeDatabase, openDatabase } from "./storage";

class FakeEmbeddingProvider implements EmbeddingProvider {
    readonly modelId: string;
    disposed = false;

    constructor(modelId: string) {
        this.modelId = modelId;
    }

    async initialize(): Promise<boolean> {
        return true;
    }

    async embed(text: string): Promise<Float32Array> {
        return new Float32Array([text.length, this.modelId.length]);
    }

    async embedBatch(texts: string[]): Promise<Float32Array[]> {
        return texts.map((text) => new Float32Array([text.length, this.modelId.length]));
    }

    async dispose(): Promise<void> {
        this.disposed = true;
    }

    isLoaded(): boolean {
        return true;
    }
}

function localConfig(model: string): EmbeddingConfig {
    return { provider: "local", model };
}

describe("project embedding registry", () => {
    const tempDirs: string[] = [];
    const originalXdgDataHome = process.env.XDG_DATA_HOME;

    function useTempDb() {
        const dir = mkdtempSync(join(tmpdir(), "project-embedding-registry-"));
        tempDirs.push(dir);
        process.env.XDG_DATA_HOME = dir;
        return openDatabase();
    }

    afterEach(() => {
        _resetProjectEmbeddingRegistryForTests();
        closeDatabase();
        process.env.XDG_DATA_HOME = originalXdgDataHome;
        for (const dir of tempDirs) {
            rmSync(dir, { recursive: true, force: true });
        }
        tempDirs.length = 0;
    });

    it("keeps independent snapshots and providers for two projects in one process", async () => {
        _setTestProviderFactoryForProject(
            (config) =>
                new FakeEmbeddingProvider(config.provider === "local" ? config.model : "off"),
        );

        registerProjectEmbeddingAndMaybeWipe(
            useTempDb(),
            "git:project-a",
            localConfig("model-a"),
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/a",
        );
        registerProjectEmbeddingAndMaybeWipe(
            openDatabase(),
            "git:project-b",
            localConfig("model-b-long"),
            { memoryEnabled: true, gitCommitEnabled: true },
            "/tmp/b",
        );

        const first = getProjectEmbeddingSnapshot("git:project-a");
        const second = getProjectEmbeddingSnapshot("git:project-b");
        const firstVector = await embedTextForProject("git:project-a", "hello");
        const secondVector = await embedTextForProject("git:project-b", "hello");

        expect(first?.projectIdentity).toBe("git:project-a");
        expect(first?.sourceDirectory).toBe("/tmp/a");
        expect(first?.enabled).toBe(true);
        expect(first?.gitCommitEnabled).toBe(false);
        expect(second?.projectIdentity).toBe("git:project-b");
        expect(second?.sourceDirectory).toBe("/tmp/b");
        expect(second?.enabled).toBe(true);
        expect(second?.gitCommitEnabled).toBe(true);
        expect(firstVector?.modelId).not.toBe(secondVector?.modelId);
        expect(firstVector?.vector[1]).not.toBe(secondVector?.vector[1]);
    });

    it("uses observation:<sha> fingerprints and disables runtime reads for corrupt first-time config", () => {
        const snapshot = registerProjectInObservationMode(
            useTempDb(),
            "git:corrupt",
            "/tmp/corrupt",
            { provider: "off" },
            "embedding config parse failed",
        );

        expect(snapshot.runtimeFingerprint).toMatch(/^observation:[0-9a-f]+$/);
        expect(snapshot.enabled).toBe(false);
        expect(snapshot.gitCommitEnabled).toBe(false);
        expect(snapshot.modelId).toBe("off");
        expect(getProjectEmbeddingSnapshot("git:corrupt")?.runtimeFingerprint).toBe(
            snapshot.runtimeFingerprint,
        );
    });

    it("invalidates stale embedding results when registration changes during an in-flight call", async () => {
        let release: (() => void) | undefined;
        _setTestProviderFactoryForProject(
            (config) =>
                new (class extends FakeEmbeddingProvider {
                    async embed(): Promise<Float32Array> {
                        await new Promise<void>((resolve) => {
                            release = resolve;
                        });
                        return new Float32Array([1, 2]);
                    }
                })(config.provider === "local" ? config.model : "off"),
        );

        registerProjectEmbeddingAndMaybeWipe(
            useTempDb(),
            "git:project",
            localConfig("model-a"),
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/project",
        );
        const inFlight = embedTextForProject("git:project", "hello");
        registerProjectEmbeddingAndMaybeWipe(
            openDatabase(),
            "git:project",
            localConfig("model-b"),
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/project",
        );

        release?.();

        expect(await inFlight).toBeNull();
    });
});
