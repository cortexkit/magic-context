import { readOpenCode2BackgroundCompaction } from "@magic-context/core/shared/conflict-detector";
import { projectOpenCodeConfigPaths } from "@magic-context/core/shared/conflict-fixer";
import { setJsoncValue } from "@magic-context/core/shared/jsonc-edit";
import { writeFileAtomic } from "../lib/atomic-write";
import { readJsoncConfig, readJsoncTextForEdit } from "../lib/jsonc-config";
import { detectConfigPaths } from "../lib/paths";
import { compareSemverPrecedence } from "./doctor-opencode2-cache";

interface BackgroundCompactionSink {
    warn(message: string): void;
    wrote(message: string): void;
    info(message: string): void;
}

export function checkOpenCodeBackgroundCompaction(
    directory: string,
    hostVersion: string | null,
    options: { compactionEnabled: boolean; fix?: boolean },
    sink: BackgroundCompactionSink,
): void {
    if (!options.compactionEnabled || !hostVersion) return;
    const comparison = compareSemverPrecedence(hostVersion, "2.3.1");
    if (comparison === null || comparison < 0) return;

    const before = readOpenCode2BackgroundCompaction(directory);
    if (!before.enabled) return;
    sink.warn(
        "OpenCode prepares compactions before you ask for them (compaction.background). If /compact uses a prepared answer, Magic Context does not shrink the next request. Run doctor --fix to turn off background compaction.",
    );
    if (!options.fix) return;

    const userPath = detectConfigPaths().opencodeConfig;
    for (const path of new Set([userPath, ...projectOpenCodeConfigPaths(directory)])) {
        try {
            const config = readJsoncConfig(path);
            if (config.kind === "parse-error") throw config.error;
            if (config.kind === "missing") {
                if (path !== userPath) continue;
                writeFileAtomic(path, '{\n  "compaction": {\n    "background": false\n  }\n}\n');
            } else {
                const block = config.value.compaction;
                const fields =
                    block && typeof block === "object" && !Array.isArray(block)
                        ? (block as Record<string, unknown>)
                        : undefined;
                if (fields?.background === false) continue;
                if (path !== userPath && fields?.background === undefined) continue;
                const { bom, text } = readJsoncTextForEdit(path);
                const next = fields
                    ? setJsoncValue(text, ["compaction", "background"], false)
                    : setJsoncValue(text, ["compaction"], { background: false });
                writeFileAtomic(path, bom + next);
            }
            sink.wrote(`Set compaction.background: false in ${path}`);
        } catch (error) {
            sink.warn(`Could not set compaction.background in ${path}: ${String(error)}`);
        }
    }

    const after = readOpenCode2BackgroundCompaction(directory);
    const unchecked = [
        ...after.unreadable,
        ...(process.env.OPENCODE_CONFIG_CONTENT ? ["the OPENCODE_CONFIG_CONTENT layer"] : []),
    ];
    if (after.enabled || unchecked.length) {
        const sources = [
            ...(after.enabled ? [after.backgroundSource ?? "OpenCode's default"] : []),
            ...unchecked,
        ];
        sink.warn(
            `Background compaction may still be enabled. Check compaction.background in: ${[...new Set(sources)].join(", ")}.`,
        );
    } else {
        sink.info(
            "Background compaction is disabled in the config files doctor could check. Remote, organization, or managed OpenCode settings may override them.",
        );
    }
    sink.info("No OpenCode restart is needed for changes to compaction.background.");
}
