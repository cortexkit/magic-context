/**
 * Provider-id translation between the canonical (OpenCode) form stored in the
 * shared magic-context config and Pi's harness-native provider ids.
 *
 * Provider IDs are a harness boundary, not a database identity. Shared config
 * always stores the canonical OpenCode form. Each non-OpenCode harness owns an
 * explicit pair of edge transforms:
 *
 *   canonical (OpenCode)   Pi / OMP selector
 *   --------------------   -----------------
 *   openai/<model>         openai-codex/<model>
 *   google/<model>         google-antigravity/<model>
 *   anthropic/<model>      anthropic/<model> (same; every other provider too)
 *
 * Pi and OMP currently expose the same two subscription-provider aliases, but
 * their exported functions remain distinct deliberately. A future OMP catalog
 * rename must not silently change plain-Pi behavior (or vice versa).
 *
 * The mapping is intentionally not a one-to-one provider identity. Both
 * harnesses also expose plain `openai` and `google` providers for direct API
 * keys, while the canonical prefix does not record whether a subscription or
 * API-key backend should win. The runtime starts with the preferred
 * subscription form and subagent-runner may retry once with the untranslated
 * canonical form when that form reports missing credentials.
 *
 * Only the provider prefix before the first slash is translated. Model IDs,
 * including nested IDs containing more slashes, are preserved byte-for-byte.
 * Scoped or otherwise unknown provider prefixes are identities.
 *
 * OpenCode needs no translation because canonical is its native form.
 */

const CANONICAL_TO_PI_PROVIDER: Readonly<Record<string, string>> = {
    openai: "openai-codex",
    google: "google-antigravity",
};

const PI_TO_CANONICAL_PROVIDER: Readonly<Record<string, string>> = {
    "openai-codex": "openai",
    "google-antigravity": "google",
};

const CANONICAL_TO_OMP_PROVIDER: Readonly<Record<string, string>> = {
    openai: "openai-codex",
    google: "google-antigravity",
};

const OMP_TO_CANONICAL_PROVIDER: Readonly<Record<string, string>> = {
    "openai-codex": "openai",
    "google-antigravity": "google",
};

/** Remap only the provider prefix (text before the first "/"), preserving the
 *  model id verbatim. No "/", empty provider, or unmapped provider -> unchanged.
 *  Lookups are own-property only, so provider ids that collide with
 *  `Object.prototype` members (`constructor/model`, `toString/model`) stay
 *  identities instead of becoming garbage prefixes. */
function remapProviderPrefix(ref: string, map: Readonly<Record<string, string>>): string {
    if (typeof ref !== "string") return ref;
    const slash = ref.indexOf("/");
    if (slash <= 0) return ref;
    const provider = ref.slice(0, slash);
    if (!Object.hasOwn(map, provider)) return ref;
    return `${map[provider]}${ref.slice(slash)}`;
}

/** Pi-native `provider/model` -> canonical (OpenCode). Identity when unmapped.
 *  Used by the Pi setup wizard so configs it writes stay OpenCode-readable. */
export function piModelRefToCanonical(ref: string): string {
    return remapProviderPrefix(ref, PI_TO_CANONICAL_PROVIDER);
}

/** Canonical (OpenCode) `provider/model` -> Pi-native, for spawning a model on
 *  Pi. Idempotent: normalizes any Pi-form prefix back to canonical first, so it
 *  is safe on a config that already holds Pi-form ids (hand-edited or pre-fix). */
export function resolveModelRefForPi(ref: string): string {
    return remapProviderPrefix(piModelRefToCanonical(ref), CANONICAL_TO_PI_PROVIDER);
}

/** OMP-native selector -> canonical shared-config model reference. */
export function ompModelRefToCanonical(ref: string): string {
    return remapProviderPrefix(ref, OMP_TO_CANONICAL_PROVIDER);
}

/** Canonical shared-config model reference -> OMP-native selector. */
export function resolveModelRefForOmp(ref: string): string {
    return remapProviderPrefix(ompModelRefToCanonical(ref), CANONICAL_TO_OMP_PROVIDER);
}
