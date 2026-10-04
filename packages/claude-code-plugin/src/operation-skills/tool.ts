/**
 * `ctx_skill`: the MCP tool over operation skills (see store.ts).
 *
 * `find` is what makes a request trigger a recorded action: the model passes the
 * user's request (or the button/event it names) and gets the verified operation
 * back, with any files that changed since verification. `save` is how a verified
 * flow becomes a skill. The session's own model does both; nothing here calls a
 * model.
 */

import { tool } from "@magic-context/core/shared/tool-schema";
import type { McpTool, McpToolResult } from "../mcp/server";
import {
    driftOf,
    findOperations,
    isStale,
    listSkills,
    loadSkill,
    markVerified,
    type OperationInput,
    type OperationSkill,
    OperationSkillError,
    removeSkillOrOperation,
    renderOperation,
    renderSetup,
    saveSkill,
    TRIGGER_KINDS,
} from "./store";

const z = tool.schema;

const trimmed = (description: string) => z.string().trim().min(1).describe(description);

const operationSchema = z.object({
    id: trimmed("Stable id of the operation, lowercase-kebab, e.g. save-order."),
    trigger: z.object({
        kind: z.enum(TRIGGER_KINDS).describe("What the user acts on."),
        label: trimmed('Visible label or event name, e.g. "保存" or "order:submitted".'),
        location: z
            .string()
            .optional()
            .describe("Where the trigger is defined, project-relative `path:line`."),
        selector: z.string().optional().describe("CSS selector / test id, when there is one."),
        event: z.string().optional().describe("onClick, submit, change, ..."),
    }),
    intents: z
        .array(z.string())
        .optional()
        .describe('Phrases a user would say for it, e.g. ["保存订单", "save the order"].'),
    action: z.object({
        summary: trimmed("What the action does, end to end, in one or two sentences."),
        handler: z.string().optional().describe("Handler function name."),
        location: z.string().optional().describe("Handler location, `path:line`."),
    }),
    apis: z
        .array(
            z.object({
                method: z.string().optional(),
                endpoint: trimmed("Path, RPC or mutation name."),
                request: z.string().optional().describe("Body / parameters it sends."),
                response: z.string().optional(),
                handler: z.string().optional().describe("Server handler, `path:symbol`."),
            }),
        )
        .optional()
        .describe("Backend calls the action makes, in order."),
    writes: z
        .array(
            z.object({
                target: trimmed("Table, collection, file, storage key, queue..."),
                fields: z.string().optional(),
                detail: z.string().optional(),
            }),
        )
        .optional()
        .describe("Data the operation writes. The most important part: what each button writes."),
    state: z
        .array(
            z.object({
                target: trimmed("Store, cache key or component state."),
                change: trimmed("How it changes."),
                location: z.string().optional(),
            }),
        )
        .optional()
        .describe("Client state the operation updates."),
    save_and_linkage: z
        .string()
        .optional()
        .describe("How saving completes and what else updates: refetches, events, other views."),
    files_to_modify: z
        .array(z.string())
        .optional()
        .describe("Files to change when this operation has to change, project-relative."),
    steps: z
        .array(z.string())
        .min(1)
        .describe(
            'How you (the agent) perform the operation directly, in order, as runnable commands or requests with <placeholders>, e.g. curl -X POST $BASE/api/notes -d \'{"text":"<text>"}\'. Not clicks: the trigger already names the button. UI steps only when there is no other way, with the selector.',
        ),
    verification: z.object({
        method: trimmed("How the flow was verified (test, request + DB check, UI run)."),
        evidence: z.string().optional().describe("Command, test name or observed result."),
    }),
});

