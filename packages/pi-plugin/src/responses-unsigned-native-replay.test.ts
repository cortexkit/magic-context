import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
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

// OMP resolves some paths at import time, before the extension runner is constructed.
const parent = join(tmpdir(), "magic-context", "issue-766");
mkdirSync(parent, { recursive: true });
const root = createTestTempDirFromPath(join(parent, "unsigned-replay-"));
const environment = {
	HOME: join(root, "home"),
	XDG_CONFIG_HOME: join(root, "config"),
	XDG_DATA_HOME: join(root, "data"),
	XDG_CACHE_HOME: join(root, "cache"),
	XDG_STATE_HOME: join(root, "state"),
	XDG_RUNTIME_DIR: join(root, "runtime"),
	MAGIC_CONTEXT_STORAGE_DIR: join(root, "storage"),
	PI_CODING_AGENT_DIR: join(root, "agent"),
	TMPDIR: join(root, "tmp"),
};
const previous = Object.fromEntries(
	Object.keys(environment).map((key) => [key, process.env[key]]),
);
for (const [key, value] of Object.entries(environment)) {
	mkdirSync(value, { recursive: true });
	process.env[key] = value;
}
const { piResponsesAssistantTexts } = await import(
	"./pi-dispatch-responses-history"
);
const { piPreparedStructure, piPreparedStructureMismatch, preparePiDispatch } =
	await import("./pi-dispatch-structure");
