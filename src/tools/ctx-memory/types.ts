import type { Database } from "bun:sqlite";

export interface CtxMemoryArgs {
    action: "write" | "delete" | "promote" | "list";
    content?: string;
    category?: string;
    id?: number;
    scope?: "project" | "global";
}

export interface CtxMemoryToolDeps {
    db: Database;
    projectPath: string;
    memoryEnabled: boolean;
}
