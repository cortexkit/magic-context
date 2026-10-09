import {
	type OutputReserveConfig,
	resolveOutputReserve,
} from "@magic-context/core/shared/models-dev-cache";
import {
	applyProvenInputFloor,
	deriveWindowGeometry,
	getWindowOverlay,
	resolveWindowOverlayFacts,
	type WindowGeometryResult,
} from "@magic-context/core/shared/window-geometry";

const MIN_SANE_LIMIT = 16_000;
const MAX_SANE_LIMIT = 10_000_000;

export interface PiModelLimit {
	provider?: string;
	id?: string;
	contextWindow?: number;
	maxTokens?: number;
}

export interface ResolvePiWindowGeometryArgs {
	rawContextWindow?: number;
	/** Defaults to observed for Pi's live getContextUsage() window. */
	rawContextWindowSource?: "observed" | "catalog";
	model?: PiModelLimit;
	detectedContextLimit?: number;
	provenInputTokens?: number;
	/** Display-only fallback for a smaller reserved denominator; never capacity proof. */
	persistedInputTokens?: number;
	persistedPercentage?: number;
	reserveConfig?: OutputReserveConfig;
}

function isSaneLimit(value: number | undefined): value is number {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= MIN_SANE_LIMIT &&
		value <= MAX_SANE_LIMIT
	);
}

export function resolvePiWindowGeometry(
	args: ResolvePiWindowGeometryArgs,
): WindowGeometryResult | undefined {
	const rawWindow = isSaneLimit(args.rawContextWindow)
		? args.rawContextWindow
		: undefined;
	const observedWindow =
		args.rawContextWindowSource === "catalog" ? undefined : rawWindow;
	const catalogWindow =
		args.rawContextWindowSource === "catalog" && rawWindow !== undefined
			? rawWindow
			: isSaneLimit(args.model?.contextWindow)
				? args.model.contextWindow
				: undefined;
	// A percentage can reconstruct an old denominator, not prove that a
	// provider accepted it. In particular it can reproduce a poisoned floor.
	const context = observedWindow ?? catalogWindow ?? args.provenInputTokens;
	if (!isSaneLimit(context)) return undefined;
	const providerID = args.model?.provider ?? "unknown";
	const modelID = args.model?.id ?? "unknown";
	const outputReserveOverride = resolveOutputReserve(
		providerID,
		modelID,
		args.reserveConfig,
	);
	const result = deriveWindowGeometry(
		providerID,
		modelID,
		{
			context,
			output: args.model?.maxTokens,
		},
		{
			providerLimit:
				observedWindow === undefined ? undefined : { context: observedWindow },
			overlay: resolveWindowOverlayFacts(
				providerID,
				modelID,
				getWindowOverlay(),
			),
			contextCap: isSaneLimit(args.detectedContextLimit)
				? args.detectedContextLimit
				: undefined,
			outputReserveOverride,
			harness: "pi",
		},
	);
	if (!result) return result;
	let resolved = result;
	const persistedUsable =
		isSaneLimit(args.persistedInputTokens) &&
		typeof args.persistedPercentage === "number" &&
		Number.isFinite(args.persistedPercentage) &&
		args.persistedPercentage > 0
			? Math.round(args.persistedInputTokens / (args.persistedPercentage / 100))
			: undefined;
	// Command contexts sometimes omit maxTokens. Keep the smaller reserved
	// denominator for display, but never enlarge capacity from a percentage.
	if (
		outputReserveOverride === undefined &&
		isSaneLimit(persistedUsable) &&
		persistedUsable < resolved.usableSoft
	) {
		resolved = {
			...resolved,
			usableSoft: persistedUsable,
			derivation: {
				...resolved.derivation,
				reserve: Math.max(0, resolved.derivation.window - persistedUsable),
			},
		};
	}
	if (
		!isSaneLimit(args.detectedContextLimit) &&
		isSaneLimit(args.provenInputTokens)
	) {
		resolved = applyProvenInputFloor(resolved, args.provenInputTokens).geometry;
	}

	return resolved;
}

export function resolvePiUsableContextLimit(
	args: ResolvePiWindowGeometryArgs,
): number | undefined {
	return resolvePiWindowGeometry(args)?.usableSoft;
}