const argsSchema = z.object({
    action: z
        .enum(["list", "find", "read", "save", "verify", "remove"])
        .describe(
            "list: this project's skills. find: the operation for a request, button or event. read: a skill or one operation in full. save: create or update a skill. verify: record a fresh verification. remove: delete an operation or skill.",
        ),
    name: z.string().optional().describe("Skill name, lowercase-kebab (read/save/verify/remove)."),
    operation: z.string().optional().describe("Operation id (read/verify/remove)."),
    query: z
        .string()
        .optional()
        .describe("find: the user's request or the button/event it names, verbatim."),
    title: z.string().optional().describe("save: human title, e.g. 订单编辑页."),
    description: z
        .string()
        .optional()
        .describe(
            "save: when to use the skill, naming its buttons/events; Claude Code uses it to trigger the skill.",
        ),
    scope: z
        .string()
        .optional()
        .describe(
            'save: project-relative directory the skill covers, e.g. "apps/web" ("." = whole project).',
        ),
    setup: z
        .array(z.string())
        .optional()
        .describe(
            "save: how to get the project ready to run these operations, as commands: start the app/server (and how to read its port), base URL, test account, env. Replaces the recorded setup.",
        ),
    operations: z
        .array(operationSchema)
        .optional()
        .describe("save: operations to add or replace (matched by id)."),
    verification: z
        .object({ method: trimmed("How it was re-verified."), evidence: z.string().optional() })
        .optional()
        .describe("verify: the new verification."),
});

type Args = ReturnType<typeof argsSchema.parse>;

export const CTX_SKILL_DESCRIPTION = `Operation skills: this project's verified flows, mapped from a trigger (button, form, event, route...) to the action behind it, the APIs it calls, the data it writes, the state it updates, how saving and linked updates complete, the steps to perform it, and how it was verified. They live in the project's .claude/skills/ and load as native skills in later sessions.

- find (query = the user's request verbatim): before working out how a UI action or flow works, look it up. A hit gives the recorded action and steps; follow them instead of re-analysing the code. Re-check only files reported as changed since verification.
- list / read: the project's skills; one skill or one operation in full.
- save: after you have traced AND verified a flow that writes data, record it. One operation per button/event; update an existing skill (same name, same operation id) instead of creating a duplicate. Writes are the most important part: say exactly what each button writes and where. Record the setup (how to start the app and reach it) and steps as commands you can run, so a later session performs the operation without reading the code.
- verify: after re-checking an operation whose files changed, record the new verification.
- remove: delete an operation or a whole skill that no longer exists.`;

function textOf(lines: string[]): McpToolResult {
    return { text: lines.join("\n"), isError: false };
}

function error(message: string): McpToolResult {
    return { text: `Error: ${message}`, isError: true };
}

function setupLines(skill: OperationSkill): string[] {
    const setup = renderSetup(skill);
    return setup ? ["Setup / 准备 (skip what is already running):", setup, ""] : [];
}

function needs<T>(value: T | undefined, what: string, action: string): T {
    if (value === undefined || (typeof value === "string" && value.trim() === "")) {
        throw new OperationSkillError(`${action} needs ${what}`);
    }
    return value;
}

