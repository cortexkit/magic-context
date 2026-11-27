#!/usr/bin/env bun

import { selectHostFiles, type ShardedHost } from "./mode-selection";
import { validateModeManifest, type ValidationResult } from "./validate-mode-manifest";

export type { ShardedHost } from "./mode-selection";

export function selectHostShard(host: ShardedHost, spec: string, validation: ValidationResult = validateModeManifest()): string[] {
    return selectHostFiles(validation, host, spec);
}

export function selectOpenCode2KnownFailures(validation: ValidationResult, files: readonly string[], version: string) {
    const selected = new Set(files);
    return validation.manifest.entries.filter((entry) => selected.has(entry.path)).flatMap((entry) =>
        (entry.knownFailures ?? []).filter((rule) => rule.hostVersions.includes(version)).flatMap((rule) =>
            rule.tests.map((name) => ({ path: entry.path, name, class: rule.class, reason: rule.reason })),
        ),
    );
}

if (import.meta.main) {
    try {
        const [host, spec, option, version] = process.argv.slice(2);
        if ((host !== "opencode" && host !== "opencode2") || !spec ||
            !(process.argv.length === 4 || (host === "opencode2" && option === "--known-failures" && version && process.argv.length === 6))) {
            throw new Error("usage: select-host-shard.ts opencode|opencode2 i/n [--known-failures <version>]");
        }
        const validation = validateModeManifest();
        const files = selectHostShard(host, spec, validation);
        if (version) console.log(JSON.stringify(selectOpenCode2KnownFailures(validation, files, version)));
        else for (const file of files) console.log(file);
    } catch (error) {
        console.error(String(error));
        process.exit(1);
    }
}
