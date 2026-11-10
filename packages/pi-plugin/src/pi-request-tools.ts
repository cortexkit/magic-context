import {
	type RequestTool,
	type RequestToolsFingerprint,
	requestToolSchemaDigest,
	requestToolsFingerprint,
} from "@magic-context/core/features/magic-context/request-tool-definitions";
import type { PiToolWireSchema } from "./pi-tool-wire-schema";

/**
 * The route the next request goes out on, as far as it decides how Pi's
 * provider layer (pi-ai) writes the `tools` array.
 */
export interface PiRequestToolsRoute {
	/**
	 * The host. Only Pi's provider layer (pi-ai) is modelled; Oh My Pi has its
	 * own, so its tools are fingerprinted as registered (or as its schema
	 * converter writes them).
	 */
	host?: "pi" | "omp";
	/** The session's model (`ctx.model`). */
	model?: {
		provider?: string;
		id?: string;
		api?: string;
		/** pi-ai's per-model overrides; only the two tool flags are read. */
		compat?: unknown;
	};
	/**
	 * The provider's credential is an OAuth token
	 * (`ctx.modelRegistry.isUsingOAuth`). pi-ai then sends tools under Claude
	 * Code's tool names. Unknown counts as false: the fingerprint then counts
	 * at least the tools pi-ai sends.
	 */
	oauth?: boolean;
}

/**
 * How a tool's schema reaches the wire, which decides what its digest covers.
 * - `omp`: Oh My Pi's own converter output, digested in full.
 * - `anthropic`: pi-ai's Anthropic Messages writer without strict tools sends
 *   only `{ type: "object", properties, required }`, with a missing
 *   `properties` or `required` written as empty.
 * - `anthropic-strict`: a model that accepts strict tools gets the whole schema
 *   with those three keys overlaid for tools that ask for constrained sampling;
 *   Magic Context cannot see which tools do, so every tool counts in full.
 * - `raw`: other routes (Bedrock, for one) send the schema object as it is.
 */
type SchemaMode = "omp" | "anthropic" | "anthropic-strict" | "raw";

/**
 * Schema digests by the schema object Pi hands out, per schema mode.
 * `getAllTools` passes each tool definition's `parameters` reference through
 * unchanged, so a session's passes digest each schema once instead of
 * serializing every tool's schema on every pass. An extension that edits a
 * schema object in place, keeping the same reference, is therefore not seen
 * until the object is replaced: an accepted limit, since Pi's own tool refresh
 * replaces definitions rather than mutating them.
 */
const schemaDigests: Record<SchemaMode, WeakMap<object, string>> = {
	omp: new WeakMap(),
	anthropic: new WeakMap(),
	"anthropic-strict": new WeakMap(),
	raw: new WeakMap(),
};

function anthropicWireSchema(parameters: unknown, strict: boolean): unknown {
	const schema =
		typeof parameters === "object" && parameters !== null
			? (parameters as { properties?: unknown; required?: unknown })
			: {};
	const legacy = {
		type: "object",
		properties: schema.properties ?? {},
		required: schema.required ?? [],
	};
	return strict ? { ...schema, ...legacy } : legacy;
}

function schemaDigest(
	tool: { name: string; description: string; parameters: unknown },
	mode: SchemaMode,
	wireSchema: PiToolWireSchema | undefined,
): string {
	const key = tool.parameters;
	const cacheable =
		(typeof key === "object" && key !== null) || typeof key === "function";
	const cache = schemaDigests[mode];
	if (cacheable) {
		const cached = cache.get(key);
		if (cached !== undefined) return cached;
	}
	const digest = requestToolSchemaDigest(
		mode === "omp" && wireSchema
			? // Oh My Pi hands out validator functions as schemas; its wire
				// converter produces the JSON Schema the provider receives.
				wireSchema(tool)
			: mode === "anthropic" || mode === "anthropic-strict"
				? anthropicWireSchema(tool.parameters, mode === "anthropic-strict")
				: tool.parameters,
	);
	if (cacheable) cache.set(key, digest);
	return digest;
}