const { registerOmpAssistantMessageStrip } = await import("./strip-tag-prefix");
const marker = openSync(join(root, "lsof-marker"), "w");
const require = createRequire(import.meta.url);
const packageRoot = (alias: string, version: string) => {
	const path = require.resolve(`${alias}/package.json`).slice(0, -12);
	expect(require(`${path}package.json`).version).toBe(version);
	return path;
};
const hostDefinitions = [
	{ ai: "omp-pi-ai-171", version: "17.1.7" },
	{
		ai: "omp-pi-ai-1812",
		agent: "omp-coding-agent-1812",
		version: "18.12.3",
	},
	{
		ai: "omp-pi-ai-18126",
		agent: "omp-coding-agent-18126",
		version: "18.12.6",
	},
	{ ai: "omp-pi-ai-1889", version: "18.8.9" },
	{ ai: "omp-pi-ai-1811", version: "18.11.3" },
	{ ai: "omp-pi-ai-1813", version: "18.13.0" },
	{
		ai: "omp-pi-ai-18132",
		agent: "omp-coding-agent-18132",
		version: "18.13.2",
	},
];
const ompLoggerAliases = hostDefinitions.flatMap((host) =>
	host.agent ? [host.ai, host.agent] : [host.ai],
);
await pinOmpLoggerFiles(root, ompLoggerAliases);
const hosts = await Promise.all(
	hostDefinitions.map(async (host) => ({
		...host,
		build: (
			await import(
				`${packageRoot(host.ai, host.version)}src/providers/openai-shared.ts`
			)
		).buildResponsesInput,
		...(host.agent
			? {
					Runner: (
						await import(
							`${packageRoot(host.agent, host.version)}src/extensibility/extensions/runner.ts`
						)
					).ExtensionRunner,
					SessionManager: (
						await import(
							`${packageRoot(host.agent, host.version)}src/session/session-manager.ts`
						)
					).SessionManager,
				}
			: {}),
	})),
);
await exerciseOmpLoggerFiles(ompLoggerAliases);
reportOmpLogDescriptors();
const model = (api = "openai-responses") => ({
	api,
	id: "gpt-5",
	provider: "openai",
	input: ["text"],
	compat: {},
	identity: { class: "gpt", model: "gpt-5" },
});
function saved(api = "openai-responses"): any {
	return {
		role: "assistant",
		api,
		model: "gpt-5",
		provider: "openai",
		timestamp: 1,
		stopReason: "stop",
		content: [{ type: "text", text: "Hello" }],
		providerPayload: {
			type: "openaiResponsesHistory",
			provider: "openai",
			dt: true,
			items: [
				{
					type: "message",
					role: "assistant",
					id: "msg_old",
					phase: "final_answer",
					status: "completed",
					content: [
						{ type: "output_text", text: "§12§ Hello", annotations: [] },
					],
				},
			],
		},
	};
}
const user = {
	role: "user",
	content: [{ type: "text", text: "hello" }],
	timestamp: 0,
};
const projected = ['["§12§ Hello","final_answer"]'];
const visible = ['["Hello",null]'];
const native = (message: any) => message.providerPayload.items[0];
function encode(host: any, messages: unknown[], target: any, replay = true) {
	return host.build({
		model: target,
		context: { messages },
		strictResponsesPairing: false,
		supportsImageDetailOriginal: false,
		nativeHistory: { replay, filterReasoning: false },
	});
}
function admits(host: any, messages: unknown[], target: any) {
	const before = JSON.stringify(messages);
	const input = encode(host, messages, target);
	const bytes = JSON.stringify(input);
	const plan = piPreparedStructure(messages, target, "omp");
	expect(piPreparedStructureMismatch({ input }, plan)).toBeUndefined();
	expect(JSON.stringify(messages)).toBe(before);
	expect(JSON.stringify(encode(host, messages, target))).toBe(bytes);
	// Standard Responses and WebSocket response.create carry the same input items.
	expect(
		piPreparedStructureMismatch({ type: "response.create", input }, plan),
	).toBeUndefined();
	return { input, plan, bytes };
}
async function rewritten(
	host: any,
	api: string,
	raw = "§12§ Hello",
	phase = "final_answer",
	toolCount = 0,
) {
	const message = saved(api);
	native(message).content[0].text = raw;
	native(message).phase = phase;
	for (let n = 1; n <= toolCount; n++) {
		message.content.push({
			type: "toolCall",
			id: `call_${n}|fc_${n}`,
			name: "read",
			arguments: { n },
		});
		message.providerPayload.items.push({
			type: "function_call",
			id: `fc_${n}`,
			call_id: `call_${n}`,
			name: "read",
			arguments: JSON.stringify({ n }),
		});
	}
	if (toolCount) message.stopReason = "toolUse";
	message.content[0] = {
		type: "text",
		text: raw,
		textSignature: JSON.stringify({
			v: 1,
			id: "msg_old",
			phase,
		}),
	};
	const handlers = new Map();
	registerOmpAssistantMessageStrip(
		{ on: (name: string, fn: unknown) => handlers.set(name, [fn]) },
		() => true,
	);
	const runner = new host.Runner(
		[{ path: "strip", handlers }],
		{},
		root,
		{},
		{},
	);
	// Only unused context dependencies are stubbed; rewrite validation is the host's.
	runner.createContext = () => ({ ui: {} });
	runner.onError((error: unknown) => {
		throw new Error(JSON.stringify(error));
	});
	const content = await runner.emitAssistantMessage(message);
	expect(content[0]).toEqual({ type: "text", text: "Hello" });
	expect(content.slice(1)).toEqual(message.content.slice(1));
	expect(message.providerPayload.items[0].content[0].text).toBe(raw);
	return { ...message, content };
}

