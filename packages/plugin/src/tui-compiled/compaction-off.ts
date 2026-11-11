import type { SidebarSnapshot } from "../shared/rpc-types";

export interface CompactionOffSidebarRow {
    label: "Memories" | "Notes" | "Archived compartments";
    value: string;
}

/**
 * Formats context pressure from the current wire input and the model context
 * limit. It deliberately does not use the stored Magic Context threshold
 * percentage, because native compaction acts on the model window instead.
 */
export function nativeCompactionContextLabel(snapshot: SidebarSnapshot): string {
    return `Context: ${nativeCompactionUsage(snapshot)}`;
}

/** The usage half of {@link nativeCompactionContextLabel}, for a labelled row. */
export function nativeCompactionUsage(snapshot: SidebarSnapshot): string {
    if (snapshot.contextLimit <= 0) return "unknown · native compaction";
    const percentage = (snapshot.inputTokens / snapshot.contextLimit) * 100;
    return `${percentage.toFixed(1)}% · native compaction`;
}

export function compactionOffSidebarRows(snapshot: SidebarSnapshot): CompactionOffSidebarRow[] {
    const rows: CompactionOffSidebarRow[] = [
        { label: "Memories", value: String(snapshot.memoryCount) },
        { label: "Notes", value: String(snapshot.sessionNoteCount) },
    ];
    const archivedCount = snapshot.archivedCompartmentCount ?? 0;
    if (archivedCount > 0) {
        rows.push({ label: "Archived compartments", value: String(archivedCount) });
    }
    return rows;
}
