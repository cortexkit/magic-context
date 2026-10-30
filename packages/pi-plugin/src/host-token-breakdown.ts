import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { getOverflowState } from "@magic-context/core/features/magic-context/storage-meta-persisted";
import type { SessionMeta } from "@magic-context/core/features/magic-context/types";
import {
	HostTokenMeasurementCache,
	measureHostToolDefinitions,
} from "@magic-context/core/hooks/magic-context/host-token-breakdown";
import type { M0BlockTokens } from "@magic-context/core/hooks/magic-context/m0-token-breakdown";
import { estimateTokens } from "@magic-context/core/hooks/magic-context/read-session-formatting";
import { readHostSystemPrompt } from "./host-system-prompt";
import { resolvePiWindowGeometry } from "./pi-context-limit";
import {
	piPressureEvidenceLimit,
	resolvePiStatusPressureSnapshot,
} from "./pi-pressure";
import {
	piProvenFloorModelKey,
	resolvePiProvenInputFloor,
} from "./pi-proven-floor";

export function hostToolSchemaBytes(
	tools: readonly {
		name?: string;
		description?: string;
		parameters?: unknown;
	}[],
): string[] {
	return tools.map((tool) => {
		let parameters = "";
		try {
			parameters =
				tool.parameters == null
					? ""
					: typeof tool.parameters === "string"
						? tool.parameters
						: (JSON.stringify(tool.parameters) ?? "");
		} catch {
			parameters = "";
		}
		return `${tool.name ?? ""}\n${tool.description ?? ""}\n${parameters}`;
	});
}

export { measureHostToolDefinitions };

const systemMeasurements = new HostTokenMeasurementCache(estimateTokens);
export const measurePiSystemPrompt = (text: string): number =>
	systemMeasurements.text(text);

export function readPiAttributionHost(pi: ExtensionAPI, ctx: ExtensionContext) {
	let system: string | undefined;
	let tools: string[] = [];
	try {
		system = readHostSystemPrompt(ctx);
	} catch {
		/* The host may not expose a prompt yet. */
	}
	try {
		tools = hostToolSchemaBytes(pi.getAllTools?.() ?? []);
	} catch {
		/* Keep status available without schemas. */
	}
	return { system, tools };
}

export function readPiAttributionUsage(
	ctx: ExtensionContext,
	db: ContextDatabase,
	sessionId: string,
	meta: Pick<SessionMeta, "lastContextPercentage" | "lastInputTokens">,
) {
	const usage = ctx.getContextUsage?.();
	let detectedContextLimit: number | undefined;
	try {
		const detected = getOverflowState(db, sessionId).detectedContextLimit;
		if (detected > 0) detectedContextLimit = detected;
	} catch {
		// Status remains available when overflow metadata cannot be read.
	}
	const providerInputLimit = piPressureEvidenceLimit(
		resolvePiWindowGeometry({
			rawContextWindow: usage?.contextWindow ?? ctx.model?.contextWindow,
			rawContextWindowSource: "catalog",
			model: ctx.model,
			detectedContextLimit,
		}),
	);
	const provenInputTokens = resolvePiProvenInputFloor({
		db,
		sessionId,
		modelKey: piProvenFloorModelKey(ctx.model),
		readBranch: () => ctx.sessionManager.getBranch(),
		providerInputLimit,
	});
	const windowGeometry = resolvePiWindowGeometry({
		rawContextWindow: usage?.contextWindow ?? ctx.model?.contextWindow,
		rawContextWindowSource: "catalog",
		model: ctx.model,
		detectedContextLimit,
		provenInputTokens: provenInputTokens || undefined,
		persistedInputTokens: meta.lastInputTokens,
		persistedPercentage: meta.lastContextPercentage,
	});
	const pressure = resolvePiStatusPressureSnapshot({
		providerInputLimit,
		sessionId,
		persistedPercentage: meta.lastContextPercentage,
		persistedInputTokens: meta.lastInputTokens,
		liveInputTokens: usage?.tokens,
		usableContextLimit: windowGeometry?.usableSoft,
	});
	return {
		pressure,
		windowGeometry,
		live: {
			persistedInputTokens: meta.lastInputTokens,
			persistedPercentage: meta.lastContextPercentage,
			detectedContextLimit,
			provenInputTokens: provenInputTokens || undefined,
			providerInputLimit,
		},
	};
}

/** Pi's dialog uses local stable buckets and assigns the displayed remainder to conversation. */
export function buildPiTokenAttribution(
	inputTokens: number,
	systemPromptTokens: number,
	toolDefinitionTokens: number,
	toolCallTokens: number,
	blocks: M0BlockTokens,
) {
	const conversationTokens = Math.max(
		0,
		inputTokens -
			systemPromptTokens -
			toolDefinitionTokens -
			toolCallTokens -
			blocks.compartmentTokens -
			blocks.factTokens -
			blocks.memoryTokens -
			blocks.docsTokens -
			blocks.profileTokens,
	);
	return {
		...blocks,
		systemTokens: systemPromptTokens,
		toolDefinitionTokens,
		toolCallTokens,
		conversationTokens,
	};
}

/** No provider response exists for the request being sent; use the dialog's last observed usage. */
export function readPiTokenAttribution(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	meta: Pick<
		SessionMeta,
		"lastContextPercentage" | "lastInputTokens" | "systemPromptTokens"
	>,
	pressureInputs: {
		sessionId: string;
		providerInputLimit: number;
		usableContextLimit?: number;
	},
	toolCallTokens: number,
	blocks: M0BlockTokens,
) {
	const pressure = resolvePiStatusPressureSnapshot({
		...pressureInputs,
		persistedInputTokens: meta.lastInputTokens,
		persistedPercentage: meta.lastContextPercentage,
		liveInputTokens: ctx.getContextUsage?.()?.tokens,
	});
	const host = readPiAttributionHost(pi, ctx);
	return buildPiTokenAttribution(
		pressure.inputTokens,
		host.system === undefined
			? meta.systemPromptTokens
			: measurePiSystemPrompt(host.system),
		measureHostToolDefinitions(host.tools),
		toolCallTokens,
		blocks,
	);
}