describe("unsigned Responses native replay", () => {
	for (const host of hosts) {
		for (const api of [
			"openai-responses",
			"openai-codex-responses",
			"azure-openai-responses",
		]) {
			test(`${host.version} ${api}: saved unsigned history follows actual native text and phase`, () => {
				const message = JSON.parse(JSON.stringify(saved(api)));
				const { input, plan } = admits(host, [user, message], model(api));
				expect(input[1].content[0].text).toBe("§12§ Hello");
				expect(input[1].phase).toBe("final_answer");
				const changed = structuredClone(input);
				changed[1].content[0].text = "§12§ unrelated";
				expect(piPreparedStructureMismatch({ input: changed }, plan)).toContain(
					"comparison=content",
				);
				changed[1].content[0].text = "§12§ Hello";
				changed[1].phase = "commentary";
				expect(piPreparedStructureMismatch({ input: changed }, plan)).toContain(
					"comparison=content",
				);
			});
			test(`${host.version} ${api}: a saved native tool turn preserves its call and reasoning`, () => {
				const message = saved(api);
				message.stopReason = "toolUse";
				message.content.push({
					type: "toolCall",
					id: "call_a|fc_a",
					name: "read",
					arguments: {},
				});
				message.providerPayload.items.unshift({
					type: "reasoning",
					id: "rs_a",
					encrypted_content: "opaque",
					summary: [],
				});
				message.providerPayload.items.push({
					type: "function_call",
					id: "fc_a",
					call_id: "call_a",
					name: "read",
					arguments: "{}",
				});
				const messages = [
					user,
					message,
					{
						role: "toolResult",
						toolCallId: "call_a|fc_a",
						toolName: "read",
						timestamp: 2,
						content: [{ type: "text", text: "file body" }],
					},
				];
				const { input } = admits(host, messages, model(api));
				expect(
					input.find((item: any) => item.type === "reasoning")
						.encrypted_content,
				).toBe("opaque");
				expect(input.some((item: any) => item.type === "function_call")).toBe(
					true,
				);
			});
			if (!host.Runner) continue;
			test(`${host.version} ${api}: the real rewrite drops the signature without breaking replay`, async () => {
				admits(host, [user, await rewritten(host, api)], model(api));
			});
			test(`${host.version} ${api}: same-tag reply retains commentary after the real hook`, async () => {
				const message = await rewritten(
					host,
					api,
					"§12§ Hello",
					"commentary",
					1,
				);
				message.content[0].text = "§12§ Hello";
				const messages = [user, message];
				const before = JSON.stringify(messages);
				const prepared = preparePiDispatch(messages, model(api), true);
				expect(JSON.stringify(prepared.messages)).toBe(before);
				const input = encode(host, prepared.messages, model(api));
				expect(
					piPreparedStructureMismatch({ input }, prepared.structure),
				).toBeUndefined();
				expect(piResponsesAssistantTexts(message, model(api), "omp")).toEqual([
					'["§12§ Hello","commentary"]',
				]);
				expect(input[1].content[0].text).toBe("§12§ Hello");
				expect(input[1].phase).toBe("commentary");
				expect(JSON.stringify(input)).toBe(
					JSON.stringify(encode(host, messages, model(api))),
				);
				const cold = encode(host, prepared.messages, model(api), false);
				expect(
					piPreparedStructureMismatch({ input: cold }, prepared.structure),
				).toBeUndefined();
				const altered = structuredClone(input);
				altered[1].phase = "final_answer";
				expect(
					piPreparedStructureMismatch({ input: altered }, prepared.structure),
				).toContain("comparison=content");
			});
			test(`${host.version} ${api}: fork alone and fork then rename admit the first converter request`, async () => {
				const manager = host.SessionManager.inMemory(root);
				manager.appendMessage(user);
				const leaf = manager.appendMessage(await rewritten(host, api));
				const parentBytes = admits(
					host,
					manager.buildSessionContext().messages,
					model(api),
				).bytes;
				manager.createBranchedSession(leaf);
				const forkBytes = admits(
					host,
					manager.buildSessionContext().messages,
					model(api),
				).bytes;
				await manager.setSessionName("renamed fork", "user");
				const renamedBytes = admits(
					host,
					manager.buildSessionContext().messages,
					model(api),
				).bytes;
				expect(forkBytes).toBe(parentBytes);
				expect(renamedBytes).toBe(forkBytes);
			});
		}
	}
});

