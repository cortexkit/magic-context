import { afterEach, describe, expect, it } from "bun:test";
import type { EmbeddingConfig } from "@magic-context/core/config/schema/magic-context";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import type { EmbeddingFailure } from "@magic-context/core/features/magic-context/memory/embedding-failure";
import type {
	EmbeddingProvider,
	EmbeddingPurpose,
} from "@magic-context/core/features/magic-context/memory/embedding-provider";
import {
	_resetProjectEmbeddingRegistryForTests,
	_setTestProviderFactoryForProject,
	getEmbeddingCoverageStatus,
	registerProjectEmbedding,
} from "@magic-context/core/features/magic-context/project-embedding-registry";
import { recordSessionProjectIdentity } from "@magic-context/core/features/magic-context/session-project-storage";
import { autoEmbedAttemptedBySession } from "@magic-context/core/hooks/magic-context/embed-session-state";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { createTestDb } from "../test-utils.test";
import {
	clearPiEmbedSessionState,
	maybeAutoEmbedPiSession,
	runEmbedDrain,
} from "./ctx-embed";

class FailingEmbeddingProvider implements EmbeddingProvider {
	readonly modelId = "fake-embedding-model";

	constructor(private readonly failure: EmbeddingFailure) {}

	async initialize(): Promise<boolean> {
		return true;
	}

	async embed(): Promise<null> {
		return null;
	}

	async embedBatch(texts: string[]): Promise<null[]> {
		return texts.map(() => null);
	}

	async dispose(): Promise<void> {}

	isLoaded(): boolean {
		return true;
	}

	getLastFailureReason(): EmbeddingFailure {
		return this.failure;
	}
}

class FakeEmbeddingProvider implements EmbeddingProvider {
	readonly modelId = "fake-embedding-model";

	async initialize(): Promise<boolean> {
		return true;
	}

	async embed(text: string, _signal?: AbortSignal): Promise<Float32Array> {
		return new Float32Array([text.length, 1]);
	}

	async embedBatch(
		texts: string[],
		_signal?: AbortSignal,
		_purpose?: EmbeddingPurpose,
	): Promise<Float32Array[]> {
		return texts.map((text) => new Float32Array([text.length, 1]));
	}

	async dispose(): Promise<void> {}

	isLoaded(): boolean {
		return true;
	}
}

function localConfig(): EmbeddingConfig {
	return { provider: "local", model: "fake-embedding-model" };
}

function seedCompartments(
	db: ReturnType<typeof createTestDb>,
	sessionId: string,
	count: number,
): void {
	for (let i = 0; i < count; i += 1) {
		const start = i * 2 + 1;
		const end = start + 1;
		appendCompartments(db, sessionId, [
			{
				sequence: i,
				startMessage: start,
				endMessage: end,
				startMessageId: `u${start}`,
				endMessageId: `a${end}`,
				title: `Embedding slice ${i}`,
				content: `Embedding content ${i}`,
				p1: `Embedding content ${i}`,
			},
		]);
		db.prepare(
			"INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content) VALUES (?, ?, ?, ?, ?)",
		).run(sessionId, start, `${sessionId}-u${start}`, "user", `Question ${i}?`);
		db.prepare(
			"INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content) VALUES (?, ?, ?, ?, ?)",
		).run(sessionId, end, `${sessionId}-a${end}`, "assistant", `Answer ${i}.`);
	}
}

function registerEmbedding(
	db: ReturnType<typeof createTestDb>,
	project: string,
): void {
	registerProjectEmbedding(
		db,
		project,
		localConfig(),
		{ memoryEnabled: true, gitCommitEnabled: false },
		"/tmp/pi-embed",
	);
}

