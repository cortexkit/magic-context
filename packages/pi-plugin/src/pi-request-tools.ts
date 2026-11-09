import {
	type RequestTool,
	type RequestToolsFingerprint,
	requestToolSchemaDigest,
	requestToolsFingerprint,
} from "@magic-context/core/features/magic-context/request-tool-definitions";
import type { PiToolWireSchema } from "./pi-tool-wire-schema";

/**
 * Schema digests by the schema object Pi hands out. `getAllTools` passes each
 * tool definition's `parameters` reference through unchanged, so a session's
 * passes digest each schema once instead of serializing every tool's schema
 * on every pass.
 */
const schemaDigests = new WeakMap<object, string>();

function schemaDigest(
	tool: { name: string; description: string; parameters: unknown },
	wireSchema: PiToolWireSchema | undefined,
): string {
	const key = tool.parameters;
	const cacheable =
		(typeof key === "object" && key !== null) || typeof key === "function";
	if (cacheable) {
		const cached = schemaDigests.get(key);
		if (cached !== undefined) return cached;
	}
	// Oh My Pi hands out validator functions as schemas; its wire converter
	// produces the JSON Schema the provider actually receives.
	const digest = requestToolSchemaDigest(
		wireSchema ? wireSchema(tool) : tool.parameters,
	);
	if (cacheable) schemaDigests.set(key, digest);
	return digest;
}

/** Tool names the conversation calls, so a deferred tool counts once used. */
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
 * request from them. Undefined when either list cannot be read, which leaves
 * the release to the provider's 400 and the reactive recovery.
 */
export function readPiRequestToolsFingerprint(
	pi: { getAllTools?: () => unknown; getActiveTools?: () => unknown },
	wireSchema: PiToolWireSchema | undefined,
	messages: readonly unknown[],
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
		const tools: RequestTool[] = [];
		for (const name of new Set(active)) {
			if (typeof name !== "string") return undefined;
			const tool = registered.get(name);
			// Pi sends only registered tools.
			if (!tool) continue;
			const description =
				typeof tool.description === "string" ? tool.description : "";
			tools.push({
				name,
				description,
				schemaDigest: schemaDigest(
					{ name, description, parameters: tool.parameters },
					wireSchema,
				),
				deferLoading: tool.defer_loading === true || tool.deferLoading === true,
			});
		}
		return requestToolsFingerprint(tools, () => calledToolNames(messages));
	} catch {
		// A throwing host API or schema converter proves nothing about the wire.
		return undefined;
	}
}
