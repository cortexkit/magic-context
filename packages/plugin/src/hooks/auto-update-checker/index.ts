import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { PluginInput } from "@opencode-ai/plugin";

import {
    AUTO_UPDATE_CHECK_STATE_FILENAME,
    type AutoUpdateCheckState,
    isUpdaterPinnedSpec,
    readAutoUpdateCheckState,
} from "../../shared/auto-update-provenance";
import { getOpenCodeStorageDir } from "../../shared/data-path";
import { log } from "../../shared/logger";
import { writeStorageFileAtomicSync } from "../../shared/storage-permissions";
import { resolveInstallContext } from "./cache";
import {
    extractChannel,
    findPluginEntry,
    getCachedVersion,
    getLatestVersion,
    getLocalDevVersion,
    hasExplicitNonExactPluginVersion,
    type PreparedConfigUpdate,
    preparePluginUpdate,
} from "./checker";
import { CACHE_DIR, NPM_FETCH_TIMEOUT, PACKAGE_NAME, resolveNpmRegistryUrl } from "./constants";
import { compareSemverCore } from "./semver";
import type { AutoUpdateCheckerOptions } from "./types";

type OpenCodeEvent = {
    type: string;
    properties?: unknown;
};

type ToastVariant = "info" | "warning" | "error" | "success";

type ResolvedAutoUpdateCheckerOptions = Required<
    Omit<AutoUpdateCheckerOptions, "enabled" | "storageDir">
> & { storageDir: string | null };

const DEFAULT_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_INIT_DELAY_MS = 5_000;
const PENDING_UPDATE_FILENAME = "pending-plugin-update.json";
const PENDING_UPDATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function warn(message: string): void {
    log(`WARN: ${message}`);
}

/**
 * Auto-update checker.
 *
 * Trigger model (rewritten in v0.17.1):
 *
 * The check fires from plugin initialization itself via a `setTimeout`
 * scheduled when this hook is created. We do NOT gate on
 * `session.created` events — that gate was unreliable because:
 *
 *   - TUI restart with a resumed session never fires `session.created`
 *     (the event fires on session creation, not on plugin reload).
 *   - Multi-project plugin reloads each get their own plugin lifetime
 *     with `hasChecked = false`, so only whichever project happens to
 *     create a fresh session first ever runs the check.
 *   - Sidebar/status polling and idle TUI use also never fire
 *     `session.created`.
 *
 * Multi-project coordination is now handled by an on-disk timestamp at
 * `<storageDir>/last-update-check.json`. Every plugin instance reads
 * the timestamp before checking; if it's within `checkIntervalMs` of
 * now, the check is skipped. The first instance to claim the slot
 * writes the timestamp atomically (temp + rename) so concurrent
 * instances don't all hit npm.
 *
 * The returned event hook is preserved as a no-op so existing tests
 * that pass synthetic events keep working — the hook itself never
 * triggers a check now.
 */
export function createAutoUpdateCheckerHook(
    ctx: PluginInput,
    options: AutoUpdateCheckerOptions = {},
) {
    const {
        enabled = true,
        showStartupToast = true,
        autoUpdate = true,
        npmRegistryUrl = resolveNpmRegistryUrl(),
        fetchTimeoutMs = NPM_FETCH_TIMEOUT,
        signal = new AbortController().signal,
        storageDir = null,
        checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS,
        initDelayMs = DEFAULT_INIT_DELAY_MS,
    } = options;

    if (!enabled) {
        // Disabled — never check. Preserve the event-hook signature so
        // existing wiring keeps working without breakage.
        return async (_input: { event: OpenCodeEvent }) => {
            // intentionally empty
        };
    }

    // Schedule the check on plugin init, not on any event. The setTimeout
    // intentionally returns control to OpenCode immediately so plugin init
    // never blocks on the npm round-trip.
    const initTimer = setTimeout(() => {
        void maybeRunCheck(ctx, {
            showStartupToast,
            autoUpdate,
            npmRegistryUrl,
            fetchTimeoutMs,
            signal,
            storageDir,
            checkIntervalMs,
            initDelayMs,
        }).catch((err) => {
            warn(`[auto-update-checker] Background update check failed: ${String(err)}`);
        });
    }, initDelayMs);

    // Don't keep the Node event loop alive just for this timer.
    if (typeof initTimer === "object" && initTimer !== null && "unref" in initTimer) {
        (initTimer as { unref: () => void }).unref();
    }

    // Cancel the pending check if the host aborts (plugin shutdown).
    signal.addEventListener(
        "abort",
        () => {
            clearTimeout(initTimer);
        },
        { once: true },
    );

    // Event hook is now a no-op. Kept for API/test compatibility.
    return async (_input: { event: OpenCodeEvent }) => {
        // intentionally empty — see hook comment
    };
}

