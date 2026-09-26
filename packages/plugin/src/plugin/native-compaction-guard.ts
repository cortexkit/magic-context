import { log } from "../shared/logger";

/**
 * Turn off OpenCode 1's automatic compaction in the host config a running
 * Magic Context instance receives through its `config` hook.
 *
 * OpenCode 1 compacts on its own whenever a step's tokens reach the model's
 * usable window, unless `compaction.auto` is `false` (`session/overflow.ts`
 * `isOverflow`, checked at every step-finish and before every step). Magic
 * Context owns compaction, so the two must never both run. The conflict
 * detector disables Magic Context when it can SEE `auto=true`, but when no
 * config layer it can read mentions compaction it stays enabled (disabling on
 * a guess would leave nothing managing the window), and OpenCode's default is
 * `auto=true`. Without this guard that session ran both managers.
 *
 * OpenCode hands every plugin the resolved config object it keeps using for
 * the instance, the same object Magic Context already adds its commands and
 * agents to, so setting the flag here is what the host reads at the next
 * overflow check. Only `auto` changes: manual `/compact` still works, and
 * `prune` keeps whatever the user configured. Returns true when it changed
 * the config.
 */
export function disableNativeAutoCompaction(config: object): boolean {
    const target = config as { compaction?: Record<string, unknown> };
    if (target.compaction?.auto === false) return false;
    target.compaction = { ...(target.compaction ?? {}), auto: false };
    log(
        "[magic-context] OpenCode auto-compaction was not disabled in any config layer; turned it off for this instance because Magic Context manages compaction",
    );
    return true;
}
