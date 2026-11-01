import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { projectDirectoryKey } from "../../../shared/project-directory-key";

export interface GitCheckoutMetadata {
    checkoutRoot: string;
    gitDir: string;
    gitCommonDir?: string;
    linkedWorktree: boolean;
}

interface CachedCheckout {
    metadata: GitCheckoutMetadata | undefined;
    evidence: Map<string, string | undefined>;
}

const checkoutMetadata = new Map<string, CachedCheckout>();

function topologySignature(file: string): string | undefined {
    try {
        const stat = statSync(file, { bigint: true });
        return `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    } catch {
        return undefined;
    }
}

/** Reuse topology only while its Git pointers and targets have unchanged metadata. */
export function readCachedGitCheckoutMetadata(directory: string): GitCheckoutMetadata | undefined {
    const key = path.resolve(directory);
    const cached = checkoutMetadata.get(key);
    if (cached && [...cached.evidence].every(([file, stamp]) => topologySignature(file) === stamp))
        return cached.metadata;
    const evidence = new Map<string, string | undefined>();
    const metadata = readCheckoutMetadata(key, (file) => {
        evidence.set(file, topologySignature(file));
    });
    checkoutMetadata.set(key, { metadata, evidence });
    return metadata;
}

export function invalidateGitCheckoutMetadata(directory?: string): void {
    if (directory === undefined) checkoutMetadata.clear();
    else checkoutMetadata.delete(path.resolve(directory));
}

/** Read Git's on-disk topology without invoking Git or guessing a checkout from a gitdir path. */
export function readGitCheckoutMetadata(directory: string): GitCheckoutMetadata | undefined {
    return readCheckoutMetadata(directory, () => {});
}

function readCheckoutMetadata(
    directory: string,
    watch: (file: string) => void,
): GitCheckoutMetadata | undefined {
    let current: string;
    watch(directory);
    try {
        current = realpathSync.native(directory);
    } catch {
        return undefined;
    }
    while (true) {
        const dotGit = path.join(current, ".git");
        watch(dotGit);
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
                watch(gitDir);
                watch(path.join(gitDir, "gitdir"));
                commonDir = gitDir;
                try {
                    const commonFile = path.join(gitDir, "commondir");
                    watch(commonFile);
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
            watch(commonDir);
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
