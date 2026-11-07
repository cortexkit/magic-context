import type { MessageData } from "../store-reader";

const changed = "The Code Mode tool catalog has changed.";
const replacement = `${changed} This catalog supersedes the previous Code Mode tool catalog.`;

// Mirrors render()/update() in OpenCode packages/core/src/codemode/instructions.ts
// at v2.0.22, v2.1.4 and v2.2.3: only a full replacement supersedes earlier
// catalogs. Incremental changes depend on the initial catalog and prior updates.
// Their session/message-updater.ts identifies persisted updates with
// metadata.instructionSources. A combined notice also carries other sources,
// so retiring that entire row would discard unrelated instructions.
// Its full catalog still supersedes earlier Code Mode-only rows, while the
// combined notice itself must survive later catalog replacements.
export function codeModeCatalogKind(
    data: MessageData,
): "initial" | "replacement" | "incremental" | "combined-replacement" | undefined {
    const text = data.text ?? "";
    const metadata = data.metadata;
    const keyed =
        typeof metadata === "object" && metadata !== null && "instructionSources" in metadata;
    if (keyed) {
        const sources = metadata.instructionSources;
        if (!Array.isArray(sources) || !sources.includes("core/codemode")) return undefined;
        if (sources.length !== 1)
            return text.startsWith(replacement) ? "combined-replacement" : undefined;
    }
    if (text.startsWith(replacement)) return "replacement";
    if (text.startsWith(changed)) return "incremental";
    if (
        keyed ||
        text.startsWith("# Code Mode\n") ||
        text.startsWith("No Code Mode tools are currently available.")
    )
        return "initial";
    return undefined;
}