/** Claude Code's tool names, as pi-ai sends tools over an OAuth token. */
const CLAUDE_CODE_TOOL_NAMES = new Map(
	[
		"Read",
		"Write",
		"Edit",
		"Bash",
		"Grep",
		"Glob",
		"AskUserQuestion",
		"EnterPlanMode",
		"ExitPlanMode",
		"KillShell",
		"NotebookEdit",
		"Skill",
		"Task",
		"TaskOutput",
		"TodoWrite",
		"WebFetch",
		"WebSearch",
	].map((name) => [name.toLowerCase(), name]),
);

const identityName = (name: string) => name;
const claudeCodeName = (name: string) =>
	CLAUDE_CODE_TOOL_NAMES.get(name.toLowerCase()) ?? name;

function compatFlag(
	model: PiRequestToolsRoute["model"],
	flag: "supportsToolReferences" | "supportsStrictTools",
): boolean | undefined {
	const value = (model?.compat as Record<string, unknown> | undefined)?.[flag];
	return typeof value === "boolean" ? value : undefined;
}

/** pi-ai's default for whether an Anthropic model accepts `tool_reference`. */
function supportsToolReferences(
	model: NonNullable<PiRequestToolsRoute["model"]>,
): boolean {
	const declared = compatFlag(model, "supportsToolReferences");
	if (declared !== undefined) return declared;
	if (model.provider !== "anthropic" || typeof model.id !== "string")
		return false;
	if (model.id.includes("haiku")) return false;
	const version = model.id.match(
		/^claude-(?:opus|sonnet|fable)-(\d+)(?:-(\d+))?(?:-|$)/,
	);
	if (!version) return false;
	const major = Number(version[1]);
	const minor = version[2] && version[2].length < 8 ? Number(version[2]) : 0;
	return major > 4 || (major === 4 && minor >= 5);
}

/**
 * Tools pi-ai sends deferred, and the tools the conversation references.
 *
 * Mirrors pi-ai's `splitDeferredTools`: a tool is deferred when a tool result's
 * `addedToolNames` (a tool that activated it during its run) names it before
 * any tool call in the conversation used it. pi-ai sends such a tool after the
 * immediate ones with `defer_loading: true`, and replaces that tool result's
 * content with a `tool_reference` to it. Tool calls and those references are
 * the conversation's references.
 */
function deferredAndReferencedNames(
	messages: readonly unknown[],
	normalizeName: (name: string) => string,
): { deferred: Set<string>; referenced: Set<string> } {
	const deferred = new Set<string>();
	const referenced = new Set<string>();
	for (const message of messages) {
		const { role, content, addedToolNames } = (message ?? {}) as {
			role?: unknown;
			content?: unknown;
			addedToolNames?: unknown;
		};
		if (role === "assistant" && Array.isArray(content)) {
			for (const block of content) {
				const { type, name } = (block ?? {}) as {
					type?: unknown;
					name?: unknown;
				};
				if (type === "toolCall" && typeof name === "string")
					referenced.add(normalizeName(name));
			}
		} else if (role === "toolResult" && Array.isArray(addedToolNames)) {
			for (const name of addedToolNames) {
				if (typeof name !== "string") continue;
				const normalized = normalizeName(name);
				if (!referenced.has(normalized)) deferred.add(normalized);
			}
		}
	}
	// Every deferred tool gets a tool_reference in the result that added it.
	for (const name of deferred) referenced.add(name);
	return { deferred, referenced };
}

/** Tool names the conversation calls, for routes that defer nothing. */
function calledToolNames(messages: readonly unknown[]): Set<string> {
	const names = new Set<string>();
	for (const message of messages) {
		const content = (message as { content?: unknown })?.content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			const { type, name } = (part ?? {}) as { type?: unknown; name?: unknown };
			if (
				typeof type === "string" &&
				type.toLowerCase().includes("tool") &&
				typeof name === "string"
			)
				names.add(name);
		}
	}
	return names;
}

