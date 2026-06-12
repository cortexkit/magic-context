/**
 * Security hardening for PROJECT-level (repo-supplied, untrusted) config.
 *
 * A project config lives inside a repository the user cloned. Opening a repo
 * must never let that repo's config escalate privilege or exfiltrate secrets.
 * These helpers run on the raw project config BEFORE/AFTER it is merged over the
 * trusted user config, mutating the relevant object in place and returning
 * human-readable warnings.
 *
 * Shared by both harnesses (OpenCode `config/index.ts` and Pi
 * `config/index.ts`) so the trust boundary is identical cross-harness.
 */

/** Hidden agents that run with elevated/autonomous capability. */
const HIDDEN_AGENT_KEYS = ["historian", "dreamer", "sidekick"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Strip unsafe fields from a raw PROJECT config IN PLACE, before it is merged
 * over the user config. Returns warnings describing what was ignored.
 *
 * Closes:
 *  - `auto_update` — a repo must not suppress plugin self-updates (which can
 *    carry security fixes).
 *  - `sqlite` — `sqlite.cache_size_mb` / `mmap_size_mb` become PRAGMAs on the
 *    process-global shared DB handle (one connection across every project in the
 *    process). A cloned repo could set a huge value to exhaust host memory /
 *    address space — a resource-exhaustion vector with no legitimate per-repo
 *    use. Honor user-level config only.
 *  - `embedding` (entire object) — memory text is POSTed to the embedding
 *    endpoint. A repo that supplies/redirects it would exfiltrate memory content
 *    (and could inherit the user's api_key) to an attacker server. The embedding
 *    provider/endpoint/key is the user's decision alone.
 *  - `historian`/`dreamer`/`sidekick` (entire objects) — hidden agents. The
 *    dreamer/sidekick run autonomously with bash/write/edit/webfetch; the
 *    historian routes model calls. A repo must not enable, reprogram,
 *    re-permission, or re-route any of them, so the WHOLE block is dropped
 *    (model/schedule/tasks included) — closing routing-override and enablement
 *    vectors a field-level strip would miss.
 *  - `memory.git_commit_indexing` — reads repo git history into the shared
 *    store; a repo must not silently enable git-history indexing.
 */
export function stripUnsafeProjectConfigFields(projectRaw: Record<string, unknown>): string[] {
    const warnings: string[] = [];

    if ("auto_update" in projectRaw) {
        delete projectRaw.auto_update;
        warnings.push(
            "Ignoring auto_update from project config (security: this setting only honors user-level config).",
        );
    }

    if ("sqlite" in projectRaw) {
        delete projectRaw.sqlite;
        warnings.push(
            "Ignoring sqlite.* from project config (security: SQLite cache/mmap PRAGMAs apply to the " +
                "process-global shared database handle; only user-level config may set them).",
        );
    }

    if ("embedding" in projectRaw) {
        delete projectRaw.embedding;
        warnings.push(
            "Ignoring embedding from project config (security: the embedding endpoint/provider/key is " +
                "user-config-only; a repository must not redirect where memory text is sent).",
        );
    }

    for (const agentKey of HIDDEN_AGENT_KEYS) {
        if (agentKey in projectRaw) {
            delete projectRaw[agentKey];
            warnings.push(
                `Ignoring ${agentKey} from project config (security: hidden agents are user-config-only; a ` +
                    "repository must not enable, reprogram, re-permission, or re-route the historian/dreamer/sidekick).",
            );
        }
    }

    const memory = projectRaw.memory;
    if (isPlainObject(memory) && "git_commit_indexing" in memory) {
        delete memory.git_commit_indexing;
        warnings.push(
            "Ignoring memory.git_commit_indexing from project config (security: git-history indexing is a " +
                "user-level-only setting).",
        );
    }

    return warnings;
}

/**
 * After the project config has been merged over the user config, drop the
 * user's inherited `embedding.api_key` when the project redirected the embedding
 * `endpoint` without supplying its own key.
 *
 * Threat: a malicious repo overrides only `embedding.endpoint` → an attacker
 * server, inheriting the user's `embedding.api_key`, which is then sent as
 * `Authorization: Bearer …` to that server. The victim did nothing but clone the
 * repo. Dropping the inherited key means a redirected endpoint never receives
 * the user's secret; a project that genuinely points at a different endpoint
 * must supply its own key.
 *
 * `projectRaw` is the raw project config (pre-merge, so we can see what the
 * project itself declared). `mergedRaw` is the post-merge result, mutated in
 * place. `userRaw` is the trusted user config; when supplied, the key is dropped
 * only when the project endpoint ACTUALLY differs from the user's endpoint — a
 * project repeating the user's own endpoint (e.g. only to change `model`) is not
 * a redirect and must keep the inherited key. Returns warnings.
 */
function normalizeEndpoint(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim().replace(/\/+$/, "");
    return trimmed.length > 0 ? trimmed.toLowerCase() : undefined;
}

export function dropInheritedEmbeddingKeyOnRedirect(
    projectRaw: Record<string, unknown>,
    mergedRaw: Record<string, unknown>,
    userRaw?: Record<string, unknown>,
): string[] {
    const projectEmbedding = projectRaw.embedding;
    if (!isPlainObject(projectEmbedding)) return [];

    // Only an ENDPOINT redirect changes WHERE the bytes (and the Authorization
    // header) are sent. A provider-only change keeps the user's endpoint, so it
    // is not an exfiltration vector.
    const redirectsEndpoint = "endpoint" in projectEmbedding;
    if (!redirectsEndpoint) return [];

    // A project that merely repeats the user's OWN endpoint (e.g. to override
    // `model` while keeping the same server) is not a redirect — the key was
    // always destined for that endpoint. Only drop when the destination
    // actually changed. When userRaw is absent we cannot tell, so fall back to
    // the conservative presence-based drop.
    const userEmbedding = userRaw?.embedding;
    if (isPlainObject(userEmbedding)) {
        const projectEndpoint = normalizeEndpoint(projectEmbedding.endpoint);
        const userEndpoint = normalizeEndpoint(userEmbedding.endpoint);
        if (projectEndpoint !== undefined && projectEndpoint === userEndpoint) {
            return [];
        }
    }

    const providesOwnKey =
        typeof projectEmbedding.api_key === "string" && projectEmbedding.api_key.length > 0;
    if (providesOwnKey) return [];

    const mergedEmbedding = mergedRaw.embedding;
    if (!isPlainObject(mergedEmbedding)) return [];
    if (!("api_key" in mergedEmbedding)) return [];

    delete mergedEmbedding.api_key;
    return [
        "Dropped inherited user embedding api_key because project config redirected " +
            "embedding.endpoint without supplying its own key (security: prevents key " +
            "exfiltration to a repository-chosen endpoint).",
    ];
}
