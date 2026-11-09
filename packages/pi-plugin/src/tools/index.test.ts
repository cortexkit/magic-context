import { describe, expect, it } from "bun:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { V2_MEMORY_CATEGORIES } from "@magic-context/core/features/magic-context/memory/constants";
import { getMemoryById } from "@magic-context/core/features/magic-context/memory/storage-memory";
import {
	A1_HASH_BASELINE_HEADING,
	A1_TOOL_SECTION_HEADING,
	a1GoldenSectionOffset,
	readA1GoldenDocument,
} from "@magic-context/core/shared/prompt-surface-a1-golden";
import {
	createPromptSurfaceRuntime,
	LIGHT_TOOL_DESCRIPTIONS,
} from "@magic-context/core/shared/prompt-surface-runtime";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import {
	FULL_PARAMETER_DESCRIPTIONS,
	LIGHT_PARAMETER_DESCRIPTIONS,
} from "@magic-context/core/tools/parameter-descriptions";
import { __setPiHarnessKindForTesting } from "../pi-harness-kind";
import { createTestDb, fakeContext } from "../test-utils.test";
import { registerMagicContextTools, syncCtxMemoryToolEnabled } from "./index";

describe("registerMagicContextTools", () => {
	it("accepts required placeholder arguments for write, get and archive", async () => {
		const db = createTestDb();
		try {
			const tools = new Map<string, ToolDefinition>();
			registerMagicContextTools(
				{
					registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
				} as never,
				{
					db,
					memoryEnabled: true,
					embeddingEnabled: false,
					resolveProjectIdentity: () => "dir:placeholder-test",
				},
			);
			const memory = tools.get("ctx_memory");
			if (!memory) throw new Error("ctx_memory was not registered");
			const execute = (args: Record<string, unknown>) =>
				memory.execute(
					"placeholder-call",
					args,
					new AbortController().signal,
					undefined,
					fakeContext("ses-placeholder") as never,
				);
			for (const category of V2_MEMORY_CATEGORIES) {
				const content = `Placeholder arguments preserve the Pi fact for ${category}.`;
				const write = await execute({
					action: "write",
					content,
					category: "PROJECT_RULES",
					ids: [],
				});
				expect(write.isError).toBeUndefined();
				const text = write.content[0];
				const id = Number(
					text?.type === "text"
						? text.text.match(/ID:\s*(\d+)/)?.[1]
						: undefined,
				);
				expect(Number.isInteger(id)).toBe(true);
				const get = await execute({
					action: "get",
					content: "",
					category,
					ids: [id],
				});
				expect(get.isError).toBeUndefined();
				expect(get.content).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							type: "text",
							text: expect.stringContaining(content),
						}),
					]),
				);
				expect(getMemoryById(db, id)?.category).toBe("PROJECT_RULES");
				expect(getMemoryById(db, id)?.content).toBe(content);
				const archive = await execute({
					action: "archive",
					content: "",
					category,
					ids: [id],
				});
				expect(archive.isError).toBeUndefined();
				expect(archive.content).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							type: "text",
							text: expect.stringContaining("Archived"),
						}),
					]),
				);
				expect(getMemoryById(db, id)?.status).toBe("archived");
				expect(getMemoryById(db, id)?.category).toBe("PROJECT_RULES");
				expect(getMemoryById(db, id)?.content).toBe(content);
			}
		} finally {
			closeQuietly(db);
		}
	});

	for (const [kind, hidden] of [
		["omp", true],
		["omp", false],
		["pi", true],
	] as const) {
		it(`${kind} ${hidden ? "hidden" : "main"} memory writes restore markers only for OMP children`, async () => {
			const previous = process.env.MAGIC_CONTEXT_PI_SUBAGENT;
			const db = createTestDb();
			try {
				if (hidden) process.env.MAGIC_CONTEXT_PI_SUBAGENT = "1";
				else delete process.env.MAGIC_CONTEXT_PI_SUBAGENT;
				__setPiHarnessKindForTesting(kind);
				const tools = new Map<string, ToolDefinition>();
				registerMagicContextTools(
					{
						registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
						registerCommand: () => undefined,
					} as never,
					{
						db,
						memoryEnabled: true,
						embeddingEnabled: false,
						allowDreamerActions: hidden,
						resolveProjectIdentity: () => "dir:issue779-test",
					},
				);
				const content =
					"Remember \u2060@agent://example and \u2060other @\u2060path";
				const args = {
					action: "write",
					category: "PROJECT_RULES",
					content,
					extra: { values: ["\u2060@nested", null, 42] },
				};
				const original = JSON.stringify(args);
				const result = await tools
					.get("ctx_memory")!
					.execute(
						"call-779",
						args,
						new AbortController().signal,
						undefined,
						fakeContext("ses-779") as never,
					);
				expect(result.isError).toBeUndefined();
				const text = result.content[0];
				const id = Number(
					text?.type === "text"
						? text.text.match(/ID:\s*(\d+)/)?.[1]
						: undefined,
				);
				expect(Number.isInteger(id)).toBe(true);
				expect(getMemoryById(db, id)?.content).toBe(
					kind === "omp" && hidden
						? "Remember @agent://example and \u2060other @\u2060path"
						: content,
				);
				expect(JSON.stringify(args)).toBe(original);
			} finally {
				if (previous === undefined)
					delete process.env.MAGIC_CONTEXT_PI_SUBAGENT;
				else process.env.MAGIC_CONTEXT_PI_SUBAGENT = previous;
				__setPiHarnessKindForTesting(undefined);
				closeQuietly(db);
			}
		});
	}

	it("removes ctx_memory from Pi's enabled tools when memory is off and restores it after a config reload", () => {
		let activeTools = ["read", "ctx_search", "ctx_memory", "ctx_note"];
		const pi = {
			getActiveTools: () => activeTools,
			setActiveTools: (tools: string[]) => {
				activeTools = tools;
			},
		} as never;

		syncCtxMemoryToolEnabled(pi, false);
		expect(activeTools).toEqual(["read", "ctx_search", "ctx_note"]);

		syncCtxMemoryToolEnabled(pi, true);
		expect(activeTools).toEqual([
			"read",
			"ctx_search",
			"ctx_note",
			"ctx_memory",
		]);
	});

	it("can omit ctx_memory for lean child processes", () => {
		const db = createTestDb();
		try {
			const registered: string[] = [];
			const commands: string[] = [];
			const pi = {
				registerTool: (tool: { name: string }) => {
					registered.push(tool.name);
				},
				registerCommand: (name: string) => {
					commands.push(name);
				},
			} as never;

			registerMagicContextTools(pi, {
				db,
				todowriteEnabled: true,
				memoryToolEnabled: false,
				sessionScopedToolsDisabled: true,
				todowriteCommandEnabled: false,
			});

			expect(registered).toContain("ctx_search");
			expect(registered).not.toContain("ctx_memory");
			expect(registered).not.toContain("ctx_note");
			expect(registered).not.toContain("ctx_expand");
			expect(registered).toContain("todowrite");
			expect(commands).not.toContain("todos");
		} finally {
			closeQuietly(db);
		}
	});

	it("removes only ctx_reduce in compaction-off mode", () => {
		const db = createTestDb();
		try {
			const registered: string[] = [];
			const pi = {
				registerTool: (tool: { name: string }) => registered.push(tool.name),
				registerCommand: () => undefined,
			} as never;
			registerMagicContextTools(pi, {
				db,
				compactionOff: true,
				todowriteEnabled: true,
			});

			expect(registered).not.toContain("ctx_reduce");
			expect(registered).toEqual(
				expect.arrayContaining([
					"ctx_search",
					"ctx_memory",
					"ctx_note",
					"ctx_expand",
					"todowrite",
				]),
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("marks every ctx_* tool essential only for OMP", () => {
		const db = createTestDb();
		const registerFor = (kind: "pi" | "omp") => {
			__setPiHarnessKindForTesting(kind);
			const registered = new Map<string, { name: string; loadMode?: string }>();
			const pi = {
				registerTool: (tool: { name: string; loadMode?: string }) =>
					registered.set(tool.name, tool),
				registerCommand: () => undefined,
			} as never;
			registerMagicContextTools(pi, { db, allowDreamerActions: true });
			return [...registered.values()].filter((tool) =>
				tool.name.startsWith("ctx_"),
			);
		};

		try {
			const expectedNames = [
				"ctx_expand",
				"ctx_memory",
				"ctx_memory_list",
				"ctx_note",
				"ctx_reduce",
				"ctx_search",
			];
			const ompTools = registerFor("omp");
			expect(ompTools.map((tool) => tool.name).sort()).toEqual(expectedNames);
			for (const tool of ompTools) expect(tool.loadMode).toBe("essential");

			const piTools = registerFor("pi");
			expect(piTools.map((tool) => tool.name).sort()).toEqual(expectedNames);
			for (const tool of piTools) expect(tool).not.toHaveProperty("loadMode");
		} finally {
			__setPiHarnessKindForTesting(undefined);
			closeQuietly(db);
		}
	});

	it("advertises only real ctx_* fields and allows additional properties", () => {
		const db = createTestDb();
		try {
			const registered = new Map<
				string,
				{
					name: string;
					parameters: {
						properties?: Record<string, unknown>;
						additionalProperties?: unknown;
					};
				}
			>();
			const pi = {
				registerTool: (tool: {
					name: string;
					parameters: {
						properties?: Record<string, unknown>;
						additionalProperties?: unknown;
					};
				}) => registered.set(tool.name, tool),
				registerCommand: () => undefined,
			} as never;

			registerMagicContextTools(pi, { db });
			expect(registered.has("ctx_memory_list")).toBe(false);

			const expectedFields: Record<string, string[]> = {
				ctx_search: ["query", "limit", "from", "to", "sources"],
				// No `limit`: it only sized the dreamer-only list action, which now
				// lives on ctx_memory_list (issue 575).
				ctx_memory: ["action", "content", "category", "ids", "reason"],
				ctx_note: [
					"action",
					"content",
					"surface_condition",
					"note_ids",
					"filter",
					"limit",
					"offset",
				],
				ctx_expand: ["start", "end", "verbose", "message", "tag"],
				ctx_reduce: ["drop"],
			};
			for (const [name, fields] of Object.entries(expectedFields)) {
				const definition = registered.get(name);
				expect(definition).toBeDefined();
				expect(
					Object.keys(definition?.parameters.properties ?? {}).sort(),
				).toEqual([...fields].sort());
				expect(definition?.parameters.properties).not.toHaveProperty("reduced");
				expect(definition?.parameters.properties).not.toHaveProperty("summary");
				expect(definition?.parameters.additionalProperties).toBe(true);
			}
		} finally {
			closeQuietly(db);
		}
	});

	it("registers ctx_memory_list only for dreamer child surfaces", () => {
		const db = createTestDb();
		try {
			const registered = new Map<
				string,
				{ parameters: { properties?: Record<string, unknown> } }
			>();
			const pi = {
				registerTool: (tool: {
					name: string;
					parameters: { properties?: Record<string, unknown> };
				}) => registered.set(tool.name, tool),
				registerCommand: () => undefined,
			} as never;
			registerMagicContextTools(pi, { db, allowDreamerActions: true });
			expect(registered.has("ctx_memory_list")).toBe(true);
			expect(
				Object.keys(
					registered.get("ctx_memory_list")?.parameters.properties ?? {},
				).sort(),
			).toEqual(["category", "limit"]);
		} finally {
			closeQuietly(db);
		}
	});

	it("registered tools resolve smart-note gating from the invocation cwd", async () => {
		const db = createTestDb();
		try {
			const registered = new Map<
				string,
				{ execute: (...args: never[]) => unknown }
			>();
			const pi = {
				registerTool: (tool: {
					name: string;
					execute: (...args: never[]) => unknown;
				}) => {
					registered.set(tool.name, tool);
				},
				registerCommand: () => undefined,
			} as never;

			registerMagicContextTools(pi, {
				db,
				dreamerEnabled: false,
				resolveDreamerEnabled: (ctx) => ctx.cwd === "/tmp/project-b",
			});

			const noteTool = registered.get("ctx_note");
			expect(noteTool).toBeDefined();
			const result = await noteTool?.execute(
				"call-1" as never,
				{
					action: "write",
					content: "Project B smart note",
					surface_condition: "When project B condition is true",
				} as never,
				new AbortController().signal as never,
				undefined as never,
				{
					cwd: "/tmp/project-b",
					sessionManager: { getSessionId: () => "ses-tool-cd" },
				} as never,
			);

			expect(
				(result as { isError?: boolean } | undefined)?.isError,
			).toBeUndefined();
		} finally {
			closeQuietly(db);
		}
	});

	it("registers todowrite and /todos when explicitly enabled", () => {
		const db = createTestDb();
		try {
			const registered: string[] = [];
			const commands: string[] = [];
			const pi = {
				registerTool: (tool: { name: string }) => registered.push(tool.name),
				registerCommand: (name: string) => commands.push(name),
			} as never;

			registerMagicContextTools(pi, { db, todowriteEnabled: true });

			expect(registered).toContain("todowrite");
			expect(commands).toContain("todos");
		} finally {
			closeQuietly(db);
		}
	});

	it.each([
		undefined,
		false,
	])("omits todowrite and /todos when enabled is %s", (todowriteEnabled) => {
		const db = createTestDb();
		try {
			const registered: string[] = [];
			const commands: string[] = [];
			const pi = {
				registerTool: (tool: { name: string }) => registered.push(tool.name),
				registerCommand: (name: string) => commands.push(name),
			} as never;

			registerMagicContextTools(pi, { db, todowriteEnabled });

			expect(registered).toContain("ctx_search");
			expect(registered).not.toContain("todowrite");
			expect(commands).not.toContain("todos");
		} finally {
			closeQuietly(db);
		}
	});

	it("can keep /todos off for lean subagent entries", () => {
		const db = createTestDb();
		try {
			const registered: string[] = [];
			const commands: string[] = [];
			const pi = {
				registerTool: (tool: { name: string }) => registered.push(tool.name),
				registerCommand: (name: string) => commands.push(name),
			} as never;

			registerMagicContextTools(pi, {
				db,
				todowriteEnabled: true,
				todowriteCommandEnabled: false,
			});

			expect(registered).toContain("todowrite");
			expect(commands).not.toContain("todos");
		} finally {
			closeQuietly(db);
		}
	});
});

function withoutDescriptions(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutDescriptions);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([key]) => key !== "description")
			.map(([key, child]) => [key, withoutDescriptions(child)]),
	);
}

