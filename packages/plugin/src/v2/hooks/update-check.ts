import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getLatestVersion } from "../../hooks/auto-update-checker/checker";
import { compareSemverCore } from "../../hooks/auto-update-checker/semver";
import { log } from "../../shared/logger";
import { pushNotification } from "../../shared/rpc-notifications";
import type { V2Context } from "./types";

let cachedPackageInfo: { version: string; development: boolean } | undefined;
function packageInfo(): { version: string; development: boolean } {
    if (cachedPackageInfo) return cachedPackageInfo;
    let directory = dirname(fileURLToPath(import.meta.url));
    for (;;) {
        try {
            const pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
            if (
                pkg.name === "@cortexkit/opencode-magic-context" &&
                typeof pkg.version === "string"
            ) {
                cachedPackageInfo = {
                    version: pkg.version,
                    development: existsSync(join(directory, "src/v2/server.ts")),
                };
                return cachedPackageInfo;
            }
        } catch {
            /* Continue to the package root, never infer a version from dist depth. */
        }
        const parent = dirname(directory);
        if (parent === directory) throw new Error("Magic Context package manifest is unavailable");
        directory = parent;
    }
}

/**
 * OpenCode 2 owns plugin installs: it installs an `@latest` entry once, flags
 * it outdated at startup, and installs a newer release only when the user asks
 * it to (its plugins dialog, or `opencode plugin update`). The v1 auto-updater
 * does not run on this host, so the notice names the host's own update path
 * instead of promising an automatic one.
 */
export function formatUpdateAvailableMessage(latest: string, current: string): string {
    return `Magic Context ${latest} is available (running ${current}). To install it, open /plugins, select Magic Context and press ctrl+u, or run \`opencode plugin update\`. A version-pinned plugin entry must be changed in your OpenCode config instead.`;
}

/** GA eventMethods is exactly ["subscribe"] (promise/event.d.ts), not on.
 * The v2 plugin domain supplies list only; version checks must never use the
 * v1 checker's singular-plugin configuration writer against plural plugins.
 */
export function startUpdateChecks(
    context: Pick<V2Context, "event" | "storage">,
    check: (signal: AbortSignal) => Promise<string | null> = (signal) => {
        // A source checkout is a local development installation, not a registry install.
        return packageInfo().development
            ? Promise.resolve(null)
            : getLatestVersion("latest", { signal });
    },
) {
    const controller = new AbortController();
    let lastCheckAt: unknown;
    let loaded = false;
    const done = (async () => {
        try {
            for await (const _event of context.event.subscribe({ signal: controller.signal })) {
                if (controller.signal.aborted) break;
                if (
                    loaded &&
                    typeof lastCheckAt === "number" &&
                    Date.now() - lastCheckAt < 60 * 60 * 1000
                )
                    continue;
                // Re-read at expiry so another host's newer check still suppresses ours.
                lastCheckAt = await context.storage.get("version-check-at");
                loaded = true;
                if (typeof lastCheckAt === "number" && Date.now() - lastCheckAt < 60 * 60 * 1000)
                    continue;
                const now = Date.now();
                await context.storage.set("version-check-at", now);
                lastCheckAt = now;
                const latest = await check(controller.signal);
                const current = packageInfo().version;
                const comparison = latest ? compareSemverCore(latest, current) : null;
                if (latest && !controller.signal.aborted && comparison !== null && comparison > 0) {
                    pushNotification("toast", {
                        message: formatUpdateAvailableMessage(latest, current),
                        variant: "info",
                    });
                }
            }
        } catch (error) {
            if (!controller.signal.aborted)
                log("[magic-context] v2 update check unavailable", error);
        }
    })();
    return {
        done,
        async dispose() {
            controller.abort();
            await done;
        },
    };
}