async function maybeRunCheck(
    ctx: PluginInput,
    options: ResolvedAutoUpdateCheckerOptions,
): Promise<void> {
    if (options.signal.aborted) return;

    // Honor the cross-process dedup window first. If another plugin
    // instance recently checked, skip silently.
    if (!claimCheckSlot(options.storageDir, options.checkIntervalMs)) {
        log("[auto-update-checker] Skipping check (another instance ran one recently)");
        return;
    }

    await runStartupCheck(ctx, options);
}

/**
 * Try to claim the next check slot via the on-disk timestamp file.
 *
 * Returns true if this caller should run the check. Returns false if
 * another instance already claimed the slot inside `intervalMs` of now,
 * or if the storage directory isn't usable (we fail open in that case
 * by returning true — the worst outcome is a duplicate npm hit, not a
 * missed check).
 *
 * Race semantics: read → check window → write. With concurrent plugin
 * inits, two callers can race here and both pass the window check before
 * either writes. That's tolerable: at worst we hit npm twice in one
 * launch. The atomic temp+rename write ensures the file is always
 * fully-formed JSON for the next read, even mid-race.
 */
function checkStatePath(storageDir: string | null): string {
    return join(storageDir ?? getOpenCodeStorageDir(), AUTO_UPDATE_CHECK_STATE_FILENAME);
}