type RegisteredPromptTool = {
	name: string;
	description: string;
	parameters: { properties?: Record<string, unknown> };
};

function readA1GoldenTools(): Record<
	string,
	{ description: string; parameters: Record<string, unknown> }
> {
	const document = readA1GoldenDocument();
	const toolSection = document.slice(
		a1GoldenSectionOffset(document, A1_TOOL_SECTION_HEADING),
		a1GoldenSectionOffset(document, A1_HASH_BASELINE_HEADING),
	);
	const headings = [...toolSection.matchAll(/^### (ctx_[a-z_]+) —.*$/gm)];
	return Object.fromEntries(
		headings.map((heading, index) => {
			const start = (heading.index ?? 0) + heading[0].length;
			const end = headings[index + 1]?.index ?? toolSection.length;
			const body = toolSection.slice(start, end);
			const description = body.match(
				/\*\*Description:\*\*\s+```\n([\s\S]*?)\n```/,
			)?.[1];
			const parameters = body.match(
				/\*\*Parameters \(JSON Schema per parameter, as serialized to the provider\):\*\*\s+```json\n([\s\S]*?)\n```/,
			)?.[1];
			if (description === undefined || parameters === undefined) {
				throw new Error(`Malformed A1 golden tool section: ${heading[1]}`);
			}
			return [
				heading[1],
				{
					description,
					parameters: JSON.parse(parameters) as Record<string, unknown>,
				},
			];
		}),
	);
}

function captureRegisteredTools(
	options: Parameters<typeof registerMagicContextTools>[1],
): Map<string, RegisteredPromptTool> {
	const registered = new Map<string, RegisteredPromptTool>();
	const pi = {
		registerTool: (tool: RegisteredPromptTool) =>
			registered.set(tool.name, tool),
		registerCommand: () => undefined,
	} as never;
	registerMagicContextTools(pi, options);
	return registered;
}

describe("registerMagicContextTools — prompt-surface registration", () => {
	it("matches the A1 golden for no config and explicit full", () => {
		const golden = readA1GoldenTools();
		const implicitDb = createTestDb();
		const explicitDb = createTestDb();
		try {
			const implicit = captureRegisteredTools({ db: implicitDb });
			const explicit = captureRegisteredTools({
				db: explicitDb,
				promptSurface: { default: "full" },
			});
			const implicitIds = [...implicit.keys()].filter((id) =>
				id.startsWith("ctx_"),
			);
			const explicitIds = [...explicit.keys()].filter((id) =>
				id.startsWith("ctx_"),
			);

			expect(implicitIds.sort()).toEqual(Object.keys(golden).sort());
			expect(explicitIds.sort()).toEqual(Object.keys(golden).sort());
			for (const [toolId, expected] of Object.entries(golden)) {
				expect(implicit.get(toolId)?.description).toBe(expected.description);
				expect(explicit.get(toolId)?.description).toBe(expected.description);
				expect(explicit.get(toolId)?.parameters).toEqual(
					implicit.get(toolId)?.parameters,
				);
				// Pi uses TypeBox rather than OpenCode's Zod adapter, so its
				// parameter object has host metadata. The A1 contract here is that
				// IDs stay aligned and prompt-surface selection leaves those
				// Pi-owned bytes unchanged.
				expect(
					Object.keys(implicit.get(toolId)?.parameters.properties ?? {}).sort(),
				).toEqual(Object.keys(expected.parameters).sort());
			}
		} finally {
			closeQuietly(implicitDb);
			closeQuietly(explicitDb);
		}
	});

	it("registers built-in light prose without changing non-description schema fields", () => {
		const fullDb = createTestDb();
		const lightDb = createTestDb();
		try {
			const full = captureRegisteredTools({ db: fullDb });
			const light = captureRegisteredTools({
				db: lightDb,
				promptSurface: { default: "light" },
			});
			for (const toolId of Object.keys(LIGHT_TOOL_DESCRIPTIONS)) {
				expect(light.get(toolId)?.description).toBe(
					LIGHT_TOOL_DESCRIPTIONS[
						toolId as keyof typeof LIGHT_TOOL_DESCRIPTIONS
					],
				);
				expect(light.get(toolId)?.parameters).not.toEqual(
					full.get(toolId)?.parameters,
				);
				const lightParameters = light.get(toolId)?.parameters;
				const fullParameters = full.get(toolId)?.parameters;
				expect(withoutDescriptions(lightParameters)).toEqual(
					withoutDescriptions(fullParameters),
				);
				for (const [name, description] of Object.entries(
					LIGHT_PARAMETER_DESCRIPTIONS[
						toolId as keyof typeof LIGHT_PARAMETER_DESCRIPTIONS
					],
				)) {
					expect(
						(lightParameters?.properties?.[name] as { description?: string })
							?.description,
					).toBe(description);
					expect(
						(fullParameters?.properties?.[name] as { description?: string })
							?.description,
					).toBe(
						(
							FULL_PARAMETER_DESCRIPTIONS as Record<
								string,
								Record<string, string>
							>
						)[toolId]?.[name],
					);
				}
			}
		} finally {
			closeQuietly(fullDb);
			closeQuietly(lightDb);
		}
	});

	it("applies top-level overrides once without changing parameter schemas", () => {
		const baselineDb = createTestDb();
		const overrideDb = createTestDb();
		const warnings: string[] = [];
		try {
			const baseline = captureRegisteredTools({ db: baselineDb });
			const runtime = createPromptSurfaceRuntime({
				userConfigDirectory: process.cwd(),
				warn: (warning) => warnings.push(warning),
			});
			const overridden = captureRegisteredTools({
				db: overrideDb,
				promptSurface: {
					default: "full",
					models: { "provider/model": "light" },
					tool_descriptions: { ctx_search: "Pi custom search surface" },
				},
				promptSurfaceRuntime: runtime,
			});

			expect(overridden.get("ctx_search")?.description).toBe(
				"Pi custom search surface",
			);
			expect(overridden.get("ctx_reduce")?.description).toBe(
				baseline.get("ctx_reduce")?.description,
			);
			for (const toolId of [...baseline.keys()].filter((id) =>
				id.startsWith("ctx_"),
			)) {
				expect(overridden.get(toolId)?.parameters).toEqual(
					baseline.get(toolId)?.parameters,
				);
			}
			expect(warnings).toEqual([]);
		} finally {
			closeQuietly(baselineDb);
			closeQuietly(overrideDb);
		}
	});
});
