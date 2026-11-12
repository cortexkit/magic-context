import { afterAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	cleanupTestTempDir,
	createTestTempDirFromPath,
} from "@magic-context/core/shared/test-temp-dir";
import {
	exerciseOmpLoggerFiles,
	pinOmpLoggerFiles,
	reportOmpLogDescriptors,
} from "./__tests__/omp-log-files";
import { piCheckPreparedDispatch } from "./pi-dispatch-acceptance";
import {
	piForeignEvidence,
	piProtectPreparedRows,
} from "./pi-dispatch-foreign";
import {
	piPreparedStructure,
	piPreparedStructureMismatch,
} from "./pi-dispatch-structure";

const parent = join(tmpdir(), "magic-context", "omp-native-files");
mkdirSync(parent, { recursive: true });
const root = createTestTempDirFromPath(join(parent, "encoders-"));
const keys = [
	"HOME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_CACHE_HOME",
	"XDG_STATE_HOME",
	"XDG_RUNTIME_DIR",
	"MAGIC_CONTEXT_STORAGE_DIR",
	"PI_CODING_AGENT_DIR",
];
const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
for (const key of keys) {
	process.env[key] = join(root, key);
	mkdirSync(process.env[key]!, { recursive: true });
}
const aliases = ["omp-coding-agent-18186", "omp-pi-ai-18186"];
await pinOmpLoggerFiles(root, aliases);
const require = createRequire(import.meta.url);
const packageRoot = (alias: string) => {
	const path = require.resolve(`${alias}/package.json`).slice(0, -12);
	expect(require(`${path}package.json`).version).toBe("18.18.6");
	return path;
};
const host = await import(`${packageRoot(aliases[0])}src/session/messages.ts`);
const path = packageRoot(aliases[1]);
const chat = (await import(`${path}src/providers/openai-completions.ts`))
	.convertMessages;
const responses = (await import(`${path}src/providers/openai-responses.ts`))
	.buildParams;
const azureInput = (await import(`${path}src/providers/openai-shared.ts`))
	.buildResponsesInput;
const codex = (await import(`${path}src/providers/openai-codex-responses.ts`))
	.convertCodexResponsesMessages;
const google = (await import(`${path}src/providers/google-shared.ts`))
	.buildGoogleGenerateContentParams;
const geminiCli = (await import(`${path}src/providers/google-gemini-cli.ts`))
	.buildRequest;
const bedrock = (await import(`${path}src/providers/amazon-bedrock.ts`))
	.streamBedrock;
const ollama = (await import(`${path}src/providers/ollama.ts`)).streamOllama;
await exerciseOmpLoggerFiles(aliases);
reportOmpLogDescriptors();
afterAll(() => {
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	cleanupTestTempDir(root);
});

// These providers expose their encoders only through streaming entrypoints.
// Capture their real onPayload request with fake credentials, then abort before transport.
async function capture(stream: any, model: any, context: any): Promise<any> {
	const controller = new AbortController();
	let payload: unknown;
	let fetches = 0;
	await stream(model, context, {
		apiKey: "isolated-fake-key",
		region: "us-east-1",
		cacheRetention: "none",
		signal: controller.signal,
		fetch: () => {
			fetches++;
			throw new Error("network forbidden in encoder test");
		},
		onPayload: (value: unknown) => {
			payload = value;
			controller.abort();
			throw new Error("stopped after real request construction");
		},
	}).result();
	expect(fetches).toBe(0);
	expect(payload).toBeDefined();
	return payload;
}

const image = {
	type: "image",
	mimeType: "image/png",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6n1IAAAAASUVORK5CYII=",
};
const apis = [
	"openai-completions",
	"openai-responses",
	"azure-openai-responses",
	"openai-codex-responses",
	"google-generative-ai",
	"google-vertex",
	"google-gemini-cli",
	"bedrock-converse-stream",
	"ollama-chat",
];

