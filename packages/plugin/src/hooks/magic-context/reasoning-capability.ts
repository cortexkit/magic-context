import { getModelsDevInterleavedField } from "../../shared/models-dev-cache";

export interface LiveSessionModel {
    providerID: string;
    modelID: string;
}

/**
 * Return true when the session's current model exposes an interleaved
 * reasoning field (for example `reasoning_content`). In that mode OpenCode's
 * provider transform concatenates typed `reasoning` parts into a top-level
 * wire field and strips those parts from `content` afterwards.
 *
 * Magic-context's older reasoning cleanup rewrites aged reasoning to the
 * literal string `[cleared]` and then removes those reasoning parts entirely.
 * That is safe for providers that treat reasoning as optional local context,
 * but it breaks providers like Moonshot/Kimi: once we remove all reasoning
 * parts from an assistant tool-call message, OpenCode emits no
 * `reasoning_content` field and the provider rejects the request.
 *
 * Unknown models return false on purpose. We only disable stripping when the
 * cache explicitly says the provider requires interleaved reasoning; guessing
 * true would preserve extra context for models that do not need it.
 */
export function modelRequiresInterleavedReasoning(model: LiveSessionModel | undefined): boolean {
    if (!model?.providerID || !model?.modelID) {
        return false;
    }

    const field = getModelsDevInterleavedField(model.providerID, model.modelID);
    return typeof field === "string" && field.length > 0;
}
