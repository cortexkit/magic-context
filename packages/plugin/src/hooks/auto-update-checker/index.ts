import type { PluginInput } from "@opencode-ai/plugin";

import { log } from "../../shared/logger";
import { preparePackageUpdate, resolveInstallContext, runBunInstallSafe } from "./cache";
import {
    extractChannel,
    findPluginEntry,
    getCachedVersion,
    getLatestVersion,
    getLocalDevVersion,
} from "./checker";
import { CACHE_DIR, NPM_FETCH_TIMEOUT, NPM_REGISTRY_URL, PACKAGE_NAME } from "./constants";
import type { AutoUpdateCheckerOptions } from "./types";

type OpenCodeEvent = {
    type: string;
    properties?: unknown;
};

type ToastVariant = "info" | "warning" | "error" | "success";

type ResolvedAutoUpdateCheckerOptions = Required<Omit<AutoUpdateCheckerOptions, "enabled">>;

function warn(message: string): void {
    log(`WARN: ${message}`);
}

export function createAutoUpdateCheckerHook(
    ctx: PluginInput,
    options: AutoUpdateCheckerOptions = {},
) {
    const {
        enabled = true,
        showStartupToast = true,
        autoUpdate = true,
        npmRegistryUrl = NPM_REGISTRY_URL,
        fetchTimeoutMs = NPM_FETCH_TIMEOUT,
        signal = new AbortController().signal,
    } = options;

    let hasChecked = false;

    return async ({ event }: { event: OpenCodeEvent }) => {
        if (!enabled) return;
        if (event.type !== "session.created") return;
        if (hasChecked) return;
        if (getParentId(event.properties)) return;

        hasChecked = true;

        setTimeout(() => {
            void runStartupCheck(ctx, {
                showStartupToast,
                autoUpdate,
                npmRegistryUrl,
                fetchTimeoutMs,
                signal,
            }).catch((err) => {
                warn(`[auto-update-checker] Background update check failed: ${String(err)}`);
            });
        }, 0);
    };
}

function getParentId(properties: unknown): string | null {
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) return null;
    const info = (properties as { info?: unknown }).info;
    if (!info || typeof info !== "object" || Array.isArray(info)) return null;
    const parentID = (info as { parentID?: unknown }).parentID;
    return typeof parentID === "string" && parentID.length > 0 ? parentID : null;
}

async function runStartupCheck(
    ctx: PluginInput,
    options: ResolvedAutoUpdateCheckerOptions,
): Promise<void> {
    if (options.signal.aborted) return;

    const cachedVersion = getCachedVersion();
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

    if (pluginInfo.isPinned) {
        showToast(
            ctx,
            `Magic Context ${latestVersion}`,
            `v${latestVersion} available. Version is pinned; update your OpenCode plugin config to upgrade.`,
            "info",
            8000,
        );
        log("[auto-update-checker] Version is pinned; skipping auto-update");
        return;
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

    const installDir = preparePackageUpdate(latestVersion, PACKAGE_NAME);
    if (!installDir) {
        showToast(
            ctx,
            `Magic Context ${latestVersion}`,
            `v${latestVersion} available. Auto-update could not prepare the active install.`,
            "warning",
            8000,
        );
        warn("[auto-update-checker] Failed to prepare install root for auto-update");
        return;
    }

    const installSuccess = await runBunInstallSafe(installDir, { signal: options.signal });
    if (installSuccess) {
        showToast(
            ctx,
            "Magic Context Updated!",
            `v${currentVersion} → v${latestVersion}\nRestart OpenCode to apply.`,
            "success",
            8000,
        );
        log(`[auto-update-checker] Update installed: ${currentVersion} → ${latestVersion}`);
        return;
    }

    showToast(
        ctx,
        `Magic Context ${latestVersion}`,
        `v${latestVersion} available, but auto-update failed to install it. Check logs or retry manually.`,
        "error",
        8000,
    );
    warn("[auto-update-checker] bun install failed; update not installed");
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
