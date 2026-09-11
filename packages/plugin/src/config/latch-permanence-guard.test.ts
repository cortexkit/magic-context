import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const SOURCE_ROOTS = ["packages/plugin/src", "packages/pi-plugin/src"] as const;

type Classification = "VERDICT" | "DIAGNOSTIC" | "PUBLICATION";

type KnownSlot = {
    classification: Classification;
    reason: string;
};

/**
 * Every module-level mutable slot whose name says it can retain a capability,
 * absence, or failure verdict. A new matching slot must be classified here so
 * a negative cache cannot quietly become permanent.
 */
const KNOWN_SLOTS: Record<string, KnownSlot> = {
    "packages/plugin/src/features/magic-context/compaction-marker.ts:cachedSchemaCompatible": {
        classification: "VERDICT",
        reason: "DEFECT: a transient PRAGMA/read failure is cached as incompatible until the writable DB is closed.",
    },
    "packages/plugin/src/features/magic-context/memory/embedding-local.ts:nativeRuntimeMissing": {
        classification: "VERDICT",
        reason: "Correct: a missing or unloadable native binding needs an install repair, which this process cannot observe.",
    },
    "packages/plugin/src/features/magic-context/memory/embedding-local.ts:localEmbeddingProcessFailure":
        {
            classification: "DIAGNOSTIC",
            reason: "Most-recent local runtime diagnostic: successful initialization and test reset both clear it; the separate runtime-mode slot owns the process verdict.",
        },
    "packages/plugin/src/features/magic-context/memory/embedding-synapse.ts:sharedClientPromise": {
        classification: "VERDICT",
        reason: "DEFECT: a rejected connection promise remains shared after the daemon recovers.",
    },
    "packages/plugin/src/features/magic-context/memory/embedding-synapse.ts:permanentFailure": {
        classification: "VERDICT",
        reason: "DEFECT: a daemon catalog or response classification can be repaired in-process, but the provider then returns null without another probe.",
    },
    "packages/plugin/src/features/magic-context/memory/embedding-openai.ts:failureTimes": {
        classification: "VERDICT",
        reason: "Correct: circuit state expires and a half-open probe re-evaluates the endpoint.",
    },
    "packages/plugin/src/features/magic-context/memory/project-identity.ts:directoryFallbackCache":
        {
            classification: "VERDICT",
            reason: "Saved: each read checks for a newly-created .git directory and deletes the fallback before resolving again.",
        },
    "packages/plugin/src/features/magic-context/memory/project-identity.ts:transientFailureCooldown":
        {
            classification: "VERDICT",
            reason: "Saved: getActiveCooldown deletes an expired entry and forces a new git probe after five minutes.",
        },
    "packages/plugin/src/features/magic-context/message-index.ts:MESSAGE_HISTORY_ORPHAN_UNAVAILABLE_REPROBE_MS":
        {
            classification: "VERDICT",
            reason: "Saved: source_unavailable persists a future timestamp, then the normal cooldown arithmetic re-probes after one day.",
        },
    "packages/plugin/src/features/magic-context/mural/storage-mural-cues.ts:muralCueColumnCache": {
        classification: "VERDICT",
        reason: "Correct by scope: the database is fully migrated before this handle reaches cue reads, so its schema cannot gain this column during use.",
    },
    "packages/plugin/src/features/magic-context/mural/storage-mural-cues.ts:muralCueRejectionColumnCache":
        {
            classification: "VERDICT",
            reason: "Correct by scope: the database is fully migrated before this handle reaches cue reads, so its schema cannot gain this column during use.",
        },
    "packages/plugin/src/features/magic-context/smart-notes/sandbox-runner.ts:asyncModulePromise": {
        classification: "VERDICT",
        reason: "DEFECT: a rejected dynamic-import/WASM-init promise is retained for every later smart-note check.",
    },
    "packages/plugin/src/features/magic-context/storage-meta-session.ts:sessionMetaSelectColumnsCache":
        {
            classification: "VERDICT",
            reason: "Correct by scope: session_meta migration completes before the first projection is built for this database handle.",
        },
    "packages/plugin/src/features/magic-context/memory/storage-memory.ts:memoryImportanceColumnCache":
        {
            classification: "VERDICT",
            reason: "Correct by scope: memory schema migration completes before this database handle serves memory reads.",
        },
    "packages/plugin/src/features/magic-context/memory/storage-memory.ts:memoryScopeColumnCache": {
        classification: "VERDICT",
        reason: "Correct by scope: memory schema migration completes before this database handle serves memory reads.",
    },
    "packages/plugin/src/features/magic-context/memory/storage-memory.ts:memoryShareableColumnCache":
        {
            classification: "VERDICT",
            reason: "Correct by scope: memory schema migration completes before this database handle serves memory reads.",
        },
    "packages/plugin/src/features/magic-context/memory/storage-memory.ts:memoryClassifiedAtColumnCache":
        {
            classification: "VERDICT",
            reason: "Correct by scope: memory schema migration completes before this database handle serves memory reads.",
        },
    "packages/plugin/src/hooks/magic-context/ctx-reduce-availability.ts:ctxReduceRegisteredGlobally":
        {
            classification: "VERDICT",
            reason: "Correct by scope: tool registration is resolved once at plugin boot and cannot change while that instance runs.",
        },
    "packages/plugin/src/hooks/magic-context/ctx-reduce-availability.ts:availabilityBySession": {
        classification: "VERDICT",
        reason: "Correct by contract: the first persisted user message freezes that session's tool surface.",
    },
    "packages/plugin/src/hooks/magic-context/ctx-reduce-availability.ts:permissionDeniedBySession":
        {
            classification: "DIAGNOSTIC",
            reason: "Repeatedly assigned on each cache-busting permission read; later reads replace an earlier denial.",
        },
    "packages/plugin/src/hooks/magic-context/read-session-formatting.ts:tokenizerLoadAttempted": {
        classification: "VERDICT",
        reason: "DEFECT: a failed tokenizer load permanently selects heuristic token counts even if the package becomes available.",
    },
    "packages/plugin/src/hooks/magic-context/module-transport.ts:stateSyncCapabilityCache": {
        classification: "VERDICT",
        reason: "Saved: invalidateStateSyncCapabilities runs on NEED_FULL_SYNC and connection invalidation before the next capability probe.",
    },
    "packages/plugin/src/plugin/conflict-warning-hook.ts:cachedDesktopStateByDir": {
        classification: "VERDICT",
        reason: "Correct by scope: its deciding startup-warning paths run once per plugin boot, so a later Desktop state-file write is not observed by design.",
    },
    "packages/plugin/src/plugin/embedding-routing.ts:synapseProbeCache": {
        classification: "VERDICT",
        reason: "Saved: the promise has a 60-second TTL, including rejections, and discovery is retried after expiry.",
    },
    "packages/plugin/src/shared/opencode-db-path.ts:lastReadFailure": {
        classification: "DIAGNOSTIC",
        reason: "Most-recent OpenCode DB read diagnostic: a successful open clears it, and path discovery re-probes after disappearance.",
    },
    "packages/plugin/src/shared/models-dev-cache.ts:authRewarmDone": {
        classification: "VERDICT",
        reason: "Saved: refreshModelLimitsAfterAuthOnce resets the latch when its warm fails.",
    },
    "packages/pi-plugin/src/dreamer/pi-session-api.ts:cachedModulePromise": {
        classification: "VERDICT",
        reason: "Saved: promise.catch clears the same rejected promise, allowing the next resolver call to retry.",
    },
    "packages/plugin/src/features/magic-context/fail-closed-block.ts:lastHookInitFailure": {
        classification: "DIAGNOSTIC",
        reason: "Most-recent boot diagnostic: recordHookInitFailure overwrites it and clearHookInitFailure resets it.",
    },
    "packages/plugin/src/hooks/magic-context/read-session-formatting.ts:tokenizerLoadPromise": {
        classification: "PUBLICATION",
        reason: "In-flight handle only: finally clears it after the load settles, so it cannot retain a failure verdict.",
    },
    "packages/plugin/src/shared/exit-abort-registry.ts:listenerRegistered": {
        classification: "PUBLICATION",
        reason: "One-time process exit-listener installation, not a capability or failure verdict.",
    },
    "packages/plugin/src/shared/storage-permissions.ts:enforcePrivateStoragePermissions": {
        classification: "VERDICT",
        reason: "Repeatedly assigned configuration: the public setter can update it during the process.",
    },
    "packages/plugin/src/features/magic-context/storage-db.ts:lastSchemaFenceRejection": {
        classification: "DIAGNOSTIC",
        reason: "Most-recent diagnostic: every open attempt clears or overwrites it.",
    },
    "packages/plugin/src/features/magic-context/storage-db.ts:lastMigrationOnOpenRefusal": {
        classification: "DIAGNOSTIC",
        reason: "Most-recent diagnostic: every open attempt clears or overwrites it.",
    },
    "packages/plugin/src/shared/models-dev-cache.ts:apiCache": {
        classification: "PUBLICATION",
        reason: "Publishes last-known-good model metadata, not a failure verdict; refresh writes a later successful value.",
    },
    "packages/plugin/src/hooks/magic-context/anthropic-wire.ts:loadPromise": {
        classification: "VERDICT",
        reason: "Saved: only a successful load is memoized. A failure clears the slot and retries after a 60-second cooldown, and callers read anthropicWireRegistryLoaded() so an unresolved registry carries the session's persisted answer forward instead of narrowing it.",
    },
};

