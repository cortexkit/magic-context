import packageMetadata from "../../package.json";
import { loadPluginConfigDetailed } from "../config";
import { bindStaleBuildNotice } from "../plugin/stale-build-notice";
import {
    claimStorageBackupWarningCheck,
    getMagicContextStorageDir,
    isMagicContextStorageOutsideEngram,
} from "../shared/data-path";
import { setHarness } from "../shared/harness";
import { flushLogger, log } from "../shared/logger";
import { registerStandalonePluginMarker } from "../standalone-plugin-marker";
import type { V2Context } from "./hooks/types";
import { startUpdateChecks } from "./hooks/update-check";

registerStandalonePluginMarker(packageMetadata.version);

/**
 * Only an OpenCode 2 host hands `setup` a context carrying `session.hook`.
 * The package's default export is the union `{ id, server, setup }`, and a
 * v1 host that finds `setup` on it must not run the v2 lane: locking the
 * harness to "opencode2" there mis-tags every row that seat writes.
 *
 * Proven against the shipped OpenCode 1.18.30 binary and traced to source at
 * tag v1.18.31: the v1 loader (`packages/opencode/src/plugin/index.ts`) calls
 * `server()`, and independently the bundled core external-plugin layer
 * (`packages/core/src/plugin/promise.ts:90`) adopts any module whose default
 * export matches `{ id, setup }` (`core/src/config/plugin/external.ts:15-30`)
 * and calls `setup(context)` with the 1.18-era v2 host surface
 * (`core/src/plugin/host.ts:30-208`): keys `[options, agent, aisdk, catalog,
 * command, integration, plugin, reference, skill]`, no `session`.
 * `registerContext` then throws on `context.session.hook`; that layer discards
 * the failure with `Effect.ignoreCause`, so nothing surfaced while the harness
 * stayed locked to "opencode2" for the rest of the v1 process.
 */
export function isOpenCode2HostContext(context: unknown): context is V2Context {
    if (typeof context !== "object" || context === null) return false;
    const session = (context as { session?: unknown }).session;
    return (
        typeof session === "object" &&
        session !== null &&
        typeof (session as { hook?: unknown }).hook === "function"
    );
}

export async function setup(context: V2Context) {
    if (!isOpenCode2HostContext(context)) {
        // Every OpenCode 1.18.x seat takes this branch at boot (the core
        // external-plugin layer calls setup() on the union export), so this is
        // routine, not a fault: record it in the plugin log and never on the
        // console, which the TUI paints straight onto the screen.
        log(
            "v2 setup() called on a host without session.hook; v1 server lane owns this host, v2 lane inert",
        );
        return async () => {};
    }
    const storageDir = getMagicContextStorageDir();
    if (claimStorageBackupWarningCheck() && isMagicContextStorageOutsideEngram(storageDir)) {
        log(
            `[magic-context] Magic Context storage is at ${storageDir}, outside the folder Engram backs up (~/.local/share/cortexkit/magic-context). It is not included in CortexKit backups.`,
        );
    }
    // The union entry is also imported and probed by OpenCode 1. Load the v2
    // adapter only after the host-shape check, retaining the same setup callback.
    const { registerContext } = await import("./hooks/context");
    setHarness("opencode2");
    bindStaleBuildNotice({}, import.meta.url, "opencode2");
    const duties = await registerContext(context);
    const checks =
        loadPluginConfigDetailed(context.location.directory).config.auto_update === false
            ? undefined
            : startUpdateChecks(context);
    // The plugin log, not the console: the host passes plugin output straight
    // through to the operator's terminal. Flushed now so a host that dies
    // during boot still leaves a record that setup completed.
    log("[magic-context] @cortexkit/opencode-magic-context v2 setup");
    flushLogger();
    return async () => {
        await checks?.dispose();
        await duties?.dispose();
    };
}

export default {
    id: "@cortexkit/opencode-magic-context",
    setup,
};