describe("unsigned native projection guards", () => {
	const rejects: Array<{
		name: string;
		change: (message: any, target: any) => void;
		expected?: string[];
	}> = [
		{
			name: "assistant role",
			change: (m) => {
				m.role = "user";
			},
		},
		{
			name: "Responses API",
			change: (m, target) => {
				m.api = target.api = "anthropic-messages";
			},
		},
		{
			name: "target API",
			change: (m) => {
				m.api = "openai-codex-responses";
			},
		},
		{
			name: "target model",
			change: (m) => {
				m.model = "other";
			},
		},
		{
			name: "target provider",
			change: (m) => {
				m.providerPayload.provider = "other";
			},
		},
		{
			name: "append-only payload",
			change: (m) => {
				m.providerPayload.dt = false;
			},
		},
		{
			name: "native payload kind",
			change: (m) => {
				m.providerPayload.type = "other";
			},
		},
		{
			name: "explicit undefined signature",
			change: (m) => {
				m.content[0].textSignature = undefined;
			},
		},
		{
			name: "malformed signature",
			change: (m) => {
				m.content[0].textSignature = "broken";
			},
		},
		{
			name: "mismatched signature",
			change: (m) => {
				m.content[0].textSignature = JSON.stringify({
					v: 1,
					id: "wrong",
					phase: "final_answer",
				});
			},
			expected: ['["Hello","final_answer"]'],
		},
		{
			name: "semantic edit",
			change: (m) => {
				native(m).content[0].text = "§12§ Someone else";
			},
		},
		{
			name: "mid-text edit",
			change: (m) => {
				native(m).content[0].text = "Hel§12§ lo";
			},
		},
		{
			name: "complete block count",
			change: (m) => {
				m.content.push({ type: "text", text: "Second" });
			},
			expected: [...visible, '["Second",null]'],
		},
		{
			name: "native output block count",
			change: (m) => {
				native(m).content.push({ type: "output_text", text: "Second" });
			},
		},
		{
			name: "ordered text relation",
			change: (m) => {
				m.content.push({ type: "text", text: "Second" });
				native(m).content.unshift({ type: "output_text", text: "§1§ Second" });
			},
			expected: [...visible, '["Second",null]'],
		},
		{
			name: "genuinely rewritten native text",
			change: (m) => {
				m.content[0].text = "§99§ Hello";
				native(m).content[0].text = "Hello";
			},
			expected: ['["§99§ Hello",null]'],
		},
		{
			name: "native text untouched by cleanup",
			change: (m) => {
				native(m).content[0].text = "Hello";
			},
		},
	];
	for (const check of rejects) {
		test(`rejects ${check.name}`, () => {
			const message = saved();
			const target = model();
			check.change(message, target);
			expect(piResponsesAssistantTexts(message, target, "omp")).toEqual(
				check.expected ?? visible,
			);
		});
	}
	test("excludes Pi", () => {
		expect(piResponsesAssistantTexts(saved(), model(), "pi")).toEqual(visible);
		expect(
			piPreparedStructure([user, saved()], model(), "pi")
				?.responsesMessages?.[1].responseTexts,
		).toEqual(visible);
	});
	test("requires explicit OMP selection", () => {
		expect(piResponsesAssistantTexts(saved(), model())).toEqual(visible);
	});
	test("recognizes retagged prepared text and preserves mixed signed bindings", () => {
		const message = saved();
		message.content[0].text = "§99§ Hello";
		message.content.push({
			type: "text",
			text: "§99§ Second",
			textSignature: JSON.stringify({
				v: 1,
				id: "msg_second",
				phase: "commentary",
			}),
		});
		message.providerPayload.items.push({
			type: "message",
			role: "assistant",
			id: "msg_second",
			phase: "commentary",
			content: [{ type: "output_text", text: "Second", annotations: [] }],
		});
		expect(piResponsesAssistantTexts(message, model(), "omp")).toEqual([
			...projected,
			'["Second","commentary"]',
		]);
	});
	test("native provider identity takes precedence just as in OMP", () => {
		const message = saved();
		message.provider = "old-provider";
		expect(piResponsesAssistantTexts(message, model(), "omp")).toEqual(
			projected,
		);
	});
	test("all unsigned blocks must correspond, not only the first", () => {
		const message = saved();
		message.content.push({ type: "text", text: "Second" });
		native(message).content.push({
			type: "output_text",
			text: "Second",
			annotations: [],
		});
		expect(piResponsesAssistantTexts(message, model(), "omp")).toEqual([
			...projected,
			'["Second","final_answer"]',
		]);
	});
});

