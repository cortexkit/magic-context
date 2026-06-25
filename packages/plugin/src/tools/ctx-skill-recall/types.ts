import type { SkillMemoryConfig } from "../../features/magic-context/skill-memory/frontmatter";
import type { SkillLoadRegistry } from "../../features/magic-context/skill-memory/provenance";
import type { Database } from "../../shared/sqlite";

export const CTX_SKILL_RECALL_TOOL_NAME = "ctx_skill_recall";

export interface CtxSkillRecallArgs {
    skill: string;
    intent?: string;
    max_tokens?: number;
}

export interface CtxSkillRecallToolDeps {
    db: Database;
    projectDirectory: string;
    // Optional: session-scoped skill-load registry (populated by transparent path).
    // When provided, resolution is registry-first (exact, no disk I/O).
    // In production, pass hooks.magicContext.skillLoadRegistry.
    // In tests, inject directly to avoid SKILL.md fixture files.
    skillLoadRegistry?: SkillLoadRegistry;
}

/**
 * Test-only DI overrides — kept OUT of the public production contract so a
 * production call site cannot accidentally pass them to bypass disk resolution,
 * frontmatter loading, and project-identity resolution. Tests pass this wider
 * type (structurally assignable to CtxSkillRecallToolDeps); the tool impl reads
 * the overrides via an internal cast.
 */
export interface CtxSkillRecallToolTestDeps extends CtxSkillRecallToolDeps {
    _testFrontmatterConfig?: SkillMemoryConfig | null;
    _testProjectIdentity?: string;
}
