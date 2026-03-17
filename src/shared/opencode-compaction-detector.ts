import { join } from "node:path";
import { readJsoncFile } from "./jsonc-parser";
import { log } from "./logger";
import { getOpenCodeConfigPaths } from "./opencode-config-dir";

interface OpenCodeConfig {
    compaction?: {
        auto?: boolean;
        prune?: boolean;
    };
}

function hasCompactionConflict(
    compaction: OpenCodeConfig["compaction"] | undefined,
): boolean | undefined {
    if (!compaction) return undefined;
    const hasExplicitSetting = compaction.auto !== undefined || compaction.prune !== undefined;
    if (!hasExplicitSetting) return undefined;
    return compaction.auto === true || compaction.prune === true;
}

export function isOpenCodeAutoCompactionEnabled(directory: string): boolean {
    if (process.env.OPENCODE_DISABLE_AUTOCOMPACT) {
        log(
            "[compaction-detector] OPENCODE_DISABLE_AUTOCOMPACT env flag set — auto compaction disabled",
        );
        return false;
    }

    const projectCompaction = readProjectCompactionConfig(directory);
    if (projectCompaction !== undefined) {
        log("[compaction-detector] project config compaction conflict =", projectCompaction);
        return projectCompaction;
    }

    const userCompaction = readUserCompactionConfig(directory);
    if (userCompaction !== undefined) {
        log("[compaction-detector] user config compaction conflict =", userCompaction);
        return userCompaction;
    }

    log("[compaction-detector] no compaction config found — default is enabled");
    return true;
}

function readProjectCompactionConfig(directory: string): boolean | undefined {
    // .opencode/ dir config has higher precedence than root-level config in OpenCode's loading order.
    // Check highest precedence first — if .opencode/ sets compaction.auto, that wins.
    const dotOpenCodeJsonc = join(directory, ".opencode", "opencode.jsonc");
    const dotOpenCodeJson = join(directory, ".opencode", "opencode.json");
    const dotOpenCodeConfig =
        readJsoncFile<OpenCodeConfig>(dotOpenCodeJsonc) ??
        readJsoncFile<OpenCodeConfig>(dotOpenCodeJson);

    const dotOpenCodeCompactionConflict = hasCompactionConflict(dotOpenCodeConfig?.compaction);
    if (dotOpenCodeCompactionConflict !== undefined) {
        return dotOpenCodeCompactionConflict;
    }

    // Root-level project config (lower precedence than .opencode/)
    const rootJsonc = join(directory, "opencode.jsonc");
    const rootJson = join(directory, "opencode.json");
    const rootConfig =
        readJsoncFile<OpenCodeConfig>(rootJsonc) ?? readJsoncFile<OpenCodeConfig>(rootJson);

    return hasCompactionConflict(rootConfig?.compaction);
}

function readUserCompactionConfig(_directory: string): boolean | undefined {
    try {
        const paths = getOpenCodeConfigPaths({ binary: "opencode" });
        const config =
            readJsoncFile<OpenCodeConfig>(paths.configJsonc) ??
            readJsoncFile<OpenCodeConfig>(paths.configJson);

        return hasCompactionConflict(config?.compaction);
    } catch {
        return undefined;
    }
}
