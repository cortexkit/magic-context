/**
 * `mural.model` used to name one cue-compressor model shared by every harness.
 * Model ids differ per harness (OpenCode and Pi spell the same model with
 * different provider prefixes), so a single string could not name a working
 * model on every host. compress-cues now resolves through each harness's
 * dreamer settings like every other dreamer task, and the key is ignored.
 */
export const MURAL_MODEL_DEPRECATION_WARNING =
    "mural.model is deprecated and ignored; compress-cues now uses the dreamer model for each harness, like every other dreamer task. To override it, set dreamer.opencode.tasks.compress-cues.model (or the pi/omp equivalent). This key no longer does anything; remove it.";

/**
 * Pushes the deprecation warning when the config still sets `mural.model`.
 * Call it after the legacy experimental migration so the pre-graduation
 * `experimental.mural.model` spelling is reported the same way.
 */
export function warnDeprecatedMuralModel(
    config: Record<string, unknown>,
    warnings: string[],
): void {
    const mural = config.mural;
    if (typeof mural === "object" && mural !== null && Object.hasOwn(mural, "model")) {
        warnings.push(MURAL_MODEL_DEPRECATION_WARNING);
    }
}
