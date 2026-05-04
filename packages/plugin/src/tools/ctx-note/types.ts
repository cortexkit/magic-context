export type CtxNoteReadFilter = "all" | "active" | "pending" | "ready" | "dismissed";

export interface CtxNoteArgs {
    action?: "write" | "read" | "dismiss" | "update";
    content?: string;
    surface_condition?: string;
    filter?: CtxNoteReadFilter;
    note_id?: number;
}
