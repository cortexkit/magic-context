import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const archivedCrates = resolve(import.meta.dir, "../../../../crates_old");

export function findTestStorageLeaks(directory: string): string[] {
    const violations: string[] = [];
    const scan = (root: string): void => {
        for (const entry of readdirSync(root, { withFileTypes: true })) {
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
