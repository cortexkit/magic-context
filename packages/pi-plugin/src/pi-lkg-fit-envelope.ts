import { createHash } from "node:crypto";
import {
	calibrationForModelKey,
	type DecisionCalibration,
} from "@magic-context/core/hooks/magic-context/decision-calibration";
import {
	estimateTokens,
	hasTokenizerForFit,
} from "@magic-context/core/hooks/magic-context/read-session-formatting";
import { piModelRefToCanonical } from "@magic-context/core/shared/harness-provider-map";
import { readHostSystemPrompt } from "./host-system-prompt";
import type { PiFitEnvelope } from "./pi-raw-fallback";
import type { PiToolWireSchema } from "./pi-tool-wire-schema";

/** Only complete current host metadata can make a replay admissible. Counting
 * every registered tool (including inactive tools) and serialized wrappers is
 * conservative relative to counting just the active definitions' prose. */
export function readPiLkgFitEnvelope(
	ctx: { getSystemPrompt?: () => unknown },
	pi: { getAllTools?: () => unknown; getActiveTools?: () => unknown },
	modelKey: string | null | undefined,
	frozen: DecisionCalibration,
	wireSchema?: PiToolWireSchema,
): PiFitEnvelope | undefined {
	try {
		if (!modelKey || typeof pi.getAllTools !== "function") return;
		const system = readHostSystemPrompt(ctx);
		const allTools = pi.getAllTools();
		if (
			typeof system !== "string" ||
			!system.length ||
			!Array.isArray(allTools)
		)
			return;
		const tools: Array<{
			name: string;
			description: string;
			parameters: object;
		}> = [];
		for (const tool of allTools) {
			if (!tool || typeof tool !== "object") return;
			const { name, description } = tool;
			const parameters = wireSchema ? wireSchema(tool) : tool.parameters;
			if (
				typeof name !== "string" ||
				!name.length ||
				typeof description !== "string" ||
				!parameters ||
				typeof parameters !== "object" ||
				Array.isArray(parameters)
			)
				return;
			tools.push({ name, description, parameters });
		}
		const stringify = (value: unknown) =>
			JSON.stringify(value, (_key, item: unknown) => {
				if (
					["undefined", "function", "symbol", "bigint"].includes(typeof item) ||
					(typeof item === "number" && !Number.isFinite(item))
				)
					throw new Error("incomplete envelope value");
				return item;
			});
		// Serialize external objects once so getters cannot give the token and
		// byte guards different schema snapshots.
		const envelopeJson = stringify({ system, tools, messages: [] });
		const serializedTools = JSON.parse(envelopeJson) as {
			system: string;
			tools: Array<{
				name: unknown;
				description: unknown;
				parameters: unknown;
			}>;
		};
		const systemJson = JSON.stringify({
			role: "system",
			content: serializedTools.system,
		});
		const toolsJson = JSON.stringify({ tools: serializedTools.tools });
		if (
			serializedTools.tools.some(
				({ name, description, parameters }) =>
					typeof name !== "string" ||
					!name.length ||
					typeof description !== "string" ||
					!parameters ||
					typeof parameters !== "object" ||
					Array.isArray(parameters),
			)
		)
			return;
		const canonical = piModelRefToCanonical(modelKey).toLowerCase();
		// Never use another model's freeze or adopt a new table while storage is
		// busy. Without a matching freeze, fit uses max(2, largest measured ratio).
		const measured = calibrationForModelKey(canonical).seeded;
		const calibration =
			frozen.modelKey === canonical &&
			measured &&
			frozen.source !== "family-fallback"
				? frozen
				: calibrationForModelKey(null);
		// A measured prefix reflects only the previously active tool subset.
		// Missing active-set introspection still permits the all-tools fallback.
		let activeNames: string[] | undefined =
			serializedTools.tools.length === 0 ? [] : undefined;
		try {
			if (typeof pi.getActiveTools === "function") {
				const active = pi.getActiveTools();
				const known = new Set(serializedTools.tools.map((tool) => tool.name));
				if (
					!Array.isArray(active) ||
					new Set(active).size !== active.length ||
					!active.every((name) => typeof name === "string" && known.has(name))
				)
					return;
				activeNames = [...active].sort();
			}
		} catch {
			activeNames = undefined;
			/* The complete registry remains sufficient for the static fallback. */
		}
		const systemTokens = estimateTokens(systemJson);
		const toolDefinitionTokens = estimateTokens(toolsJson);
		const refusalToolDefinitionTokens = activeNames
			? estimateTokens(
					JSON.stringify({
						tools: serializedTools.tools.filter((tool) =>
							activeNames.includes(String(tool.name)),
						),
					}),
				)
			: undefined;
		if (!hasTokenizerForFit()) return;
		return {
			modelKey: canonical,
			systemTokens,
			toolDefinitionTokens,
			refusalToolDefinitionTokens,
			toolDefinitionsMeasured: refusalToolDefinitionTokens !== undefined,
			envelopeBytes: Buffer.byteLength(envelopeJson),
			envelopeSignature: activeNames
				? createHash("sha256")
						.update(envelopeJson)
						.update(JSON.stringify(activeNames))
						.digest("hex")
				: undefined,
			calibration,
		};
	} catch {
		// Missing metadata, cycles, invalid schemas and throwing APIs are partial.
		return;
	}
}