function writeCheckState(path: string, state: AutoUpdateCheckState): void {
    writeStorageFileAtomicSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

function claimCheckSlot(storageDir: string | null, intervalMs: number): boolean {
    if (!storageDir) return true; // No storage available — fail open.
    try {
        const file = checkStatePath(storageDir);
        const previous = readAutoUpdateCheckState(file) ?? {};
        const last = previous.lastCheckedMs ?? 0;
        if (Date.now() - last < intervalMs) return false;
        writeCheckState(file, { ...previous, lastCheckedMs: Date.now() });
        return true;
    } catch (err) {
        warn(`[auto-update-checker] Could not coordinate via timestamp file: ${String(err)}`);
        return true;
    }
}

function recordUpdaterPinnedSpec(storageDir: string | null, spec: string): void {
    try {
        const path = checkStatePath(storageDir);
        const previous = readAutoUpdateCheckState(path) ?? {};
        writeCheckState(path, {
            ...previous,
            updaterPinnedSpec: spec,
            updaterPinnedAt: Date.now(),
        });
    } catch (err) {
        warn(`[auto-update-checker] Could not record updater pin provenance: ${String(err)}`);
    }
}

type PendingUpdateMarker = {
    spec: string;
    version: string;
    configPaths: [string, string];
    writtenAt: number;
};

function pendingMarkerPath(storageDir: string | null): string {
    return join(storageDir ?? getOpenCodeStorageDir(), PENDING_UPDATE_FILENAME);
}

function writePendingUpdateMarker(
    storageDir: string | null,
    update: PreparedConfigUpdate,
    version: string,
): void {
    recordUpdaterPinnedSpec(storageDir, update.spec);
    try {
        const path = pendingMarkerPath(storageDir);
        writeStorageFileAtomicSync(
            path,
            `${JSON.stringify({ spec: update.spec, version, configPaths: update.configPaths, writtenAt: Date.now() }, null, 2)}\n`,
        );
    } catch (err) {
        warn(`[auto-update-checker] Could not write pending update marker: ${String(err)}`);
    }
}

function consumePendingUpdateMarker(storageDir: string | null, loadedVersion: string | null): void {
    const path = pendingMarkerPath(storageDir);
    if (!existsSync(path)) return;
    try {
        const marker = JSON.parse(readFileSync(path, "utf-8")) as Partial<PendingUpdateMarker>;
        const age = Date.now() - (marker.writtenAt ?? 0);
        const olderThanLoaded =
            typeof marker.version === "string" &&
            typeof loadedVersion === "string" &&
            (compareSemverCore(marker.version, loadedVersion) ?? 0) < 0;
        if (
            marker.version === loadedVersion &&
            marker.spec === `${PACKAGE_NAME}@${loadedVersion}` &&
            Array.isArray(marker.configPaths) &&
            marker.configPaths.length === 2
        ) {
            rmSync(path, { force: true });
            log(`[auto-update-checker] Pending update applied: ${marker.spec}`);
        } else if (age > PENDING_UPDATE_MAX_AGE_MS || olderThanLoaded) {
            rmSync(path, { force: true });
            warn("[auto-update-checker] Discarded stale or mismatched pending update marker");
        }
    } catch (err) {
        try {
            rmSync(path, { force: true });
        } catch {
            // Best-effort cleanup of an invalid bookkeeping marker.
        }
        warn(`[auto-update-checker] Discarded corrupt pending update marker: ${String(err)}`);
    }
}

async function runStartupCheck(
    ctx: PluginInput,
    options: ResolvedAutoUpdateCheckerOptions,
): Promise<void> {
    if (options.signal.aborted) return;

    const cachedVersion = getCachedVersion();
    consumePendingUpdateMarker(options.storageDir, cachedVersion);
    const localDevVersion = getLocalDevVersion(ctx.directory);
    const displayVersion = localDevVersion ?? cachedVersion;

    if (localDevVersion) {
        if (options.showStartupToast) {
            showToast(
                ctx,
                `Magic Context ${displayVersion} (dev)`,
                "Running in local development mode.",
                "info",
            );
        }
        log("[auto-update-checker] Local development mode");
        return;
    }

    if (options.showStartupToast) {
        showToast(
            ctx,
            `Magic Context ${displayVersion ?? "unknown"}`,
            "@cortexkit/opencode-magic-context is active.",
            "info",
        );
    }

    await runBackgroundUpdateCheck(ctx, options);
}

async function runBackgroundUpdateCheck(
    ctx: PluginInput,
    options: ResolvedAutoUpdateCheckerOptions,
): Promise<void> {
    if (options.signal.aborted) return;

    const pluginInfo = findPluginEntry(ctx.directory);
    if (!pluginInfo) {
        log("[auto-update-checker] Plugin not found in config");
        return;
    }

    if (hasExplicitNonExactPluginVersion(pluginInfo.entry)) {
        if (pluginInfo.entry === `${PACKAGE_NAME}@latest`) {
            log(
                "[auto-update-checker] Explicit @latest leaves the active package unpinned; OpenCode may delete it mid-session.",
            );
        }
        return;
    }

    const cachedVersion = getCachedVersion(pluginInfo.entry);
    const currentVersion = cachedVersion ?? pluginInfo.pinnedVersion;
    if (!currentVersion) {
        log("[auto-update-checker] No version found (cached or pinned)");
        return;
    }

    const channel = extractChannel(pluginInfo.pinnedVersion ?? currentVersion);
    const latestVersion = await getLatestVersion(channel, {
        registryUrl: options.npmRegistryUrl,
        timeoutMs: options.fetchTimeoutMs,
        signal: options.signal,
    });
    if (!latestVersion) {
        warn(`[auto-update-checker] Failed to fetch latest version for channel: ${channel}`);
        showToast(
            ctx,
            "Magic Context update check failed",
            "Could not check npm for @cortexkit/opencode-magic-context updates. Continuing with the cached version.",
            "warning",
            8000,
        );
        return;
    }

    if (currentVersion === latestVersion) {
        log(`[auto-update-checker] Already on latest version for channel: ${channel}`);
        return;
    }

    log(
        `[auto-update-checker] Update available (${channel}): ${currentVersion} → ${latestVersion}`,
    );

    const updaterOwnedPin =
        pluginInfo.isPinned &&
        isUpdaterPinnedSpec(
            readAutoUpdateCheckState(checkStatePath(options.storageDir)),
            pluginInfo.entry,
        );
    if (pluginInfo.isPinned && !updaterOwnedPin) {
        showToast(
            ctx,
            `Magic Context ${latestVersion}`,
            `v${latestVersion} available. This version was pinned by you; update your OpenCode plugin config to upgrade.`,
            "info",
            8000,
        );
        log("[auto-update-checker] Version was pinned by you; skipping auto-update");
        return;
    }
    if (updaterOwnedPin) {
        log("[auto-update-checker] Version was pinned by the updater; continuing auto-update");
    }

    if (!options.autoUpdate) {
        showToast(
            ctx,
            `Magic Context ${latestVersion}`,
            `v${latestVersion} available. Auto-update is disabled.`,
            "info",
            8000,
        );
        log("[auto-update-checker] Auto-update disabled, notification only");
        return;
    }

    const preparedUpdate = await preparePluginUpdate(ctx.directory, pluginInfo, latestVersion, {
        signal: options.signal,
    });
    if (preparedUpdate) {
        writePendingUpdateMarker(options.storageDir, preparedUpdate, latestVersion);
        showToast(
            ctx,
            "Magic Context Update Ready",
            `v${currentVersion} → v${latestVersion}\nRestart OpenCode to apply.`,
            "success",
            8000,
        );
        log(`[auto-update-checker] Update ready: ${currentVersion} → ${latestVersion}`);
        return;
    }

    showToast(
        ctx,
        `Magic Context ${latestVersion}`,
        `v${latestVersion} available, but auto-update failed to update both plugin configs.`,
        "error",
        8000,
    );
    warn("[auto-update-checker] Exact-spec config transaction failed; update not announced");
}

export function getAutoUpdateInstallDir(): string {
    return resolveInstallContext()?.installDir ?? CACHE_DIR;
}

function showToast(
    ctx: PluginInput,
    title: string,
    message: string,
    variant: ToastVariant = "info",
    duration = 3000,
): void {
    ctx.client.tui.showToast({ body: { title, message, variant, duration } }).catch(() => {});
}

export type { AutoUpdateCheckerOptions } from "./types";
