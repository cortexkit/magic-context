import { type Dirent, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const archivedCrates = resolve(import.meta.dir, "../../../../crates_old");

type ReadDirectory = (path: string) => Dirent[];

const readDirectory: ReadDirectory = (path) => readdirSync(path, { withFileTypes: true });

/** `read` exists so a test can make a folder vanish mid-scan. */
export function findTestStorageLeaks(
    directory: string,
    read: ReadDirectory = readDirectory,
): string[] {
    const violations: string[] = [];
    const scan = (root: string): void => {
        let entries: Dirent[];
        try {
            entries = read(root);
        } catch (error) {
            // Test files run in parallel, and another file may remove its own
            // temp folder between the parent's listing and this read. A folder
            // that no longer exists can't hold a leak; any other error, or a
            // missing top-level folder, still fails the scan.
            if (root !== directory && (error as NodeJS.ErrnoException).code === "ENOENT") return;
            throw error;
        }
        for (const entry of entries) {
            const path = join(root, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === "node_modules" || entry.name === ".git") continue;
                // The archived crate tree is excluded from the shipped workspace and tests.
                // Do not descend into its historical database captures during a root scan.
                if (resolve(path) === archivedCrates) continue;
                if (entry.name === "undefined") violations.push(path);
                scan(path);
            } else if (entry.isFile() && entry.name === "context.db") {
                violations.push(path);
            }
        }
    };
    scan(directory);
    return violations;
}
