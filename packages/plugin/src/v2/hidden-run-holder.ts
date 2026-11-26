import { createHash, randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import type { HiddenChildHost } from "./hidden-child-record";

const HOLDER_PREFIX = "ses_mc_bg_";
const HOLDER_CANDIDATES = 3;

export function isHiddenRunHolder(id: string): boolean {
    return id.startsWith(HOLDER_PREFIX);
}

/** OpenCode 2.3.0 reports every child completion and wakes its parent; later versions
 * exempt automation runs, and earlier versions do not send a report at all. An
 * unknown version keeps the run unparented rather than risk a billed turn in the holder. */
export function supportsQuietHiddenChildren(version: unknown): boolean {
    return typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version) && version !== "2.3.0";
}

export async function hiddenRunPlacement(
    createHolder: NonNullable<HiddenChildHost["createHolder"]>,
    directory: string,
): Promise<{ id: string; parentID: string; directory: string }> {
    const location = await realpath(directory);
    if (!(await stat(location)).isDirectory()) throw new Error(`Not a run directory: ${directory}`);
    const base = HOLDER_PREFIX + createHash("sha256").update(location).digest("hex").slice(0, 32);
    const displaced: string[] = [];
    for (let index = 0; index < HOLDER_CANDIDATES; index++) {
        const id = index === 0 ? base : `${base}_${index + 1}`;
        // This root is permanent: removing it would cascade to its live or retained runs.
        // OpenCode returns the existing session on duplicate create, including after restart
        // or when two instances ask at once. A moved holder must not lend its new location.
        const holder = await createHolder({
            id,
            title: "Magic Context background runs",
            location: { directory: location },
            metadata: { magic_context: "background-holder" },
        });
        if (holder.id !== id || holder.parentID)
            throw new Error(`OpenCode did not return the expected background holder ${id}`);
        if (
            holder.metadata?.magic_context === "background-holder" &&
            holder.location?.directory === location
        ) {
            // OpenCode's automation ID convention suppresses reports to the holder. Using a
            // dedicated parent also leaves the user's own completion notification alone.
            return { id: `ses_aut_${randomUUID()}`, parentID: id, directory: location };
        }
        displaced.push(id);
    }
    throw new Error(
        `No background holder at ${location}; displaced holders: ${displaced.join(", ")}`,
    );
}