afterAll(() => {
	try {
		if (process.platform === "linux") {
			const files = execFileSync("lsof", ["-nP", "-p", String(process.pid)], {
				encoding: "utf8",
				windowsHide: true,
			});
			expect(files).toContain(join(root, "lsof-marker"));
			const outside = files
				.split("\n")
				.filter(
					(line) =>
						!line.includes(parent) &&
						!(
							previous.HOME?.includes("/magic-context/issue-766/") &&
							line.includes(previous.HOME)
						),
				)
				.join("\n");
			expect(outside).not.toMatch(
				/\/(?:\.pi|\.omp)(?:\/|\s)|\.local\/share\/opencode\/[^\s]*\.db|\.local\/share\/cortexkit\/magic-context\/(?:context|store)\.db|\.config\/(?:opencode|cortexkit)\//,
			);
			console.log(
				"native replay lsof: isolated host descriptors checked",
				files.split("\n").length - 1,
			);
		}
	} finally {
		closeSync(marker);
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		cleanupTestTempDir(root);
	}
});

for (const harness of ["omp", "pi"] as const) {
	// The differential gate needs the pinned Git object, which shallow CI clones may omit.
	test.skipIf(process.env.MC_RESPONSES_MASTER_ORACLE !== "1")(
		`${harness}: 500 randomized unaffected passes preserve master projection and host bytes`,
		async () => {
			const source = execFileSync(
				"git",
				[
					"-c",
					`safe.directory=${join(import.meta.dir, "../../..")}`,
					"show",
					"79ce01a522ae5a9d65d6bb2ac81aadf16fa8285a:packages/pi-plugin/src/pi-dispatch-responses-history.ts",
				],
				{ encoding: "utf8", windowsHide: true },
			);
			const baselinePath = join(root, `master-${harness}.ts`);
			writeFileSync(baselinePath, source);
			const baseline = (await import(baselinePath)).piResponsesAssistantTexts;
			const sourceDir = import.meta.dir;
			const structureSource = execFileSync(
				"git",
				[
					"-c",
					`safe.directory=${join(sourceDir, "../../..")}`,
					"show",
					"79ce01a522ae5a9d65d6bb2ac81aadf16fa8285a:packages/pi-plugin/src/pi-dispatch-structure.ts",
				],
				{ encoding: "utf8", windowsHide: true },
			)
				.replace(
					'from "./pi-dispatch-responses-history"',
					`from "${baselinePath}"`,
				)
				.replaceAll('from "./', `from "${sourceDir}/`);
			const structurePath = join(root, `master-structure-${harness}.ts`);
			writeFileSync(structurePath, structureSource);
			const masterPrepare = (await import(structurePath)).preparePiDispatch;
			const pi = await import(
				new URL(
					"./api/openai-responses-shared.js",
					import.meta.resolve("@earendil-works/pi-ai"),
				).href
			);
			let state = 0x125708;
			const next = () => {
				state ^= state << 13;
				state ^= state >>> 17;
				state ^= state << 5;
				return state >>> 0;
			};
			let signed = 0;
			let unsigned = 0;
			for (let pass = 0; pass < 500; pass++) {
				const target = model();
				const message = saved();
				message.content = [];
				message.providerPayload.items = [];
				const count = 1 + (next() % 4);
				for (let index = 0; index < count; index++) {
					const text = `reply-${next()}-λ\n${next()}`;
					const phase = next() % 2 ? "commentary" : "final_answer";
					const id = `msg_${pass}_${index}`;
					const isSigned = next() % 2 === 0;
					let wireText = text;
					const block: any = {
						type: "text",
						text: next() % 2 ? `§${next() % 100}§ ${text}` : text,
					};
					if (isSigned) {
						signed++;
						block.textSignature = JSON.stringify({ v: 1, id, phase });
					} else {
						unsigned++;
						// Pi also includes unsigned text differing only by a leading ordinal;
						// it must not use OMP's unsigned tag-rewrite exception.
						if (harness === "pi" && next() % 2) wireText = `§12§ ${text}`;
						else if (next() % 3 === 0) wireText = `different-${text}`;
					}
					message.content.push(block);
					message.providerPayload.items.push({
						type: "message",
						role: "assistant",
						id,
						phase,
						content: [{ type: "output_text", text: wireText, annotations: [] }],
					});
				}
				if (next() % 5 === 0) message.providerPayload.dt = false;
				if (next() % 7 === 0) message.providerPayload.provider = "other";
				const messages = [user, message];
				const wire = (input: unknown[]) =>
					JSON.stringify(
						harness === "omp"
							? encode(hosts[2], input, target)
							: pi.convertResponsesMessages(
									target,
									{ messages: input },
									new Set([target.provider]),
								),
					);
				const original = JSON.stringify(messages);
				const expected = baseline(message, target);
				const masterPrepared = masterPrepare(
					structuredClone(messages),
					target,
					harness === "omp",
				);
				const currentPrepared = preparePiDispatch(
					structuredClone(messages),
					target,
					harness === "omp",
				);
				expect(piResponsesAssistantTexts(message, target, harness)).toEqual(
					expected,
				);
				expect(currentPrepared).toEqual(masterPrepared);
				expect(wire(currentPrepared.messages)).toBe(
					wire(masterPrepared.messages),
				);
				expect(JSON.stringify(messages)).toBe(original);
			}
			expect(signed).toBeGreaterThan(400);
			expect(unsigned).toBeGreaterThan(400);
			console.log(
				`${harness}: 500 master comparisons, signed=${signed}, unsigned=${unsigned}, provider bytes identical`,
			);
		},
	);
}

