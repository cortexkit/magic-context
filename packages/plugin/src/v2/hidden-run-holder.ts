import { createHash, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { sameProjectDirectory } from "../shared/project-directory-key";
import type { HiddenChildHost, HiddenChildSetupBudget } from "./hidden-child-record";

const HOLDER_PREFIX = "ses_mc_bg_";
const HOLDER_CANDIDATES = 3;

export function isHiddenRunHolder(id: string): boolean {
    return id.startsWith(HOLDER_PREFIX);
}

/**
 * OpenCode 2.3.1 and later recognize `ses_aut_` as an automation session ID and
 * skip the child completion report to its parent. Earlier releases do not send
 * reports at all, except 2.3.0, which wakes the parent for every child. On 2.3.0
 * or an unknown version, keep the run unparented to avoid a billed holder turn.
 */
export function supportsQuietHiddenChildren(version: unknown): boolean {
    return typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version) && version !== "2.3.0";
}

/** Compare host path syntax without resolving symlinks into a different plugin location. */
export function matchesHiddenRunLocation(wanted: string, returned: string | undefined): boolean {
    return sameProjectDirectory(wanted, returned ?? "");
}

export async function hiddenRunPlacement(
    createHolder: NonNullable<HiddenChildHost["createHolder"]>,
    directory: string,
    work: HiddenChildSetupBudget["work"] = (start) => start(),
): Promise<{ id: string; parentID: string }> {
    if (!(await work(() => stat(directory))).isDirectory())
        throw new Error(`Not a run directory: ${directory}`);
    // The child inherits its parent's location. Keep the spelling OpenCode used
    // to start this plugin instance; following a symlink would send the child to
    // a different instance that has not registered the run.
    const base = HOLDER_PREFIX + createHash("sha256").update(directory).digest("hex").slice(0, 32);
    const displaced: string[] = [];
    for (let index = 0; index < HOLDER_CANDIDATES; index++) {
        const id = index === 0 ? base : `${base}_${index + 1}`;
        // This root is permanent: removing it would cascade to its live or retained runs.
        // OpenCode returns the existing session on duplicate create, including after restart
        // or when two instances ask at once. A moved holder must not lend its new location.
        const holder = await work(() =>
            createHolder({
                id,
                title: "Magic Context background runs",
                location: { directory },
                metadata: { magic_context: "background-holder" },
            }),
        );
        if (holder.id !== id || holder.parentID)
            throw new Error(`OpenCode did not return the expected background holder ${id}`);
        if (
            holder.metadata?.magic_context === "background-holder" &&
            matchesHiddenRunLocation(directory, holder.location?.directory)
        ) {
            return { id: `ses_aut_${randomUUID()}`, parentID: id };
        }
        displaced.push(id);
    }
    throw new Error(
        `No background holder at ${directory}; displaced holders: ${displaced.join(", ")}`,
    );
}
