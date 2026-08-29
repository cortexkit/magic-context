import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const HISTORIAN_TEMPERATURE_ENV = "MAGIC_CONTEXT_HISTORIAN_TEMPERATURE";
export const HISTORIAN_MAX_OUTPUT_TOKENS_ENV = "MAGIC_CONTEXT_HISTORIAN_MAX_OUTPUT_TOKENS";

function finiteNumber(value: string | undefined): number | undefined {
	if (value === undefined || value.trim().length === 0) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Apply the historian calibration to each provider's serialized request shape. */
export function calibrateHistorianProviderPayload(
	payload: unknown,
	temperature: number,
	maxOutputTokens: number,
): unknown {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return payload;
	const calibrated = { ...(payload as Record<string, unknown>) };
	const generationConfig = calibrated.generationConfig;
	if (
		typeof generationConfig === "object" &&
		generationConfig !== null &&
		!Array.isArray(generationConfig)
	) {
		calibrated.generationConfig = {
			...(generationConfig as Record<string, unknown>),
			temperature,
			maxOutputTokens,
		};
		return calibrated;
	}
	const inferenceConfig = calibrated.inferenceConfig;
	if (
		typeof inferenceConfig === "object" &&
		inferenceConfig !== null &&
		!Array.isArray(inferenceConfig)
	) {
		calibrated.inferenceConfig = {
			...(inferenceConfig as Record<string, unknown>),
			temperature,
			maxTokens: maxOutputTokens,
		};
		return calibrated;
	}

	calibrated.temperature = temperature;
	if ("max_output_tokens" in calibrated) {
		calibrated.max_output_tokens = maxOutputTokens;
	} else if ("max_completion_tokens" in calibrated) {
		calibrated.max_completion_tokens = maxOutputTokens;
	} else if ("max_tokens" in calibrated) {
		calibrated.max_tokens = maxOutputTokens;
	} else if ("maxTokens" in calibrated) {
		calibrated.maxTokens = maxOutputTokens;
	}
	return calibrated;
}

export default function historianCalibrationExtension(pi: ExtensionAPI): void {
	const temperature = finiteNumber(process.env[HISTORIAN_TEMPERATURE_ENV]);
	const maxOutputTokens = finiteNumber(process.env[HISTORIAN_MAX_OUTPUT_TOKENS_ENV]);
	if (temperature === undefined || maxOutputTokens === undefined) return;
	pi.on("before_provider_request", (event) =>
		calibrateHistorianProviderPayload(event.payload, temperature, maxOutputTokens),
	);
}
