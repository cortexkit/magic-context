/**
 * Decides which `embedding.dimensions` width the Test Connection probe sends.
 *
 * The bounds match the runtime schema (`z.number().int().min(1).max(8192)
 * .optional()`), with no string coercion. When the user config has an invalid
 * value, the runtime does not quietly fall back to the endpoint default. The
 * loader records `embedding.dimensions` as a recovered field, and embedding
 * registration treats that load as untrusted and keeps the last-known-good
 * registration. If the probe dropped the bad value and tested the default
 * width, it could report "Connected" for a config the runtime has paused. So
 * an invalid value is reported before any request is sent. The field is left
 * out of the request only when it is absent.
 */

export const EMBEDDING_DIMENSIONS_MAX = 8192;

export type ProbeDimensions =
  | { ok: true; dimensions: number | null }
  | { ok: false; message: string };

export function resolveProbeDimensions(raw: unknown): ProbeDimensions {
  if (raw === undefined) return { ok: true, dimensions: null };
  if (
    typeof raw === "number" &&
    Number.isInteger(raw) &&
    raw >= 1 &&
    raw <= EMBEDDING_DIMENSIONS_MAX
  ) {
    return { ok: true, dimensions: raw };
  }
  return {
    ok: false,
    message: `embedding.dimensions must be an integer from 1 to ${EMBEDDING_DIMENSIONS_MAX} (got ${JSON.stringify(raw) ?? String(raw)}); the runtime will not register embeddings with this value — fix or remove it`,
  };
}