/**
 * The fingerprint of the tools Pi's next request sends: the registered tools
 * (`getAllTools`) the session has active (`getActiveTools`), as Pi builds the
 * request from them, written the way the route's provider writer sends them.
 * Undefined when either list cannot be read, which leaves the release to the
 * provider's 400 and the reactive recovery.
 *
 * Descriptions come from the registered definitions. Pi sends the wrapped
 * tool, which copied the definition's description when the tool registry was
 * last refreshed, so an extension that edits a definition's description in
 * place without a refresh makes the fingerprint change while the wire does
 * not: a needless release, never a missed one. The same holds for an in-place
 * schema edit (see schemaDigests above), which is missed instead.
 */
export function readPiRequestToolsFingerprint(
	pi: { getAllTools?: () => unknown; getActiveTools?: () => unknown },
	wireSchema: PiToolWireSchema | undefined,
	messages: readonly unknown[],
	route: PiRequestToolsRoute = {},
): RequestToolsFingerprint | undefined {
	try {
		if (
			typeof pi.getAllTools !== "function" ||
			typeof pi.getActiveTools !== "function"
		)
			return undefined;
		const all = pi.getAllTools();
		const active = pi.getActiveTools();
		if (!Array.isArray(all) || !Array.isArray(active)) return undefined;
		const registered = new Map<string, Record<string, unknown>>();
		for (const tool of all) {
			if (!tool || typeof tool !== "object") return undefined;
			const { name } = tool as { name?: unknown };
			if (typeof name !== "string") return undefined;
			registered.set(name, tool as Record<string, unknown>);
		}
		// pi-ai's Anthropic Messages writer is the one modelled here; Oh My Pi
		// has its own writer, and other routes send tools as registered.
		const model = route.model;
		const anthropicWriter =
			route.host === "pi" &&
			wireSchema === undefined &&
			model?.api === "anthropic-messages";
		const mode: SchemaMode = wireSchema
			? "omp"
			: anthropicWriter
				? compatFlag(model, "supportsStrictTools") === true
					? "anthropic-strict"
					: "anthropic"
				: "raw";
		const normalizeName =
			anthropicWriter && route.oauth === true ? claudeCodeName : identityName;
		// One tool per name as sent: pi-ai keeps the last tool registered under
		// a name, and over OAuth two names that map to the same Claude Code name
		// send one tool.
		const sent = new Map<string, Record<string, unknown>>();
		for (const name of active) {
			if (typeof name !== "string") return undefined;
			const tool = registered.get(name);
			// Pi sends only registered tools.
			if (!tool) continue;
			sent.set(normalizeName(name), tool);
		}
		const split =
			anthropicWriter && model && supportsToolReferences(model)
				? deferredAndReferencedNames(messages, normalizeName)
				: undefined;
		// pi-ai sends deferred tools as immediate ones when nothing else is sent.
		const anyImmediate = [...sent.keys()].some(
			(name) => !split?.deferred.has(name),
		);
		const tools: RequestTool[] = [];
		for (const [name, tool] of sent) {
			const description =
				typeof tool.description === "string" ? tool.description : "";
			tools.push({
				name,
				description,
				schemaDigest: schemaDigest(
					{
						name: tool.name as string,
						description,
						parameters: tool.parameters,
					},
					mode,
					wireSchema,
				),
				deferLoading: split
					? anyImmediate && split.deferred.has(name)
					: tool.defer_loading === true || tool.deferLoading === true,
			});
		}
		return requestToolsFingerprint(
			tools,
			// Open question, pending a live probe: Anthropic documents that adding
			// a deferred tool nothing references leaves signed thinking valid, but
			// not whether a deferred tool that a tool_reference names invalidates
			// the blocks before that reference. pi-ai always sends that reference
			// with the deferred tool, so until this is settled a referenced
			// deferred tool counts like any other, which errs toward stripping.
			() => split?.referenced ?? calledToolNames(messages),
		);
	} catch {
		// A throwing host API or schema converter proves nothing about the wire.
		return undefined;
	}
}
