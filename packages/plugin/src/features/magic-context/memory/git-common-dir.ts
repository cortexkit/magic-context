import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { projectDirectoryKey } from "../../../shared/project-directory-key";

export interface GitCheckoutMetadata {
    checkoutRoot: string;
    gitDir: string;
    gitCommonDir?: string;
    linkedWorktree: boolean;
}

const checkoutMetadata = new Map<string, GitCheckoutMetadata | undefined>();

/** Fallback lookups reuse topology; live pin authorization still reads the current layout. */
export function readCachedGitCheckoutMetadata(directory: string): GitCheckoutMetadata | undefined {
    const key = path.resolve(directory);
    if (!checkoutMetadata.has(key)) checkoutMetadata.set(key, readGitCheckoutMetadata(key));
    return checkoutMetadata.get(key);
}

export function invalidateGitCheckoutMetadata(directory?: string): void {
    if (directory === undefined) checkoutMetadata.clear();
    else checkoutMetadata.delete(path.resolve(directory));
}

/** Read Git's on-disk topology without invoking Git or guessing a checkout from a gitdir path. */
export function readGitCheckoutMetadata(directory: string): GitCheckoutMetadata | undefined {
    let current: string;
    try {
        current = realpathSync.native(directory);
    } catch {
        return undefined;
    }
    while (true) {
        const dotGit = path.join(current, ".git");
        try {
            const stat = lstatSync(dotGit);
            let gitDir: string;
            let linkedWorktree = false;
            let commonDir: string;
            if (stat.isDirectory()) {
                gitDir = dotGit;
                commonDir = gitDir;
            } else if (stat.isFile()) {
                const target = /^gitdir:\s*(.+?)\s*$/u.exec(readFileSync(dotGit, "utf8"))?.[1];
                if (!target) return undefined;
                gitDir = path.resolve(current, target);
                commonDir = gitDir;
                try {
                    const commonFile = path.join(gitDir, "commondir");
                    if (lstatSync(commonFile).isFile()) {
                        linkedWorktree = true;
                        const target = readFileSync(commonFile, "utf8").trim();
                        if (!target) return { checkoutRoot: current, gitDir, linkedWorktree };
                        commonDir = path.resolve(gitDir, target);
                    }
                } catch (error) {
                    if (linkedWorktree) return { checkoutRoot: current, gitDir, linkedWorktree };
                    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
                }
            } else {
                return undefined;
            }
            let gitCommonDir: string | undefined;
            try {
                gitCommonDir = projectDirectoryKey(realpathSync.native(commonDir));
            } catch {
                // An unreadable target cannot match another checkout's canonical common dir.
            }
            return { checkoutRoot: current, gitDir, gitCommonDir, linkedWorktree };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
        }
        const parent = path.dirname(current);
        if (parent === current) return undefined;
        current = parent;
    }
}

export function getGitCommonDir(directory: string): string | undefined {
    return readGitCheckoutMetadata(directory)?.gitCommonDir;
}
