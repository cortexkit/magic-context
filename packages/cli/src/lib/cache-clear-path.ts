import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export type CachePathRefusal = {
    allowed: false;
    reason: "linked" | "missing" | "outside" | "unavailable";
    path: string;
};

function descendantPath(root: string, path: string): string | undefined {
    const child = relative(root, path);
    if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
        return undefined;
    }
    return child;
}

/** Check the configured cache base and its descendants, not its parents (such as macOS `/var`). */
export function checkCacheClearPath(
    cacheRoot: string,
    candidate: string,
): { allowed: true; path: string } | CachePathRefusal {
    const root = resolve(cacheRoot);
    const path = resolve(candidate);
    const child = descendantPath(root, path);
    if (child === undefined) return { allowed: false, reason: "outside", path };

    let current = root;
    try {
        // Check in order so lstat never looks through an already linked parent.
        for (const part of ["", ...child.split(sep)]) {
            current = join(current, part);
            const entry = lstatSync(current);
            if (entry.isSymbolicLink()) return { allowed: false, reason: "linked", path: current };
            if (!entry.isDirectory())
                return { allowed: false, reason: "unavailable", path: current };
        }
        if (descendantPath(realpathSync(root), realpathSync(path)) === undefined) {
            return { allowed: false, reason: "outside", path };
        }
    } catch (error) {
        const reason =
            (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unavailable";
        return { allowed: false, reason, path: current };
    }
    return { allowed: true, path };
}

export function describeCacheClearRefusal(
    path: string,
    reason: CachePathRefusal["reason"],
): string {
    if (reason === "linked") {
        return `Left ${path} alone: it is reached through a linked folder, so it isn't a cache Magic Context can clear.`;
    }
    if (reason === "outside") return `Left ${path} alone: it is outside the cache folder.`;
    return `Left ${path} alone: could not verify it is a directory inside the cache folder.`;
}