describe("complete Responses replay modes", () => {
	const twoTurns = () => {
		const first = saved();
		const second = saved();
		second.content[0].text = "Second";
		native(second).id = "msg_second";
		native(second).content[0].text = "§13§ Second";
		return [user, first, { ...user, timestamp: 2 }, second];
	};
	for (const host of hosts) {
		test(`${host.version}: native-disabled request uses complete visible fallback`, () => {
			const messages = twoTurns();
			const input = encode(host, messages, model(), false);
			expect(
				piPreparedStructureMismatch(
					{ input },
					piPreparedStructure(messages, model(), "omp"),
				),
			).toBeUndefined();
			expect(input[1].content[0].text).toBe("Hello");
			expect(input[1].phase).toBeUndefined();
		});
		test(`${host.version}: fabricated cross-mode mix refuses`, () => {
			const messages = twoTurns();
			const warm = encode(host, messages, model());
			const cold = encode(host, messages, model(), false);
			const mixed = [...warm];
			mixed[3] = cold[3];
			expect(
				piPreparedStructureMismatch(
					{ input: mixed },
					piPreparedStructure(messages, model(), "omp"),
				),
			).toContain("comparison=content");
		});
		test(`${host.version}: signed message never gains the unsigned fallback alternative`, () => {
			const messages = twoTurns();
			const signed = messages[3];
			signed.content[0].text = "§99§ Second";
			signed.content[0].textSignature = JSON.stringify({
				v: 1,
				id: "msg_second",
				phase: "final_answer",
			});
			native(signed).content[0].text = "Second";
			const input = encode(host, messages, model(), false);
			expect(
				piPreparedStructureMismatch(
					{ input },
					piPreparedStructure(messages, model(), "omp"),
				),
			).toContain("comparison=content");
		});
		if (host.version.startsWith("17.")) continue;
		test(`${host.version}: modern cold request mixes only cold-safe native and stateful fallback`, () => {
			const messages = twoTurns();
			messages[1].providerPayload.items.unshift({
				type: "reasoning",
				id: "rs_plain",
				summary: [],
				content: [{ type: "reasoning_text", text: "plain reasoning" }],
			});
			messages[3].providerPayload.items.unshift({
				type: "reasoning",
				id: "rs_encrypted",
				encrypted_content: "opaque",
				summary: [],
			});
			const input = encode(host, messages, model(), false);
			expect(
				input.find((item: any) => item.role === "assistant").content[0].text,
			).toBe("§12§ Hello");
			expect(input.at(-1).content[0].text).toBe("Second");
			expect(
				piPreparedStructureMismatch(
					{ input },
					piPreparedStructure(messages, model(), "omp"),
				),
			).toBeUndefined();
		});
	}
	test("never mixes native text with fallback phase", () => {
		const messages = [user, saved()];
		const input = encode(hosts[2], messages, model());
		delete input[1].phase;
		expect(
			piPreparedStructureMismatch(
				{ input },
				piPreparedStructure(messages, model(), "omp"),
			),
		).toContain("comparison=content");
	});
	for (const check of [
		"encrypted state",
		"summary-only reasoning",
		"no reasoning",
	] as const) {
		test(`cold projection rejects ${check}`, () => {
			const message = saved();
			if (check !== "no reasoning")
				message.providerPayload.items.unshift({
					type: "reasoning",
					summary: [],
					...(check === "encrypted state"
						? {
								encrypted_content: "opaque",
								content: [{ type: "reasoning_text", text: "plain" }],
							}
						: {}),
				});
			const alternatives: any = {};
			piResponsesAssistantTexts(message, model(), "omp", alternatives);
			expect(alternatives.cold).toEqual(visible);
		});
	}
});

