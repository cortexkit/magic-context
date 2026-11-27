import durations from "./shard-durations.json";
import { selectWeightedShard } from "./select-weighted-shard";
import type { HarnessSelection, Mode, ValidationResult } from "./validate-mode-manifest";

export type ShardedHost = "opencode" | "opencode2";

export function filesForMode(validation: ValidationResult, mode: Mode, harness: HarnessSelection = "all"): string[] {
    return validation.manifest.entries
        .filter((entry) => entry.invocation[mode])
        .filter((entry) => harness === "all" || entry.hosts.includes(harness))
        .map((entry) => entry.path)
        .sort();
}

export function selectHostFiles(validation: ValidationResult, host: ShardedHost, spec: string): string[] {
    return selectWeightedShard(filesForMode(validation, "ts", host), spec, durations.seconds[host]);
}

export function selectRustShard(files: string[], spec: string): string[] {
    return selectWeightedShard(files, spec, durations.seconds.rust);
}
