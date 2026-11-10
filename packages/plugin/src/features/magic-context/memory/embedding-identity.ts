import type { EmbeddingConfig } from "../../../config/schema/magic-context";
import { DEFAULT_LOCAL_EMBEDDING_MODEL } from "../../../config/schema/magic-context";
import { resolveEmbeddingTextPrefixes } from "./embedding-model-match";
import { getSynapseLaneIdentity } from "./embedding-synapse";
import { getCachedLocalEmbeddingPooling } from "./local-embedding-pooling";
import { computeNormalizedHash } from "./normalize-hash";

function normalizeEndpoint(endpoint?: string): string {
    return endpoint?.trim().replace(/\/+$/, "") ?? "";
}

// Local vectors can change when the Transformers or ONNX implementation changes,
// even when the model files and fp32 configuration stay the same. Keep stored
// memory and chunk vectors fenced to the runtime stack that produced them.
export const LOCAL_EMBEDDING_RUNTIME_FINGERPRINT =
    "transformers@4.3.0;onnxruntime-node@1.30.0;onnxruntime-web@1.26.0-dev.20260416-b7804b056c";

/**
 * Stable embedding-provider identity used for provider/pipeline reuse.
 *
 * The API key value is intentionally never hashed or stored. Only key
 * presence participates in identity so switching between anonymous and
 * authenticated modes recreates the provider, while rotating a key does not
 * leak secret material into logs or persisted model ids.
 */
export function getEmbeddingProviderIdentity(config: EmbeddingConfig): string {
    if (config.provider === "off") {
        return "embedding-provider:off";
    }

    if (config.provider === "synapse") {
        const resolved = config as EmbeddingConfig & {
            model?: string;
            synapse_fingerprint?: string;
        };
        if (!resolved.model || !resolved.synapse_fingerprint) return "synapse:v1:pending";
        return getSynapseLaneIdentity(resolved.model, resolved.synapse_fingerprint);
    }

    if (config.provider !== "local" && config.provider !== "openai-compatible") {
        throw new Error("Unknown embedding provider");
    }

    const truncate = config.provider === "openai-compatible" ? config.truncate?.trim() : undefined;
    // A requested output width picks a different vector subspace out of the same
    // weights (Matryoshka MRL), so it MUST fold into identity exactly like the
    // model name does. Spread CONDITIONALLY and omit when unset: the identity
    // stays byte-identical for every config that never sets it, so this field
    // forces no global re-embed on upgrade.
    const dimensions = config.provider === "openai-compatible" ? config.dimensions : undefined;
    const documentPrefix =
        config.provider === "openai-compatible"
            ? resolveEmbeddingTextPrefixes(
                  config.model,
                  config.query_instruction,
                  config.document_prefix,
              ).documentPrefix
            : "";
    // local_dtype changes the produced vectors (a quantized ONNX model emits
    // different embeddings than fp32), so a non-default dtype MUST fold into the
    // model identity — switching dtype re-embeds rather than mixing vector
    // spaces. Spread CONDITIONALLY and EXCLUDE the default "fp32": omitting the
    // term when unset OR when set to the default keeps the identity byte-
    // identical for the common config, so adding this field does not force a
    // global re-embed on upgrade. Mirrors the truncate fold above. See #259.
    const localDtype =
        config.provider === "local" && config.local_dtype && config.local_dtype !== "fp32"
            ? config.local_dtype
            : undefined;
    const localPooling =
        config.provider === "local"
            ? getCachedLocalEmbeddingPooling(config.model?.trim() || DEFAULT_LOCAL_EMBEDDING_MODEL)
            : null;
    // The original local default was mean pooling with normalization. Preserve
    // its identity for declared mean models with a Normalize module and for
    // models that do not declare a sentence-transformers Pooling module.
    const localPoolingFingerprint =
        localPooling?.status === "ready" &&
        (localPooling.pooling !== "mean" || !localPooling.normalize)
            ? `${localPooling.pooling};normalize=${localPooling.normalize}`
            : undefined;
    const identityInput =
        config.provider === "openai-compatible"
            ? {
                  provider: "openai-compatible",
                  model: config.model.trim(),
                  endpoint: normalizeEndpoint(config.endpoint),
                  apiKeyPresent: Boolean(config.api_key?.trim()),
                  // input_type and documentPrefix shape stored passage vectors,
                  // so either change must re-embed. query_input_type and
                  // query_instruction shape only per-call query vectors and stay
                  // out. Conditional fields keep the identity byte-identical for
                  // Qwen3 and other models whose document prefix is empty.
                  inputType: config.input_type?.trim() || "",
                  ...(documentPrefix ? { documentPrefix } : {}),
                  ...(truncate ? { truncate } : {}),
                  ...(dimensions ? { dimensions } : {}),
              }
            : {
                  provider: "local",
                  model: config.model?.trim() || DEFAULT_LOCAL_EMBEDDING_MODEL,
                  endpoint: "",
                  apiKeyPresent: false,
                  runtimeFingerprint: LOCAL_EMBEDDING_RUNTIME_FINGERPRINT,
                  ...(localDtype ? { localDtype } : {}),
                  ...(localPoolingFingerprint ? { localPooling: localPoolingFingerprint } : {}),
              };

    return `embedding-provider:${computeNormalizedHash(JSON.stringify(identityInput))}`;
}