describe("the exact persisted assistant cleanup relation", () => {
	for (const host of hosts) {
		for (const [label, raw] of [
			["trailing newline", "§12§ Hello\n"],
			["middle tag", "Hel§12§lo"],
			["surrounding whitespace", " \t Hello \n"],
			["middle tag and newline", "Hello §12§\n"],
		] as const) {
			test(`${host.version}: hook cleanup ${label} and two calls`, async () => {
				let message = saved();
				if (host.Runner)
					message = await rewritten(
						host,
						"openai-responses",
						raw,
						"commentary",
						2,
					);
				else {
					message.stopReason = "toolUse";
					native(message).content[0].text = raw;
					native(message).phase = "commentary";
					for (let n = 1; n <= 2; n++) {
						message.content.push({
							type: "toolCall",
							id: `call_${n}|fc_${n}`,
							name: "read",
							arguments: { n },
						});
						message.providerPayload.items.push({
							type: "function_call",
							id: `fc_${n}`,
							call_id: `call_${n}`,
							name: "read",
							arguments: JSON.stringify({ n }),
						});
					}
				}
				const messages = [
					user,
					JSON.parse(JSON.stringify(message)),
					...[1, 2].map((n) => ({
						role: "toolResult",
						toolCallId: `call_${n}|fc_${n}`,
						toolName: "read",
						timestamp: n + 1,
						content: [{ type: "text", text: `result ${n}` }],
					})),
				];
				const { input, plan } = admits(host, messages, model());
				expect(input.find((item: any) => item.role === "assistant").phase).toBe(
					"commentary",
				);
				expect(
					input.find((item: any) => item.role === "assistant").content[0].text,
				).toBe(raw);
				expect(
					input
						.filter((item: any) => item.type === "function_call")
						.map((item: any) => ({
							id: item.call_id,
							arguments: item.arguments,
						})),
				).toEqual(
					[1, 2].map((n) => ({
						id: `call_${n}`,
						arguments: JSON.stringify({ n }),
					})),
				);
				const altered = structuredClone(input);
				altered.find((item: any) => item.role === "assistant").content[0].text =
					"unrelated edit";
				expect(piPreparedStructureMismatch({ input: altered }, plan)).toContain(
					"comparison=content",
				);
			});
		}
		test(`${host.version}: a visible edit not produced by cleanup still refuses`, () => {
			const message = saved();
			message.content[0].text = "Hello!";
			native(message).content[0].text = "§12§ Hello\n";
			native(message).phase = "commentary";
			const messages = [user, message];
			expect(
				piPreparedStructureMismatch(
					{ input: encode(host, messages, model()) },
					piPreparedStructure(messages, model(), "omp"),
				),
			).toContain("comparison=content");
		});
	}
});
