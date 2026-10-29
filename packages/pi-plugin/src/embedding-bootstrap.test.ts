import { describe, expect, it, spyOn } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { EmbeddingConfig } from "@magic-context/core/config/schema/magic-context";
import {
	appendCompartments,
	getCompartments,
} from "@magic-context/core/features/magic-context/compartment-storage";
import * as projectEmbedding from "@magic-context/core/features/magic-context/memory/embedding";
import {
	_resetProjectEmbeddingRegistryForTests,
	_setTestProviderFactoryForProject,
	getProjectEmbeddingSnapshot,
	getShadowEmbeddingMeasurementCohort,
	registerProjectShadowEmbedding,
} from "@magic-context/core/features/magic-context/memory/embedding";
import {
	getProjectEmbeddings,
	peekProjectEmbeddings,
	resetEmbeddingCacheForTests,
} from "@magic-context/core/features/magic-context/memory/embedding-cache";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import * as logger from "@magic-context/core/shared/logger";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { createTestTempDir } from "@magic-context/core/shared/test-temp-dir";

import {
	ensureProjectRegisteredFromPiDirectory,
	unregisterPiProjectEmbeddings,
} from "./embedding-bootstrap";
import { createTestDb } from "./test-utils.test";

describe("ensureProjectRegisteredFromPiDirectory", () => {
	it("keeps memory on at first startup after recovering an out-of-range injection budget", async () => {
		const db = createTestDb();
		const directory = createTestTempDir("pi-budget-bootstrap-").dir;
		const home = createTestTempDir("pi-budget-home-").dir;
		const previous = {
			HOME: process.env.HOME,
			XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
		};
		process.env.HOME = home;
		process.env.XDG_CONFIG_HOME = path.join(home, ".config");
		_resetProjectEmbeddingRegistryForTests();
		try {
			const configDir = path.join(home, ".config", "cortexkit");
			await fs.mkdir(configDir, { recursive: true });
			await fs.writeFile(
				path.join(configDir, "magic-context.json"),
				JSON.stringify({
					embedding: {
						provider: "openai-compatible",
						model: "fixture",
						endpoint: "http://127.0.0.1:9/v1",
					},
					memory: { injection_budget_tokens: 20001 },
				}),
			);
			await ensureProjectRegisteredFromPiDirectory(directory, db);
			const snapshot = getProjectEmbeddingSnapshot(
				resolveProjectIdentity(directory),
			);
			expect(snapshot?.features.memoryEnabled).toBe(true);
			expect(snapshot?.enabled).toBe(true);
			expect(snapshot?.runtimeFingerprint).not.toStartWith("observation:");
		} finally {
			unregisterPiProjectEmbeddings(db);
			_resetProjectEmbeddingRegistryForTests();
			closeQuietly(db);
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});
	it("resumes project repair on the cached Pi registration path", async () => {
		const db = createTestDb();
		const directory = createTestTempDir("pi-embedding-bootstrap-").dir;
		const home = createTestTempDir("pi-embedding-home-").dir;
		const previous = {
			HOME: process.env.HOME,
			XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
		};
		process.env.HOME = home;
		process.env.XDG_CONFIG_HOME = path.join(home, ".config");
		try {
			const configDir = path.join(home, ".config", "cortexkit");
			await fs.mkdir(configDir, { recursive: true });
			await fs.writeFile(
				path.join(configDir, "magic-context.json"),
				JSON.stringify({
					embedding: {
						provider: "local",
						model: "cache-repair",
						local_runtime: "auto",
					},
				}),
			);
			const project = resolveProjectIdentity(directory);
			await ensureProjectRegisteredFromPiDirectory(directory, db);
			appendCompartments(db, "pi-cached-repair", [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 2,
					startMessageId: "u1",
					endMessageId: "a2",
					title: "repair",
					content: "repair",
					p1: "repair",
				},
			]);
			const compartment = getCompartments(db, "pi-cached-repair")[0].id;
			db.prepare("INSERT INTO session_projects VALUES (?, 'pi', ?, 0)").run(
				"pi-cached-repair",
				project,
			);
			const insert = db.prepare(`INSERT INTO compartment_chunk_embeddings(
                compartment_id, session_id, project_path, harness, window_index, start_ordinal, end_ordinal,
                chunk_hash, model_id, dims, vector, created_at) VALUES (?, ?, 'git:wrong', 'pi', ?, 1, 2, ?, 'old', 1, ?, 0)`);
			for (let i = 0; i < 200; i++)
				insert.run(
					compartment,
					"pi-cached-repair",
					i,
					`hash-${i}`,
					new Uint8Array(4),
				);
			await ensureProjectRegisteredFromPiDirectory(directory, db);
			expect(
				db
					.prepare(
						"SELECT COUNT(*) AS n FROM compartment_chunk_embeddings WHERE project_path=?",
					)
					.get(project),
			).toEqual({ n: 200 });
		} finally {
			unregisterPiProjectEmbeddings(db);
			closeQuietly(db);
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});
	it("preserves the embedding cache across consecutive identical registrations", async () => {
		const db = createTestDb();
		const oldHome = process.env.HOME;
		const oldConfigHome = process.env.XDG_CONFIG_HOME;
		const directory = createTestTempDir("pi-embedding-bootstrap-").dir;
		const fakeHome = createTestTempDir("pi-embedding-home-").dir;
		process.env.HOME = fakeHome;
		process.env.XDG_CONFIG_HOME = path.join(fakeHome, ".config");
		resetEmbeddingCacheForTests();
		try {
			const projectIdentity = resolveProjectIdentity(directory);

			await ensureProjectRegisteredFromPiDirectory(directory, db);
			const modelId =
				getProjectEmbeddingSnapshot(projectIdentity)?.modelId ?? "off";
			const cached = getProjectEmbeddings(db, projectIdentity, modelId);
			cached.set(42, { embedding: new Float32Array([1, 2, 3]), modelId });

			await ensureProjectRegisteredFromPiDirectory(directory, db);

			expect(peekProjectEmbeddings(projectIdentity, modelId)).toBe(cached);
			expect(peekProjectEmbeddings(projectIdentity, modelId)?.get(42)).toEqual({
				embedding: new Float32Array([1, 2, 3]),
				modelId,
			});
		} finally {
			resetEmbeddingCacheForTests();
			if (oldHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = oldHome;
			}
			if (oldConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
			else process.env.XDG_CONFIG_HOME = oldConfigHome;
			closeQuietly(db);
		}
	});

	it("shutdown unregisters project embedding providers", async () => {
		const db = createTestDb();
		const directory = createTestTempDir("pi-embedding-shutdown-").dir;
		try {
			await ensureProjectRegisteredFromPiDirectory(directory, db);
			const identity = resolveProjectIdentity(directory);
			expect(getProjectEmbeddingSnapshot(identity)).not.toBeNull();
			unregisterPiProjectEmbeddings(db);
			expect(getProjectEmbeddingSnapshot(identity)).toBeNull();
		} finally {
			closeQuietly(db);
		}
	});

	it("registers the fallback identity when native discovery is unavailable", async () => {
		const db = createTestDb();
		const directory = createTestTempDir("pi-embedding-synapse-").dir;
		const fakeHome = createTestTempDir("pi-embedding-synapse-home-").dir;
		const previous = {
			HOME: process.env.HOME,
			XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
		};
		process.env.HOME = fakeHome;
		process.env.XDG_CONFIG_HOME = path.join(fakeHome, ".config");
		resetEmbeddingCacheForTests();
		try {
			// Provider and SubC settings are user-tier only.
			const configDir = path.join(fakeHome, ".config", "cortexkit");
			await fs.mkdir(configDir, { recursive: true });
			await fs.writeFile(
				path.join(configDir, "magic-context.json"),
				JSON.stringify({
					embedding: { provider: "synapse", fallback_provider: "off" },
					subc: { connection_file: path.join(fakeHome, "absent-subc.json") },
				}),
			);
			const projectIdentity = resolveProjectIdentity(directory);
			await ensureProjectRegisteredFromPiDirectory(directory, db);
			expect(getProjectEmbeddingSnapshot(projectIdentity)?.provider).toBe(
				"off",
			);
			expect(getProjectEmbeddingSnapshot(projectIdentity)?.modelId).not.toMatch(
				/synapse/u,
			);
		} finally {
			resetEmbeddingCacheForTests();
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			closeQuietly(db);
		}
	});
	it("retires a disabled shadow without removing the primary lane", async () => {
		const db = createTestDb();
		const directory = createTestTempDir("pi-shadow-retirement-").dir;
		const configHome = createTestTempDir("pi-shadow-config-").dir;
		const previous = process.env.XDG_CONFIG_HOME;
		process.env.XDG_CONFIG_HOME = configHome;
		let disposed = false;
		_setTestProviderFactoryForProject(() => ({
			modelId: "shadow",
			initialize: async () => true,
			embed: async () => new Float32Array([1, 0]),
			embedBatch: async (texts: string[]) =>
				texts.map(() => new Float32Array([1, 0])),
			// Non-async: the flag is recorded when dispose is *called*, which is the
			// deterministic contract. disposeProvider is fire-and-forget
			// (`void provider.dispose()`), so an async body here would make the
			// assertion below depend on that body running before its first await.
			dispose: () => {
				disposed = true;
				return Promise.resolve();
			},
			isLoaded: () => true,
		}));
		try {
			await fs.mkdir(path.join(configHome, "cortexkit"), { recursive: true });
			await fs.writeFile(
				path.join(configHome, "cortexkit", "magic-context.json"),
				JSON.stringify({
					embedding: { provider: "off" },
					shadow_embedding: { enabled: false },
				}),
			);
			const identity = resolveProjectIdentity(directory);
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
			expect(getShadowEmbeddingMeasurementCohort(identity)?.fingerprint).toBe(
				"fixture",
			);
			await ensureProjectRegisteredFromPiDirectory(directory, db);
			expect(getShadowEmbeddingMeasurementCohort(identity)).toBeNull();
			expect(getProjectEmbeddingSnapshot(identity)?.provider).toBe("off");
			expect(disposed).toBe(true);
		} finally {
			_resetProjectEmbeddingRegistryForTests();
			if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
			else process.env.XDG_CONFIG_HOME = previous;
			closeQuietly(db);
		}
	});
	it("does not repeat a missing-SubC warning until configuration changes", async () => {
		const db = createTestDb();
		const directory = createTestTempDir("pi-routing-memo-").dir;
		const configHome = createTestTempDir("pi-routing-memo-config-").dir;
		const previous = process.env.XDG_CONFIG_HOME;
		process.env.XDG_CONFIG_HOME = configHome;
		const messages: string[] = [];
		const logging = spyOn(logger, "log").mockImplementation((message) => {
			messages.push(String(message));
		});
		try {
			const configDir = path.join(configHome, "cortexkit");
			await fs.mkdir(configDir, { recursive: true });
			const configFile = path.join(configDir, "magic-context.json");
			await fs.writeFile(
				configFile,
				JSON.stringify({
					embedding: { provider: "synapse", fallback_provider: "off" },
				}),
			);
			await ensureProjectRegisteredFromPiDirectory(directory, db);
			await ensureProjectRegisteredFromPiDirectory(directory, db);
			expect(
				messages.filter((message) => message.includes("requires a subc block")),
			).toHaveLength(1);
			await fs.writeFile(
				configFile,
				JSON.stringify({
					embedding: { provider: "synapse", fallback_provider: "off" },
					subc: { connection_file: path.join(configHome, "missing.json") },
				}),
			);
			await ensureProjectRegisteredFromPiDirectory(directory, db);
			await ensureProjectRegisteredFromPiDirectory(directory, db);
			// A configured but unavailable daemon is retryable, unlike missing configuration.
			expect(
				messages.filter((message) =>
					message.startsWith("[magic-context] Synapse is not ready;"),
				),
			).toHaveLength(2);
		} finally {
			logging.mockRestore();
			_resetProjectEmbeddingRegistryForTests();
			if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
			else process.env.XDG_CONFIG_HOME = previous;
			closeQuietly(db);
		}
	});
	it("retires a shadow lane that becomes unavailable without removing the primary lane", async () => {
		const db = createTestDb();
		const directory = createTestTempDir("pi-shadow-unavailable-").dir;
		const configHome = createTestTempDir("pi-shadow-unavailable-config-").dir;
		const previous = process.env.XDG_CONFIG_HOME;
		process.env.XDG_CONFIG_HOME = configHome;
		let disposed = false;
		_setTestProviderFactoryForProject(() => ({
			modelId: "shadow",
			initialize: async () => true,
			embed: async () => new Float32Array([1, 0]),
			embedBatch: async (texts: string[]) =>
				texts.map(() => new Float32Array([1, 0])),
			// Non-async: the flag is recorded when dispose is *called*, which is the
			// deterministic contract. disposeProvider is fire-and-forget
			// (`void provider.dispose()`), so an async body here would make the
			// assertion below depend on that body running before its first await.
			dispose: () => {
				disposed = true;
				return Promise.resolve();
			},
			isLoaded: () => true,
		}));
		try {
			await fs.mkdir(path.join(configHome, "cortexkit"), { recursive: true });
			await fs.writeFile(
				path.join(configHome, "cortexkit", "magic-context.json"),
				JSON.stringify({
					embedding: {
						provider: "openai-compatible",
						model: "qwen3",
						endpoint: "http://127.0.0.1:9/v1",
					},
					shadow_embedding: { enabled: true },
					subc: { connection_file: path.join(configHome, "absent-subc.json") },
				}),
			);
			const identity = resolveProjectIdentity(directory);
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
			expect(getShadowEmbeddingMeasurementCohort(identity)?.fingerprint).toBe(
				"fixture",
			);
			await ensureProjectRegisteredFromPiDirectory(directory, db);
			expect(getShadowEmbeddingMeasurementCohort(identity)).toBeNull();
			expect(getProjectEmbeddingSnapshot(identity)?.provider).toBe(
				"openai-compatible",
			);
			expect(disposed).toBe(true);
		} finally {
			_resetProjectEmbeddingRegistryForTests();
			if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
			else process.env.XDG_CONFIG_HOME = previous;
			closeQuietly(db);
		}
	});
	it("treats a no-probe outcome as a registry no-op on the next call", async () => {
		const db = createTestDb();
		const directory = createTestTempDir("pi-noprobe-memo-").dir;
		const configHome = createTestTempDir("pi-noprobe-memo-config-").dir;
		const previous = process.env.XDG_CONFIG_HOME;
		process.env.XDG_CONFIG_HOME = configHome;
		_setTestProviderFactoryForProject(() => ({
			modelId: "primary",
			initialize: async () => true,
			embed: async () => new Float32Array([1, 0]),
			embedBatch: async (texts: string[]) =>
				texts.map(() => new Float32Array([1, 0])),
			dispose: async () => undefined,
			isLoaded: () => true,
		}));
		const registerPrimary = spyOn(projectEmbedding, "registerProjectEmbedding");
		const registerShadow = spyOn(
			projectEmbedding,
			"registerProjectShadowEmbedding",
		);
		const unregisterShadow = spyOn(
			projectEmbedding,
			"unregisterProjectShadowEmbedding",
		);
		try {
			const configDir = path.join(configHome, "cortexkit");
			await fs.mkdir(configDir, { recursive: true });
			const configFile = path.join(configDir, "magic-context.json");
			// provider off + shadow enabled never probes; the outcome is deterministic.
			await fs.writeFile(
				configFile,
				JSON.stringify({
					embedding: { provider: "off" },
					shadow_embedding: { enabled: true },
				}),
			);
			await ensureProjectRegisteredFromPiDirectory(directory, db);
			await ensureProjectRegisteredFromPiDirectory(directory, db);
			expect(registerPrimary).toHaveBeenCalledTimes(1);
			expect(registerShadow).toHaveBeenCalledTimes(0);
			expect(unregisterShadow).toHaveBeenCalledTimes(1);

			await fs.writeFile(
				configFile,
				JSON.stringify({
					embedding: {
						provider: "openai-compatible",
						model: "qwen3",
						endpoint: "http://127.0.0.1:9/v1",
					},
					shadow_embedding: { enabled: true },
					subc: { connection_file: path.join(configHome, "absent-subc.json") },
				}),
			);
			await ensureProjectRegisteredFromPiDirectory(directory, db);
			await ensureProjectRegisteredFromPiDirectory(directory, db);
			// An attempted-unavailable shadow probe must re-resolve so a recovered
			// daemon can be picked up without a configuration change.
			expect(registerPrimary).toHaveBeenCalledTimes(3);
			expect(unregisterShadow).toHaveBeenCalledTimes(3);
		} finally {
			registerPrimary.mockRestore();
			registerShadow.mockRestore();
			unregisterShadow.mockRestore();
			_resetProjectEmbeddingRegistryForTests();
			if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
			else process.env.XDG_CONFIG_HOME = previous;
			closeQuietly(db);
		}
	});
});
