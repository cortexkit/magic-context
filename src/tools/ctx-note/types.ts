export interface CtxNoteArgs {
    action?: "write" | "read" | "clear" | "dismiss";
    content?: string;
    surface_condition?: string;
    note_id?: number;
}
