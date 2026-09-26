import { formatSynapseLaneDescriptor } from "../../features/magic-context/memory/embedding-synapse";
import type { EmbeddingCoverageStatus } from "../../features/magic-context/project-embedding-registry";
import { describeShadowBackfillWriteRefusal } from "../../features/magic-context/shadow-backfill-state";
import type { EmbedDrainUiStatus } from "./embed-session-state";

export function formatEmbedStatusText(
    coverage: EmbeddingCoverageStatus,
    drain: { status: EmbedDrainUiStatus; embedded?: number; total?: number; failed?: number },
): string {
    if (!coverage.enabled) {
        return "Embedding is off (no provider configured).";
    }

    const lines: string[] = [];
    lines.push(`Embedding — model: ${coverage.model} (${coverage.provider})`);
    if (coverage.synapseDescriptor) {
        lines.push(`Synapse — ${formatSynapseLaneDescriptor(coverage.synapseDescriptor)}`);
    }
    lines.push(
        `This session:  ${coverage.session.embedded} / ${coverage.session.total} compartments embedded`,
    );
    lines.push(
        coverage.memories.memoryEnabled === false
            ? "Project memories:  off (memory disabled)"
            : `Project memories:  ${coverage.memories.embedded} / ${coverage.memories.total} embedded`,
    );
    if (coverage.commits.gitEnabled) {
        lines.push(`Git commits:  ${coverage.commits.embedded} / ${coverage.commits.total}`);
    } else {
        lines.push("Git commits:  0 / 0 (git indexing off)");
    }

    let drainLine = "Drain: idle";
    switch (drain.status) {
        case "running": {
            const e = drain.embedded ?? coverage.session.embedded;
            const t = drain.total ?? coverage.session.total;
            const failedSuffix =
                drain.failed && drain.failed > 0 ? ` (${drain.failed} failed)` : "";
            drainLine = `Drain: running ${e}/${t}${failedSuffix}`;
            break;
        }
        case "paused": {
            const e = drain.embedded ?? coverage.session.embedded;
            const t = drain.total ?? coverage.session.total;
            drainLine = `Drain: paused ${e}/${t}`;
            break;
        }
        case "stopped":
            drainLine = "Drain: stopped (provider down)";
            break;
        default:
            drainLine = "Drain: idle";
    }
    lines.push(drainLine);
    for (const stall of coverage.shadowBackfillStalls) {
        lines.push(
            `Shadow ${stall.scope}: stalled_no_progress — ${describeShadowBackfillWriteRefusal(stall.writeRefusalReason)}.`,
        );
    }
    return lines.join("\n");
}
