import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

type Writers = Pick<
    typeof import("../../packages/plugin/src/features/magic-context/storage-db"),
    "openDatabase"
> &
    Pick<
        typeof import("../../packages/plugin/src/features/magic-context/storage-tags"),
        "insertTag"
    > &
    Pick<
        typeof import("../../packages/plugin/src/features/magic-context/message-index"),
        "indexSourcesAfterOrdinal"
    > &
    Pick<
        typeof import("../../packages/plugin/src/features/magic-context/compartment-storage"),
        "appendCompartments"
    > &
    Pick<
        typeof import("../../packages/plugin/src/features/magic-context/memory/storage-memory"),
        "insertMemory"
    > &
    Pick<
        typeof import("../../packages/plugin/src/features/magic-context/storage-notes"),
        "addNote"
    > &
    Pick<
        typeof import("../../packages/plugin/src/features/magic-context/storage-meta-shared"),
        "ensureSessionMetaRow"
    > &
    Pick<
        typeof import("../../packages/plugin/src/features/magic-context/session-project-storage"),
        "recordSessionProjectIdentity"
    > &
    Pick<
        typeof import("../../packages/plugin/src/features/magic-context/storage-meta-persisted"),
        "armThinkingBindingRecovery"
    > &
    Pick<
        typeof import("../../packages/plugin/src/hooks/magic-context/lkg-persist"),
        "saveLkgSlotToDb"
    >;

export const RELEASE_WRITERS = [
    "openDatabase",
    "insertTag",
    "indexSourcesAfterOrdinal",
    "appendCompartments",
    "insertMemory",
    "addNote",
    "ensureSessionMetaRow",
    "recordSessionProjectIdentity",
    "armThinkingBindingRecovery",
    "saveLkgSlotToDb",
] as const;

/** Use the shipped code, not rebuilt release sources or a hand-written schema. */
export async function releasedWriters(dist: string): Promise<Writers> {
    const found: Record<string, unknown> = {};
    for (const file of readdirSync(dist).filter((name) => name.endsWith(".js"))) {
        const path = join(dist, file);
        const exports = [...readFileSync(path, "utf8").matchAll(/export\s*\{([^}]+)\}/g)]
            .map((match) => match[1])
            .join("\n");
        const needed = RELEASE_WRITERS.filter(
            (name) => !found[name] && new RegExp(`\\b${name}\\b`).test(exports),
        );
        if (!needed.length) continue;
        const module = await import(path);
        for (const name of needed)
            if (typeof module[name] === "function") found[name] = module[name];
    }
    const missing = RELEASE_WRITERS.filter((name) => !found[name]);
    if (missing.length)
        throw new Error(`Released bundle writer exports unavailable: ${missing.join(", ")}`);
    return found as Writers;
}
