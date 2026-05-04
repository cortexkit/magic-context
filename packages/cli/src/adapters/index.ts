import { OpenCodeAdapter } from "./opencode";
import { PiAdapter } from "./pi";
import type { HarnessAdapter, HarnessKind } from "./types";

export type { HarnessAdapter, HarnessKind } from "./types";
export { OpenCodeAdapter, PiAdapter };

const ALL: HarnessAdapter[] = [new OpenCodeAdapter(), new PiAdapter()];

/** Every registered adapter. */
export function getAllAdapters(): HarnessAdapter[] {
    return ALL;
}

/** Look up an adapter by kind. Throws on unknown kind. */
export function getAdapter(kind: HarnessKind): HarnessAdapter {
    const found = ALL.find((a) => a.kind === kind);
    if (!found) throw new Error(`Unknown harness: ${kind}`);
    return found;
}

/** Adapters whose host binary is on PATH or at a known stock location. */
export function getInstalledAdapters(): HarnessAdapter[] {
    return ALL.filter((a) => a.isInstalled());
}

/** Adapters whose plugin entry is registered in the harness's config. */
export function getAdaptersWithPluginRegistered(): HarnessAdapter[] {
    return ALL.filter((a) => a.hasPluginEntry());
}

/** Sorted: installed adapters first, then the rest. Stable for ties. */
export function getAdaptersPreferInstalled(): HarnessAdapter[] {
    return [...ALL].sort((a, b) => {
        const aa = a.isInstalled() ? 0 : 1;
        const bb = b.isInstalled() ? 0 : 1;
        return aa - bb;
    });
}