function run(projectDir: string, args: Args): McpToolResult {
    switch (args.action) {
        case "list": {
            const skills = listSkills(projectDir);
            if (skills.length === 0) {
                return textOf([
                    "No operation skills are recorded for this project yet. Trace and verify a flow, then save it with ctx_skill save.",
                ]);
            }
            const lines = [`${skills.length} operation skill(s) in .claude/skills/:`];
            for (const skill of skills) {
                lines.push("", `${skill.name} — ${skill.title} (scope: ${skill.scope})`);
                for (const operation of skill.operations) {
                    const drift = driftOf(projectDir, operation);
                    const effect = operation.writes.map((write) => write.target).join(", ");
                    lines.push(
                        `  - ${operation.id}: ${operation.trigger.kind} "${operation.trigger.label}"${effect ? ` → writes ${effect}` : ""} (verified ${operation.verification.verifiedAt.slice(0, 10)}${isStale(drift) ? ", files changed since" : ""})`,
                    );
                }
            }
            return textOf(lines);
        }
        case "find": {
            const query = needs(args.query, "a query", "find");
            const matches = findOperations(projectDir, query);
            if (matches.length === 0) {
                return textOf([
                    `No recorded operation matches "${query}". Trace the flow in the code; once it is verified, save it with ctx_skill save.`,
                ]);
            }
            const [best, ...others] = matches;
            const lines = [
                `Best match: skill "${best.skill.name}" (${best.skill.title}, scope ${best.skill.scope}), operation "${best.operation.id}":`,
                "",
                ...setupLines(best.skill),
                renderOperation(best.operation, driftOf(projectDir, best.operation)),
            ];
            if (others.length > 0) {
                lines.push(
                    "",
                    "Other candidates:",
                    ...others.map(
                        (match) =>
                            `- ${match.skill.name}/${match.operation.id}: ${match.operation.trigger.kind} "${match.operation.trigger.label}"`,
                    ),
                );
            }
            return textOf(lines);
        }
        case "read": {
            const name = needs(args.name, "a skill name", "read");
            const skill = loadSkill(projectDir, name);
            if (!skill) return error(`no operation skill named "${name}" (ctx_skill list)`);
            const operations = args.operation
                ? skill.operations.filter((operation) => operation.id === args.operation)
                : skill.operations;
            if (operations.length === 0) {
                return error(`skill "${name}" has no operation "${args.operation}"`);
            }
            return textOf([
                `# ${skill.title} (${skill.name}, scope ${skill.scope})`,
                "",
                skill.description,
                "",
                ...setupLines(skill),
                operations
                    .map((operation) => renderOperation(operation, driftOf(projectDir, operation)))
                    .join("\n\n"),
            ]);
        }
        case "save": {
            const name = needs(args.name, "a skill name", "save");
            const operations: OperationInput[] = (args.operations ?? []).map((operation) => ({
                id: operation.id,
                trigger: operation.trigger,
                intents: operation.intents,
                action: operation.action,
                apis: operation.apis ?? [],
                writes: operation.writes ?? [],
                state: operation.state ?? [],
                saveAndLinkage: operation.save_and_linkage,
                filesToModify: operation.files_to_modify ?? [],
                steps: operation.steps,
                verification: operation.verification,
            }));
            const { skill, created } = saveSkill(projectDir, {
                name,
                title: args.title,
                description: args.description,
                scope: args.scope,
                setup: args.setup,
                operations,
            });
            const tracked = new Set(
                skill.operations.flatMap((operation) => Object.keys(operation.fileHashes)),
            );
            return textOf([
                `${created ? "Created" : "Updated"} operation skill "${skill.name}" with ${skill.operations.length} operation(s) in .claude/skills/${skill.name}/ (SKILL.md + flow.json); ${tracked.size} file(s) tracked for changes.`,
                "ctx_skill find/read serve it now; Claude Code loads it as a native skill from the next session.",
            ]);
        }
        case "verify": {
            const name = needs(args.name, "a skill name", "verify");
            const operation = needs(args.operation, "an operation id", "verify");
            const verification = needs(args.verification, "a verification", "verify");
            markVerified(projectDir, name, operation, verification);
            return textOf([
                `Recorded a fresh verification of ${name}/${operation}; its files are tracked from their current contents.`,
            ]);
        }
        case "remove": {
            const name = needs(args.name, "a skill name", "remove");
            const removed = removeSkillOrOperation(projectDir, name, args.operation);
            return textOf([
                removed === "skill"
                    ? `Removed operation skill "${name}".`
                    : `Removed operation "${args.operation}" from "${name}".`,
            ]);
        }
        default:
            return error(`unknown action "${String(args.action)}"`);
    }
}

function describeIssues(
    issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>,
) {
    return issues
        .map(
            (issue) =>
                `${issue.path.length > 0 ? issue.path.join(".") : "arguments"}: ${issue.message}`,
        )
        .join("; ");
}

/**
 * The tool for one project. `getProjectDir` is read per call so the tool follows
 * the session's project; `unavailable` short-circuits every call with a reason.
 */
export function createCtxSkillTool(options: {
    getProjectDir: () => string;
    unavailable?: () => string | null;
}): McpTool {
    return {
        name: "ctx_skill",
        description: CTX_SKILL_DESCRIPTION,
        inputSchema: z.toJSONSchema(argsSchema, { io: "input" }) as Record<string, unknown>,
        annotations: {
            title: "ctx_skill",
            readOnlyHint: false,
            destructiveHint: false,
            openWorldHint: false,
        },
        async call(rawArgs) {
            const reason = options.unavailable?.();
            if (reason) return { text: reason, isError: true };
            const parsed = argsSchema.safeParse(rawArgs ?? {});
            if (!parsed.success) {
                return {
                    text: `Invalid arguments: ${describeIssues(parsed.error.issues)}`,
                    isError: true,
                };
            }
            try {
                return run(options.getProjectDir(), parsed.data);
            } catch (caught) {
                if (caught instanceof OperationSkillError) return error(caught.message);
                throw caught;
            }
        },
    };
}