for (const api of [
	"openrouter",
	"factory-droid-agent",
	"devin-agent",
	"apple-foundation-models",
	"future-provider",
]) {
	test(`${api} keeps the legacy structural skip for unverified native @file serialization only`, () => {
		const model = { api, provider: "test", id: "test" };
		const user = { role: "user", content: "§1§ prompt", timestamp: 1 };
		const mention = {
			role: "fileMention",
			files: [{ path: "note.md", content: "file context" }],
			timestamp: 2,
		};
		expect(piPreparedStructure([user], model, "omp")).toBeDefined();
		expect(piPreparedStructure([user, mention], model, "omp")).toBeUndefined();
	});
}
for (const api of apis)
	for (const developerRole of api === "openai-completions"
		? [false, true]
		: [true])
		for (const mode of ["text", "mixed", "text-model"] as const) {
			test(`${api} native @file through real OMP18.18.6 encoder: ${mode}, developer=${developerRole}`, async () => {
				const model = {
					api,
					provider: api.startsWith("google")
						? "google"
						: api === "bedrock-converse-stream"
							? "amazon-bedrock"
							: api === "ollama-chat"
								? "ollama"
								: "openai",
					id: "proof-model",
					name: "Proof model",
					baseUrl: "http://127.0.0.1:1/v1",
					input: mode === "text-model" ? ["text"] : ["text", "image"],
					identity: {
						class: api.startsWith("google")
							? "gemini"
							: api === "bedrock-converse-stream"
								? "anthropic"
								: "gpt",
					},
					compat: {
						supportsDeveloperRole: developerRole,
						supportsImageDetailOriginal: false,
						supportsMidConversationSystem: false,
						promptCacheMode: "none",
					},
					reasoning: false,
					contextWindow: 128000,
					maxTokens: 100,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				};
				const files = [
					{ path: "notes.md", content: "file text the session supplied" },
					...(mode === "text"
						? []
						: [{ path: "screen.png", content: "image caption", image }]),
				];
				const raw = [
					{ role: "user", content: "session prompt", timestamp: 1 },
					{ role: "fileMention", files, timestamp: 2 },
					{ role: "user", content: "next prompt", timestamp: 3 },
				];
				const managed = [
					{ ...raw[0], content: "§1§ session prompt" },
					raw[1],
					{ ...raw[2], content: "§3§ next prompt" },
				];
				const prepared = piPreparedStructure(managed, model, "omp");
				// No skip can hide a bad projection: these native rows are checked even
				// for sessions without any extension, using the host's actual converters.
				expect(prepared.structuralSkipReason).toBeUndefined();
				async function encode(messages: unknown[]) {
					const context = {
						systemPrompt: "system",
						messages: host.convertToLlm(messages),
						tools: [],
					};
					if (api.startsWith("google-") && api !== "google-gemini-cli")
						return google(model, context, {});
					if (api === "google-gemini-cli")
						return geminiCli(model, context, "isolated-project", {});
					if (api === "bedrock-converse-stream")
						return capture(bedrock, model, context);
					if (api === "ollama-chat") return capture(ollama, model, context);
					if (api === "openai-completions")
						return { messages: chat(model, context, model.compat) };
					if (api === "openai-codex-responses")
						return { input: codex(model, context) };
					if (api === "openai-responses")
						return responses(model, context, undefined, undefined).params;
					// Same shared-encoder options as the pinned Azure buildParams.
					return {
						input: azureInput({
							model,
							context,
							strictResponsesPairing: true,
							supportsImageDetailOriginal: false,
							systemRole: "system",
							nativeHistory: { replay: true, filterReasoning: false },
							includeThinkingSignatures: true,
							developerStringContent: true,
							preserveAssistantMessageIds: true,
							repairOrphanOutputs: true,
						}),
					};
				}
				const own = await encode(managed);
				expect(piPreparedStructureMismatch(own, prepared) ?? "accepted").toBe(
					"accepted",
				);
				const evidence = piForeignEvidence(
					{
						getEntries: () =>
							raw.map((message, index) => ({
								type: "message",
								id: `e${index}`,
								message,
							})),
					},
					raw,
				);
				piProtectPreparedRows(evidence, managed, prepared);
				const added = await encode([
					{
						role: "user",
						content: "foreign extension bootstrap",
						timestamp: 0,
					},
					...managed,
				]);
				expect(
					piCheckPreparedDispatch(added, prepared, evidence).mismatch ??
						"accepted",
				).toBe("accepted");
			});
		}
