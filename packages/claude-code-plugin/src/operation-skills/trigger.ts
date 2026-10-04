/**
 * Prompt → recorded action. The UserPromptSubmit hook passes every prompt here;
 * when it names a recorded operation (its button label or one of its intents),
 * the verified operation goes into the model's context before it starts working
 * out the flow from the code. Whether the operation fires does not depend on the
 * model thinking of ctx_skill or of the native skill.
 *
 * Only skill files are read, so the hook stays cheap enough to run on every
 * prompt.
 */
import { driftOf, findOperations, renderOperation, renderSetup } from "./store";

/** At most this many operations are injected for one prompt. */
const MAX_INJECTED = 2;

const TAG = "operation-skill";

/** Context for a prompt that names recorded operations, or null when none does. */
export function operationContextFor(projectDir: string, prompt: string): string | null {
    if (prompt.trim().length === 0) return null;
    const matches = findOperations(projectDir, prompt, 5)
        .filter((match) => match.strong)
        .slice(0, MAX_INJECTED);
    if (matches.length === 0) return null;

    const sections = [
        "The request names a verified operation recorded for this project (Magic Context operation skill). If it asks for that operation, perform it with the setup and steps below: do not re-read the source or use another skill to work out the flow, and re-check only files flagged as changed since verification. If it asks to change the operation, these are its files, APIs and writes; once the change is verified, update the record with ctx_skill save.",
    ];
    for (const { skill, operation } of matches) {
        const setup = renderSetup(skill);
        sections.push(
            [
                `Skill "${skill.name}" (${skill.title}, scope ${skill.scope}, .claude/skills/${skill.name}/)`,
                ...(setup ? ["Setup / 准备 (skip what is already running):", setup] : []),
                renderOperation(operation, driftOf(projectDir, operation)),
            ].join("\n"),
        );
    }
    // Recorded text must not close the wrapper early.
    const body = sections.join("\n\n").replaceAll(`</${TAG}`, `<\\/${TAG}`);
    return `<${TAG}>\n${body}\n</${TAG}>`;
}
