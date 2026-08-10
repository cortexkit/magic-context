import { OmpAdapter } from "./omp";
import { OpenCodeAdapter } from "./opencode";
import { PiAdapter } from "./pi";
import type { HarnessAdapter, HarnessKind } from "./types";

export type { HarnessAdapter, HarnessKind } from "./types";
export { OmpAdapter, OpenCodeAdapter, PiAdapter };

const ALL: HarnessAdapter[] = [new OpenCodeAdapter(), new PiAdapter(), new OmpAdapter()];

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
