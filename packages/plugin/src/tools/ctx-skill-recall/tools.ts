import { readFileSync } from "node:fs";
import { type ToolContext, type ToolDefinition, tool } from "@opencode-ai/plugin";
import { resolveProjectIdentity } from "../../features/magic-context/memory/project-identity";
import { parseFrontmatterConfig } from "../../features/magic-context/skill-memory/frontmatter";
import {
    getSkillLoad,
    resolveSkillPathByName,
    type SkillProvenance,
} from "../../features/magic-context/skill-memory/provenance";
import { recallSkillMemoryBlock } from "../../features/magic-context/skill-memory/recall";
import {
    CTX_SKILL_RECALL_TOOL_NAME,
    type CtxSkillRecallArgs,
    type CtxSkillRecallToolDeps,
    type CtxSkillRecallToolTestDeps,
} from "./types";

// NOTE on tool() API: same pattern as ctx_skill_note (Task 8).
// `name` is registry-level (not in tool body). `args` uses tool.schema.* Zod-like shape.
// See packages/plugin/src/tools/ctx-memory/tools.ts for the canonical pattern.

type SkillLoadEntry = ReturnType<typeof getSkillLoad>;

export function createCtxSkillRecallTool(deps: CtxSkillRecallToolDeps): ToolDefinition {
    return tool({
        description:
            "Explicitly recall skill-memory notes for a named skill without re-loading the skill. " +
            "Use when you want to query accumulated gotchas/discoveries for a skill you have already loaded " +
            "this session, or when you need to recall notes without triggering a full skill load. " +
            "Returns the <skill-memory> block as a string, or a 'No skill-memory found' message when empty.",
        args: {
            skill: tool.schema
                .string()
                .describe("The skill name to recall notes for (e.g. 'test-driven-development')"),
            intent: tool.schema
                .string()
                .optional()
                .describe(
                    "Optional: your current task intent — used for intent-scoped recall (P2). Omit for flat recall.",
                ),
            max_tokens: tool.schema
                .number()
                .optional()
                .describe(
                    "Optional token budget override. Defaults to the skill's frontmatter max_tokens (or 1500 if absent).",
                ),
        },
        execute: async (args: CtxSkillRecallArgs, toolContext: ToolContext) => {
            // Test-only DI overrides (bypass all resolution). Read via an internal
            // cast to the test-deps type so the seams stay OUT of the public
            // CtxSkillRecallToolDeps contract (production callers can't pass them).
            const testDeps = deps as CtxSkillRecallToolTestDeps;
            if (
                testDeps._testFrontmatterConfig !== undefined ||
                testDeps._testProjectIdentity !== undefined
            ) {
                const projectIdentity =
                    testDeps._testProjectIdentity ??
                    resolveProjectIdentity(toolContext.directory ?? deps.projectDirectory);
                const frontmatterConfig = testDeps._testFrontmatterConfig ?? null;
                const tier: "project" | "global" = "global"; // default for test injection
                const block = await recallSkillMemoryBlock(deps.db, {
                    skill: args.skill,
                    intent: args.intent,
                    scope: tier,
                    projectIdentity,
                    frontmatterConfig,
                    maxTokens: args.max_tokens,
                });
                if (!block) {
                    return `No skill-memory found for '${args.skill}' in this session.`;
                }
                return block;
            }

            // Resolve project identity from the session's working directory
            const projectDirectory = toolContext.directory ?? deps.projectDirectory;
            const projectIdentity = resolveProjectIdentity(projectDirectory);

            // ── RESOLUTION: REGISTRY-FIRST + disk-fallback ──────────────────────────
            //
            // 1. Registry-first (common case): if the skill was loaded this session,
            //    the transparent path already populated SkillLoadRegistry with the
            //    exact resolvedPath + frontmatterConfig. Use it — no disk I/O needed.
            //
            // 2. Disk-fallback (cold-start): only when NOT in registry, search disk.
            //    Search order matches opencode's real discoverSkills() from
            //    packages/opencode/src/skill/index.ts:173-233:
            //      - Project dirs FIRST (finding U3: project shadows global)
            //      - Global dirs second
            //    Verified paths (see discoverSkills() source):
            //      - Global external: ~/.claude/skills/, ~/.agents/skills/
            //        (pattern: skills/**/SKILL.md, via CLAUDE_EXTERNAL_DIR + AGENTS_EXTERNAL_DIR)
            //      - Walk-up project external: .claude/skills/, .agents/skills/
            //        (same pattern, ancestor walk from project root)
            //      - Config dirs (pattern: {skill,skills}/**/SKILL.md):
            //          ~/.config/opencode/ (= Global.Path.config = xdgConfig/opencode)
            //          .opencode/ (walk-up from project root)
            //        NOTE: ~/.config/opencode/skills/ IS discovered via this path —
            //        config.directories() returns Global.Path.config and the pattern
            //        {skill,skills}/**/SKILL.md matches skills/<name>/SKILL.md under it.
            //      - Custom paths: cfg.skills?.paths (user-configured in opencode.jsonc)
            //    Singular .opencode/skill/ is also valid (OPENCODE_SKILL_PATTERN covers both).

            const sessionId = toolContext.sessionID;
            const registryEntry: SkillLoadEntry =
                sessionId && deps.skillLoadRegistry
                    ? getSkillLoad(deps.skillLoadRegistry, sessionId, args.skill)
                    : undefined;

            let resolvedPath: string | null = null;
            let frontmatterConfig = registryEntry?.frontmatterConfig ?? null;
            let tier: SkillProvenance["tier"] = "global";

            if (registryEntry) {
                // Registry hit: exact resolution, reuse already-parsed frontmatterConfig
                resolvedPath = registryEntry.resolvedPath;
                tier = registryEntry.tier;
            } else {
                // Cold-start disk fallback: resolve via shared name-based walker
                // (same order as opencode's discoverSkills()).
                const resolved = resolveSkillPathByName(args.skill, projectDirectory);
                if (!resolved) {
                    // SKILL.md not found anywhere — distinct message from "no notes" cold-start
                    return (
                        `SKILL.md not found for '${args.skill}' in any known skill directory. ` +
                        `Load the skill first with the skill tool, or verify the skill name is correct. ` +
                        `Searched: project .opencode/skill/, .opencode/skills/, .agents/skills/, .claude/skills/; ` +
                        `global ~/.config/opencode/skill/, ~/.config/opencode/skills/, ~/.agents/skills/, ~/.claude/skills/.`
                    );
                }

                resolvedPath = resolved.resolvedPath;
                tier = resolved.tier;

                // Parse frontmatter from on-disk SKILL.md
                let rawSkillContent: string | null = null;
                try {
                    rawSkillContent = readFileSync(resolvedPath, "utf-8");
                } catch {
                    // SKILL.md exists per resolveSkillPathByName, so this is a read race;
                    // treat as not-found (unlikely but guard non-fatally).
                }
                frontmatterConfig = rawSkillContent
                    ? parseFrontmatterConfig(rawSkillContent)
                    : null;
            }

            if (!frontmatterConfig?.enabled) {
                // Distinct message: skill-memory disabled in frontmatter (not "no notes")
                return (
                    `skill-memory is not enabled for '${args.skill}'. ` +
                    `To enable it, add \`skill-memory: { enabled: true }\` to the skill's SKILL.md frontmatter.`
                );
            }

            // Delegate to shared recall core (feature layer — same as transparent path)
            const block = await recallSkillMemoryBlock(deps.db, {
                skill: args.skill,
                intent: args.intent,
                scope: tier,
                projectIdentity,
                frontmatterConfig,
                maxTokens: args.max_tokens,
            });

            if (!block) {
                // Cold-start: skill-memory enabled but no notes recorded yet
                return `No skill-memory found for '${args.skill}' — no notes have been recorded yet. Use ctx_skill_note to record gotchas, discoveries, fixes, or workflow steps after using this skill.`;
            }

            return block;
        },
    });
}

// Re-export the tool name for the registration site (lives in plugin/tool-registry.ts).
export { CTX_SKILL_RECALL_TOOL_NAME };
