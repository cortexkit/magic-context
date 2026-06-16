import type { SkillLoadRegistry } from "../../features/magic-context/skill-memory/provenance";
import type { Database } from "../../shared/sqlite";

export const CTX_SKILL_NOTE_TOOL_NAME = "ctx_skill_note";

export const VALID_KINDS = ["gotcha", "discovery", "fix", "workflow"] as const;
export type SkillNoteKind = (typeof VALID_KINDS)[number];

export interface CtxSkillNoteArgs {
    skill: string;
    intent: string;
    kind: SkillNoteKind;
    delta: string;
    tags?: string[];
}

export interface CtxSkillNoteToolDeps {
    db: Database;
    skillLoadRegistry: SkillLoadRegistry;
    // NOTE: projectDirectory is intentionally absent — execute uses toolContext.directory
    // (the session's working directory) to match ctx_memory's pattern and correctly handle
    // `opencode -s` launched outside the project root. See Task 8 Step 3 for rationale.
}