describe("Pi /ctx-embed progress", () => {
	afterEach(() => {
		autoEmbedAttemptedBySession.clear();
		_resetProjectEmbeddingRegistryForTests();
		_setTestProviderFactoryForProject(null);
	});

	it.each([
		{
			failure: {
				class: "substitution_rejected",
				reason:
					"served model 'bge-m3' does not match requested 'baai/bge-m3-embedding' (substitution guard)",
				retryable: false,
			} satisfies EmbeddingFailure,
		},
		{
			failure: {
				class: "http_error",
				reason: "HTTP 402 from endpoint: quota exhausted",
				retryable: false,
			} satisfies EmbeddingFailure,
		},
		{
			failure: {
				class: "empty_result",
				reason: "response data[] was empty",
				retryable: true,
			} satisfies EmbeddingFailure,
		},
		{
			failure: {
				class: "invalid_envelope",
				reason: "response had keys [object, results] but data[] was absent",
				retryable: false,
			} satisfies EmbeddingFailure,
		},
	])("surfaces $failure.class in the /ctx-embed summary", async ({
		failure,
	}) => {
		_setTestProviderFactoryForProject(
			() => new FailingEmbeddingProvider(failure),
		);
		const db = createTestDb();
		try {
			const project = `pi-embed-failure-${failure.class}`;
			const sessionId = `pi-embed-failure-${failure.class}`;
			registerEmbedding(db, project);
			seedCompartments(db, sessionId, 1);

			const terminal = await runEmbedDrain(db, project, sessionId, {
				batchSize: 1,
			});
			expect(terminal.text).toContain(failure.reason);
			if (failure.retryable) {
				expect(terminal.text).toContain(
					"Run /ctx-embed start again to retry them.",
				);
			} else {
				expect(terminal.text).not.toContain(
					"Run /ctx-embed start again to retry them.",
				);
			}
		} finally {
			closeQuietly(db);
		}
	});

	it("re-arms after a zero-work pass and latches only after the later drain succeeds", async () => {
		_setTestProviderFactoryForProject(() => new FakeEmbeddingProvider());
		const db = createTestDb();
		const project = "pi-auto-embed-project";
		const sessionId = "pi-auto-embed-session";
		const notifications: string[] = [];
		const waitUntil = async (predicate: () => boolean): Promise<void> => {
			const deadline = Date.now() + 3_000;
			while (!predicate() && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(predicate()).toBe(true);
		};
		try {
			registerEmbedding(db, project);
			recordSessionProjectIdentity(db, sessionId, project);

			maybeAutoEmbedPiSession(
				{ db, projectDir: "/tmp/pi-embed", projectIdentity: project },
				sessionId,
				"/tmp/pi-embed",
				project,
				(text) => notifications.push(text),
			);
			await waitUntil(() => !autoEmbedAttemptedBySession.has(sessionId));
			expect(notifications).toEqual([]);

			seedCompartments(db, sessionId, 1);
			expect(getEmbeddingCoverageStatus(db, project, sessionId)).toMatchObject({
				enabled: true,
				session: { total: 1, embedded: 0 },
			});
			maybeAutoEmbedPiSession(
				{ db, projectDir: "/tmp/pi-embed", projectIdentity: project },
				sessionId,
				"/tmp/pi-embed",
				project,
				(text) => notifications.push(text),
			);
			await waitUntil(
				() =>
					autoEmbedAttemptedBySession.has(sessionId) &&
					notifications.some((text) =>
						text.includes(
							"Embedded 1 compartment of history for semantic search.",
						),
					),
			);
			const completedNotifications = notifications.length;

			maybeAutoEmbedPiSession(
				{ db, projectDir: "/tmp/pi-embed", projectIdentity: project },
				sessionId,
				"/tmp/pi-embed",
				project,
				(text) => notifications.push(text),
			);
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(notifications).toHaveLength(completedNotifications);
		} finally {
			clearPiEmbedSessionState(sessionId);
			closeQuietly(db);
		}
	});

	it("emits start, throttled progress, and terminal summary for a multi-batch drain", async () => {
		_setTestProviderFactoryForProject(() => new FakeEmbeddingProvider());
		const db = createTestDb();
		try {
			const project = "pi-embed-project";
			const sessionId = "pi-embed-many";
			registerEmbedding(db, project);
			seedCompartments(db, sessionId, 9);
			const statuses: Array<{ text: string; level: "success" | "info" }> = [];

			const terminal = await runEmbedDrain(db, project, sessionId, {
				onStatus: (status) => statuses.push(status),
			});

			expect(statuses.map((status) => status.text)).toEqual([
				"## /ctx-embed\n\nEmbedding 9 compartments of history…",
				"## /ctx-embed\n\nEmbedded 8/9 compartments so far…",
			]);
			expect(terminal).toEqual({
				text: "## /ctx-embed\n\nEmbedded 9 compartments of history for semantic search.",
				level: "success",
			});
		} finally {
			closeQuietly(db);
		}
	});

	it("emits only start and terminal summary for a single-chunk drain", async () => {
		_setTestProviderFactoryForProject(() => new FakeEmbeddingProvider());
		const db = createTestDb();
		try {
			const project = "pi-embed-project-single";
			const sessionId = "pi-embed-one";
			registerEmbedding(db, project);
			seedCompartments(db, sessionId, 1);
			const statuses: Array<{ text: string; level: "success" | "info" }> = [];

			const terminal = await runEmbedDrain(db, project, sessionId, {
				onStatus: (status) => statuses.push(status),
			});

			expect(statuses.map((status) => status.text)).toEqual([
				"## /ctx-embed\n\nEmbedding 1 compartment of history…",
			]);
			expect(terminal).toEqual({
				text: "## /ctx-embed\n\nEmbedded 1 compartment of history for semantic search.",
				level: "success",
			});
		} finally {
			closeQuietly(db);
		}
	});
});
