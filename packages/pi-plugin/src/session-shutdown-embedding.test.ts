import { afterEach, describe, expect, it, mock } from "bun:test";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	_resetProjectEmbeddingRegistryForTests,
	_setTestProviderFactoryForProject,
} from "@magic-context/core/features/magic-context/memory/embedding";
import type { EmbeddingProvider } from "@magic-context/core/features/magic-context/memory/embedding-provider";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import {
	embedTextForProject,
	registerProjectInObservationMode,
} from "@magic-context/core/features/magic-context/project-embedding-registry";
import {
	cleanupTestTempDir,
	createTestTempDir,
} from "@magic-context/core/shared/test-temp-dir";

import magicContextPiExtension, { __test } from "./index";

const previousConfigHome = process.env.XDG_CONFIG_HOME;
const tempRoots: string[] = [];

afterEach(() => {
	if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
	else process.env.XDG_CONFIG_HOME = previousConfigHome;
	for (const root of tempRoots.splice(0)) cleanupTestTempDir(root);
	_resetProjectEmbeddingRegistryForTests();
});

/** The ExtensionAPI surface the extension touches, with its event handlers kept. */
function createPi() {
	const handlers = new Map<
		string,
		Set<(event: unknown, ctx: unknown) => unknown>
	>();
	const pi = {
		events: { on: () => () => {} },
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			const set = handlers.get(event) ?? new Set();
			set.add(handler);
			handlers.set(event, set);
		},
		registerTool: mock(() => {}),
		getActiveTools: () => [],
		setActiveTools: () => {},
		registerFlag: mock(() => {}),
		registerCommand: mock(() => {}),
		registerEntryRenderer: mock(() => {}),
		appendEntry: mock(() => undefined),
		sendMessage: mock(() => undefined),
		sendUserMessage: mock(() => undefined),
	} as unknown as ExtensionAPI;
	return {
		pi,
		async emit(event: string, ctx: unknown) {
			for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
		},
	};
}

/**
 * Starts a Pi runtime whose project uses a test provider standing in for the
 * local one: its disposal ends only when the test releases it, as the local
 * provider's ends only when its worker thread has finished the running
 * inference and exited. The provider is created by one embedding.
 */
async function startRuntimeWithProvider() {
	const root = createTestTempDir("magic-context-pi-shutdown-embedding-").dir;
	tempRoots.push(root);
	process.env.XDG_CONFIG_HOME = join(root, "config");
	// Runtimes other tests left running would keep the registrations alive.
	__test.forgetActivePiRuntimes();
	let finishDispose!: () => void;
	const disposeStarted = mock(() => {});
	const provider: EmbeddingProvider = {
		modelId: "shutdown-fixture",
		initialize: async () => true,
		isLoaded: () => true,
		embed: async () => new Float32Array([1, 0]),
		embedBatch: async (texts) => texts.map(() => new Float32Array([1, 0])),
		dispose: () => {
			disposeStarted();
			return new Promise<void>((resolve) => {
				finishDispose = resolve;
			});
		},
	};
	_setTestProviderFactoryForProject(() => provider);

	const runtime = createPi();
	await magicContextPiExtension(runtime.pi);
	const identity = resolveProjectIdentityForSession(process.cwd(), false);
	expect(identity).toBeTruthy();
	expect(await embedTextForProject(identity!, "warm")).not.toBeNull();
	return {
		runtime,
		identity: identity!,
		disposeStarted,
		finishDispose: () => finishDispose(),
	};
}

/** Runs session_shutdown and checks it returns only once the disposal is released. */
async function expectShutdownWaitsForDisposal(
	fixture: Awaited<ReturnType<typeof startRuntimeWithProvider>>,
): Promise<void> {
	const ctx = {
		cwd: process.cwd(),
		hasUI: false,
		sessionManager: { getSessionId: () => "ses-shutdown-embedding" },
		ui: { setStatus() {} },
	};
	let returned = false;
	const shutdown = fixture.runtime.emit("session_shutdown", ctx).then(() => {
		returned = true;
	});
	const deadline = Date.now() + 10_000;
	while (
		fixture.disposeStarted.mock.calls.length === 0 &&
		Date.now() < deadline
	)
		await new Promise((resolve) => setTimeout(resolve, 10));
	expect(fixture.disposeStarted).toHaveBeenCalledTimes(1);
	// Give the handler time to reach its end; it must still be waiting.
	await new Promise((resolve) => setTimeout(resolve, 200));
	expect(returned).toBe(false);

	fixture.finishDispose();
	await shutdown;
	expect(returned).toBe(true);
}

describe("Pi session_shutdown and the embedding worker", () => {
	it("returns only after the embedding provider has been disposed", async () => {
		await expectShutdownWaitsForDisposal(await startRuntimeWithProvider());
	}, 30_000);

	it("also waits for a provider that observation mode retired before the shutdown", async () => {
		const fixture = await startRuntimeWithProvider();
		// Retiring the registration starts the provider's disposal in the
		// background; no registration reaches that provider any more.
		registerProjectInObservationMode(
			{} as never,
			fixture.identity,
			process.cwd(),
			{ provider: "off" },
			"retire the test provider",
		);
		expect(fixture.disposeStarted).toHaveBeenCalledTimes(1);
		await expectShutdownWaitsForDisposal(fixture);
	}, 30_000);
});