function sourceFiles(directory: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...sourceFiles(path));
        } else if (entry.isFile() && path.endsWith(".ts") && !path.endsWith(".test.ts")) {
            files.push(path);
        }
    }
    return files;
}

function declaredOneShotSlots(source: string): string[] {
    // `let` is deliberate: this targets mutable module state, not constant lookup
    // tables or prepared-statement handles. The initializer restriction excludes
    // ordinary counters and per-call scratch values.
    const declarations =
        /^(?:export\s+)?let\s+([A-Za-z_$][\w$]*)\b[^\n]*(?:=\s*(?:null|false|true)|Promise<)/gm;
    const verdictName =
        /(?:attempted|availability|compatible|cooldown|disabled|failed|failure|latch|missing|permission|promise|registered|unavailable)/i;
    const moduleSlots = [...source.matchAll(declarations)].map((match) => match[1]);
    // A provider-local permanent failure has the same operational effect as a
    // module slot: every later provider call short-circuits without re-probing.
    const providerLatches = [
        ...source.matchAll(/^\s*private\s+(permanentFailure)\s*=\s*false;/gm),
    ].map((match) => match[1]);
    return [...moduleSlots, ...providerLatches].filter(
        (name): name is string => name !== undefined && verdictName.test(name),
    );
}

describe("latch permanence classification guard", () => {
    test("classifies every production one-shot verdict-shaped slot", () => {
        const inlineTestBlocks: string[] = [];
        const discovered = new Set<string>();
        for (const root of SOURCE_ROOTS) {
            for (const file of sourceFiles(join(REPOSITORY_ROOT, root))) {
                const source = readFileSync(file, "utf8");
                if (/from\s+["']bun:test["']/.test(source)) {
                    inlineTestBlocks.push(relative(REPOSITORY_ROOT, file));
                }
                for (const slot of declaredOneShotSlots(source)) {
                    discovered.add(`${relative(REPOSITORY_ROOT, file)}:${slot}`);
                }
            }
        }

        expect(inlineTestBlocks).toEqual([]);
        const unclassified = [...discovered].filter((slot) => !(slot in KNOWN_SLOTS)).sort();
        expect(
            unclassified,
            `Classify each new one-shot verdict-shaped slot in KNOWN_SLOTS: ${unclassified.join(", ")}`,
        ).toEqual([]);
        expect(Object.keys(KNOWN_SLOTS).length).toBeGreaterThan(0);
    });
});
