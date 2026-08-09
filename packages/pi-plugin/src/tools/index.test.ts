import { describe, expect, it } from "bun:test";
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
import { createTestDb } from "../test-utils.test";
import { registerMagicContextTools } from "./index";

describe("registerMagicContextTools", () => {
	it("can omit ctx_memory for retrieval-only sidekick subagents", () => {
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
			registerMagicContextTools(pi, { db, compactionOff: true });

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

			const expectedFields: Record<string, string[]> = {
				ctx_search: ["query", "limit", "sources"],
				ctx_memory: ["action", "content", "category", "ids", "limit", "reason"],
				ctx_note: [
					"action",
					"content",
					"surface_condition",
					"note_id",
					"filter",
					"limit",
					"offset",
				],
				ctx_expand: ["start", "end", "verbose", "message"],
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

	it("registers todowrite and /todos by default", () => {
		const db = createTestDb();
		try {
			const registered: string[] = [];
			const commands: string[] = [];
			const pi = {
				registerTool: (tool: { name: string }) => registered.push(tool.name),
				registerCommand: (name: string) => commands.push(name),
			} as never;

			registerMagicContextTools(pi, { db });

			expect(registered).toContain("todowrite");
			expect(commands).toContain("todos");
		} finally {
			closeQuietly(db);
		}
	});

	it("omits todowrite and /todos when todowrite is disabled", () => {
		const db = createTestDb();
		try {
			const registered: string[] = [];
			const commands: string[] = [];
			const pi = {
				registerTool: (tool: { name: string }) => registered.push(tool.name),
				registerCommand: (name: string) => commands.push(name),
			} as never;

			registerMagicContextTools(pi, { db, todowriteEnabled: false });

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

			registerMagicContextTools(pi, { db, todowriteCommandEnabled: false });

			expect(registered).toContain("todowrite");
			expect(commands).not.toContain("todos");
		} finally {
			closeQuietly(db);
		}
	});
});

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

/**
 * Tools present in the A1 golden but NOT registered by Pi.
 *
 * The golden is exported from OpenCode's tool surface, and skill-memory
 * (`ctx_skill_note` / `ctx_skill_recall`) is OpenCode-only: its transparent
 * recall path hangs off OpenCode's `skill` tool lifecycle hooks, which Pi has no
 * counterpart for. See PARITY.md.
 *
 * Listed explicitly rather than filtered by prefix so that a NEW golden tool Pi
 * fails to register still breaks this test — the drift guard stays intact for
 * every tool both hosts are supposed to share.
 */
const OPENCODE_ONLY_GOLDEN_TOOLS = new Set([
	"ctx_skill_note",
	"ctx_skill_recall",
]);

function readA1GoldenToolsForPi(): ReturnType<typeof readA1GoldenTools> {
	const golden = readA1GoldenTools();
	for (const id of OPENCODE_ONLY_GOLDEN_TOOLS) {
		if (!(id in golden)) {
			throw new Error(
				`OPENCODE_ONLY_GOLDEN_TOOLS lists ${id}, which is absent from the A1 golden; drop it from the list.`,
			);
		}
		delete golden[id];
	}
	return golden;
}

describe("registerMagicContextTools — prompt-surface registration", () => {
	it("matches the A1 golden for no config and explicit full", () => {
		const golden = readA1GoldenToolsForPi();
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

	it("registers built-in light descriptions without changing parameter schemas", () => {
		const fullDb = createTestDb();
		const lightDb = createTestDb();
		try {
			const full = captureRegisteredTools({ db: fullDb });
			const light = captureRegisteredTools({
				db: lightDb,
				promptSurface: { default: "light" },
			});
			for (const toolId of Object.keys(LIGHT_TOOL_DESCRIPTIONS)) {
				if (OPENCODE_ONLY_GOLDEN_TOOLS.has(toolId)) continue;
				expect(light.get(toolId)?.description).toBe(
					LIGHT_TOOL_DESCRIPTIONS[
						toolId as keyof typeof LIGHT_TOOL_DESCRIPTIONS
					],
				);
				expect(light.get(toolId)?.parameters).toEqual(
					full.get(toolId)?.parameters,
				);
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
